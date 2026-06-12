import { chromeApi as chrome } from "./runtimeEnv";
import { cleanupPiBrowserTab } from "./runtime";
import { isScriptable, piBridgeInfo } from "./bridge_info";
import type { PiBridgeWebSocketLike, PiBrowserTabSyncTransport, PiChromeTab } from "./types";

// tab_sync.js - tab list synchronization and tab lifecycle hooks.

let piBrowserTabSyncInstalled = false;
let piBrowserTabSyncTransport: PiBrowserTabSyncTransport | null = null;
const MAX_REPLACEMENT_RECORDS = 20;
const REPLACEMENT_TTL_MS = 5 * 60_000;
const replacementRing: Array<{ from: number; to: number; at: number }> = [];
let lastActivation: { tabId: number; windowId?: number; at: number } | undefined;

function setPiBrowserTabSyncTransport(deps: PiBrowserTabSyncTransport) {
  if (!deps || typeof deps.getSocket !== 'function' || typeof deps.probe !== 'function') throw new Error('tab sync transport dependencies are invalid');
  piBrowserTabSyncTransport = { getSocket: deps.getSocket, getSockets: deps.getSockets, probe: deps.probe };
}

function requirePiBrowserTabSyncTransport(): PiBrowserTabSyncTransport {
  if (!piBrowserTabSyncTransport) throw new Error('tab sync transport dependencies are not configured');
  return piBrowserTabSyncTransport;
}

function pruneReplacementRing(now = Date.now()) {
  while (replacementRing.length && now - replacementRing[0]!.at > REPLACEMENT_TTL_MS) replacementRing.shift();
  while (replacementRing.length > MAX_REPLACEMENT_RECORDS) replacementRing.shift();
}

function recordReplacement(from: number, to: number, at = Date.now()) {
  if (!Number.isInteger(from) || from <= 0 || !Number.isInteger(to) || to <= 0 || from === to) return;
  replacementRing.push({ from, to, at });
  pruneReplacementRing(at);
}

function recordActivation(tabId: number, windowId?: number, at = Date.now()) {
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  lastActivation = { tabId, ...(Number.isInteger(windowId) ? { windowId } : {}), at };
}

async function sendTabsUpdate() {
  const transport = requirePiBrowserTabSyncTransport();
  const sockets = typeof transport.getSockets === 'function' ? transport.getSockets() : [transport.getSocket()].filter((socket): socket is PiBridgeWebSocketLike => !!socket);
  const openSockets = sockets.filter((socket) => socket.readyState === WebSocket.OPEN);
  if (!openSockets.length) return;
  pruneReplacementRing();
  const tabs = (await chrome.tabs.query({}) as PiChromeTab[]).filter((t: PiChromeTab) => isScriptable(t.url || '') && !/streamlit/i.test(t.title || ''));
  const payload = JSON.stringify({
    type: 'tabs_update',
    bridge: piBridgeInfo(),
    tabs: tabs.map((t: PiChromeTab) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId, openerTabId: t.openerTabId, incognito: t.incognito === true })),
    ...(replacementRing.length ? { replaced: replacementRing.slice() } : {}),
    ...(lastActivation ? { activation: lastActivation } : {})
  });
  for (const socket of openSockets) socket.send(payload);
}

function piBrowserErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message || error);
  return String(error);
}

function isExpectedTabSyncShutdownError(message: string): boolean {
  return /browser is shutting down|extension context invalidated|context invalidated/i.test(message);
}

function logTabSyncError(reason: string, error: unknown) {
  const message = error ? piBrowserErrorMessage(error) : String(error);
  if (isExpectedTabSyncShutdownError(message)) return;
  console.debug(`[PI-BROWSER] tab sync error reason=${reason} error=${message}`);
}

function runTabSyncTask(reason: string, task: () => unknown) {
  try {
    const result = task();
    if (result && typeof (result as Promise<unknown>).catch === 'function') void (result as Promise<unknown>).catch((e: unknown) => logTabSyncError(reason, e));
  } catch (e) {
    logTabSyncError(reason, e);
  }
}

function safeProbeAndConnectWS(reason: string) {
  runTabSyncTask(reason, () => requirePiBrowserTabSyncTransport().probe(false));
}

function safeSendTabsUpdate(reason: string) {
  runTabSyncTask(reason, sendTabsUpdate);
}

function installPiBrowserTabSync(deps: PiBrowserTabSyncTransport | undefined = undefined) {
  if (deps) setPiBrowserTabSyncTransport(deps);
  requirePiBrowserTabSyncTransport();
  if (piBrowserTabSyncInstalled) return false;
  chrome.tabs.onUpdated.addListener((_: unknown, changeInfo: { status?: string }) => {
    if (changeInfo.status === 'complete') {
      safeProbeAndConnectWS('tabs.onUpdated.probe');
      safeSendTabsUpdate('tabs.onUpdated');
    }
  });
  chrome.tabs.onRemoved.addListener((tabId: number) => { cleanupPiBrowserTab(tabId, 'tab_removed'); safeSendTabsUpdate('tabs.onRemoved'); });
  chrome.tabs.onCreated.addListener(() => { safeProbeAndConnectWS('tabs.onCreated.probe'); safeSendTabsUpdate('tabs.onCreated'); });
  chrome.tabs.onReplaced?.addListener((addedTabId: number, removedTabId: number) => {
    recordReplacement(removedTabId, addedTabId);
    safeSendTabsUpdate('tabs.onReplaced');
    cleanupPiBrowserTab(removedTabId, 'tab_replaced');
  });
  chrome.tabs.onActivated?.addListener((activeInfo: { tabId: number; windowId: number }) => {
    recordActivation(activeInfo.tabId, activeInfo.windowId);
    safeSendTabsUpdate('tabs.onActivated');
  });
  piBrowserTabSyncInstalled = true;
  return true;
}
export { setPiBrowserTabSyncTransport, requirePiBrowserTabSyncTransport, sendTabsUpdate, logTabSyncError, runTabSyncTask, safeProbeAndConnectWS, safeSendTabsUpdate, installPiBrowserTabSync };
// ESM module metadata
export const __piBridgeModule_tab_sync = { name: "tab_sync", symbols: { setPiBrowserTabSyncTransport, requirePiBrowserTabSyncTransport, sendTabsUpdate, logTabSyncError, runTabSyncTask, safeProbeAndConnectWS, safeSendTabsUpdate, installPiBrowserTabSync } };
