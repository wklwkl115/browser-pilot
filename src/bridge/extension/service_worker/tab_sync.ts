import { isScriptable, browserPilotBridgeInfo } from "./bridge_info.js";
import { cleanupPersistentCdpForTab } from "./cdp.js";
import { cleanupInterceptSessionTab } from "./intercept.js";
import { cleanupNetworkRecorderTab } from "./network.js";
import { chromeApi as chrome } from "./runtimeEnv.js";
import { runtimeErrorPreview } from "./runtimeSupport.js";
import { browserPilotSessions, browserPilotTabQueues } from "./state_store.js";
import { cleanupBrowserPilotPageListenersForTab } from "./wait.js";
import { cancelWaitsForTab, cleanupTabWaits } from "./wait_coordinator.js";
import { cleanupWsSessionsForTab } from "./ws.js";
import type { BrowserPilotBridgeWebSocketLike, BrowserPilotTabSyncTransport, BrowserPilotChromeTab } from "./types.js";

// tab_sync.js - tab list synchronization and tab lifecycle hooks.

let browserPilotTabSyncInstalled = false;
let browserPilotTabSyncTransport: BrowserPilotTabSyncTransport | null = null;
const MAX_REPLACEMENT_RECORDS = 20;
const REPLACEMENT_TTL_MS = 5 * 60_000;
const replacementRing: Array<{ from: number; to: number; at: number }> = [];
let lastActivation: { tabId: number; windowId?: number; at: number } | undefined;

function setBrowserPilotTabSyncTransport(deps: BrowserPilotTabSyncTransport) {
  if (!deps || typeof deps.getSocket !== 'function' || typeof deps.probe !== 'function') throw new Error('tab sync transport dependencies are invalid');
  browserPilotTabSyncTransport = { getSocket: deps.getSocket, getSockets: deps.getSockets, probe: deps.probe };
}

function requireBrowserPilotTabSyncTransport(): BrowserPilotTabSyncTransport {
  if (!browserPilotTabSyncTransport) throw new Error('tab sync transport dependencies are not configured');
  return browserPilotTabSyncTransport;
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
  const transport = requireBrowserPilotTabSyncTransport();
  const sockets = typeof transport.getSockets === 'function' ? transport.getSockets() : [transport.getSocket()].filter((socket): socket is BrowserPilotBridgeWebSocketLike => !!socket);
  const openSockets = sockets.filter((socket) => socket.readyState === WebSocket.OPEN);
  if (!openSockets.length) return;
  pruneReplacementRing();
  const tabs = (await chrome.tabs.query({}) as BrowserPilotChromeTab[]).filter((t: BrowserPilotChromeTab) => isScriptable(t.url || '') && !/streamlit/i.test(t.title || ''));
  const payload = JSON.stringify({
    type: 'tabs_update',
    bridge: browserPilotBridgeInfo(),
    tabs: tabs.map((t: BrowserPilotChromeTab) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId, openerTabId: t.openerTabId, incognito: t.incognito === true })),
    ...(replacementRing.length ? { replaced: replacementRing.slice() } : {}),
    ...(lastActivation ? { activation: lastActivation } : {})
  });
  for (const socket of openSockets) socket.send(payload);
}

function browserPilotErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message || error);
  return String(error);
}

function isExpectedTabSyncShutdownError(message: string): boolean {
  return /browser is shutting down|extension context invalidated|context invalidated/i.test(message);
}

function logTabSyncError(reason: string, error: unknown) {
  const message = error ? browserPilotErrorMessage(error) : String(error);
  if (isExpectedTabSyncShutdownError(message)) return;
  console.debug(`[BROWSER-PILOT] tab sync error reason=${reason} error=${message}`);
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
  runTabSyncTask(reason, () => requireBrowserPilotTabSyncTransport().probe(false));
}

function safeSendTabsUpdate(reason: string) {
  runTabSyncTask(reason, sendTabsUpdate);
}

function cleanupBrowserPilotTab(tabId: number, reason?: string) {
  const key = Number(tabId);
  const cleanupReason = reason || "tab_cleanup";
  try {
    const pageCleanup = cleanupBrowserPilotPageListenersForTab(tabId, cleanupReason);
    if ((pageCleanup as Promise<unknown> | undefined)?.catch) {
      void (pageCleanup as Promise<unknown>).catch((error: unknown) => console.warn("[BROWSER-PILOT] page listener cleanup failed", key, cleanupReason, runtimeErrorPreview(error)));
    }
  } catch (error) {
    console.warn("[BROWSER-PILOT] page listener cleanup failed", key, cleanupReason, runtimeErrorPreview(error));
  }
  browserPilotSessions.delete(key);
  browserPilotTabQueues.delete(key);
  try { cleanupNetworkRecorderTab(tabId, cleanupReason); }
  catch (error) { console.warn("[BROWSER-PILOT-NET] recorder cleanup failed", key, runtimeErrorPreview(error)); }
  try { cleanupInterceptSessionTab(tabId, cleanupReason); }
  catch (error) { console.warn("[BROWSER-PILOT-INTERCEPT] session cleanup failed", key, runtimeErrorPreview(error)); }
  try { cleanupWsSessionsForTab(tabId, cleanupReason); }
  catch (error) { console.warn("[BROWSER-PILOT-WS] session cleanup failed", key, runtimeErrorPreview(error)); }
  try { cleanupPersistentCdpForTab(tabId, cleanupReason); }
  catch (error) { console.warn("[BROWSER-PILOT-CDP] persistent session cleanup failed", key, runtimeErrorPreview(error)); }
  if (cleanupReason === "tab_cleanup") cancelWaitsForTab(tabId, "tab_cleanup");
  else cleanupTabWaits(tabId, cleanupReason, { includeCdp: true, action: "tab_cleanup" });
}

function installBrowserPilotTabSync(deps: BrowserPilotTabSyncTransport | undefined = undefined) {
  if (deps) setBrowserPilotTabSyncTransport(deps);
  requireBrowserPilotTabSyncTransport();
  if (browserPilotTabSyncInstalled) return false;
  chrome.tabs.onUpdated.addListener((_: unknown, changeInfo: { status?: string }) => {
    if (changeInfo.status === 'complete') {
      safeProbeAndConnectWS('tabs.onUpdated.probe');
      safeSendTabsUpdate('tabs.onUpdated');
    }
  });
  chrome.tabs.onRemoved.addListener((tabId: number) => { cleanupBrowserPilotTab(tabId, 'tab_removed'); safeSendTabsUpdate('tabs.onRemoved'); });
  chrome.tabs.onCreated.addListener(() => { safeProbeAndConnectWS('tabs.onCreated.probe'); safeSendTabsUpdate('tabs.onCreated'); });
  chrome.tabs.onReplaced?.addListener((addedTabId: number, removedTabId: number) => {
    recordReplacement(removedTabId, addedTabId);
    safeSendTabsUpdate('tabs.onReplaced');
    cleanupBrowserPilotTab(removedTabId, 'tab_replaced');
  });
  chrome.tabs.onActivated?.addListener((activeInfo: { tabId: number; windowId: number }) => {
    recordActivation(activeInfo.tabId, activeInfo.windowId);
    safeSendTabsUpdate('tabs.onActivated');
  });
  browserPilotTabSyncInstalled = true;
  return true;
}
export { setBrowserPilotTabSyncTransport, requireBrowserPilotTabSyncTransport, sendTabsUpdate, logTabSyncError, runTabSyncTask, safeProbeAndConnectWS, safeSendTabsUpdate, cleanupBrowserPilotTab, installBrowserPilotTabSync };
// ESM module metadata
export const __browserPilotBridgeModule_tab_sync = { name: "tab_sync", symbols: { setBrowserPilotTabSyncTransport, requireBrowserPilotTabSyncTransport, sendTabsUpdate, logTabSyncError, runTabSyncTask, safeProbeAndConnectWS, safeSendTabsUpdate, cleanupBrowserPilotTab, installBrowserPilotTabSync } };
