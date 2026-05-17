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

function installPiBrowserTabSync() {
  chrome.tabs.onUpdated.addListener((_, changeInfo) => {
    if (changeInfo.status === 'complete') {
      void probeAndConnectWS(false);
      sendTabsUpdate();
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => { cleanupPiBrowserTab(tabId, 'tab_removed'); sendTabsUpdate(); });
  chrome.tabs.onCreated.addListener(() => { void probeAndConnectWS(false); sendTabsUpdate(); });
}
