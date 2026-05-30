import { PI_BROWSER_BRIDGE_HOST, PI_BROWSER_BRIDGE_HTTP_URL, PI_BROWSER_BRIDGE_PORT, PI_BROWSER_BRIDGE_PORT_RANGE_END, PI_BROWSER_BRIDGE_WS_URL } from "./config";
import { chromeApi as chrome } from "./runtimeEnv";
import { installCspBypassRule, isScriptable, piBridgeInfo } from "./bridge_info";
import { setBridgeWakeProbe } from "./core_commands";
import { handlePiBridgeWsMessage } from "./router";
import { runStartupRecovery } from "./state_store";
import { installPiBrowserTabSync } from "./tab_sync";
import type { PiChromeAlarm, PiChromeTab } from "./types";

let primaryPort = PI_BROWSER_BRIDGE_PORT;
const sockets = new Map<number, WebSocket>();
let startupRecoveryDone = false;
const WS_URL = PI_BROWSER_BRIDGE_WS_URL;
const WS_HEALTH_URL = PI_BROWSER_BRIDGE_HTTP_URL;
const WS_RECONNECT_INITIAL_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;
let wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
let piBrowserTransportInstalled = false;

function portRange(): number[] {
  const ports: number[] = [];
  for (let port = PI_BROWSER_BRIDGE_PORT; port <= PI_BROWSER_BRIDGE_PORT_RANGE_END; port += 1) ports.push(port);
  return ports;
}

function wsUrlForPort(port: number): string {
  return port === PI_BROWSER_BRIDGE_PORT ? PI_BROWSER_BRIDGE_WS_URL : `ws://${PI_BROWSER_BRIDGE_HOST}:${port}`;
}

function httpUrlForPort(port: number): string {
  return port === PI_BROWSER_BRIDGE_PORT ? PI_BROWSER_BRIDGE_HTTP_URL : `http://${PI_BROWSER_BRIDGE_HOST}:${port}`;
}

function getPiBrowserTransportSocket(): WebSocket | null {
  const open = getPiBrowserTransportSockets()[0];
  if (open) return open;
  for (const socket of sockets.values()) if (socket.readyState === WebSocket.CONNECTING) return socket;
  return null;
}

function getPiBrowserTransportSockets(): WebSocket[] {
  return Array.from(sockets.values()).filter((socket) => socket.readyState === WebSocket.OPEN);
}

function piBrowserErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanupTransportSocket(socket: WebSocket | null, reason: string = ''): boolean {
  if (!socket) return false;
  let removed = false;
  for (const [port, current] of sockets.entries()) {
    if (current !== socket) continue;
    sockets.delete(port);
    removed = true;
    console.log('[PI-BROWSER-WS] Disconnected', port, reason || '');
  }
  if (!removed) return false;
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

async function isServerAlive(port: number = PI_BROWSER_BRIDGE_PORT): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2000);
    await fetch(httpUrlForPort(port), { signal: ctrl.signal });
    return true;
  } catch (e) {
    return false;
  }
}

async function probeAndConnectWS(resetDelay: boolean) {
  if (resetDelay) wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
  let detected = false;
  for (const port of portRange()) {
    const current = sockets.get(port);
    if (current && current.readyState <= WebSocket.OPEN) { detected = true; continue; }
    if (current) sockets.delete(port);
    if (await isServerAlive(port)) {
      detected = true;
      console.log('[PI-BROWSER-WS] Server detected, connecting...', port);
      connectWS(port);
    }
  }
  if (!detected) bumpProbeBackoff();
  scheduleProbe();
}

async function handlePiBrowserTransportAlarm(alarm: PiChromeAlarm) {
  if (alarm.name === 'pi-browser-self-reload') {
    chrome.runtime.reload();
    return;
  }
  if (alarm.name === 'pi-browser-ws-keepalive') {
    const openSockets = getPiBrowserTransportSockets();
    for (const socket of openSockets) {
      try { socket.send('{"type":"ping"}'); } catch (error) { console.warn('[PI-BROWSER-WS] Keepalive ping failed', error); cleanupTransportSocket(socket, 'keepalive-send'); }
    }
    if (openSockets.length) scheduleKeepalive();
    else await probeAndConnectWS(false);
  }
  if (alarm.name === 'pi-browser-ws-probe') {
    await probeAndConnectWS(false);
  }
}

function connectWS(port: number = PI_BROWSER_BRIDGE_PORT): void {
  const current = sockets.get(port);
  if (current && current.readyState <= WebSocket.OPEN) return;
  sockets.delete(port);
  const url = wsUrlForPort(port);
  console.log('[PI-BROWSER-WS] Connecting to', url);
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
    sockets.set(port, socket);
  } catch (e) {
    console.warn('[PI-BROWSER-WS] Constructor failed:', piBrowserErrorMessage(e));
    bumpProbeBackoff();
    scheduleProbe();
    return;
  }
  socket.onopen = async () => {
    if (sockets.get(port) !== socket) return;
    primaryPort = port;
    wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
    console.log('[PI-BROWSER-WS] Connected!', port);
    scheduleKeepalive();
    // Run startup recovery once before first ext_ready
    if (!startupRecoveryDone) {
      startupRecoveryDone = true;
      try { await runStartupRecovery(); } catch (e) { console.warn('[PI-BROWSER-WS] Startup recovery failed', e); }
    }
    const tabs = (await chrome.tabs.query({}) as PiChromeTab[]).filter((t: PiChromeTab) => isScriptable(t.url));
    if (sockets.get(port) !== socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: 'ext_ready',
      bridge: { ...piBridgeInfo(), bridgePort: port, primaryPort },
      tabs: tabs.map((t: PiChromeTab) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
    }));
    console.log('[PI-BROWSER-WS] Sent ext_ready with', tabs.length, 'tabs to', port);
  };
  socket.onmessage = async (event: MessageEvent) => {
    if (sockets.get(port) !== socket) return;
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
      port,
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
  installCspBypassRule();
  chrome.alarms.onAlarm.addListener(handlePiBrowserTransportAlarm);
  setBridgeWakeProbe(probeAndConnectWS);
  void probeAndConnectWS(true);
  chrome.runtime.onStartup.addListener(() => { void probeAndConnectWS(true); });
  installPiBrowserTabSync({ getSocket: getPiBrowserTransportSocket, getSockets: getPiBrowserTransportSockets, probe: probeAndConnectWS });
  piBrowserTransportInstalled = true;
  return true;
}

export { installPiBrowserTransport, getPiBrowserTransportSocket, getPiBrowserTransportSockets, cleanupTransportSocket, scheduleProbe, bumpProbeBackoff, scheduleKeepalive, isServerAlive, probeAndConnectWS, handlePiBrowserTransportAlarm, connectWS };
// ESM module boundary marker for TODO 189
export const __piBridgeModule_transport = { name: "transport", symbols: { installPiBrowserTransport, sockets, WS_URL, WS_HEALTH_URL, WS_RECONNECT_INITIAL_MS, WS_RECONNECT_MAX_MS, wsReconnectDelayMs, getPiBrowserTransportSocket, getPiBrowserTransportSockets, cleanupTransportSocket, scheduleProbe, bumpProbeBackoff, scheduleKeepalive, isServerAlive, probeAndConnectWS, handlePiBrowserTransportAlarm, connectWS } };
