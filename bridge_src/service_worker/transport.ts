import { PI_BROWSER_BRIDGE_HTTP_URL, PI_BROWSER_BRIDGE_WS_URL } from "./config";
import { chromeApi as chrome } from "./runtimeEnv";
import { installCspBypassRule, isScriptable, piBridgeInfo } from "./bridge_info";
import { setBridgeWakeProbe } from "./core_commands";
import { handlePiBridgeWsMessage } from "./router";
import { installPiBrowserTabSync } from "./tab_sync";
import type { PiChromeAlarm, PiChromeTab } from "./types";

// transport.js - Pi browser WebSocket connection, probe, reconnect, keepalive, and envelope handling.

let ws: WebSocket | null = null;
const WS_URL = PI_BROWSER_BRIDGE_WS_URL;
const WS_HEALTH_URL = PI_BROWSER_BRIDGE_HTTP_URL;
const WS_RECONNECT_INITIAL_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;
let wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
let piBrowserTransportInstalled = false;

function getPiBrowserTransportSocket(): WebSocket | null {
  return ws;
}

function piBrowserErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanupTransportSocket(socket: WebSocket | null, reason: string = ''): boolean {
  if (ws !== socket) return false;
  ws = null;
  console.log('[PI-BROWSER-WS] Disconnected', reason || '');
  bumpProbeBackoff();
  scheduleProbe();
  return true;
}

function scheduleProbe(resetDelay: boolean = false) {
  if (resetDelay) wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
  const jitter = 0.85 + (Math.random() * 0.3);
  const delayMs = Math.min(WS_RECONNECT_MAX_MS, Math.max(WS_RECONNECT_INITIAL_MS, wsReconnectDelayMs)) * jitter;
  chrome.alarms.create('pi-browser-ws-probe', { delayInMinutes: Math.max(0.02, delayMs / 60000) });
}

function bumpProbeBackoff(): void {
  wsReconnectDelayMs = Math.min(WS_RECONNECT_MAX_MS, Math.max(WS_RECONNECT_INITIAL_MS, wsReconnectDelayMs * 2));
}

function scheduleKeepalive(): void {
  chrome.alarms.create('pi-browser-ws-keepalive', { delayInMinutes: 0.4 });
}

async function isServerAlive(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2000);
    await fetch(WS_HEALTH_URL, { signal: ctrl.signal });
    return true;
  } catch (e) {
    return false;
  }
}

async function probeAndConnectWS(resetDelay: boolean) {
  if (ws && ws.readyState <= 1) return;
  if (resetDelay) wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
  if (await isServerAlive()) {
    console.log('[PI-BROWSER-WS] Server detected, connecting...');
    connectWS();
  } else {
    bumpProbeBackoff();
    scheduleProbe();
  }
}

async function handlePiBrowserTransportAlarm(alarm: PiChromeAlarm) {
  if (alarm.name === 'pi-browser-self-reload') {
    chrome.runtime.reload();
    return;
  }
  if (alarm.name === 'pi-browser-ws-keepalive') {
    const socket = ws;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try { socket.send('{"type":"ping"}'); } catch (_) {}
      scheduleKeepalive();
    } else {
      cleanupTransportSocket(socket, 'keepalive');
    }
  }
  if (alarm.name === 'pi-browser-ws-probe') {
    await probeAndConnectWS(false);
  }
}

function connectWS(): void {
  if (ws && ws.readyState <= 1) return;
  ws = null;
  console.log('[PI-BROWSER-WS] Connecting to', WS_URL);
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.warn('[PI-BROWSER-WS] Constructor failed:', piBrowserErrorMessage(e));
    ws = null;
    bumpProbeBackoff();
    scheduleProbe();
    return;
  }
  const socket = ws;
  socket.onopen = async () => {
    if (ws !== socket) return;
    wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
    console.log('[PI-BROWSER-WS] Connected!');
    scheduleKeepalive();
    const tabs = (await chrome.tabs.query({}) as PiChromeTab[]).filter((t: PiChromeTab) => isScriptable(t.url));
    if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: 'ext_ready',
      bridge: piBridgeInfo(),
      tabs: tabs.map((t: PiChromeTab) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
    }));
    console.log('[PI-BROWSER-WS] Sent ext_ready with', tabs.length, 'tabs');
  };
  socket.onmessage = async (event: MessageEvent) => {
    if (ws !== socket) return;
    try {
      await handlePiBridgeWsMessage(JSON.parse(event.data), socket);
    } catch (e) {
      console.error('[PI-BROWSER-WS] message parse error', e);
    }
  };
  socket.onclose = () => {
    cleanupTransportSocket(socket, 'close');
  };
  socket.onerror = (e: Event) => {
    console.debug('[PI-BROWSER-WS] Connection error; waiting for local server', {
      readyState: socket ? socket.readyState : null,
      type: e && e.type ? e.type : 'error'
    });
    if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) cleanupTransportSocket(socket, 'error');
  };
}

function installPiBrowserTransport(): boolean {
  if (piBrowserTransportInstalled) return false;
  chrome.runtime.onInstalled.addListener(() => {
    console.log('Pi Browser Bridge installed');
    installCspBypassRule();
    void probeAndConnectWS(true);
  });
  chrome.alarms.onAlarm.addListener(handlePiBrowserTransportAlarm);
  setBridgeWakeProbe(probeAndConnectWS);
  void probeAndConnectWS(true);
  chrome.runtime.onStartup.addListener(() => { void probeAndConnectWS(true); });
  installPiBrowserTabSync({ getSocket: getPiBrowserTransportSocket, probe: probeAndConnectWS });
  piBrowserTransportInstalled = true;
  return true;
}

export { installPiBrowserTransport, getPiBrowserTransportSocket, cleanupTransportSocket, scheduleProbe, bumpProbeBackoff, scheduleKeepalive, isServerAlive, probeAndConnectWS, handlePiBrowserTransportAlarm, connectWS };
// ESM module boundary marker for TODO 189
export const __piBridgeModule_transport = { name: "transport", symbols: { installPiBrowserTransport, ws, WS_URL, WS_HEALTH_URL, WS_RECONNECT_INITIAL_MS, WS_RECONNECT_MAX_MS, wsReconnectDelayMs, getPiBrowserTransportSocket, cleanupTransportSocket, scheduleProbe, bumpProbeBackoff, scheduleKeepalive, isServerAlive, probeAndConnectWS, handlePiBrowserTransportAlarm, connectWS } };
