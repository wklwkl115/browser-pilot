// bridge_info.js - shared bridge metadata and tab helpers.

import { BROWSER_PILOT_WORKER_BOOT_ID, BROWSER_PILOT_WORKER_STARTED_AT, chromeApi as chrome } from "./runtimeEnv";
import { BRIDGE_BUILD_ID, BRIDGE_BUILD_PIPELINE_VERSION } from "../shared/buildInfo";

let lostHookSessionsGetter: (() => Array<Record<string, unknown>>) | null = null;
function registerLostHookSessionsGetter(getter: () => Array<Record<string, unknown>>): void {
  lostHookSessionsGetter = getter;
}

let offscreenUnreachableGetter: (() => boolean) | null = null;
function registerOffscreenUnreachableGetter(getter: () => boolean): void {
  offscreenUnreachableGetter = getter;
}

const CSP_BYPASS_ALARM = "browser-pilot-csp-bypass-prune";

function browserPilotBridgeInfo() {
  const manifest = chrome.runtime.getManifest();
  const recovery = (globalThis as typeof globalThis & {
    __BROWSER_PILOT_RUNTIME_RECOVERY_SUMMARY__?: {
      ranAt?: number;
      totals?: {
        recovered?: number;
        recoveredWithHistoryLoss?: number;
        lost?: number;
        byKind?: Record<string, { recovered: number; lost: number }>;
      };
    } | null;
  }).__BROWSER_PILOT_RUNTIME_RECOVERY_SUMMARY__;
  return {
    id: chrome.runtime.id,
    name: manifest.name,
    version: manifest.version_name || manifest.version,
    manifestVersion: manifest.version,
    build: {
      buildId: BRIDGE_BUILD_ID,
      pipelineVersion: BRIDGE_BUILD_PIPELINE_VERSION,
    },
    userAgent: navigator.userAgent,
    workerBootId: BROWSER_PILOT_WORKER_BOOT_ID,
    workerStartedAt: BROWSER_PILOT_WORKER_STARTED_AT,
    runtimeRecovery: recovery ? {
      ranAt: recovery.ranAt,
      recovered: recovery.totals?.recovered || 0,
      recoveredWithHistoryLoss: recovery.totals?.recoveredWithHistoryLoss || 0,
      lost: recovery.totals?.lost || 0,
      byKind: recovery.totals?.byKind || {},
    } : null,
    lostHookSessions: (() => { const lost = lostHookSessionsGetter?.() || []; return lost.length ? lost : undefined; })(),
    offscreenUnreachable: offscreenUnreachableGetter?.() === true ? true : undefined,
    ...(cspBypassRuleUnavailable ? { cspBypassRuleUnavailable } : {}),
  };
}

const CSP_BYPASS_RULE_ID = 9999;
const CSP_BYPASS_TTL_MS = 30_000;
const cspBypassTabs = new Map<number, number>();
let cspBypassUpdate: Promise<void> | null = null;
let cspBypassAlarmInstalled = false;
let cspBypassRuleUnavailable = false;

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
    .catch((error: unknown) => console.warn('[BROWSER-PILOT-CSP] Failed to update scoped CSP bypass rule', error))
    .finally(() => {
      cspBypassUpdate = null;
      scheduleCspBypassAlarm();
    });
  return cspBypassUpdate;
}

function clearCspBypassAlarm() {
  try {
    void chrome.alarms.clear?.(CSP_BYPASS_ALARM);
  } catch (_error) {
    /* best-effort alarm clear */
  }
}

function scheduleCspBypassAlarm(now = Date.now()) {
  const expirations = Array.from(cspBypassTabs.values()).filter((value) => Number.isFinite(value));
  if (!expirations.length) {
    clearCspBypassAlarm();
    return;
  }
  const nextExpiry = Math.min(...expirations);
  chrome.alarms.create(CSP_BYPASS_ALARM, { when: Math.max(now + 250, nextExpiry + 250) });
}

function ensureCspBypassAlarmListener() {
  if (cspBypassAlarmInstalled) return;
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== CSP_BYPASS_ALARM) return;
    activeCspBypassTabIds();
    void syncCspBypassRule();
    scheduleCspBypassAlarm();
  });
  cspBypassAlarmInstalled = true;
}

function installCspBypassRule() {
  cspBypassTabs.clear();
  ensureCspBypassAlarmListener();
  void syncCspBypassRule();
}

async function validateCspBypassRule(): Promise<boolean> {
  const dnr = chrome.declarativeNetRequest as typeof chrome.declarativeNetRequest & {
    getSessionRules?(): Promise<Array<Record<string, unknown>>>;
    getDynamicRules?(): Promise<Array<Record<string, unknown>>>;
  };
  try {
    const getRules = dnr.getSessionRules ?? dnr.getDynamicRules;
    if (!getRules) {
      // API unavailable — assume rule is present (best-effort)
      cspBypassRuleUnavailable = false;
      return true;
    }
    const rules = await getRules.call(dnr);
    const found = Array.isArray(rules) && rules.some((r) => (r as { id?: unknown }).id === CSP_BYPASS_RULE_ID);
    if (found) {
      cspBypassRuleUnavailable = false;
      return true;
    }
    // Rule missing — attempt reinstallation
    await syncCspBypassRule();
    cspBypassRuleUnavailable = false;
    return true;
  } catch (_error) {
    cspBypassRuleUnavailable = true;
    return false;
  }
}

function enableCspBypassForTab(tabId: unknown, ttlMs = CSP_BYPASS_TTL_MS) {
  const id = typeof tabId === 'string' ? Number(tabId) : typeof tabId === 'number' ? tabId : NaN;
  if (!Number.isInteger(id) || id <= 0) return false;
  const ttl = Math.max(1_000, Math.floor(ttlMs));
  cspBypassTabs.set(id, Date.now() + ttl);
  ensureCspBypassAlarmListener();
  void syncCspBypassRule();
  scheduleCspBypassAlarm();
  return true;
}

// Track normal scriptable tabs plus about:blank tabs created by browser_tabs before navigation.
const isScriptable = (url: unknown): boolean => {
  const text = typeof url === 'string' ? url : '';
  return !!text && (/^https?:/.test(text) || text === 'about:blank');
};
export { BROWSER_PILOT_WORKER_STARTED_AT, BROWSER_PILOT_WORKER_BOOT_ID, browserPilotBridgeInfo, installCspBypassRule, enableCspBypassForTab, validateCspBypassRule, isScriptable, registerLostHookSessionsGetter, registerOffscreenUnreachableGetter };
// ESM module metadata
export const __browserPilotBridgeModule_bridge_info = { name: "bridge_info", symbols: { BROWSER_PILOT_WORKER_STARTED_AT, BROWSER_PILOT_WORKER_BOOT_ID, browserPilotBridgeInfo, installCspBypassRule, enableCspBypassForTab, validateCspBypassRule, isScriptable, registerLostHookSessionsGetter, registerOffscreenUnreachableGetter } };
