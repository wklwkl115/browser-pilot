import { PI_BROWSER_BRIDGE_HTTP_URL, PI_BROWSER_BRIDGE_PORT, PI_BROWSER_BRIDGE_WS_URL } from "./config";
import { chromeApi as chrome } from "./runtimeEnv";
import { installCspBypassRule, isScriptable, piBridgeInfo } from "./bridge_info";
import { setBridgeWakeProbe } from "./core_commands";
import { handlePiBridgeWsMessage } from "./router";
import { runStartupRecovery } from "./state_store";
import { installPiBrowserTabSync } from "./tab_sync";
import type { JsonRecord, PiBridgeWebSocketLike, PiBridgeWsEnvelope, PiChromeAlarm, PiChromeTab } from "./types";

type OffscreenMessage = JsonRecord & {
  type?: string;
  port?: number;
  data?: unknown;
  resetDelay?: boolean;
};

type SocketAdapter = PiBridgeWebSocketLike & {
  port: number;
  readyState: number;
};

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
const WS_RECONNECT_INITIAL_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;
let wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;

function isOffscreenBridgeMessage(message: unknown): message is OffscreenMessage {
  return !!message && typeof message === "object" && typeof (message as OffscreenMessage).type === "string" && String((message as OffscreenMessage).type).startsWith("pi-browser-offscreen-");
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
      justification: "Maintain the local Pi browser bridge WebSocket transport outside the MV3 service worker lifetime.",
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
      void sendOffscreenMessage({ type: "pi-browser-offscreen-send", port, data }).catch((error: unknown) => console.warn("[PI-BROWSER-WS] offscreen send failed", error));
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

function cleanupTransportSocket(socket: PiBridgeWebSocketLike | null, reason = ""): boolean {
  if (!socket) return false;
  let removed = false;
  for (const [port, current] of sockets.entries()) {
    if (current !== socket) continue;
    current.readyState = SOCKET_CLOSED;
    sockets.delete(port);
    removed = true;
    console.log("[PI-BROWSER-WS] Disconnected", port, reason || "");
  }
  return removed;
}

function scheduleProbe(resetDelay = false): void {
  if (resetDelay) wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
  chrome.alarms.create("pi-browser-ws-probe", { delayInMinutes: 1 });
}

function bumpProbeBackoff(): void {
  wsReconnectDelayMs = Math.min(WS_RECONNECT_MAX_MS, Math.max(WS_RECONNECT_INITIAL_MS, wsReconnectDelayMs * 2));
}

function scheduleKeepalive(): void {
  void sendOffscreenMessage({ type: "pi-browser-offscreen-status" }).catch((error: unknown) => console.debug("[PI-BROWSER-WS] offscreen status failed", error));
}

async function isServerAlive(): Promise<boolean> {
  const response = await sendOffscreenMessage({ type: "pi-browser-offscreen-status" });
  return responseOpenPorts(response).length > 0;
}

async function syncOpenPorts(response: unknown): Promise<void> {
  for (const port of responseOpenPorts(response)) await handleOffscreenConnected(port);
}

async function probeAndConnectWS(resetDelay: boolean): Promise<void> {
  const response = await sendOffscreenMessage({ type: "pi-browser-offscreen-probe", resetDelay });
  await syncOpenPorts(response);
  scheduleProbe(resetDelay);
}

function connectWS(port: number = PI_BROWSER_BRIDGE_PORT): void {
  void sendOffscreenMessage({ type: "pi-browser-offscreen-probe", port, resetDelay: false }).then(syncOpenPorts);
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
    bridge: { ...piBridgeInfo(), bridgePort: port, primaryPort },
    tabs: tabs.map((tab: PiChromeTab) => ({ id: tab.id, url: tab.url, title: tab.title, active: tab.active, windowId: tab.windowId })),
  }));
  console.log("[PI-BROWSER-WS] Sent ext_ready with", tabs.length, "tabs to", port);
}

async function handleOffscreenConnected(port: number): Promise<void> {
  const socket = ensureSocketAdapter(port);
  await sendExtReady(socket, port);
}

async function handlePiBrowserOffscreenMessage(message: OffscreenMessage): Promise<unknown> {
  if (message.type === "pi-browser-offscreen-ready") return { ok: true };
  if (message.type === "pi-browser-offscreen-connected" && typeof message.port === "number") {
    await handleOffscreenConnected(message.port);
    return { ok: true };
  }
  if (message.type === "pi-browser-offscreen-disconnected" && typeof message.port === "number") {
    cleanupTransportSocket(sockets.get(message.port) ?? null, String((message.data as JsonRecord | undefined)?.reason ?? ""));
    return { ok: true };
  }
  if (message.type === "pi-browser-offscreen-ws-message" && typeof message.port === "number") {
    await handlePiBridgeWsMessage(message.data as PiBridgeWsEnvelope, ensureSocketAdapter(message.port));
    return { ok: true };
  }
  return { ok: false, error: "unknown offscreen message" };
}

async function handlePiBrowserTransportAlarm(alarm: PiChromeAlarm): Promise<void> {
  if (alarm.name === "pi-browser-self-reload") {
    chrome.runtime.reload();
    return;
  }
  if (alarm.name === "pi-browser-ws-keepalive" || alarm.name === "pi-browser-ws-probe") await probeAndConnectWS(false);
}

function installPiBrowserTransport(): boolean {
  if (piBrowserTransportInstalled) return false;
  chrome.runtime.onMessage.addListener((message: unknown, _sender: unknown, sendResponse: (response?: unknown) => void) => {
    if (!isOffscreenBridgeMessage(message)) return false;
    void handlePiBrowserOffscreenMessage(message).then(sendResponse);
    return true;
  });
  chrome.runtime.onInstalled.addListener(() => {
    console.log("Pi Browser Bridge installed");
    installCspBypassRule();
    void probeAndConnectWS(true);
  });
  installCspBypassRule();
  chrome.alarms.onAlarm.addListener(handlePiBrowserTransportAlarm);
  setBridgeWakeProbe(probeAndConnectWS);
  void probeAndConnectWS(true);
  chrome.runtime.onStartup.addListener(() => { void probeAndConnectWS(true); });
  installPiBrowserTabSync({ getSocket: getPiBrowserTransportSocket, getSockets: getPiBrowserTransportSockets, probe: probeAndConnectWS });
  piBrowserTransportInstalled = true;
  return true;
}

export { installPiBrowserTransport, getPiBrowserTransportSocket, getPiBrowserTransportSockets, cleanupTransportSocket, scheduleProbe, bumpProbeBackoff, scheduleKeepalive, isServerAlive, probeAndConnectWS, handlePiBrowserTransportAlarm, connectWS, handlePiBrowserOffscreenMessage, ensureOffscreenDocument };
// ESM module metadata
export const __piBridgeModule_transport = { name: "transport", symbols: { installPiBrowserTransport, sockets, WS_URL, WS_HEALTH_URL, WS_RECONNECT_INITIAL_MS, WS_RECONNECT_MAX_MS, wsReconnectDelayMs, getPiBrowserTransportSocket, getPiBrowserTransportSockets, cleanupTransportSocket, scheduleProbe, bumpProbeBackoff, scheduleKeepalive, isServerAlive, probeAndConnectWS, handlePiBrowserTransportAlarm, connectWS, handlePiBrowserOffscreenMessage, ensureOffscreenDocument } };
