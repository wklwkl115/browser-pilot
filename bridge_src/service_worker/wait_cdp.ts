import { chromeApi as chrome } from "./runtimeEnv";
import { normalizePersistentPiBrowserResponse, piBrowserPersistentCdp } from "./runtime";
import type { JsonRecord, PiBrowserCdpDomainRef, PiBrowserCdpSubscription, PiBrowserWaitRecord } from "./types";

// wait_cdp.js - Pi browser wait CDP domain refcount, subscription and diagnostics helpers.
// Loaded after runtime.js and before wait.js by background.js.

const piBrowserCdpSubscriptions = new Map<string, PiBrowserCdpSubscription>();
const piBrowserCdpTabRefs = new Map<number, Set<string>>();
const piBrowserCdpDomainRefs = new Map<string, PiBrowserCdpDomainRef>();
const piBrowserCdpCleanupHistory: Array<JsonRecord & { t: number }> = [];
type PiBrowserCdpSubscriptionRecord = Partial<Pick<PiBrowserWaitRecord, "waitId" | "kind" | "cdpSubscriptions">>;
function waitCdpErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function waitCdpRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
let piBrowserCdpSubSeq = 0;
function piBrowserCdpDomainKey(tabId: unknown, domain: unknown): string { return Number(tabId) + ':' + String(domain); }
function piBrowserCdpHolderId(record: Partial<PiBrowserWaitRecord> | null | undefined): string { return record?.key || (Number(record?.tabId) + ':' + String(record?.waitId || record?.kind || 'anonymous')); }
function rememberPiBrowserCdpCleanup(entry: JsonRecord = {}): void {
  piBrowserCdpCleanupHistory.push({ t: Date.now(), ...(entry || {}) });
  if (piBrowserCdpCleanupHistory.length > 200) piBrowserCdpCleanupHistory.splice(0, piBrowserCdpCleanupHistory.length - 200);
}
async function sendPiBrowserCdpDomainCommand(tabId: number, domain: string, action: string, modeHint?: string | null): Promise<string> {
  const cdp = piBrowserPersistentCdp();
  const method = String(domain) + '.' + String(action);
  if (cdp?.send && modeHint !== 'chrome.debugger') {
    const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, method, {}, { name: 'wait', persistent: true }));
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
async function acquirePiBrowserCdpDomain(record: PiBrowserWaitRecord, domain: string): Promise<string> {
  const tabId = Number(record.tabId);
  const holderId = piBrowserCdpHolderId(record);
  const key = piBrowserCdpDomainKey(tabId, domain);
  let ref = piBrowserCdpDomainRefs.get(key);
  if (ref?.holders?.has(holderId)) {
    record.cdpDomains.add(domain);
    record.cdpAttached = true;
    return ref.mode || 'refcounted';
  }
  if (ref?.disablePending) {
    if (ref.disableInFlight && ref.disablePromise) await ref.disablePromise.catch(() => {});
    ref = piBrowserCdpDomainRefs.get(key);
  }
  if (!ref) {
    ref = { key, tabId, domain, count: 0, holders: new Map(), mode: null, createdAt: Date.now(), enabledAt: 0, lastError: null, disablePending: false, disableInFlight: false, disablePromise: null, disableToken: 0 };
    piBrowserCdpDomainRefs.set(key, ref);
  }
  const first = ref.count === 0;
  try {
    if (first) {
      ref.mode = await sendPiBrowserCdpDomainCommand(tabId, domain, 'enable', ref.mode);
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
    if (first && ref.count === 0 && !ref.holders.size) piBrowserCdpDomainRefs.delete(key);
    throw e;
  }
}
function schedulePiBrowserCdpDomainDisable(ref: PiBrowserCdpDomainRef | null | undefined, reason?: string, holderId?: string, action?: string): boolean {
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
  rememberPiBrowserCdpCleanup({ tabId, domain, reason, holderId, action: action || 'disable', mode });
  ref.disablePromise = sendPiBrowserCdpDomainCommand(tabId, domain, 'disable', mode).then(() => {
    const current = piBrowserCdpDomainRefs.get(key);
    if (current !== ref || current.disableToken !== token) return;
    current.disableInFlight = false;
    current.disablePending = false;
    current.disablePromise = null;
    current.lastError = null;
    if (current.count === 0 && current.holders.size === 0) piBrowserCdpDomainRefs.delete(key);
  }).catch(e => {
    const current = piBrowserCdpDomainRefs.get(key);
    if (current === ref && current.disableToken === token) {
      const errorText = waitCdpErrorMessage(e);
      if (String(reason || '').toLowerCase() === 'tab_removed' || /no tab|no target|closed|detached/i.test(errorText)) {
        piBrowserCdpDomainRefs.delete(key);
      } else {
        current.disableInFlight = false;
        current.disablePending = true;
        current.disablePromise = null;
        current.lastError = errorText;
      }
    }
    rememberPiBrowserCdpCleanup({ tabId, domain, reason, holderId, action: (action || 'disable') + '_failed', mode, error: waitCdpErrorMessage(e) });
  });
  return true;
}
function releasePiBrowserCdpDomains(record: PiBrowserWaitRecord | null | undefined, domains: Iterable<string> | string[] | undefined, reason?: string) {
  const unique = Array.from(new Set(domains || []));
  if (!record || !unique.length) return { released: 0, disabled: 0 };
  const tabId = Number(record.tabId);
  const holderId = piBrowserCdpHolderId(record);
  let released = 0;
  let disabled = 0;
  for (const domain of unique.reverse()) {
    const key = piBrowserCdpDomainKey(tabId, domain);
    const ref = piBrowserCdpDomainRefs.get(key);
    if (!ref) { try { record.cdpDomains?.delete(domain); } catch (_) { /* best-effort cdp domain set cleanup */ } continue; }
    if (ref.holders.delete(holderId)) { ref.count = Math.max(0, ref.count - 1); released += 1; }
    else ref.count = Math.max(0, ref.holders.size);
    try { record.cdpDomains?.delete(domain); } catch (_) { /* best-effort cdp domain set cleanup */ }
    if (ref.count === 0 || ref.holders.size === 0) {
      ref.count = 0;
      if (schedulePiBrowserCdpDomainDisable(ref, reason, holderId, 'disable')) disabled += 1;
    }
  }
  return { released, disabled };
}
function forceReleasePiBrowserCdpDomainsForTab(tabId: unknown, reason?: string) {
  let released = 0;
  let disabled = 0;
  for (const [key, ref] of Array.from(piBrowserCdpDomainRefs.entries())) {
    if (Number(ref.tabId) !== Number(tabId)) continue;
    const holders = Array.from(ref.holders.values()).map(holder => ({ holderId:holder.holderId, waitId:holder.waitId, kind:holder.kind }));
    released += ref.count || holders.length;
    ref.holders.clear();
    ref.count = 0;
    if (schedulePiBrowserCdpDomainDisable(ref, reason, holders.map(h => h.holderId).join(','), 'force_disable')) disabled += 1;
  }
  return { released, disabled };
}
async function enablePiBrowserCdpDomains(record: PiBrowserWaitRecord, domains: Iterable<string> | string[] | undefined) {
  const unique = Array.from(new Set(domains || []));
  if (!unique.length) return { mode: 'none', domains: [] };
  const acquired: string[] = [];
  let mode = 'none';
  try {
    for (const domain of unique) {
      mode = await acquirePiBrowserCdpDomain(record, domain);
      acquired.push(domain);
    }
    return { mode, domains: unique, refcounted: true, refs: diagnosePiBrowserCdpDomainRefs(record.tabId) };
  } catch (e) {
    record.lastError = waitCdpErrorMessage(e);
    releasePiBrowserCdpDomains(record, acquired, 'enable_failed');
    throw e;
  }
}
async function attachDebuggerForWait(record: PiBrowserWaitRecord, domains: Iterable<string> | string[] | undefined) { return await enablePiBrowserCdpDomains(record, domains); }
function subscribePiBrowserCdp(tabId: number, event: string | string[], handler: (source: { tabId?: number }, method: string, params: JsonRecord) => void, record?: PiBrowserCdpSubscriptionRecord | null): string | null {
  if (!chrome.debugger?.onEvent) return null;
  const subscriptionId = 'cdp-sub-' + (++piBrowserCdpSubSeq);
  const events = Array.isArray(event) ? event : [event];
  const wrapped = (source: { tabId?: number }, method: string, params?: JsonRecord) => {
    if (!source || Number(source.tabId) !== Number(tabId)) return;
    if (events.length && !events.includes(method) && !events.includes('*')) return;
    handler(source, method, params || {});
  };
  chrome.debugger.onEvent.addListener(wrapped);
  const rec: PiBrowserCdpSubscription = { subscriptionId, tabId:Number(tabId), events, createdAt:Date.now(), handler: wrapped as (...args: unknown[]) => void, waitId: record?.waitId || null, kind: record?.kind || null };
  piBrowserCdpSubscriptions.set(subscriptionId, rec);
  const set = piBrowserCdpTabRefs.get(Number(tabId)) || new Set(); set.add(subscriptionId); piBrowserCdpTabRefs.set(Number(tabId), set);
  if (record?.cdpSubscriptions) record.cdpSubscriptions.push(subscriptionId);
  return subscriptionId;
}
function unsubscribePiBrowserCdp(subscriptionId: string): boolean {
  const rec = piBrowserCdpSubscriptions.get(subscriptionId);
  if (!rec) return false;
  try { chrome.debugger.onEvent.removeListener(rec.handler); } catch (error) { console.warn('[PI-BROWSER-WAIT] Failed to remove debugger event listener', subscriptionId, error); }
  piBrowserCdpSubscriptions.delete(subscriptionId);
  const set = piBrowserCdpTabRefs.get(Number(rec.tabId));
  if (set) { set.delete(subscriptionId); if (!set.size) piBrowserCdpTabRefs.delete(Number(rec.tabId)); }
  return true;
}
function cleanupPiBrowserCdpTab(tabId: unknown, reason?: string) {
  const ids = Array.from(piBrowserCdpTabRefs.get(Number(tabId)) || []);
  for (const id of ids) unsubscribePiBrowserCdp(id);
  const domains = forceReleasePiBrowserCdpDomainsForTab(tabId, reason || 'tab_cleanup');
  const result = { tabId:Number(tabId), reason, removed: ids.length, subscriptions_removed: ids.length, domains_released: domains.released, domains_disabled: domains.disabled };
  rememberPiBrowserCdpCleanup({ ...result, action: 'tab_cleanup' });
  return result;
}
function diagnosePiBrowserCdpSubscriptions(tabId?: unknown) {
  return Array.from(piBrowserCdpSubscriptions.values()).filter(s => tabId === undefined || Number(s.tabId) === Number(tabId)).map(s => ({ subscriptionId:s.subscriptionId, tabId:s.tabId, events:s.events, waitId:s.waitId, kind:s.kind, age_ms:Date.now()-s.createdAt }));
}
function diagnosePiBrowserCdpDomainRefs(tabId?: unknown) {
  return Array.from(piBrowserCdpDomainRefs.values()).filter(r => tabId === undefined || Number(r.tabId) === Number(tabId)).map(r => ({ key:r.key, tabId:r.tabId, domain:r.domain, count:r.count, mode:r.mode, holders:Array.from(r.holders.values()).map(holder => ({ holderId:holder.holderId, waitId:holder.waitId, kind:holder.kind, age_ms:Date.now()-holder.acquiredAt })), age_ms:Date.now()-r.createdAt, enabled_age_ms:r.enabledAt ? Date.now()-r.enabledAt : null, lastError:r.lastError || null, disablePending:!!r.disablePending }));
}
function diagnosePiBrowserCdpCleanupHistory(tabId?: unknown) {
  return piBrowserCdpCleanupHistory.filter(e => tabId === undefined || Number(e.tabId) === Number(tabId)).slice(-50).map(e => ({ ...e, age_ms: Date.now() - e.t }));
}
export { piBrowserCdpSubscriptions, piBrowserCdpTabRefs, piBrowserCdpDomainRefs, piBrowserCdpCleanupHistory, piBrowserCdpSubSeq, piBrowserCdpDomainKey, piBrowserCdpHolderId, rememberPiBrowserCdpCleanup, sendPiBrowserCdpDomainCommand, acquirePiBrowserCdpDomain, schedulePiBrowserCdpDomainDisable, releasePiBrowserCdpDomains, forceReleasePiBrowserCdpDomainsForTab, enablePiBrowserCdpDomains, attachDebuggerForWait, subscribePiBrowserCdp, unsubscribePiBrowserCdp, cleanupPiBrowserCdpTab, diagnosePiBrowserCdpSubscriptions, diagnosePiBrowserCdpDomainRefs, diagnosePiBrowserCdpCleanupHistory };
// ESM module metadata
export const __piBridgeModule_wait_cdp = { name: "wait_cdp", symbols: { piBrowserCdpSubscriptions, piBrowserCdpTabRefs, piBrowserCdpDomainRefs, piBrowserCdpCleanupHistory, piBrowserCdpSubSeq, piBrowserCdpDomainKey, piBrowserCdpHolderId, rememberPiBrowserCdpCleanup, sendPiBrowserCdpDomainCommand, acquirePiBrowserCdpDomain, schedulePiBrowserCdpDomainDisable, releasePiBrowserCdpDomains, forceReleasePiBrowserCdpDomainsForTab, enablePiBrowserCdpDomains, attachDebuggerForWait, subscribePiBrowserCdp, unsubscribePiBrowserCdp, cleanupPiBrowserCdpTab, diagnosePiBrowserCdpSubscriptions, diagnosePiBrowserCdpDomainRefs, diagnosePiBrowserCdpCleanupHistory } };
