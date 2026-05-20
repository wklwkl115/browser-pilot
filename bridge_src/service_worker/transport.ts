// @ts-nocheck
// transport.js - Pi browser WebSocket connection, probe, reconnect, keepalive, and envelope handling.

let ws = null;
const WS_URL = PI_BROWSER_BRIDGE_WS_URL;
const WS_HEALTH_URL = PI_BROWSER_BRIDGE_HTTP_URL;
const WS_RECONNECT_INITIAL_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;
let wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;

function getPiBrowserTransportSocket() {
  return ws;
}

function cleanupTransportSocket(socket, reason) {
  if (ws !== socket) return false;
  ws = null;
  console.log('[PI-BROWSER-WS] Disconnected', reason || '');
  bumpProbeBackoff();
  scheduleProbe();
  return true;
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('Pi Browser Bridge installed');
  installCspBypassRule();
  void probeAndConnectWS(true);
});

function scheduleProbe(resetDelay) {
  if (resetDelay) wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
  const jitter = 0.85 + (Math.random() * 0.3);
  const delayMs = Math.min(WS_RECONNECT_MAX_MS, Math.max(WS_RECONNECT_INITIAL_MS, wsReconnectDelayMs)) * jitter;
  chrome.alarms.create('pi-browser-ws-probe', { delayInMinutes: Math.max(0.02, delayMs / 60000) });
}

function bumpProbeBackoff() {
  wsReconnectDelayMs = Math.min(WS_RECONNECT_MAX_MS, Math.max(WS_RECONNECT_INITIAL_MS, wsReconnectDelayMs * 2));
}

function scheduleKeepalive() {
  chrome.alarms.create('pi-browser-ws-keepalive', { delayInMinutes: 0.4 });
}

async function isServerAlive() {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2000);
    await fetch(WS_HEALTH_URL, { signal: ctrl.signal });
    return true;
  } catch (e) {
    return false;
  }
}

async function probeAndConnectWS(resetDelay) {
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

chrome.alarms.onAlarm.addListener(async (alarm) => {
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
});

function connectWS() {
  if (ws && ws.readyState <= 1) return;
  ws = null;
  console.log('[PI-BROWSER-WS] Connecting to', WS_URL);
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.warn('[PI-BROWSER-WS] Constructor failed:', e && (e.message || String(e)));
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
    const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
    if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: 'ext_ready',
      bridge: piBridgeInfo(),
      tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
    }));
    console.log('[PI-BROWSER-WS] Sent ext_ready with', tabs.length, 'tabs');
  };
  socket.onmessage = async (event) => {
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
  socket.onerror = (e) => {
    console.debug('[PI-BROWSER-WS] Connection error; waiting for local server', {
      readyState: socket ? socket.readyState : null,
      type: e && e.type ? e.type : 'error'
    });
    if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) cleanupTransportSocket(socket, 'error');
  };
}

void probeAndConnectWS(true);
chrome.runtime.onStartup.addListener(() => { void probeAndConnectWS(true); });
installPiBrowserTabSync();
// ESM module boundary marker for TODO 189
export const __piBridgeModule_transport = { name: "transport", symbols: { ws, WS_URL, WS_HEALTH_URL, WS_RECONNECT_INITIAL_MS, WS_RECONNECT_MAX_MS, wsReconnectDelayMs, getPiBrowserTransportSocket, cleanupTransportSocket, scheduleProbe, bumpProbeBackoff, scheduleKeepalive, isServerAlive, probeAndConnectWS, connectWS } };
