import { PI_BROWSER_BRIDGE_HOST, PI_BROWSER_BRIDGE_HTTP_URL, PI_BROWSER_BRIDGE_PORT, PI_BROWSER_BRIDGE_PORT_RANGE_END, PI_BROWSER_BRIDGE_WS_URL } from "../service_worker/config";

type RuntimeMessage = {
  type?: string;
  port?: number;
  data?: unknown;
  resetDelay?: boolean;
};

type ChromeRuntimeLite = {
  sendMessage(message: unknown): Promise<unknown>;
  onMessage: { addListener(listener: (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | void): void };
};

const chromeRuntime = (globalThis as typeof globalThis & { chrome?: { runtime?: ChromeRuntimeLite } }).chrome?.runtime as ChromeRuntimeLite;

const sockets = new Map<number, WebSocket>();
let probeTimer: ReturnType<typeof setTimeout> | null = null;
let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
let wsReconnectDelayMs = 1000;
const WS_RECONNECT_INITIAL_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;

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

function post(message: RuntimeMessage): void {
  void chromeRuntime.sendMessage(message).catch((error: unknown) => console.debug("[PI-BROWSER-OFFSCREEN] message failed", error));
}

function openPorts(): number[] {
  return Array.from(sockets.entries()).filter(([, socket]) => socket.readyState === WebSocket.OPEN).map(([port]) => port);
}

function bumpProbeBackoff(): void {
  wsReconnectDelayMs = Math.min(WS_RECONNECT_MAX_MS, Math.max(WS_RECONNECT_INITIAL_MS, wsReconnectDelayMs * 2));
}

function scheduleProbe(resetDelay = false): void {
  if (resetDelay) wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
  if (probeTimer) clearTimeout(probeTimer);
  const jitter = 0.85 + Math.random() * 0.3;
  const delayMs = Math.min(WS_RECONNECT_MAX_MS, Math.max(WS_RECONNECT_INITIAL_MS, wsReconnectDelayMs)) * jitter;
  probeTimer = setTimeout(() => { void probeAndConnectWS(false); }, delayMs);
}

function scheduleKeepalive(): void {
  if (keepaliveTimer) clearTimeout(keepaliveTimer);
  keepaliveTimer = setTimeout(() => {
    const openSockets = Array.from(sockets.values()).filter((socket) => socket.readyState === WebSocket.OPEN);
    for (const socket of openSockets) {
      try { socket.send('{"type":"ping"}'); } catch (_error) { cleanupTransportSocket(socket, "keepalive-send"); }
    }
    if (openSockets.length) scheduleKeepalive();
  }, 25000);
}

async function isServerAlive(port: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    await fetch(httpUrlForPort(port), { signal: ctrl.signal });
    return true;
  } catch (_error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function cleanupTransportSocket(socket: WebSocket | null, reason = ""): boolean {
  if (!socket) return false;
  let removed = false;
  for (const [port, current] of sockets.entries()) {
    if (current !== socket) continue;
    sockets.delete(port);
    removed = true;
    post({ type: "pi-browser-offscreen-disconnected", port, data: { reason } });
  }
  if (!removed) return false;
  bumpProbeBackoff();
  scheduleProbe();
  return true;
}

function connectWS(port: number): void {
  const current = sockets.get(port);
  if (current && current.readyState <= WebSocket.OPEN) return;
  sockets.delete(port);
  const url = wsUrlForPort(port);
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
    sockets.set(port, socket);
  } catch (error) {
    console.warn("[PI-BROWSER-OFFSCREEN] Constructor failed", error);
    bumpProbeBackoff();
    scheduleProbe();
    return;
  }
  socket.onopen = () => {
    if (sockets.get(port) !== socket) return;
    wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
    post({ type: "pi-browser-offscreen-connected", port, data: { openPorts: openPorts() } });
    scheduleKeepalive();
  };
  socket.onmessage = (event: MessageEvent) => {
    if (sockets.get(port) !== socket) return;
    try {
      post({ type: "pi-browser-offscreen-ws-message", port, data: JSON.parse(String(event.data)) });
    } catch (error) {
      console.error("[PI-BROWSER-OFFSCREEN] message parse error", error);
    }
  };
  socket.onclose = () => { cleanupTransportSocket(socket, "close"); };
  socket.onerror = (event: Event) => {
    console.debug("[PI-BROWSER-OFFSCREEN] Connection error; waiting for local server", { port, readyState: socket.readyState, type: event.type || "error" });
    if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) cleanupTransportSocket(socket, "error");
  };
}

async function probeAndConnectWS(resetDelay = false): Promise<void> {
  if (resetDelay) wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
  let detected = false;
  for (const port of portRange()) {
    const current = sockets.get(port);
    if (current && current.readyState <= WebSocket.OPEN) { detected = true; continue; }
    if (current) sockets.delete(port);
    if (await isServerAlive(port)) {
      detected = true;
      connectWS(port);
    }
  }
  if (!detected) bumpProbeBackoff();
  scheduleProbe();
}

function handleRuntimeMessage(message: unknown, _sender: unknown, sendResponse: (response?: unknown) => void): boolean {
  const msg = (message && typeof message === "object" ? message : {}) as RuntimeMessage;
  if (msg.type === "pi-browser-offscreen-probe") {
    void probeAndConnectWS(msg.resetDelay === true).then(() => sendResponse({ ok: true, openPorts: openPorts() }));
    return true;
  }
  if (msg.type === "pi-browser-offscreen-send" && typeof msg.port === "number" && typeof msg.data === "string") {
    const socket = sockets.get(msg.port);
    if (socket?.readyState === WebSocket.OPEN) socket.send(msg.data);
    sendResponse({ ok: true, sent: socket?.readyState === WebSocket.OPEN });
    return false;
  }
  if (msg.type === "pi-browser-offscreen-status") {
    sendResponse({ ok: true, openPorts: openPorts(), socketCount: sockets.size });
    return false;
  }
  return false;
}

function installPiBrowserOffscreenTransport(): void {
  chromeRuntime.onMessage.addListener(handleRuntimeMessage);
  post({ type: "pi-browser-offscreen-ready", data: { openPorts: openPorts() } });
  void probeAndConnectWS(true);
}

installPiBrowserOffscreenTransport();
