// bridge_info.js - shared bridge metadata and tab helpers.

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
    workerStartedAt: PI_BROWSER_WORKER_STARTED_AT
  };
}

const CSP_BYPASS_RULE_ID = 9999;
const CSP_BYPASS_TTL_MS = 30_000;
const cspBypassTabs = new Map<number, number>();
let cspBypassUpdate: Promise<void> | null = null;

function activeCspBypassTabIds(now = Date.now()): number[] {
  for (const [tabId, expiresAt] of Array.from(cspBypassTabs.entries())) {
    if (expiresAt <= now) cspBypassTabs.delete(tabId);
  }
  return Array.from(cspBypassTabs.keys()).sort((a, b) => a - b);
}

function syncCspBypassRule() {
  const tabIds = activeCspBypassTabIds();
  const addRules = tabIds.length ? [{
    id: CSP_BYPASS_RULE_ID,
    priority: 1,
    action: { type: 'modifyHeaders', responseHeaders: [
      { header: 'content-security-policy', operation: 'remove' },
      { header: 'content-security-policy-report-only', operation: 'remove' }
    ] },
    condition: { urlFilter: '*', tabIds, resourceTypes: ['main_frame', 'sub_frame'] }
  }] : [];
  const dnr = chrome.declarativeNetRequest as typeof chrome.declarativeNetRequest & { updateSessionRules?: (rules: Record<string, unknown>) => Promise<void> };
  const updateRules = dnr.updateSessionRules ?? dnr.updateDynamicRules;
  cspBypassUpdate = updateRules.call(dnr, { removeRuleIds: [CSP_BYPASS_RULE_ID], addRules })
    .catch((error: unknown) => console.warn('[PI-BROWSER-CSP] Failed to update scoped CSP bypass rule', error))
    .finally(() => { cspBypassUpdate = null; });
  return cspBypassUpdate;
}

function installCspBypassRule() {
  cspBypassTabs.clear();
  void syncCspBypassRule();
}

function enableCspBypassForTab(tabId: unknown, ttlMs = CSP_BYPASS_TTL_MS) {
  const id = typeof tabId === 'string' ? Number(tabId) : typeof tabId === 'number' ? tabId : NaN;
  if (!Number.isInteger(id) || id <= 0) return false;
  const ttl = Math.max(1_000, Math.floor(ttlMs));
  cspBypassTabs.set(id, Date.now() + ttl);
  void syncCspBypassRule();
  setTimeout(() => { activeCspBypassTabIds(); void syncCspBypassRule(); }, ttl + 250);
  return true;
}

// Track normal scriptable tabs plus about:blank tabs created by browser_tabs before navigation.
const isScriptable = (url: unknown): boolean => {
  const text = typeof url === 'string' ? url : '';
  return !!text && (/^https?:/.test(text) || text === 'about:blank');
};
export { PI_BROWSER_WORKER_STARTED_AT, PI_BROWSER_WORKER_BOOT_ID, piBridgeInfo, installCspBypassRule, enableCspBypassForTab, isScriptable };
// ESM module boundary marker for TODO 189
export const __piBridgeModule_bridge_info = { name: "bridge_info", symbols: { PI_BROWSER_WORKER_STARTED_AT, PI_BROWSER_WORKER_BOOT_ID, piBridgeInfo, installCspBypassRule, enableCspBypassForTab, isScriptable } };
