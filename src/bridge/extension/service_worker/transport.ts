import { BROWSER_PILOT_BRIDGE_HTTP_URL, BROWSER_PILOT_BRIDGE_PORT, BROWSER_PILOT_BRIDGE_WS_URL } from "./config";
import { chromeApi as chrome } from "./runtimeEnv";
import { installCspBypassRule, isScriptable, browserPilotBridgeInfo, getExtensionInstanceId, validateCspBypassRule, registerOffscreenUnreachableGetter } from "./bridge_info";
import { setBridgeWakeProbe } from "./core_commands";
import { handleBrowserPilotBridgeWsMessage, setTransportSocketGetter } from "./router";
import { runStartupRecovery } from "./state_store";
import { installBrowserPilotTabSync } from "./tab_sync";
import { setBrowserPilotOperationEventSocketGetter } from "./operation_event_transport";
import { browserPilotPageIdentityFields } from "./page_identity";
import { browserPilotTabIdentityFields } from "./tab_identity";
import type { JsonRecord, BrowserPilotBridgeWebSocketLike, BrowserPilotBridgeWsEnvelope, BrowserPilotChromeAlarm, BrowserPilotChromeTab } from "./types";

type OffscreenMessage = JsonRecord & { type?: string; port?: number; data?: unknown; resetDelay?: boolean };
type SocketAdapter = BrowserPilotBridgeWebSocketLike & { port: number; readyState: number };

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
let primaryPort = BROWSER_PILOT_BRIDGE_PORT;
const sockets = new Map<number, SocketAdapter>();
let startupRecoveryDone = false;
let browserPilotTransportInstalled = false;
let offscreenCreateInFlight: Promise<boolean> | null = null;
let offscreenUnreachable = false;
registerOffscreenUnreachableGetter(() => offscreenUnreachable);
const WS_URL = BROWSER_PILOT_BRIDGE_WS_URL;
const WS_HEALTH_URL = BROWSER_PILOT_BRIDGE_HTTP_URL;

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
    console.warn("[BROWSER-PILOT-WS] chrome.offscreen unavailable; durable transport cannot start");
    return false;
  }
  if (await hasOffscreenDocument()) return true;
  if (!offscreenCreateInFlight) {
    offscreenCreateInFlight = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["WORKERS"],
      justification: "Maintain the local Browser Pilot Bridge WebSocket transport outside the MV3 service worker lifetime.",
    }).then(() => true, async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/only a single offscreen document/i.test(message)) {
        // Validate the existing offscreen document is reachable
        try {
          const pong = await Promise.race([
            chrome.runtime.sendMessage({ type: "browser-pilot-offscreen-status" }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
          ]);
          if (pong && typeof pong === "object") {
            offscreenUnreachable = false;
            return true;
          }
        } catch (_pingError) {
          // Ping failed — offscreen may be crashed
        }
        // Offscreen document exists but is unreachable — try to close and recreate
        console.warn("[BROWSER-PILOT-WS] offscreen document exists but is unreachable; attempting close+recreate");
        try {
          const offscreenApi = chrome.offscreen as typeof chrome.offscreen & { closeDocument?: () => Promise<void> };
          if (typeof offscreenApi?.closeDocument === "function") await offscreenApi.closeDocument();
          await chrome.offscreen!.createDocument({
            url: OFFSCREEN_DOCUMENT_PATH,
            reasons: ["WORKERS"],
            justification: "Maintain the local Browser Pilot Bridge WebSocket transport outside the MV3 service worker lifetime.",
          });
          offscreenUnreachable = false;
          return true;
        } catch (recreateError) {
          console.warn("[BROWSER-PILOT-WS] offscreen close+recreate failed", recreateError);
          offscreenUnreachable = true;
          return false;
        }
      }
      console.warn("[BROWSER-PILOT-WS] offscreen create failed", error);
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
  console.warn(`[BROWSER-PILOT-WS] ${reason} failed`, message);
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
        console.warn("[BROWSER-PILOT-WS] offscreen send failed", message);
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

function getBrowserPilotTransportSocket(): BrowserPilotBridgeWebSocketLike | null {
  return getBrowserPilotTransportSockets()[0] ?? null;
}

function getBrowserPilotTransportSockets(): BrowserPilotBridgeWebSocketLike[] {
  return Array.from(sockets.values()).filter((socket) => socket.readyState === SOCKET_OPEN);
}

function cleanupTransportSocket(socket: BrowserPilotBridgeWebSocketLike | null, _reason = ""): boolean {
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

function connectWS(port: number = BROWSER_PILOT_BRIDGE_PORT): void {
  runTransportTask("offscreen probe", async () => { await syncOpenPorts(await sendOffscreenMessage({ type: "browser-pilot-offscreen-probe", port, resetDelay: false })); });
}

async function sendExtReady(socket: SocketAdapter, port: number): Promise<void> {
  primaryPort = port;
  if (!startupRecoveryDone) {
    startupRecoveryDone = true;
    try { await runStartupRecovery(); } catch (error) { console.warn("[BROWSER-PILOT-WS] Startup recovery failed", error); }
  }
  try { await validateCspBypassRule(); } catch (_e) { /* best-effort */ }
  const extensionInstanceId = await getExtensionInstanceId();
  const tabs = (await chrome.tabs.query({}) as BrowserPilotChromeTab[]).filter((tab: BrowserPilotChromeTab) => isScriptable(tab.url));
  const tabsWithIdentity = await Promise.all(tabs.map(async (tab: BrowserPilotChromeTab) => ({ id: tab.id, url: tab.url, title: tab.title, active: tab.active, windowId: tab.windowId, ...browserPilotPageIdentityFields(tab), ...await browserPilotTabIdentityFields(tab) })));
  socket.send(JSON.stringify({
    type: "ext_ready",
    consentCapable: true,
    bridge: { ...browserPilotBridgeInfo(), bridgePort: port, primaryPort, ...(extensionInstanceId ? { extensionInstanceId } : {}) },
    tabs: tabsWithIdentity,
  }));
}

async function handleOffscreenConnected(port: number): Promise<void> {
  const current = sockets.get(port);
  const shouldSendReady = !current || current.readyState !== SOCKET_OPEN;
  const socket = ensureSocketAdapter(port);
  if (shouldSendReady) await sendExtReady(socket, port);
}

async function handleBrowserPilotOffscreenMessage(message: OffscreenMessage): Promise<unknown> {
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
    await handleBrowserPilotBridgeWsMessage(message.data as BrowserPilotBridgeWsEnvelope, ensureSocketAdapter(message.port));
    return { ok: true };
  }
  return { ok: false, error: "unknown offscreen message" };
}

async function handleBrowserPilotTransportAlarm(alarm: BrowserPilotChromeAlarm): Promise<void> {
  if (alarm.name === "browser-pilot-self-reload") {
    chrome.runtime.reload();
    return;
  }
  if (alarm.name === "browser-pilot-ws-keepalive" || alarm.name === "browser-pilot-ws-probe") await probeAndConnectWS(false);
}

function installBrowserPilotTransport(): boolean {
  if (browserPilotTransportInstalled) return false;
  chrome.runtime.onMessage.addListener((message: unknown, _sender: unknown, sendResponse: (response?: unknown) => void) => {
    if (!isOffscreenEventMessage(message)) return false;
    void handleBrowserPilotOffscreenMessage(message).then(sendResponse);
    return true;
  });
  chrome.runtime.onInstalled.addListener(() => {
    installCspBypassRule();
    runTransportTask("install probe", async () => { await probeAndConnectWS(true); });
  });
  installCspBypassRule();
  chrome.alarms.onAlarm.addListener((alarm: BrowserPilotChromeAlarm) => { runTransportTask("transport alarm", async () => { await handleBrowserPilotTransportAlarm(alarm); }); });
  setBridgeWakeProbe(probeAndConnectWS);
  setTransportSocketGetter(getBrowserPilotTransportSocket);
  setBrowserPilotOperationEventSocketGetter(getBrowserPilotTransportSocket);
  runTransportTask("initial probe", async () => { await probeAndConnectWS(true); });
  chrome.runtime.onStartup.addListener(() => { runTransportTask("startup probe", async () => { await probeAndConnectWS(true); }); });
  installBrowserPilotTabSync({ getSocket: getBrowserPilotTransportSocket, getSockets: getBrowserPilotTransportSockets, probe: probeAndConnectWS });
  browserPilotTransportInstalled = true;
  return true;
}

export { installBrowserPilotTransport, getBrowserPilotTransportSocket, getBrowserPilotTransportSockets, cleanupTransportSocket, scheduleProbe, bumpProbeBackoff, scheduleKeepalive, isServerAlive, probeAndConnectWS, handleBrowserPilotTransportAlarm, connectWS, handleBrowserPilotOffscreenMessage, ensureOffscreenDocument };
// ESM module metadata
export const __browserPilotBridgeModule_transport = { name: "transport", symbols: { installBrowserPilotTransport, sockets, WS_URL, WS_HEALTH_URL, getBrowserPilotTransportSocket, getBrowserPilotTransportSockets, cleanupTransportSocket, scheduleProbe, bumpProbeBackoff, scheduleKeepalive, isServerAlive, probeAndConnectWS, handleBrowserPilotTransportAlarm, connectWS, handleBrowserPilotOffscreenMessage, ensureOffscreenDocument } };
