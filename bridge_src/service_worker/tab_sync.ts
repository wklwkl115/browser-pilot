// @ts-nocheck
// tab_sync.js - tab list synchronization and tab lifecycle hooks.

async function sendTabsUpdate() {
  const ws = typeof getPiBrowserTransportSocket === 'function' ? getPiBrowserTransportSocket() : null;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url) && !/streamlit/i.test(t.title));
  ws.send(JSON.stringify({
    type: 'tabs_update',
    bridge: piBridgeInfo(),
    tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
  }));
}

function logTabSyncError(reason, error) {
  console.debug('[PI-BROWSER] tab sync error', {
    reason,
    error: error && (error.message || String(error))
  });
}

function runTabSyncTask(reason, task) {
  try {
    const result = task();
    if (result && typeof result.catch === 'function') void result.catch(e => logTabSyncError(reason, e));
  } catch (e) {
    logTabSyncError(reason, e);
  }
}

function safeProbeAndConnectWS(reason) {
  if (typeof probeAndConnectWS === 'function') runTabSyncTask(reason, () => probeAndConnectWS(false));
}

function safeSendTabsUpdate(reason) {
  runTabSyncTask(reason, sendTabsUpdate);
}

function installPiBrowserTabSync() {
  chrome.tabs.onUpdated.addListener((_, changeInfo) => {
    if (changeInfo.status === 'complete') {
      safeProbeAndConnectWS('tabs.onUpdated.probe');
      safeSendTabsUpdate('tabs.onUpdated');
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => { cleanupPiBrowserTab(tabId, 'tab_removed'); safeSendTabsUpdate('tabs.onRemoved'); });
  chrome.tabs.onCreated.addListener(() => { safeProbeAndConnectWS('tabs.onCreated.probe'); safeSendTabsUpdate('tabs.onCreated'); });
}
// ESM module boundary marker for TODO 189
export const __piBridgeModule_tab_sync = { name: "tab_sync", symbols: { sendTabsUpdate, logTabSyncError, runTabSyncTask, safeProbeAndConnectWS, safeSendTabsUpdate, installPiBrowserTabSync } };
