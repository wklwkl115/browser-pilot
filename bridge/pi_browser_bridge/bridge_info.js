// bridge_info.js - shared bridge metadata and tab helpers.

function piBridgeInfo() {
  const manifest = chrome.runtime.getManifest();
  return { id: chrome.runtime.id, name: manifest.name, version: manifest.version_name || manifest.version, manifestVersion: manifest.version, userAgent: navigator.userAgent };
}

function installCspBypassRule() {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [9999],
    addRules: [{
      id: 9999,
      priority: 1,
      action: { type: 'modifyHeaders', responseHeaders: [
        { header: 'content-security-policy', operation: 'remove' },
        { header: 'content-security-policy-report-only', operation: 'remove' }
      ] },
      condition: { urlFilter: '*', resourceTypes: ['main_frame', 'sub_frame'] }
    }]
  });
}

// Filter out chrome:// and other internal tabs that can't be scripted.
const isScriptable = url => url && /^https?:/.test(url);
