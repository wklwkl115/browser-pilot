import { chromeApi as chrome } from "./runtimeEnv";
import { normalizePersistentBrowserPilotResponse, browserPilotPersistentCdp } from "./runtimeSupport.js";
import type { JsonRecord, BrowserPilotCdpDomainRef, BrowserPilotCdpSubscription, BrowserPilotWaitRecord } from "./types";

// wait_cdp.js - Browser Pilot wait CDP domain refcount, subscription and diagnostics helpers.
// Loaded after runtime.js and before wait.js by background.js.

const browserPilotCdpSubscriptions = new Map<string, BrowserPilotCdpSubscription>();
const browserPilotCdpTabRefs = new Map<number, Set<string>>();
const browserPilotCdpDomainRefs = new Map<string, BrowserPilotCdpDomainRef>();
const browserPilotCdpCleanupHistory: Array<JsonRecord & { t: number }> = [];
type BrowserPilotCdpSubscriptionRecord = Partial<Pick<BrowserPilotWaitRecord, "waitId" | "kind" | "cdpSubscriptions">>;
function waitCdpErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function waitCdpRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
let browserPilotCdpSubSeq = 0;
function browserPilotCdpDomainKey(tabId: unknown, domain: unknown): string { return Number(tabId) + ':' + String(domain); }
function browserPilotCdpHolderId(record: Partial<BrowserPilotWaitRecord> | null | undefined): string { return record?.key || (Number(record?.tabId) + ':' + String(record?.waitId || record?.kind || 'anonymous')); }
function rememberBrowserPilotCdpCleanup(entry: JsonRecord = {}): void {
  browserPilotCdpCleanupHistory.push({ t: Date.now(), ...(entry || {}) });
  if (browserPilotCdpCleanupHistory.length > 200) browserPilotCdpCleanupHistory.splice(0, browserPilotCdpCleanupHistory.length - 200);
}
async function sendBrowserPilotCdpDomainCommand(tabId: number, domain: string, action: string, modeHint?: string | null): Promise<string> {
  const cdp = browserPilotPersistentCdp();
  const method = String(domain) + '.' + String(action);
  if (cdp?.send && modeHint !== 'chrome.debugger') {
    const resp = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, method, {}, { name: 'wait', persistent: true }));
    if (!resp || resp.ok === false) {
      const error = waitCdpRecord(resp?.error);
      const msg = error.message || resp?.message || resp?.error || ('failed to ' + action + ' ' + domain);
      throw new Error(String(msg));
    }
    return 'persistent_cdp';
  }
  if (action === 'enable') {
    await chrome.debugger.attach({ tabId: Number(tabId) }, '1.3').catch((e: unknown) => {
      if (!/Another debugger|already attached|Debugger is already attached/i.test(waitCdpErrorMessage(e))) throw e;
    });
  }
  await chrome.debugger.sendCommand({ tabId: Number(tabId) }, method, {});
  return 'chrome.debugger';
}
async function acquireBrowserPilotCdpDomain(record: BrowserPilotWaitRecord, domain: string): Promise<string> {
  const tabId = Number(record.tabId);
  const holderId = browserPilotCdpHolderId(record);
  const key = browserPilotCdpDomainKey(tabId, domain);
  let ref = browserPilotCdpDomainRefs.get(key);
  if (ref?.holders?.has(holderId)) {
    record.cdpDomains.add(domain);
    record.cdpAttached = true;
    return ref.mode || 'refcounted';
  }
  if (ref?.disablePending) {
    if (ref.disableInFlight && ref.disablePromise) await ref.disablePromise.catch(() => {});
    ref = browserPilotCdpDomainRefs.get(key);
  }
  if (!ref) {
    ref = { key, tabId, domain, count: 0, holders: new Map(), mode: null, createdAt: Date.now(), enabledAt: 0, lastError: null, disablePending: false, disableInFlight: false, disablePromise: null, disableToken: 0 };
    browserPilotCdpDomainRefs.set(key, ref);
  }
  const first = ref.count === 0;
  try {
    if (first) {
      ref.mode = await sendBrowserPilotCdpDomainCommand(tabId, domain, 'enable', ref.mode);
      ref.enabledAt = Date.now();
      ref.lastError = null;
      ref.disablePending = false;
      ref.disableInFlight = false;
      ref.disablePromise = null;
    }
    ref.holders.set(holderId, { holderId, waitId: record.waitId || null, kind: record.kind || null, acquiredAt: Date.now() });
    ref.count = ref.holders.size;
    record.cdpDomains.add(domain);
    record.cdpAttached = true;
    return ref.mode || 'refcounted';
  } catch (e) {
    ref.lastError = waitCdpErrorMessage(e);
    if (first && ref.count === 0 && !ref.holders.size) browserPilotCdpDomainRefs.delete(key);
    throw e;
  }
}
function scheduleBrowserPilotCdpDomainDisable(ref: BrowserPilotCdpDomainRef | null | undefined, reason?: string, holderId?: string, action?: string): boolean {
  if (!ref || ref.disableInFlight) return false;
  ref.count = 0;
  ref.disablePending = true;
  ref.disableInFlight = true;
  ref.disableToken = Number(ref.disableToken || 0) + 1;
  const token = ref.disableToken;
  const mode = ref.mode;
  const tabId = Number(ref.tabId);
  const domain = ref.domain;
  const key = ref.key;
  rememberBrowserPilotCdpCleanup({ tabId, domain, reason, holderId, action: action || 'disable', mode });
  ref.disablePromise = sendBrowserPilotCdpDomainCommand(tabId, domain, 'disable', mode).then(() => {
    const current = browserPilotCdpDomainRefs.get(key);
    if (current !== ref || current.disableToken !== token) return;
    current.disableInFlight = false;
    current.disablePending = false;
    current.disablePromise = null;
    current.lastError = null;
    if (current.count === 0 && current.holders.size === 0) browserPilotCdpDomainRefs.delete(key);
  }).catch(e => {
    const current = browserPilotCdpDomainRefs.get(key);
    if (current === ref && current.disableToken === token) {
      const errorText = waitCdpErrorMessage(e);
      if (String(reason || '').toLowerCase() === 'tab_removed' || /no tab|no target|closed|detached/i.test(errorText)) {
        browserPilotCdpDomainRefs.delete(key);
      } else {
        current.disableInFlight = false;
        current.disablePending = true;
        current.disablePromise = null;
        current.lastError = errorText;
      }
    }
    rememberBrowserPilotCdpCleanup({ tabId, domain, reason, holderId, action: (action || 'disable') + '_failed', mode, error: waitCdpErrorMessage(e) });
  });
  return true;
}
function releaseBrowserPilotCdpDomains(record: BrowserPilotWaitRecord | null | undefined, domains: Iterable<string> | string[] | undefined, reason?: string) {
  const unique = Array.from(new Set(domains || []));
  if (!record || !unique.length) return { released: 0, disabled: 0 };
  const tabId = Number(record.tabId);
  const holderId = browserPilotCdpHolderId(record);
  let released = 0;
  let disabled = 0;
  for (const domain of unique.reverse()) {
    const key = browserPilotCdpDomainKey(tabId, domain);
    const ref = browserPilotCdpDomainRefs.get(key);
    if (!ref) { try { record.cdpDomains?.delete(domain); } catch (_) { /* best-effort cdp domain set cleanup */ } continue; }
    if (ref.holders.delete(holderId)) { ref.count = Math.max(0, ref.count - 1); released += 1; }
    else ref.count = Math.max(0, ref.holders.size);
    try { record.cdpDomains?.delete(domain); } catch (_) { /* best-effort cdp domain set cleanup */ }
    if (ref.count === 0 || ref.holders.size === 0) {
      ref.count = 0;
      if (scheduleBrowserPilotCdpDomainDisable(ref, reason, holderId, 'disable')) disabled += 1;
    }
  }
  return { released, disabled };
}
function forceReleaseBrowserPilotCdpDomainsForTab(tabId: unknown, reason?: string) {
  let released = 0;
  let disabled = 0;
  for (const [, ref] of Array.from(browserPilotCdpDomainRefs.entries())) {
    if (Number(ref.tabId) !== Number(tabId)) continue;
    const holders = Array.from(ref.holders.values()).map(holder => ({ holderId:holder.holderId, waitId:holder.waitId, kind:holder.kind }));
    released += ref.count || holders.length;
    ref.holders.clear();
    ref.count = 0;
    if (scheduleBrowserPilotCdpDomainDisable(ref, reason, holders.map(h => h.holderId).join(','), 'force_disable')) disabled += 1;
  }
  return { released, disabled };
}
async function enableBrowserPilotCdpDomains(record: BrowserPilotWaitRecord, domains: Iterable<string> | string[] | undefined) {
  const unique = Array.from(new Set(domains || []));
  if (!unique.length) return { mode: 'none', domains: [] };
  const acquired: string[] = [];
  let mode = 'none';
  try {
    for (const domain of unique) {
      mode = await acquireBrowserPilotCdpDomain(record, domain);
      acquired.push(domain);
    }
    return { mode, domains: unique, refcounted: true, refs: diagnoseBrowserPilotCdpDomainRefs(record.tabId) };
  } catch (e) {
    record.lastError = waitCdpErrorMessage(e);
    releaseBrowserPilotCdpDomains(record, acquired, 'enable_failed');
    throw e;
  }
}
async function attachDebuggerForWait(record: BrowserPilotWaitRecord, domains: Iterable<string> | string[] | undefined) { return await enableBrowserPilotCdpDomains(record, domains); }
function subscribeBrowserPilotCdp(tabId: number, event: string | string[], handler: (source: { tabId?: number }, method: string, params: JsonRecord) => void, record?: BrowserPilotCdpSubscriptionRecord | null): string | null {
  if (!chrome.debugger?.onEvent) return null;
  const subscriptionId = 'cdp-sub-' + (++browserPilotCdpSubSeq);
  const events = Array.isArray(event) ? event : [event];
  const wrapped = (source: { tabId?: number }, method: string, params?: JsonRecord) => {
    if (!source || Number(source.tabId) !== Number(tabId)) return;
    if (events.length && !events.includes(method) && !events.includes('*')) return;
    handler(source, method, params || {});
  };
  chrome.debugger.onEvent.addListener(wrapped);
  const rec: BrowserPilotCdpSubscription = { subscriptionId, tabId:Number(tabId), events, createdAt:Date.now(), handler: wrapped as (...args: unknown[]) => void, waitId: record?.waitId || null, kind: record?.kind || null };
  browserPilotCdpSubscriptions.set(subscriptionId, rec);
  const set = browserPilotCdpTabRefs.get(Number(tabId)) || new Set(); set.add(subscriptionId); browserPilotCdpTabRefs.set(Number(tabId), set);
  if (record?.cdpSubscriptions) record.cdpSubscriptions.push(subscriptionId);
  return subscriptionId;
}
function unsubscribeBrowserPilotCdp(subscriptionId: string): boolean {
  const rec = browserPilotCdpSubscriptions.get(subscriptionId);
  if (!rec) return false;
  try { chrome.debugger.onEvent.removeListener(rec.handler); } catch (error) { console.warn('[BROWSER-PILOT-WAIT] Failed to remove debugger event listener', subscriptionId, error); }
  browserPilotCdpSubscriptions.delete(subscriptionId);
  const set = browserPilotCdpTabRefs.get(Number(rec.tabId));
  if (set) { set.delete(subscriptionId); if (!set.size) browserPilotCdpTabRefs.delete(Number(rec.tabId)); }
  return true;
}
function cleanupBrowserPilotCdpTab(tabId: unknown, reason?: string) {
  const ids = Array.from(browserPilotCdpTabRefs.get(Number(tabId)) || []);
  for (const id of ids) unsubscribeBrowserPilotCdp(id);
  const domains = forceReleaseBrowserPilotCdpDomainsForTab(tabId, reason || 'tab_cleanup');
  const result = { tabId:Number(tabId), reason, removed: ids.length, subscriptions_removed: ids.length, domains_released: domains.released, domains_disabled: domains.disabled };
  rememberBrowserPilotCdpCleanup({ ...result, action: 'tab_cleanup' });
  return result;
}
function diagnoseBrowserPilotCdpSubscriptions(tabId?: unknown) {
  return Array.from(browserPilotCdpSubscriptions.values()).filter(s => tabId === undefined || Number(s.tabId) === Number(tabId)).map(s => ({ subscriptionId:s.subscriptionId, tabId:s.tabId, events:s.events, waitId:s.waitId, kind:s.kind, age_ms:Date.now()-s.createdAt }));
}
function diagnoseBrowserPilotCdpDomainRefs(tabId?: unknown) {
  return Array.from(browserPilotCdpDomainRefs.values()).filter(r => tabId === undefined || Number(r.tabId) === Number(tabId)).map(r => ({ key:r.key, tabId:r.tabId, domain:r.domain, count:r.count, mode:r.mode, holders:Array.from(r.holders.values()).map(holder => ({ holderId:holder.holderId, waitId:holder.waitId, kind:holder.kind, age_ms:Date.now()-holder.acquiredAt })), age_ms:Date.now()-r.createdAt, enabled_age_ms:r.enabledAt ? Date.now()-r.enabledAt : null, lastError:r.lastError || null, disablePending:!!r.disablePending }));
}
function diagnoseBrowserPilotCdpCleanupHistory(tabId?: unknown) {
  return browserPilotCdpCleanupHistory.filter(e => tabId === undefined || Number(e.tabId) === Number(tabId)).slice(-50).map(e => ({ ...e, age_ms: Date.now() - e.t }));
}
export { browserPilotCdpSubscriptions, browserPilotCdpTabRefs, browserPilotCdpDomainRefs, browserPilotCdpCleanupHistory, browserPilotCdpSubSeq, browserPilotCdpDomainKey, browserPilotCdpHolderId, rememberBrowserPilotCdpCleanup, sendBrowserPilotCdpDomainCommand, acquireBrowserPilotCdpDomain, scheduleBrowserPilotCdpDomainDisable, releaseBrowserPilotCdpDomains, forceReleaseBrowserPilotCdpDomainsForTab, enableBrowserPilotCdpDomains, attachDebuggerForWait, subscribeBrowserPilotCdp, unsubscribeBrowserPilotCdp, cleanupBrowserPilotCdpTab, diagnoseBrowserPilotCdpSubscriptions, diagnoseBrowserPilotCdpDomainRefs, diagnoseBrowserPilotCdpCleanupHistory };
// ESM module metadata
export const __browserPilotBridgeModule_wait_cdp = { name: "wait_cdp", symbols: { browserPilotCdpSubscriptions, browserPilotCdpTabRefs, browserPilotCdpDomainRefs, browserPilotCdpCleanupHistory, browserPilotCdpSubSeq, browserPilotCdpDomainKey, browserPilotCdpHolderId, rememberBrowserPilotCdpCleanup, sendBrowserPilotCdpDomainCommand, acquireBrowserPilotCdpDomain, scheduleBrowserPilotCdpDomainDisable, releaseBrowserPilotCdpDomains, forceReleaseBrowserPilotCdpDomainsForTab, enableBrowserPilotCdpDomains, attachDebuggerForWait, subscribeBrowserPilotCdp, unsubscribeBrowserPilotCdp, cleanupBrowserPilotCdpTab, diagnoseBrowserPilotCdpSubscriptions, diagnoseBrowserPilotCdpDomainRefs, diagnoseBrowserPilotCdpCleanupHistory } };
