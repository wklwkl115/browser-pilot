// bridge_info.js - shared bridge metadata and tab helpers.

import { PI_BROWSER_MANAGED_PROFILE } from "./config";
import { chromeApi as chrome } from "./runtimeEnv";

const PI_BROWSER_WORKER_STARTED_AT = Date.now();
const PI_BROWSER_WORKER_BOOT_ID = [
  chrome.runtime.id || 'pi-browser-bridge',
  PI_BROWSER_WORKER_STARTED_AT,
  Math.random().toString(36).slice(2, 10)
].join(':');

function piBridgeInfo() {
  const manifest = chrome.runtime.getManifest();
  return {
    id: chrome.runtime.id,
    name: manifest.name,
    version: manifest.version_name || manifest.version,
    manifestVersion: manifest.version,
    userAgent: navigator.userAgent,
    workerBootId: PI_BROWSER_WORKER_BOOT_ID,
    workerStartedAt: PI_BROWSER_WORKER_STARTED_AT,
    profileId: PI_BROWSER_MANAGED_PROFILE?.profileId,
    managedProfile: PI_BROWSER_MANAGED_PROFILE
  };
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

// Track normal scriptable tabs plus about:blank tabs created by browser_tabs before navigation.
const isScriptable = (url: unknown): boolean => {
  const text = typeof url === 'string' ? url : '';
  return !!text && (/^https?:/.test(text) || text === 'about:blank');
};
export { PI_BROWSER_WORKER_STARTED_AT, PI_BROWSER_WORKER_BOOT_ID, piBridgeInfo, installCspBypassRule, isScriptable };
// ESM module boundary marker for TODO 189
export const __piBridgeModule_bridge_info = { name: "bridge_info", symbols: { PI_BROWSER_WORKER_STARTED_AT, PI_BROWSER_WORKER_BOOT_ID, piBridgeInfo, installCspBypassRule, isScriptable } };
