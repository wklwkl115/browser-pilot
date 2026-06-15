import { PI_BROWSER_BRIDGE_HTTP_URL, PI_BROWSER_BRIDGE_PORT, PI_BROWSER_BRIDGE_WS_URL } from "./config";
import { chromeApi as chrome } from "./runtimeEnv";
import { installCspBypassRule, isScriptable, piBridgeInfo } from "./bridge_info";
import { setBridgeWakeProbe } from "./core_commands";
import { handlePiBridgeWsMessage, setTransportSocketGetter } from "./router";
import { runStartupRecovery } from "./state_store";
import { installPiBrowserTabSync } from "./tab_sync";
import type { JsonRecord, PiBridgeWebSocketLike, PiBridgeWsEnvelope, PiChromeAlarm, PiChromeTab } from "./types";

type OffscreenMessage = JsonRecord & { type?: string; port?: number; data?: unknown; resetDelay?: boolean };
type SocketAdapter = PiBridgeWebSocketLike & { port: number; readyState: number };

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
let primaryPort = PI_BROWSER_BRIDGE_PORT;
const sockets = new Map<number, SocketAdapter>();
let startupRecoveryDone = false;
let piBrowserTransportInstalled = false;
let offscreenCreateInFlight: Promise<boolean> | null = null;
const WS_URL = PI_BROWSER_BRIDGE_WS_URL;
const WS_HEALTH_URL = PI_BROWSER_BRIDGE_HTTP_URL;

function isOffscreenEventMessage(message: unknown): message is OffscreenMessage {
  if (!message || typeof message !== "object") return false;
  const type = String((message as OffscreenMessage).type || "");
  return type === "browser-pilot-offscreen-ready"
    || type === "browser-pilot-offscreen-connected"
    || type === "browser-pilot-offscreen-disconnected"
    || type === "browser-pilot-offscreen-ws-message";
}

function offscreenUrl(): string {
  return chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
}

async function hasOffscreenDocument(): Promise<boolean> {
  if (typeof chrome.offscreen?.hasDocument === "function") return await chrome.offscreen.hasDocument();
  const workerGlobal = globalThis as typeof globalThis & { clients?: { matchAll(options?: unknown): Promise<Array<{ url?: string }>> } };
  const clientsApi = workerGlobal.clients;
  if (!clientsApi?.matchAll) return false;
  const clients = await clientsApi.matchAll({ type: "window", includeUncontrolled: true });
  return clients.some((client) => client.url === offscreenUrl());
}

async function ensureOffscreenDocument(): Promise<boolean> {
  if (!chrome.offscreen?.createDocument) {
    console.warn("[PI-BROWSER-WS] chrome.offscreen unavailable; durable transport cannot start");
    return false;
  }
  if (await hasOffscreenDocument()) return true;
  if (!offscreenCreateInFlight) {
    offscreenCreateInFlight = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["WORKERS"],
      justification: "Maintain the local Browser Pilot Bridge WebSocket transport outside the MV3 service worker lifetime.",
    }).then(() => true, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/only a single offscreen document/i.test(message)) return true;
      console.warn("[PI-BROWSER-WS] offscreen create failed", error);
      return false;
    }).finally(() => { offscreenCreateInFlight = null; });
  }
  return await offscreenCreateInFlight;
}

async function sendOffscreenMessage(message: OffscreenMessage): Promise<unknown> {
  if (!await ensureOffscreenDocument()) return { ok: false, error: "offscreen unavailable" };
  return await chrome.runtime.sendMessage(message);
}

function offscreenTransportErrorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || error) : String(error);
}

function isExpectedOffscreenTransientError(message: string): boolean { return /browser is shutting down|extension context invalidated|context invalidated|receiving end does not exist/i.test(message); }

function logTransportAsyncError(reason: string, error: unknown): void {
  const message = offscreenTransportErrorMessage(error);
  if (isExpectedOffscreenTransientError(message)) return;
  console.warn(`[PI-BROWSER-WS] ${reason} failed`, message);
}

function runTransportTask(reason: string, task: () => Promise<unknown>): void { void task().catch((error: unknown) => logTransportAsyncError(reason, error)); }

function ensureSocketAdapter(port: number): SocketAdapter {
  const current = sockets.get(port);
  if (current) {
    current.readyState = SOCKET_OPEN;
    return current;
  }
  const socket: SocketAdapter = {
    port,
    readyState: SOCKET_OPEN,
    send(data: string) {
      void sendOffscreenMessage({ type: "browser-pilot-offscreen-send", port, data }).then((response: unknown) => {
        const sent = response && typeof response === "object" ? (response as JsonRecord).sent : undefined;
        if (sent === false) cleanupTransportSocket(socket, "offscreen-send-failed");
      }).catch((error: unknown) => {
        const message = offscreenTransportErrorMessage(error);
        if (isExpectedOffscreenTransientError(message)) return;
        console.warn("[PI-BROWSER-WS] offscreen send failed", message);
        cleanupTransportSocket(socket, "offscreen-send-error");
      });
    },
  };
  sockets.set(port, socket);
  return socket;
}

function responseOpenPorts(response: unknown): number[] {
  const record = response && typeof response === "object" ? response as JsonRecord : {};
  return Array.isArray(record.openPorts) ? record.openPorts.filter((port): port is number => typeof port === "number") : [];
}

function getPiBrowserTransportSocket(): PiBridgeWebSocketLike | null {
  return getPiBrowserTransportSockets()[0] ?? null;
}

function getPiBrowserTransportSockets(): PiBridgeWebSocketLike[] {
  return Array.from(sockets.values()).filter((socket) => socket.readyState === SOCKET_OPEN);
}

function cleanupTransportSocket(socket: PiBridgeWebSocketLike | null, _reason = ""): boolean {
  if (!socket) return false;
  let removed = false;
  for (const [port, current] of sockets.entries()) {
    if (current !== socket) continue;
    current.readyState = SOCKET_CLOSED;
    sockets.delete(port);
    removed = true;
  }
  return removed;
}

function scheduleProbe(resetDelay = false): void {
  void resetDelay;
  // Repeating alarm (not one-shot): the wake cadence self-heals even if a probe
  // throws before it can reschedule. 1 minute is the Chrome floor for released
  // extensions; this is only the cold-start backstop — a warm offscreen reconnects
  // far faster via its own sub-10s backoff.
  chrome.alarms.create("browser-pilot-ws-probe", { delayInMinutes: 1, periodInMinutes: 1 });
}

function bumpProbeBackoff(): void {
  scheduleProbe(false);
}

function scheduleKeepalive(): void {
  runTransportTask("offscreen status", async () => { await sendOffscreenMessage({ type: "browser-pilot-offscreen-status" }); });
}

async function isServerAlive(): Promise<boolean> {
  const response = await sendOffscreenMessage({ type: "browser-pilot-offscreen-status" });
  return responseOpenPorts(response).length > 0;
}

async function syncOpenPorts(response: unknown): Promise<void> {
  for (const port of responseOpenPorts(response)) await handleOffscreenConnected(port);
}

async function probeAndConnectWS(resetDelay: boolean): Promise<void> {
  const response = await sendOffscreenMessage({ type: "browser-pilot-offscreen-probe", resetDelay });
  await syncOpenPorts(response);
  scheduleProbe(resetDelay);
}

function connectWS(port: number = PI_BROWSER_BRIDGE_PORT): void {
  runTransportTask("offscreen probe", async () => { await syncOpenPorts(await sendOffscreenMessage({ type: "browser-pilot-offscreen-probe", port, resetDelay: false })); });
}

async function sendExtReady(socket: SocketAdapter, port: number): Promise<void> {
  primaryPort = port;
  if (!startupRecoveryDone) {
    startupRecoveryDone = true;
    try { await runStartupRecovery(); } catch (error) { console.warn("[PI-BROWSER-WS] Startup recovery failed", error); }
  }
  const tabs = (await chrome.tabs.query({}) as PiChromeTab[]).filter((tab: PiChromeTab) => isScriptable(tab.url));
  socket.send(JSON.stringify({
    type: "ext_ready",
    consentCapable: true,
    bridge: { ...piBridgeInfo(), bridgePort: port, primaryPort },
    tabs: tabs.map((tab: PiChromeTab) => ({ id: tab.id, url: tab.url, title: tab.title, active: tab.active, windowId: tab.windowId })),
  }));
}

async function handleOffscreenConnected(port: number): Promise<void> {
  const current = sockets.get(port);
  const shouldSendReady = !current || current.readyState !== SOCKET_OPEN;
  const socket = ensureSocketAdapter(port);
  if (shouldSendReady) await sendExtReady(socket, port);
}

async function handlePiBrowserOffscreenMessage(message: OffscreenMessage): Promise<unknown> {
  if (message.type === "browser-pilot-offscreen-ready") return { ok: true };
  if (message.type === "browser-pilot-offscreen-connected" && typeof message.port === "number") {
    await handleOffscreenConnected(message.port);
    return { ok: true };
  }
  if (message.type === "browser-pilot-offscreen-disconnected" && typeof message.port === "number") {
    cleanupTransportSocket(sockets.get(message.port) ?? null, String((message.data as JsonRecord | undefined)?.reason ?? ""));
    return { ok: true };
  }
  if (message.type === "browser-pilot-offscreen-ws-message" && typeof message.port === "number") {
    await handlePiBridgeWsMessage(message.data as PiBridgeWsEnvelope, ensureSocketAdapter(message.port));
    return { ok: true };
  }
  return { ok: false, error: "unknown offscreen message" };
}

async function handlePiBrowserTransportAlarm(alarm: PiChromeAlarm): Promise<void> {
  if (alarm.name === "browser-pilot-self-reload") {
    chrome.runtime.reload();
    return;
  }
  if (alarm.name === "browser-pilot-ws-keepalive" || alarm.name === "browser-pilot-ws-probe") await probeAndConnectWS(false);
}

function installPiBrowserTransport(): boolean {
  if (piBrowserTransportInstalled) return false;
  chrome.runtime.onMessage.addListener((message: unknown, _sender: unknown, sendResponse: (response?: unknown) => void) => {
    if (!isOffscreenEventMessage(message)) return false;
    void handlePiBrowserOffscreenMessage(message).then(sendResponse);
    return true;
  });
  chrome.runtime.onInstalled.addListener(() => {
    installCspBypassRule();
    runTransportTask("install probe", async () => { await probeAndConnectWS(true); });
  });
  installCspBypassRule();
  chrome.alarms.onAlarm.addListener((alarm: PiChromeAlarm) => { runTransportTask("transport alarm", async () => { await handlePiBrowserTransportAlarm(alarm); }); });
  setBridgeWakeProbe(probeAndConnectWS);
  setTransportSocketGetter(getPiBrowserTransportSocket);
  runTransportTask("initial probe", async () => { await probeAndConnectWS(true); });
  chrome.runtime.onStartup.addListener(() => { runTransportTask("startup probe", async () => { await probeAndConnectWS(true); }); });
  installPiBrowserTabSync({ getSocket: getPiBrowserTransportSocket, getSockets: getPiBrowserTransportSockets, probe: probeAndConnectWS });
  piBrowserTransportInstalled = true;
  return true;
}

export { installPiBrowserTransport, getPiBrowserTransportSocket, getPiBrowserTransportSockets, cleanupTransportSocket, scheduleProbe, bumpProbeBackoff, scheduleKeepalive, isServerAlive, probeAndConnectWS, handlePiBrowserTransportAlarm, connectWS, handlePiBrowserOffscreenMessage, ensureOffscreenDocument };
// ESM module metadata
export const __piBridgeModule_transport = { name: "transport", symbols: { installPiBrowserTransport, sockets, WS_URL, WS_HEALTH_URL, getPiBrowserTransportSocket, getPiBrowserTransportSockets, cleanupTransportSocket, scheduleProbe, bumpProbeBackoff, scheduleKeepalive, isServerAlive, probeAndConnectWS, handlePiBrowserTransportAlarm, connectWS, handlePiBrowserOffscreenMessage, ensureOffscreenDocument } };
