import { chromeApi as chrome } from "./runtimeEnv";
import { cleanupPiBrowserTab } from "./runtime";
import { isScriptable, piBridgeInfo } from "./bridge_info";
import type { PiBridgeWebSocketLike, PiBrowserTabSyncTransport, PiChromeTab } from "./types";

// tab_sync.js - tab list synchronization and tab lifecycle hooks.

let piBrowserTabSyncInstalled = false;
let piBrowserTabSyncTransport: PiBrowserTabSyncTransport | null = null;

function setPiBrowserTabSyncTransport(deps: PiBrowserTabSyncTransport) {
  if (!deps || typeof deps.getSocket !== 'function' || typeof deps.probe !== 'function') throw new Error('tab sync transport dependencies are invalid');
  piBrowserTabSyncTransport = { getSocket: deps.getSocket, probe: deps.probe };
}

function requirePiBrowserTabSyncTransport(): PiBrowserTabSyncTransport {
  if (!piBrowserTabSyncTransport) throw new Error('tab sync transport dependencies are not configured');
  return piBrowserTabSyncTransport;
}

async function sendTabsUpdate() {
  const ws: PiBridgeWebSocketLike | null = requirePiBrowserTabSyncTransport().getSocket();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const tabs = (await chrome.tabs.query({}) as PiChromeTab[]).filter((t: PiChromeTab) => isScriptable(t.url || '') && !/streamlit/i.test(t.title || ''));
  ws.send(JSON.stringify({
    type: 'tabs_update',
    bridge: piBridgeInfo(),
    tabs: tabs.map((t: PiChromeTab) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId, groupId: t.groupId }))
  }));
}

function piBrowserErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message || error);
  return String(error);
}

function logTabSyncError(reason: string, error: unknown) {
  console.debug('[PI-BROWSER] tab sync error', {
    reason,
    error: error ? piBrowserErrorMessage(error) : String(error)
  });
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
  piBrowserTabSyncInstalled = true;
  return true;
}
export { setPiBrowserTabSyncTransport, requirePiBrowserTabSyncTransport, sendTabsUpdate, logTabSyncError, runTabSyncTask, safeProbeAndConnectWS, safeSendTabsUpdate, installPiBrowserTabSync };
// ESM module boundary marker for TODO 189
export const __piBridgeModule_tab_sync = { name: "tab_sync", symbols: { setPiBrowserTabSyncTransport, requirePiBrowserTabSyncTransport, sendTabsUpdate, logTabSyncError, runTabSyncTask, safeProbeAndConnectWS, safeSendTabsUpdate, installPiBrowserTabSync } };
