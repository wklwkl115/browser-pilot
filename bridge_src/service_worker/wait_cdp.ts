import { chromeApi as chrome } from "./runtimeEnv";
import { normalizePersistentPiBrowserResponse, piBrowserPersistentCdp } from "./runtime";

// wait_cdp.js - Pi browser wait CDP domain refcount, subscription and diagnostics helpers.
// Loaded after runtime.js and before wait.js by background.js.

/** @type {Map<string, any>} */
const piBrowserCdpSubscriptions = new Map();
/** @type {Map<number, Set<string>>} */
const piBrowserCdpTabRefs = new Map();
/** @type {Map<string, any>} */
const piBrowserCdpDomainRefs = new Map();
const piBrowserCdpCleanupHistory = [];
let piBrowserCdpSubSeq = 0;
function piBrowserCdpDomainKey(tabId, domain) { return Number(tabId) + ':' + String(domain); }
function piBrowserCdpHolderId(record) { return record?.key || (Number(record?.tabId) + ':' + String(record?.waitId || record?.kind || 'anonymous')); }
function rememberPiBrowserCdpCleanup(entry) {
  piBrowserCdpCleanupHistory.push({ t: Date.now(), ...(entry || {}) });
  if (piBrowserCdpCleanupHistory.length > 200) piBrowserCdpCleanupHistory.splice(0, piBrowserCdpCleanupHistory.length - 200);
}
async function sendPiBrowserCdpDomainCommand(tabId, domain, action, modeHint) {
  const cdp = piBrowserPersistentCdp();
  const method = String(domain) + '.' + String(action);
  if (cdp?.send && modeHint !== 'chrome.debugger') {
    const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, method, {}, { name: 'wait', persistent: true }));
    if (!resp || resp.ok === false) {
      const msg = resp?.error?.message || resp?.message || resp?.error || ('failed to ' + action + ' ' + domain);
      throw new Error(String(msg));
    }
    return 'persistent_cdp';
  }
  if (action === 'enable') {
    await chrome.debugger.attach({ tabId: Number(tabId) }, '1.3').catch(e => {
      if (!/Another debugger|already attached|Debugger is already attached/i.test(e.message || String(e))) throw e;
    });
  }
  await chrome.debugger.sendCommand({ tabId: Number(tabId) }, method, {});
  return 'chrome.debugger';
}
async function acquirePiBrowserCdpDomain(record, domain) {
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
    ref = { key, tabId, domain, count: 0, holders: /** @type {Map<string, any>} */ (new Map()), mode: null, createdAt: Date.now(), enabledAt: 0, lastError: null, disablePending: false, disableInFlight: false, disablePromise: null, disableToken: 0 };
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
    ref.lastError = e.message || String(e);
    if (first && ref.count === 0 && !ref.holders.size) piBrowserCdpDomainRefs.delete(key);
    throw e;
  }
}
function schedulePiBrowserCdpDomainDisable(ref, reason, holderId, action) {
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
      const errorText = e.message || String(e);
      if (String(reason || '').toLowerCase() === 'tab_removed' || /no tab|no target|closed|detached/i.test(errorText)) {
        piBrowserCdpDomainRefs.delete(key);
      } else {
        current.disableInFlight = false;
        current.disablePending = true;
        current.disablePromise = null;
        current.lastError = errorText;
      }
    }
    rememberPiBrowserCdpCleanup({ tabId, domain, reason, holderId, action: (action || 'disable') + '_failed', mode, error: e.message || String(e) });
  });
  return true;
}
function releasePiBrowserCdpDomains(record, domains, reason) {
  const unique = Array.from(new Set(domains || []));
  if (!record || !unique.length) return { released: 0, disabled: 0 };
  const tabId = Number(record.tabId);
  const holderId = piBrowserCdpHolderId(record);
  let released = 0;
  let disabled = 0;
  for (const domain of unique.reverse()) {
    const key = piBrowserCdpDomainKey(tabId, domain);
    const ref = piBrowserCdpDomainRefs.get(key);
    if (!ref) { try { record.cdpDomains?.delete(domain); } catch (_) {} continue; }
    if (ref.holders.delete(holderId)) { ref.count = Math.max(0, ref.count - 1); released += 1; }
    else ref.count = Math.max(0, ref.holders.size);
    try { record.cdpDomains?.delete(domain); } catch (_) {}
    if (ref.count === 0 || ref.holders.size === 0) {
      ref.count = 0;
      if (schedulePiBrowserCdpDomainDisable(ref, reason, holderId, 'disable')) disabled += 1;
    }
  }
  return { released, disabled };
}
function forceReleasePiBrowserCdpDomainsForTab(tabId, reason) {
  let released = 0;
  let disabled = 0;
  for (const [key, ref] of Array.from(piBrowserCdpDomainRefs.entries())) {
    if (Number(ref.tabId) !== Number(tabId)) continue;
    const holders = Array.from(ref.holders.values()).map(h => { const holder = h as any; return { holderId:holder.holderId, waitId:holder.waitId, kind:holder.kind }; });
    released += ref.count || holders.length;
    ref.holders.clear();
    ref.count = 0;
    if (schedulePiBrowserCdpDomainDisable(ref, reason, holders.map(h => h.holderId).join(','), 'force_disable')) disabled += 1;
  }
  return { released, disabled };
}
async function enablePiBrowserCdpDomains(record, domains) {
  const unique = Array.from(new Set(domains || []));
  if (!unique.length) return { mode: 'none', domains: [] };
  const acquired = [];
  let mode = 'none';
  try {
    for (const domain of unique) {
      mode = await acquirePiBrowserCdpDomain(record, domain);
      acquired.push(domain);
    }
    return { mode, domains: unique, refcounted: true, refs: diagnosePiBrowserCdpDomainRefs(record.tabId) };
  } catch (e) {
    record.lastError = e.message || String(e);
    releasePiBrowserCdpDomains(record, acquired, 'enable_failed');
    throw e;
  }
}
async function attachDebuggerForWait(record, domains) { return await enablePiBrowserCdpDomains(record, domains); }
function subscribePiBrowserCdp(tabId, event, handler, record) {
  if (!chrome.debugger?.onEvent) return null;
  const subscriptionId = 'cdp-sub-' + (++piBrowserCdpSubSeq);
  const events = Array.isArray(event) ? event : [event];
  const wrapped = (source, method, params) => {
    if (!source || Number(source.tabId) !== Number(tabId)) return;
    if (events.length && !events.includes(method) && !events.includes('*')) return;
    handler(source, method, params || {});
  };
  chrome.debugger.onEvent.addListener(wrapped);
  const rec = { subscriptionId, tabId:Number(tabId), events, createdAt:Date.now(), handler: wrapped, waitId: record?.waitId || null, kind: record?.kind || null };
  piBrowserCdpSubscriptions.set(subscriptionId, rec);
  const set = piBrowserCdpTabRefs.get(Number(tabId)) || new Set(); set.add(subscriptionId); piBrowserCdpTabRefs.set(Number(tabId), set);
  if (record) record.cdpSubscriptions.push(subscriptionId);
  return subscriptionId;
}
function unsubscribePiBrowserCdp(subscriptionId) {
  const rec = piBrowserCdpSubscriptions.get(subscriptionId);
  if (!rec) return false;
  try { chrome.debugger.onEvent.removeListener(rec.handler); } catch (_) {}
  piBrowserCdpSubscriptions.delete(subscriptionId);
  const set = piBrowserCdpTabRefs.get(Number(rec.tabId));
  if (set) { set.delete(subscriptionId); if (!set.size) piBrowserCdpTabRefs.delete(Number(rec.tabId)); }
  return true;
}
function cleanupPiBrowserCdpTab(tabId, reason) {
  const ids = Array.from(piBrowserCdpTabRefs.get(Number(tabId)) || []);
  for (const id of ids) unsubscribePiBrowserCdp(id);
  const domains = forceReleasePiBrowserCdpDomainsForTab(tabId, reason || 'tab_cleanup');
  const result = { tabId:Number(tabId), reason, removed: ids.length, subscriptions_removed: ids.length, domains_released: domains.released, domains_disabled: domains.disabled };
  rememberPiBrowserCdpCleanup({ ...result, action: 'tab_cleanup' });
  return result;
}
function diagnosePiBrowserCdpSubscriptions(tabId) {
  return Array.from(piBrowserCdpSubscriptions.values()).filter(s => tabId === undefined || Number(s.tabId) === Number(tabId)).map(s => ({ subscriptionId:s.subscriptionId, tabId:s.tabId, events:s.events, waitId:s.waitId, kind:s.kind, age_ms:Date.now()-s.createdAt }));
}
function diagnosePiBrowserCdpDomainRefs(tabId) {
  return Array.from(piBrowserCdpDomainRefs.values()).filter(r => tabId === undefined || Number(r.tabId) === Number(tabId)).map(r => ({ key:r.key, tabId:r.tabId, domain:r.domain, count:r.count, mode:r.mode, holders:Array.from(r.holders.values()).map(h => { const holder = h as any; return { holderId:holder.holderId, waitId:holder.waitId, kind:holder.kind, age_ms:Date.now()-holder.acquiredAt }; }), age_ms:Date.now()-r.createdAt, enabled_age_ms:r.enabledAt ? Date.now()-r.enabledAt : null, lastError:r.lastError || null, disablePending:!!r.disablePending }));
}
function diagnosePiBrowserCdpCleanupHistory(tabId) {
  return piBrowserCdpCleanupHistory.filter(e => tabId === undefined || Number(e.tabId) === Number(tabId)).slice(-50).map(e => ({ ...e, age_ms: Date.now() - e.t }));
}
export { piBrowserCdpSubscriptions, piBrowserCdpTabRefs, piBrowserCdpDomainRefs, piBrowserCdpCleanupHistory, piBrowserCdpSubSeq, piBrowserCdpDomainKey, piBrowserCdpHolderId, rememberPiBrowserCdpCleanup, sendPiBrowserCdpDomainCommand, acquirePiBrowserCdpDomain, schedulePiBrowserCdpDomainDisable, releasePiBrowserCdpDomains, forceReleasePiBrowserCdpDomainsForTab, enablePiBrowserCdpDomains, attachDebuggerForWait, subscribePiBrowserCdp, unsubscribePiBrowserCdp, cleanupPiBrowserCdpTab, diagnosePiBrowserCdpSubscriptions, diagnosePiBrowserCdpDomainRefs, diagnosePiBrowserCdpCleanupHistory };
// ESM module boundary marker for TODO 189
export const __piBridgeModule_wait_cdp = { name: "wait_cdp", symbols: { piBrowserCdpSubscriptions, piBrowserCdpTabRefs, piBrowserCdpDomainRefs, piBrowserCdpCleanupHistory, piBrowserCdpSubSeq, piBrowserCdpDomainKey, piBrowserCdpHolderId, rememberPiBrowserCdpCleanup, sendPiBrowserCdpDomainCommand, acquirePiBrowserCdpDomain, schedulePiBrowserCdpDomainDisable, releasePiBrowserCdpDomains, forceReleasePiBrowserCdpDomainsForTab, enablePiBrowserCdpDomains, attachDebuggerForWait, subscribePiBrowserCdp, unsubscribePiBrowserCdp, cleanupPiBrowserCdpTab, diagnosePiBrowserCdpSubscriptions, diagnosePiBrowserCdpDomainRefs, diagnosePiBrowserCdpCleanupHistory } };
