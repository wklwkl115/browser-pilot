// wait.js - Pi browser native wait, event listener and CDP wait coordination commands.

class WaitCoordinator {
  constructor() { this.activeWaits = new Map(); this.eventSubscriptions = new Map(); this.epoch = 0; }
  makeWaitId(tabId, kind) { return makeWaitId(tabId, kind); }
  waitKey(tabId, waitId) { return waitKey(tabId, waitId); }
  register(record) {
    const key = record.key || waitKey(record.tabId, record.wait_id || record.waitId);
    record.key = key;
    this.activeWaits.set(key, record);
    return record;
  }
  get(key) { return this.activeWaits.get(key); }
  set(key, record) { this.activeWaits.set(key, record); return this; }
  has(key) { return this.activeWaits.has(key); }
  delete(key) { return this.activeWaits.delete(key); }
  values() { return this.activeWaits.values(); }
  entries() { return this.activeWaits.entries(); }
  keys() { return this.activeWaits.keys(); }
  get size() { return this.activeWaits.size; }
  [Symbol.iterator]() { return this.activeWaits[Symbol.iterator](); }
  registerEventSubscription(listenerId, sub) { this.eventSubscriptions.set(listenerId, sub); return sub; }
  deleteEventSubscription(listenerId) { return this.eventSubscriptions.delete(listenerId); }
  eventSubscriptionValues() { return this.eventSubscriptions.values(); }
  cleanupEventSubscriptionsForTab(tabId) {
    let n = 0;
    for (const [listenerId, sub] of Array.from(this.eventSubscriptions.entries())) {
      if (Number(sub.tabId) === Number(tabId)) { this.eventSubscriptions.delete(listenerId); n++; }
    }
    return n;
  }
  cleanupWait(record, reason) { return cleanupWait(record, reason); }
  cleanupWaitsForFrame(tabId, frameId, reason) { return cleanupWaitsForFrame(tabId, frameId, reason); }
  cleanupWaitsForUninstall(tabId) { return cleanupWaitsForUninstall(tabId); }
  diagnostics(tabId) { return { activeWaits: Array.from(this.activeWaits.values()).filter(w => !tabId || Number(w.tabId) === Number(tabId)).map(w => ({ wait_id: w.wait_id || w.waitId, request_id: w.request_id || w.requestId, kind: w.kind, epoch: w.epoch, diagnostics: w.diagnostics || {} })), eventSubscriptions: this.eventSubscriptions.size, epoch: this.epoch }; }
}
function cleanupWait(record, reason) { return cleanupPiBrowserWait(record, reason); }
function cleanupWaitsForFrame(tabId, frameId, reason) { let n = 0; for (const r of Array.from(piBrowserWaits.values())) if (Number(r.tabId) === Number(tabId) && String(r.frameId || '') === String(frameId || '')) { cleanupPiBrowserWait(r, reason || 'FRAME_DETACHED'); n++; } return n; }
function cleanupWaitsForUninstall(tabId) { cleanupEventSubscriptionsForTab(tabId); return cancelWaitsForTab(tabId, 'uninstall'); }

const piBrowserWaits = new WaitCoordinator();
// Legacy Map-compatible wait registry contract: const piBrowserWaits = new Map
const PI_BROWSER_ORPHAN_WAIT_MAX_AGE_MS = 300000;
function cleanupPiBrowserOrphanWaits(reason, maxAgeMs) {
  const now = Date.now();
  const limit = Number.isFinite(Number(maxAgeMs)) ? Number(maxAgeMs) : PI_BROWSER_ORPHAN_WAIT_MAX_AGE_MS;
  let cleaned = 0;
  for (const record of Array.from(piBrowserWaits.values())) {
    const age = now - Number(record.createdAt || now);
    if (!record || record.status === 'cleaned') continue;
    if (limit >= 0 && age < limit) continue;
    try { record.abortController?.abort(reason || 'orphan_cleanup'); } catch (_) {}
    try { clearWait(record, reason || 'orphan_cleanup'); cleaned += 1; } catch (_) {}
  }
  if (cleaned) rememberPiBrowserCdpCleanup({ reason: reason || 'orphan_cleanup', orphan_waits: cleaned });
  return cleaned;
}
const piBrowserCdpSubscriptions = new Map();
const piBrowserCdpTabRefs = new Map();
const piBrowserCdpDomainRefs = new Map();
const piBrowserCdpCleanupHistory = [];
try {
  if (typeof self !== 'undefined' && self.addEventListener && !self.__piBrowserUnhandledRejectionCleanupInstalled) {
    self.__piBrowserUnhandledRejectionCleanupInstalled = true;
    self.addEventListener('unhandledrejection', () => { try { cleanupPiBrowserOrphanWaits('unhandledRejection', 0); } catch (_) {} });
  }
} catch (_) {}
let piBrowserWaitSeq = 0;
let piBrowserCdpSubSeq = 0;
const PI_BROWSER_DEFAULT_WAIT_TIMEOUT_MS = 30000;
const PI_BROWSER_SELECTOR_STABLE_SAMPLES = 2;
function normalizePiBrowserTimeoutMs(msg, fallback) {
  const hasExplicit = msg && (msg.timeoutMs !== undefined || msg.timeout_ms !== undefined || msg.timeout !== undefined);
  if (hasExplicit && Number(msg.timeoutMs ?? msg.timeout_ms ?? msg.timeout) === 0) return 0;
  const raw = msg?.timeoutMs ?? msg?.timeout_ms ?? msg?.timeout ?? fallback ?? PI_BROWSER_DEFAULT_WAIT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback === 0 ? 0 : (fallback || PI_BROWSER_DEFAULT_WAIT_TIMEOUT_MS);
  if (n === 0) return 0;
  return Math.max(50, Math.min(300000, Math.floor(n)));
}
function makeWaitId(tabId, kind) { return 'wait_' + Number(tabId) + '_' + String(kind || 'generic') + '_' + Date.now() + '_' + (++piBrowserWaitSeq); }
function waitKey(tabId, waitId) { return Number(tabId) + ':' + String(waitId); }
function isAbortError(e) { return !!e && (e.name === 'AbortError' || /aborted|cancelled/i.test(e.message || String(e))); }
function waitAbortMessage(record) { return 'piBrowser wait ' + record.waitId + ' cancelled'; }
function normalizeWaitState(value, fallback) {
  const s = String(value || fallback || '').toLowerCase().replace(/_/g, '');
  if (s === 'domcontentloaded' || s === 'dominteractive') return 'domcontentloaded';
  if (s === 'load' || s === 'loaded') return 'load';
  if (s === 'complete' || s === 'networkalmostidle') return 'complete';
  if (s === 'networkidle') return 'networkidle';
  return s || 'complete';
}
function registerWait(tabId, kind, criteria) {
  const waitId = (criteria && (criteria.waitId || criteria.wait_id)) || makeWaitId(tabId, kind);
  const requestId = criteria && (criteria.requestId || criteria.request_id);
  const abortController = criteria?.abortController || new AbortController();
  const record = { waitId: String(waitId), wait_id: String(waitId), requestId: requestId ? String(requestId) : undefined, request_id: requestId ? String(requestId) : undefined, tabId: Number(tabId), kind, criteria: criteria || {}, createdAt: Date.now(), status: 'pending', listeners: [], timers: [], cdpAttached: false, cdpDomains: new Set(), cdpSubscriptions: [], cdpEvents: [], diagnostics: [], lastEventAt: 0, lastError: null, abortController };
  record.key = waitKey(tabId, record.waitId);
  // lifecycle identity: key: waitKey(tabId, record.waitId)
  piBrowserWaits.register(record);
  const onAbort = () => { record.status = 'cancelled'; };
  try { abortController.signal.addEventListener('abort', onAbort, { once: true }); record.listeners.push({ remove: () => abortController.signal.removeEventListener('abort', onAbort) }); } catch (_) {}
  return record;
}
function recordWaitEvent(record, event) {
  record.lastEventAt = Date.now();
  record.cdpEvents.push({ t: record.lastEventAt, ...(event || {}) });
  if (record.cdpEvents.length > 200) record.cdpEvents.splice(0, record.cdpEvents.length - 200);
}
function shouldAbortWaitCleanupReason(reason) {
  // Completing a wait is cleanup, not cancellation.  Aborting the wait's own
  // controller while finishPiBrowserWait() is building an OK/TIMEOUT/failed result
  // synchronously fires abort listeners and can race the Promise into returning
  // CANCELLED instead of the terminal result that already happened.
  const r = String(reason || 'cleaned').toLowerCase();
  return !['completed', 'timeout', 'failed', 'cleaned'].includes(r);
}
function clearWait(record, reason) {
  if (!record || record.status === 'cleaned') return;
  if (shouldAbortWaitCleanupReason(reason)) { try { record.abortController?.abort(reason || 'cleaned'); } catch (_) {} }
  for (const t of record.timers.splice(0)) { try { clearTimeout(t); } catch (_) {} }
  for (const item of record.listeners.splice(0)) { try { item.remove(); } catch (_) {} }
  for (const sid of record.cdpSubscriptions.splice(0)) { try { unsubscribePiBrowserCdp(sid); } catch (_) {} }
  releasePiBrowserCdpDomains(record, Array.from(record.cdpDomains || []), reason || 'cleaned');
  if (record.cdpAttached) record.cdpAttached = false;
  record.status = reason || record.status || 'cleaned';
  piBrowserWaits.delete(record.key);
}
function cleanupPiBrowserWait(record, reason) { return clearWait(record, reason); }
function isWaitRecordForTab(record, tabId) { return !!record && Number(record.tabId) === Number(tabId); }
function cleanupTabWaits(tabId, reason, options) {
  const opts = options || {};
  const cleanupReason = reason || 'tab_cleanup';
  const records = Array.from(piBrowserWaits.values()).filter(r => isWaitRecordForTab(r, tabId));
  let cleaned = 0;
  let aborted = 0;
  let orphaned = 0;
  for (const r of records) {
    const wasMissingKey = !r.key || piBrowserWaits.get(r.key) !== r;
    try { r.abortController?.abort(cleanupReason); aborted += 1; } catch (_) {}
    try { clearWait(r, cleanupReason); cleaned += 1; } catch (_) {}
    if (wasMissingKey) orphaned += 1;
  }
  // Defensive second pass: clear any wait inserted or left behind while tab cleanup was running.
  for (const [key, r] of Array.from(piBrowserWaits.entries())) {
    if (!isWaitRecordForTab(r, tabId)) continue;
    orphaned += 1;
    try { r.abortController?.abort(cleanupReason); aborted += 1; } catch (_) {}
    try { clearWait(r, cleanupReason); cleaned += 1; } catch (_) { try { piBrowserWaits.delete(key); cleaned += 1; } catch (__) {} }
  }
  if (opts.includeCdp !== false) cleanupPiBrowserCdpTab(tabId, cleanupReason);
  cleanupEventSubscriptionsForTab(tabId);
  if (cleaned || orphaned || opts.remember !== false) rememberPiBrowserCdpCleanup({ tabId:Number(tabId), reason: cleanupReason, action: opts.action || 'cleanup_tab_waits', waits_cleaned: cleaned, waits_aborted: aborted, orphan_waits: orphaned, remaining_waits: Array.from(piBrowserWaits.values()).filter(r => isWaitRecordForTab(r, tabId)).length });
  return { tabId:Number(tabId), reason:cleanupReason, cleaned, aborted, orphaned };
}
function cancelWaitsForTab(tabId, reason) {
  return cleanupTabWaits(tabId, reason || 'cancelled', { includeCdp: true, action: 'cancel_waits_for_tab' }).cleaned;
}
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
  if (!ref) {
    ref = { key, tabId, domain, count: 0, holders: new Map(), mode: null, createdAt: Date.now(), enabledAt: 0, lastError: null, disablePending: false };
    piBrowserCdpDomainRefs.set(key, ref);
  }
  const first = ref.count === 0;
  try {
    if (first) {
      ref.mode = await sendPiBrowserCdpDomainCommand(tabId, domain, 'enable', ref.mode);
      ref.enabledAt = Date.now();
      ref.lastError = null;
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
      ref.disablePending = true;
      const mode = ref.mode;
      piBrowserCdpDomainRefs.delete(key);
      disabled += 1;
      rememberPiBrowserCdpCleanup({ tabId, domain, reason, holderId, action: 'disable', mode });
      void sendPiBrowserCdpDomainCommand(tabId, domain, 'disable', mode).catch(e => rememberPiBrowserCdpCleanup({ tabId, domain, reason, holderId, action: 'disable_failed', mode, error: e.message || String(e) }));
    }
  }
  return { released, disabled };
}
function forceReleasePiBrowserCdpDomainsForTab(tabId, reason) {
  let released = 0;
  let disabled = 0;
  for (const [key, ref] of Array.from(piBrowserCdpDomainRefs.entries())) {
    if (Number(ref.tabId) !== Number(tabId)) continue;
    const holders = Array.from(ref.holders.values()).map(h => ({ holderId:h.holderId, waitId:h.waitId, kind:h.kind }));
    piBrowserCdpDomainRefs.delete(key);
    released += ref.count || holders.length;
    disabled += 1;
    rememberPiBrowserCdpCleanup({ tabId:Number(tabId), domain:ref.domain, reason, action:'force_disable', holders, mode:ref.mode });
    void sendPiBrowserCdpDomainCommand(Number(tabId), ref.domain, 'disable', ref.mode).catch(e => rememberPiBrowserCdpCleanup({ tabId:Number(tabId), domain:ref.domain, reason, action:'force_disable_failed', mode:ref.mode, error:e.message || String(e) }));
  }
  return { released, disabled };
}
function waitWithTimeout(record, promise, timeoutMs, label) {
  if (timeoutMs === 0) return promise;
  let timeoutHandle;
  const timeout = new Promise((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error((label || record.kind) + ' timed out')), timeoutMs); });
  record.timers.push(timeoutHandle);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutHandle));
}
function finishPiBrowserWait(record, ok, data, errorCode, message, details) {
  const elapsed_ms = Date.now() - record.createdAt;
  const base = { waitId: record.waitId, nativeWaitId: record.waitId, kind: record.kind, tabId: record.tabId, elapsed_ms, criteria: record.criteria };
  clearWait(record, ok ? 'completed' : (errorCode === PI_BROWSER_ERROR_CODES.TIMEOUT ? 'timeout' : (errorCode === 'CANCELLED' ? 'cancelled' : 'failed')));
  if (ok) return { ok: true, data: { ...base, ...(data || {}) } };
  return piBrowserError(errorCode || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, message || 'wait failed', { ...base, ...(details || {}) });
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
  return Array.from(piBrowserCdpDomainRefs.values()).filter(r => tabId === undefined || Number(r.tabId) === Number(tabId)).map(r => ({ key:r.key, tabId:r.tabId, domain:r.domain, count:r.count, mode:r.mode, holders:Array.from(r.holders.values()).map(h => ({ holderId:h.holderId, waitId:h.waitId, kind:h.kind, age_ms:Date.now()-h.acquiredAt })), age_ms:Date.now()-r.createdAt, enabled_age_ms:r.enabledAt ? Date.now()-r.enabledAt : null, lastError:r.lastError || null, disablePending:!!r.disablePending }));
}
function diagnosePiBrowserCdpCleanupHistory(tabId) {
  return piBrowserCdpCleanupHistory.filter(e => tabId === undefined || Number(e.tabId) === Number(tabId)).slice(-50).map(e => ({ ...e, age_ms: Date.now() - e.t }));
}
function rejectIfAborted(record) {
  if (record.abortController?.signal?.aborted || record.status === 'cancelled') throw new DOMException(waitAbortMessage(record), 'AbortError');
}
async function navigatePiBrowser(tabId, msg) {
  const url = msg.url;
  if (!url) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'wait.navigate requires url', {});
  cleanupTabWaits(tabId, 'navigate', { includeCdp: false, action: 'navigate_cancel_waits' });
  const cdp = piBrowserPersistentCdp();
  if (cdp?.send) {
    const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Page.navigate', { url }, { persistent: true, name: msg.cdpSessionName || 'navigate' }));
    if (!resp || resp.ok === false) return resp;
    return { ok: true, data: resp.data?.result || resp.result || resp.data };
  }
  if (chrome.tabs?.update) return { ok: true, data: await chrome.tabs.update(tabId, { url }) };
  await chrome.debugger.attach({ tabId }, '1.3');
  try { const result = await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url }); await chrome.debugger.detach({ tabId }); return { ok: true, data: result }; }
  catch (e) { try { await chrome.debugger.detach({ tabId }); } catch (_) {} throw e; }
}

async function navigateAndWait(tabId, msg) {
  if (!msg.url) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'wait.navigateAndWait requires url', {});
  const waitUntil = normalizeWaitState(msg.waitUntil || msg.wait_until || msg.state || 'load');
  const timeoutMs = normalizePiBrowserTimeoutMs(msg);
  const navigation = await navigatePiBrowser(tabId, msg);
  if (!navigation.ok) return navigation;
  let waited;
  if (waitUntil === 'networkidle') waited = await waitForNetworkIdle(tabId, { ...msg, timeoutMs });
  else if (waitUntil === 'selector') waited = await waitForSelector(tabId, { ...msg, timeoutMs });
  else waited = await waitForLoadState(tabId, { ...msg, state: waitUntil === 'load' ? 'complete' : waitUntil, timeoutMs });
  if (!waited.ok) return waited;
  return { ok: true, data: { navigation: navigation.data, wait: waited.data, url: msg.url, waitUntil } };
}
async function waitForNavigation(tabId, msg) {
  const timeoutMs = normalizePiBrowserTimeoutMs(msg);
  const targetUrl = msg.targetUrl || msg.url || msg.target_url || null;
  const urlContains = msg.urlContains || msg.url_contains || '';
  const sameDocument = msg.sameDocument === true || msg.same_document === true;
  const requestId = msg.requestId || msg.request_id || null;
  const waitUntil = normalizeWaitState(msg.waitUntil || msg.wait_until || msg.state || 'load');
  const wait_id = msg.waitId || msg.wait_id || makeWaitId(tabId, 'navigation');
  const diagnostics = { targetUrl, urlContains, sameDocument, waitUntil, request_id: requestId, epoch: Date.now(), sources: ['chrome.webNavigation.onBeforeNavigate','chrome.webNavigation.onCommitted','chrome.webNavigation.onCompleted','chrome.webNavigation.onErrorOccurred','chrome.webNavigation.onHistoryStateUpdated','chrome.webNavigation.onReferenceFragmentUpdated','chrome.tabs.onUpdated','Page.frameNavigated','Page.navigatedWithinDocument','Page.lifecycleEvent','Page.loadEventFired','Page.domContentEventFired','Page.frameStoppedLoading','same-document','hash','redirect'] };
  const record = registerWait(tabId, 'navigation', { waitId: wait_id, wait_id, requestId, request_id: requestId, targetUrl, urlContains, sameDocument, waitUntil, timeout_ms: timeoutMs, diagnostics, epoch: diagnostics.epoch, abortController: new AbortController(), cleanup: () => {} });
  // chrome.webNavigation.onBeforeNavigate / onCommitted / onCompleted / onErrorOccurred are the MV3 navigation backbone.
  // Persistent CDP Page.frameNavigated/Page.lifecycleEvent and tabs.onUpdated cover debugger-enabled and fallback paths.
  if (timeoutMs === 0) { cleanupWait(record, 'immediate'); return { ok: true, data: { wait_id, request_id: requestId, targetUrl, urlContains, sameDocument, waitUntil, diagnostics } }; }
  const urlMatches = (url) => {
    const value = String(url || '');
    if (!value) return !targetUrl && !urlContains;
    if (urlContains && value.includes(String(urlContains))) return true;
    if (!targetUrl) return !urlContains;
    const target = String(targetUrl);
    return value === target || value.startsWith(target + '#') || value.startsWith(target + '?');
  };
  const isMainWebNavigation = (details) => Number(details?.tabId) === Number(tabId) && Number(details?.frameId || 0) === 0;
  const cdp = piBrowserPersistentCdp();
  if (cdp?.send) {
    try {
      const probe = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true }, { persistent: true, name: 'wait_navigation_probe', timeoutMs: Math.min(timeoutMs, 1000) }));
      const currentUrl = probe?.data?.result?.result?.value || probe?.result?.result?.value || null;
      if (currentUrl) record.diagnostics.push({ source:'Runtime.evaluate', currentUrl });
    } catch (_) {}
  }
  return await new Promise(resolve => {
    let completed = false;
    let lastUrl = null;
    let mainFrameId = null;
    const terminalData = (source, extra) => ({ wait_id, request_id: requestId, targetUrl, urlContains, sameDocument, waitUntil, source, url: extra?.url || lastUrl || null, diagnostics, events: record.cdpEvents.slice(-50), ...(extra || {}) });
    const finish = (ok, source, extra, code, message) => {
      if (completed) return;
      completed = true;
      if (ok) resolve(finishPiBrowserWait(record, true, terminalData(source, extra)));
      else resolve(finishPiBrowserWait(record, false, null, code || PI_BROWSER_ERROR_CODES.NAVIGATION_TIMEOUT, message || 'waitForNavigation timed out', terminalData(source, extra)));
    };
    const completeIfReady = (source, url, stage, extra) => {
      if (url) lastUrl = url;
      if (!urlMatches(lastUrl)) return false;
      if (stage === 'error') { finish(false, source, { ...(extra || {}), url:lastUrl, stage }, PI_BROWSER_ERROR_CODES.NAVIGATION_TIMEOUT, 'waitForNavigation failed'); return true; }
      if (waitUntil === 'commit' || waitUntil === 'committed') { finish(true, source, { ...(extra || {}), url:lastUrl, stage }); return true; }
      if (waitUntil === 'domcontentloaded' && (stage === 'domcontentloaded' || stage === 'load' || stage === 'complete')) { finish(true, source, { ...(extra || {}), url:lastUrl, stage }); return true; }
      if ((waitUntil === 'load' || waitUntil === 'complete') && (stage === 'load' || stage === 'complete')) { finish(true, source, { ...(extra || {}), url:lastUrl, stage }); return true; }
      return false;
    };
    const timeoutHandle = setTimeout(() => finish(false, 'timeout', { error_code: 'NAVIGATION_TIMEOUT' }, PI_BROWSER_ERROR_CODES.NAVIGATION_TIMEOUT, 'waitForNavigation timed out'), Math.max(1, timeoutMs));
    record.timers.push(timeoutHandle);
    const checkCurrent = async (source) => {
      if (completed) return;
      const tab = await chrome.tabs.get(tabId).catch(e => { record.lastError = e.message || String(e); return null; });
      const url = tab?.url || lastUrl;
      if (url) lastUrl = url;
      recordWaitEvent(record, { method:'wait.navigation.currentUrl', source, url, tabStatus:tab?.status });
      if (!urlMatches(url)) return;
      if (waitUntil === 'commit' || waitUntil === 'committed') return finish(true, source || 'currentUrl', { url, stage:'commit', tabStatus:tab?.status });
      const metrics = await queryLoadMetrics(tabId).catch(() => null);
      if (waitUntil === 'domcontentloaded' && (metrics?.readyState === 'interactive' || metrics?.readyState === 'complete' || tab?.status === 'complete')) return finish(true, source || 'currentUrl', { url, stage:'domcontentloaded', tabStatus:tab?.status, readyState:metrics?.readyState });
      if ((waitUntil === 'load' || waitUntil === 'complete') && (metrics?.readyState === 'complete' || tab?.status === 'complete')) return finish(true, source || 'currentUrl', { url, stage:'complete', tabStatus:tab?.status, readyState:metrics?.readyState });
    };
    const pollMs = Math.max(100, Math.min(500, Number(msg.pollMs || msg.poll_ms || 200)));
    const pollHandle = setInterval(() => { void checkCurrent('poll'); }, pollMs);
    record.timers.push(pollHandle);
    void checkCurrent('initial');
    const failIfAbort = () => { if (record.abortController?.signal?.aborted) finish(false, 'abort', {}, PI_BROWSER_ERROR_CODES.CANCELLED, 'waitForNavigation cancelled'); };
    try { record.abortController.signal.addEventListener('abort', failIfAbort, { once:true }); record.listeners.push({ remove: () => record.abortController.signal.removeEventListener('abort', failIfAbort) }); } catch (_) {}
    const onTabsUpdated = (changedTabId, changeInfo, updatedTab) => {
      if (Number(changedTabId) !== Number(tabId)) return;
      const url = changeInfo?.url || updatedTab?.url || lastUrl;
      recordWaitEvent(record, { method:'chrome.tabs.onUpdated', changeInfo, url });
      if (changeInfo?.url) completeIfReady('chrome.tabs.onUpdated', url, 'commit', { changeInfo });
      if (changeInfo?.status === 'complete' || updatedTab?.status === 'complete') completeIfReady('chrome.tabs.onUpdated', url, 'complete', { changeInfo, title: updatedTab?.title });
    };
    chrome.tabs.onUpdated.addListener(onTabsUpdated);
    record.listeners.push({ remove: () => chrome.tabs.onUpdated.removeListener(onTabsUpdated) });
    if (chrome.webNavigation) {
      const onBeforeNavigate = (details) => { if (!isMainWebNavigation(details)) return; recordWaitEvent(record, { method:'chrome.webNavigation.onBeforeNavigate', url:details.url, frameId:details.frameId }); };
      const onCommitted = (details) => { if (!isMainWebNavigation(details)) return; recordWaitEvent(record, { method:'chrome.webNavigation.onCommitted', url:details.url, transitionType:details.transitionType }); completeIfReady('chrome.webNavigation.onCommitted', details.url, 'commit', { transitionType:details.transitionType, transitionQualifiers:details.transitionQualifiers }); };
      const onCompleted = (details) => { if (!isMainWebNavigation(details)) return; recordWaitEvent(record, { method:'chrome.webNavigation.onCompleted', url:details.url }); completeIfReady('chrome.webNavigation.onCompleted', details.url, 'complete', {}); };
      const onErrorOccurred = (details) => { if (!isMainWebNavigation(details)) return; recordWaitEvent(record, { method:'chrome.webNavigation.onErrorOccurred', url:details.url, error:details.error }); if (urlMatches(details.url)) completeIfReady('chrome.webNavigation.onErrorOccurred', details.url, 'error', { error:details.error }); };
      const onSameDocument = (details) => { if (!isMainWebNavigation(details)) return; recordWaitEvent(record, { method:'chrome.webNavigation.sameDocument', url:details.url }); if (sameDocument && urlMatches(details.url)) finish(true, 'chrome.webNavigation.sameDocument', { url:details.url, sameDocument:true, transitionType:details.transitionType }); };
      chrome.webNavigation.onBeforeNavigate?.addListener(onBeforeNavigate);
      chrome.webNavigation.onCommitted?.addListener(onCommitted);
      chrome.webNavigation.onCompleted?.addListener(onCompleted);
      chrome.webNavigation.onErrorOccurred?.addListener(onErrorOccurred);
      chrome.webNavigation.onHistoryStateUpdated?.addListener(onSameDocument);
      chrome.webNavigation.onReferenceFragmentUpdated?.addListener(onSameDocument);
      record.listeners.push({ remove: () => {
        try { chrome.webNavigation.onBeforeNavigate?.removeListener(onBeforeNavigate); } catch (_) {}
        try { chrome.webNavigation.onCommitted?.removeListener(onCommitted); } catch (_) {}
        try { chrome.webNavigation.onCompleted?.removeListener(onCompleted); } catch (_) {}
        try { chrome.webNavigation.onErrorOccurred?.removeListener(onErrorOccurred); } catch (_) {}
        try { chrome.webNavigation.onHistoryStateUpdated?.removeListener(onSameDocument); } catch (_) {}
        try { chrome.webNavigation.onReferenceFragmentUpdated?.removeListener(onSameDocument); } catch (_) {}
      } });
    } else record.diagnostics.push({ warning:'chrome.webNavigation unavailable; using tabs/CDP listeners only' });
    enablePiBrowserCdpDomains(record, ['Page']).then(() => {
      const sub = subscribePiBrowserCdp(tabId, ['Page.frameNavigated','Page.navigatedWithinDocument','Page.lifecycleEvent','Page.domContentEventFired','Page.loadEventFired','Page.frameStoppedLoading'], (_source, method, params) => {
        const frame = params?.frame || {};
        const frameId = params?.frameId || frame.id || null;
        const isMainFrame = method === 'Page.frameNavigated' ? !frame.parentId : (!mainFrameId || !frameId || String(frameId) === String(mainFrameId));
        if (!isMainFrame) return;
        if (method === 'Page.frameNavigated') { mainFrameId = frame.id || mainFrameId; lastUrl = frame.url || lastUrl; recordWaitEvent(record, { method, frameId: mainFrameId, url:lastUrl }); completeIfReady('Page.frameNavigated', lastUrl, 'commit', { frameId:mainFrameId }); }
        else if (method === 'Page.navigatedWithinDocument') { lastUrl = params?.url || lastUrl; recordWaitEvent(record, { method, frameId, url:lastUrl }); if (sameDocument && urlMatches(lastUrl)) finish(true, 'Page.navigatedWithinDocument', { url:lastUrl, frameId, sameDocument:true }); }
        else if (method === 'Page.lifecycleEvent') { recordWaitEvent(record, { method, frameId, name:params?.name }); if (params?.name === 'DOMContentLoaded') completeIfReady('Page.lifecycleEvent', lastUrl, 'domcontentloaded', { frameId, name:params.name }); if (params?.name === 'load') completeIfReady('Page.lifecycleEvent', lastUrl, 'load', { frameId, name:params.name }); }
        else if (method === 'Page.domContentEventFired') { recordWaitEvent(record, { method, frameId }); completeIfReady(method, lastUrl, 'domcontentloaded', { frameId }); }
        else if (method === 'Page.loadEventFired' || method === 'Page.frameStoppedLoading') { recordWaitEvent(record, { method, frameId }); completeIfReady(method, lastUrl, 'load', { frameId }); }
      }, record);
      record.diagnostics.push({ cdp_subscription: sub });
      chrome.debugger.sendCommand({ tabId }, 'Page.setLifecycleEventsEnabled', { enabled: true }).catch(e => { record.lastError = e.message || String(e); });
    }).catch(e => { record.lastError = e.message || String(e); record.diagnostics.push({ cdp_error: record.lastError }); });
  });
}

function loadStateSatisfied(state, tab, metrics) {
  const rs = metrics?.readyState || '';
  if (state === 'domcontentloaded') return rs === 'interactive' || rs === 'complete' || metrics?.domContentLoaded === true;
  if (state === 'load' || state === 'complete') return tab?.status === 'complete' || rs === 'complete' || metrics?.load === true;
  return false;
}
async function queryLoadMetrics(tabId) {
  const expr = `(() => ({readyState:document.readyState, url:location.href, title:document.title, domContentLoaded:document.readyState==='interactive'||document.readyState==='complete', load:document.readyState==='complete'}))()`;
  const res = await piBrowserEval(tabId, expr, true).catch(e => ({ ok:false, error:e.message || String(e) }));
  return res && res.ok ? (res.data || res.result || null) : null;
}
async function waitForLoadState(tabId, msg) {
  const targetState = normalizeWaitState(msg.state || msg.loadState || msg.load_state || 'complete'); // Page.lifecycleEvent document.readyState timeoutMs === 0
  if (!['domcontentloaded','load','complete'].includes(targetState)) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'wait.loadState unsupported state', { state: targetState });
  const timeoutMs = normalizePiBrowserTimeoutMs(msg);
  const record = registerWait(tabId, 'load_state', { state: targetState, timeout_ms: timeoutMs, waitId: msg.waitId, wait_id: msg.wait_id, abortController: msg.abortController });
  const tab = await chrome.tabs.get(tabId).catch(e => { record.lastError = e.message || String(e); return null; });
  const metrics = await queryLoadMetrics(tabId).catch(() => null);
  if (loadStateSatisfied(targetState, tab, metrics)) return finishPiBrowserWait(record, true, { state: targetState, url: metrics?.url || tab?.url, title: metrics?.title || tab?.title, immediate: true, readyState: metrics?.readyState });
  if (timeoutMs === 0) return finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.TIMEOUT, 'wait.loadState immediate check failed', { timeout_ms:0, targetState, readyState:metrics?.readyState, tabStatus:tab?.status });
  return await new Promise(resolve => {
    const complete = (res) => resolve(res);
    const failIfAbort = () => { if (record.abortController?.signal?.aborted) complete(finishPiBrowserWait(record, false, null, 'CANCELLED', waitAbortMessage(record), { targetState })); };
    try { record.abortController.signal.addEventListener('abort', failIfAbort, { once:true }); record.listeners.push({ remove: () => record.abortController.signal.removeEventListener('abort', failIfAbort) }); } catch (_) {}
    const timeoutHandle = setTimeout(() => complete(finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.TIMEOUT, 'wait.loadState timed out', { timeout_ms: timeoutMs, targetState, last_error: record.lastError, events: record.cdpEvents.slice(-50) })), timeoutMs);
    record.timers.push(timeoutHandle);
    enablePiBrowserCdpDomains(record, ['Page']).then(() => {
      const sub = subscribePiBrowserCdp(tabId, ['Page.lifecycleEvent','Page.domContentEventFired','Page.loadEventFired','Page.frameStoppedLoading'], async (source, method, params) => {
        recordWaitEvent(record, { method, name: params.name, frameId: params.frameId });
        if ((targetState === 'domcontentloaded' && (method === 'Page.domContentEventFired' || params.name === 'DOMContentLoaded')) || ((targetState === 'load' || targetState === 'complete') && (method === 'Page.loadEventFired' || params.name === 'load' || method === 'Page.frameStoppedLoading'))) {
          complete(finishPiBrowserWait(record, true, { state: targetState, method, params, cdp: true }));
        }
      }, record);
      record.diagnostics.push({ cdp_subscription: sub });
      chrome.debugger.sendCommand({ tabId }, 'Page.setLifecycleEventsEnabled', { enabled: true }).catch(e => { record.lastError = e.message || String(e); });
    }).catch(e => { record.lastError = e.message || String(e); record.diagnostics.push({ cdp_error: record.lastError }); });
    const onUpdated = (changedTabId, changeInfo, updatedTab) => {
      if (Number(changedTabId) !== Number(tabId)) return;
      recordWaitEvent(record, { method:'chrome.tabs.onUpdated', changeInfo });
      if ((targetState === 'complete' || targetState === 'load') && (changeInfo.status === 'complete' || updatedTab?.status === 'complete')) complete(finishPiBrowserWait(record, true, { state: targetState, changeInfo, url: updatedTab?.url, title: updatedTab?.title, fallback: 'tabs.onUpdated' }));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    record.listeners.push({ remove: () => chrome.tabs.onUpdated.removeListener(onUpdated) });
  });
}
// CDP contract literal: 'Network.enable'
function compileNetworkIdleFilter(msg) {
  const ignoreUrl = (Array.isArray(msg.ignoreUrls) ? msg.ignoreUrls : Array.isArray(msg.ignore_urls) ? msg.ignore_urls : []).map(x => String(x));
  const includeUrl = (Array.isArray(msg.includeUrls) ? msg.includeUrls : Array.isArray(msg.include_urls) ? msg.include_urls : []).map(x => String(x));
  const resourceTypes = new Set((Array.isArray(msg.resourceTypes) ? msg.resourceTypes : Array.isArray(msg.resource_types) ? msg.resource_types : []).map(x => String(x).toLowerCase()));
  const ignoreResourceTypes = new Set((Array.isArray(msg.ignoreResourceTypes) ? msg.ignoreResourceTypes : Array.isArray(msg.ignore_resource_types) ? msg.ignore_resource_types : ['eventsource','websocket']).map(x => String(x).toLowerCase()));
  const ignoreSchemes = new Set((Array.isArray(msg.ignoreSchemes) ? msg.ignoreSchemes : Array.isArray(msg.ignore_schemes) ? msg.ignore_schemes : ['data','blob']).map(x => String(x).toLowerCase()));
  const ignoreMethods = new Set((Array.isArray(msg.ignoreMethods) ? msg.ignoreMethods : Array.isArray(msg.ignore_methods) ? msg.ignore_methods : []).map(x => String(x).toUpperCase()));
  const includePreflight = msg.includePreflight === true || msg.include_preflight === true;
  const includeBeacon = msg.includeBeacon === true || msg.include_beacon === true;
  const ignoreLongPollingMs = Math.max(0, Number(msg.ignoreLongPollingMs || msg.ignore_long_polling_ms || 30000));
  const matchAny = (url, list) => list.some(p => { try { return new RegExp(p).test(url); } catch (_) { return url.includes(p); } });
  return function shouldTrack(req) {
    const url = req.url || '';
    const type = String(req.type || '').toLowerCase();
    const method = String(req.method || 'GET').toUpperCase();
    if (includeUrl.length && !matchAny(url, includeUrl)) return { track:false, reason:'not_included' };
    if (ignoreUrl.length && matchAny(url, ignoreUrl)) return { track:false, reason:'ignored_url' };
    const scheme = (url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/) || [,''])[1].toLowerCase();
    if (scheme && ignoreSchemes.has(scheme)) return { track:false, reason:'ignored_scheme' };
    if (resourceTypes.size && !resourceTypes.has(type)) return { track:false, reason:'resource_type_not_included' };
    if (ignoreResourceTypes.has(type)) return { track:false, reason:'ignored_resource_type' };
    if (!includePreflight && (type === 'preflight' || method === 'OPTIONS')) return { track:false, reason:'preflight' };
    if (!includeBeacon && (type === 'ping' || req.initiatorType === 'beacon')) return { track:false, reason:'beacon' };
    if (ignoreMethods.has(method)) return { track:false, reason:'ignored_method' };
    return { track:true, reason:'tracked', ignoreLongPollingMs };
  };
}
async function waitForNetworkIdle(tabId, msg) {
  const timeoutMs = normalizePiBrowserTimeoutMs(msg);
  const idleMs = Math.max(100, Math.min(Math.max(timeoutMs, 100), Number(msg.idleMs || msg.idle_ms || 500))); // idleMs Network.requestWillBeSent Network.requestServedFromCache Network.responseReceived Network.loadingFinished Network.loadingFailed redirectResponse preflight serviceWorker beacon WebSocket EventSource long_polling NETWORK_IDLE_TIMEOUT
  const maxInflight = Math.max(0, Number(msg.maxInflight ?? msg.max_inflight ?? 0)); // maxInflight
  const record = registerWait(tabId, 'network_idle', { idle_ms: idleMs, max_inflight: maxInflight, timeout_ms: timeoutMs, filters: msg.filters || null, waitId: msg.waitId, wait_id: msg.wait_id, abortController: msg.abortController });
  const shouldTrack = compileNetworkIdleFilter(msg || {});
  const inflight = new Map();
  const ignored = [];
  let idleTimer = null;
  const maybeExpireLongPolling = () => {
    const now = Date.now();
    for (const [id, item] of Array.from(inflight.entries())) {
      if (item.ignoreLongPollingMs && now - item.startedAt >= item.ignoreLongPollingMs) { inflight.delete(id); ignored.push({ requestId:id, reason:'long_polling', url:item.url, age_ms:now-item.startedAt }); }
    }
  };
  if (timeoutMs === 0) return finishPiBrowserWait(record, true, { state:'network_idle', idle_ms:0, inflight:0, immediate:true });
  await attachDebuggerForWait(record, ['Network']).catch(e => { record.lastError = e.message || String(e); });
  return await new Promise(resolve => {
    const complete = (res) => { try { clearTimeout(idleTimer); } catch (_) {} resolve(res); };
    const failIfAbort = () => { if (record.abortController?.signal?.aborted) complete(finishPiBrowserWait(record, false, null, 'CANCELLED', waitAbortMessage(record), { inflight:Array.from(inflight.values()) })); };
    try { record.abortController.signal.addEventListener('abort', failIfAbort, { once:true }); record.listeners.push({ remove: () => record.abortController.signal.removeEventListener('abort', failIfAbort) }); } catch (_) {}
    const armIdle = () => {
      maybeExpireLongPolling();
      try { clearTimeout(idleTimer); } catch (_) {}
      if (inflight.size <= maxInflight) idleTimer = setTimeout(() => complete(finishPiBrowserWait(record, true, { state: 'network_idle', idle_ms: idleMs, inflight: inflight.size, ignored: ignored.slice(-100), events: record.cdpEvents.slice(-50) })), idleMs);
    };
    const timeoutHandle = setTimeout(() => complete(finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.TIMEOUT, 'wait.networkIdle timed out', { timeout_ms: timeoutMs, idle_ms: idleMs, inflight: Array.from(inflight.values()), ignored: ignored.slice(-100), events: record.cdpEvents.slice(-50), last_error: record.lastError })), timeoutMs);
    record.timers.push(timeoutHandle);
    const onEvent = (source, method, params) => {
      if (!source || Number(source.tabId) !== Number(tabId)) return;
      if (method === 'Network.requestWillBeSent') {
        const req = { requestId: params?.requestId || makeWaitId(tabId, 'request'), url: params?.request?.url || '', type: params?.type || params?.resourceType || '', method: params?.request?.method || 'GET', initiatorType: params?.initiator?.type || '', redirectResponse: params?.redirectResponse || null };
        const decision = shouldTrack(req);
        recordWaitEvent(record, { method, requestId:req.requestId, url:req.url, type:req.type, decision:decision.reason });
        if (params?.redirectResponse && inflight.has(req.requestId)) inflight.delete(req.requestId);
        if (decision.track) inflight.set(req.requestId, { ...req, startedAt:Date.now(), ignoreLongPollingMs:decision.ignoreLongPollingMs }); else ignored.push({ requestId:req.requestId, url:req.url, reason:decision.reason });
      } else if (method === 'Network.requestServedFromCache') {
        recordWaitEvent(record, { method, requestId:params?.requestId });
        inflight.delete(params?.requestId);
      } else if (method === 'Network.responseReceived') {
        const item = inflight.get(params?.requestId);
        if (item) { item.status = params?.response?.status; item.mimeType = params?.response?.mimeType; item.fromServiceWorker = !!params?.response?.fromServiceWorker; item.fromDiskCache = !!params?.response?.fromDiskCache; }
        recordWaitEvent(record, { method, requestId:params?.requestId, status:params?.response?.status, fromServiceWorker:!!params?.response?.fromServiceWorker });
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        inflight.delete(params?.requestId);
        recordWaitEvent(record, { method, requestId: params?.requestId, errorText: params?.errorText, canceled: params?.canceled });
      } else if (method === 'Network.webSocketCreated' || method === 'Network.eventSourceMessageReceived') {
        recordWaitEvent(record, { method, requestId:params?.requestId, url:params?.url });
      }
      armIdle();
    };
    // contract literals: chrome.debugger.onEvent.addListener(onEvent) / chrome.debugger.onEvent.removeListener(onEvent)
    subscribePiBrowserCdp(tabId, ['Network.requestWillBeSent','Network.responseReceived','Network.requestServedFromCache','Network.loadingFinished','Network.loadingFailed','Network.webSocketCreated','Network.eventSourceMessageReceived'], onEvent, record);
    armIdle();
  });
}

// ============================================================
// N1: Edge F12 Network-equivalent recorder (CDP Network/Page)
// ============================================================
const PI_BROWSER_SELECTOR_PROBE_SOURCE = String.raw`(() => {
  const cfg = __PI_BROWSER_SELECTOR_PROBE_CFG__;
  const selector = String(cfg.selector || '');
  const state = String(cfg.state || 'attached');
  const stableMs = Math.max(0, Number(cfg.stableMs || 0));
  const maxStableWaitMs = Math.max(stableMs, Number(cfg.maxStableWaitMs || 10000));
  const mutationEpoch = Number(cfg.mutationEpoch || 0);
  const NOISE_SELECTORS = ['read-frog','.read-frog-translated-content-wrapper','.read-frog-translated-block-content','.read-frog-translated-inline-content','[class*="read-frog-translated"]','#goog-gt-tt','#google_translate_element','.goog-te-banner-frame','.goog-te-balloon-frame','.goog-te-menu-frame','.goog-tooltip','.goog-text-highlight','.skiptranslate','[class^="VIpgJd-"]','[class*=" VIpgJd-"]','#immersive-translate-popup','.immersive-translate-target-wrapper','.immersive-translate-target-translation','[class*="immersive-translate"]','#mate-translate-tooltip','.mate-translate-tooltip','[class*="mate-translate"]','#pi-browser-bridge-ind','#ljq-ind','#__pi_browser_bridge_request__','#aix-drop-panel','#aix-supported-by','[id^="aix-drop-panel"]','[data-testid="floating-button-container"]'];
  const NOISE_ATTR_NAMES = new Set(['data-read-frog-walked','data-read-frog-paragraph','data-read-frog-block-node','data-read-frog-inline-node']);
  const NOISE_ATTR_PREFIXES = ['data-read-frog','data-immersive-translate','data-google-translate','data-mate-translate'];
  const NOISE_CLASS_PATTERNS = ['read-frog-translated','goog-te','goog-tooltip','goog-text-highlight','skiptranslate','VIpgJd-','immersive-translate','mate-translate'];
  function isNoiseAttr(name) {
    const n = String(name || '').toLowerCase();
    return NOISE_ATTR_NAMES.has(n) || NOISE_ATTR_PREFIXES.some(prefix => { const p = String(prefix).toLowerCase(); return n === p || n.startsWith(p + '-'); });
  }
  function isNoiseClass(cls) { return NOISE_CLASS_PATTERNS.some(pattern => String(cls || '').toLowerCase().includes(String(pattern).toLowerCase())); }
  function isNoiseNode(node) { try { return NOISE_SELECTORS.some(sel => node.matches && node.matches(sel)); } catch (_) { return false; } }
  function textWithoutNoise(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
    if (node.nodeType === Node.ELEMENT_NODE && isNoiseNode(node)) return '';
    return Array.from(node.childNodes || []).map(textWithoutNoise).join(' ');
  }
  function cleanupClone(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return root;
    try { root.querySelectorAll(NOISE_SELECTORS.join(',')).forEach(node => node.remove()); } catch (_) {}
    const all = [root].concat(Array.from(root.querySelectorAll('*')));
    for (const node of all) {
      for (const attr of Array.from(node.attributes || [])) {
        if (isNoiseAttr(attr.name)) node.removeAttribute(attr.name);
        else if (attr.name === 'class') {
          const next = String(attr.value || '').split(/\s+/).filter(cls => cls && !isNoiseClass(cls)).join(' ');
          if (next) node.setAttribute('class', next); else node.removeAttribute('class');
        }
      }
    }
    return root;
  }
  function cleanText(value, limit) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit); }
  function sanitizedOuterHtml(node, limit) { return cleanText(cleanupClone(node.cloneNode(true))?.outerHTML || '', limit); }
  let el;
  try { el = document.querySelector(selector); } catch (e) { return {syntaxError:e.message, selector}; }
  const now = performance.now();
  const out = {selector, found:!!el, state, readyState:document.readyState, visibilityState:document.visibilityState, throttled:document.hidden===true, mutationEpoch, maxStableWaitMs};
  if (!el) { out.matched = (state === 'hidden' || state === 'detached'); return out; }
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const viewportW = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
  const viewportH = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
  const intersectsViewport = r.bottom > 0 && r.right > 0 && r.top < viewportH && r.left < viewportW;
  const cssVisible = !!(r.width || r.height) && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  const ioStore = (window.__piBrowserSelectorIntersection = window.__piBrowserSelectorIntersection || {});
  const ioKey = selector;
  if (cfg.useIntersectionObserver && cssVisible && !ioStore[ioKey]?.observer && typeof IntersectionObserver === 'function') {
    try {
      const entryState = ioStore[ioKey] = ioStore[ioKey] || {};
      entryState.isIntersecting = intersectsViewport;
      entryState.intersectionRatio = intersectsViewport ? 1 : 0;
      entryState.observer = new IntersectionObserver(entries => {
        const last = entries && entries[entries.length - 1];
        if (last) { entryState.isIntersecting = !!last.isIntersecting; entryState.intersectionRatio = Number(last.intersectionRatio || 0); entryState.ts = performance.now(); }
      }, { threshold: [0, 0.01, 0.5, 1] });
      entryState.observer.observe(el);
    } catch (e) { out.intersectionObserverError = e.message || String(e); }
  }
  const ioState = ioStore[ioKey] || null;
  const rectVisible = cssVisible && intersectsViewport;
  const ioVisible = cfg.visible === true ? !!(ioState ? ioState.isIntersecting : intersectsViewport) : true;
  let hitOk = null;
  let hitTarget = null;
  if (rectVisible && document.elementFromPoint) {
    const samplePoints = [[0.5,0.5],[0.25,0.5],[0.75,0.5],[0.5,0.25],[0.5,0.75]];
    for (const pair of samplePoints) {
      const x = Math.round(Math.max(0, Math.min(viewportW - 1, r.left + r.width * pair[0])));
      const y = Math.round(Math.max(0, Math.min(viewportH - 1, r.top + r.height * pair[1])));
      const hit = document.elementFromPoint(x, y);
      const ok = !hit || hit === el || el.contains(hit) || (hit.contains && hit.contains(el));
      if (!hitTarget && hit) hitTarget = { tagName: hit.tagName ? hit.tagName.toLowerCase() : '', id: hit.id || null, role: hit.getAttribute && hit.getAttribute('role'), text: cleanText(textWithoutNoise(hit), 160) };
      if (ok) { hitOk = true; if (hit) hitTarget = { tagName: hit.tagName ? hit.tagName.toLowerCase() : '', id: hit.id || null, role: hit.getAttribute && hit.getAttribute('role'), text: cleanText(textWithoutNoise(hit), 160) }; break; }
      hitOk = false;
    }
  }
  // Visibility is geometry/CSS based.  IntersectionObserver can lag or report 0
  // for transformed/sticky app layouts, so keep it as diagnostics instead of the
  // decisive visible gate.
  const visible = rectVisible;
  const sig = [Math.round(r.x*10)/10,Math.round(r.y*10)/10,Math.round(r.width*10)/10,Math.round(r.height*10)/10,visible].join('|');
  const store = (window.__piBrowserSelectorStable = window.__piBrowserSelectorStable || {});
  const prev = store[selector];
  const resetByMutation = prev && prev.mutationEpoch !== mutationEpoch;
  const stableOrigin = prev && prev.sig === sig && !resetByMutation ? prev.t : now;
  const stableFor = Math.max(0, now - stableOrigin);
  store[selector] = {sig, t:stableOrigin, mutationEpoch};
  const stableTimedOut = stableMs > 0 && stableFor >= maxStableWaitMs;
  const stable = stableMs === 0 || stableFor >= stableMs || stableTimedOut;
  Object.assign(out, {visible, cssVisible, rectVisible, ioVisible, intersectionRatio:ioState ? ioState.intersectionRatio : (intersectsViewport ? 1 : 0), hitOk, hitTarget, attached:true, stableFor, stable, stableTimedOut, text:cleanText(textWithoutNoise(el),500), html:sanitizedOuterHtml(el,2000), rect:{x:r.x,y:r.y,width:r.width,height:r.height}});
  out.matched = (state === 'attached') || (state === 'visible' && visible) || (state === 'hidden' && !visible) || (state === 'stable' && visible && stable) || (state === 'detached' && false);
  return out;
})()`;
function buildSelectorProbe(selector, state, stableMs, options = {}) {
  const cfg = {
    selector: String(selector),
    state: String(state),
    stableMs: Number(stableMs),
    maxStableWaitMs: Number(options.maxStableWaitMs || options.max_stable_wait_ms || 10000),
    mutationEpoch: Number(options.mutationEpoch || 0),
    visible: Boolean(options.visible === true || state === 'visible' || state === 'stable'),
    useIntersectionObserver: options.useIntersectionObserver !== false
  };
  return PI_BROWSER_SELECTOR_PROBE_SOURCE.replace('__PI_BROWSER_SELECTOR_PROBE_CFG__', JSON.stringify(cfg));
}
async function waitForSelector(tabId, msg) {
  const selector = msg.selector || msg.css || msg.target;
  if (!selector) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'wait.selector requires selector', {});
  if (msg.frameId || msg.frame_id) return piBrowserError(PI_BROWSER_ERROR_CODES.CROSS_ORIGIN_IFRAME, 'waitForSelector currently supports the main frame only; frameId is not supported by DOM bridge', { frameId: msg.frameId || msg.frame_id });
  const state = String(msg.state || (msg.visible === true ? 'visible' : 'attached')).toLowerCase(); // attached visible hidden detached stable shadow SELECTOR_TIMEOUT getComputedStyle getBoundingClientRect MutationObserver IntersectionObserver
  if (!['attached','visible','hidden','detached','stable'].includes(state)) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'wait.selector unsupported state', { state });
  const timeoutMs = normalizePiBrowserTimeoutMs(msg);
  const pollMs = Math.max(10, Math.min(1000, Number(msg.pollMs || msg.poll_ms || 100)));
  const stableMs = Math.max(50, Math.min(5000, Number(msg.stableMs || msg.stable_ms || 250)));
  const maxStableWaitMs = Math.max(stableMs, Math.min(60000, Math.max(100, Number(msg.maxStableWaitMs || msg.max_stable_wait_ms || 10000))));
  const record = registerWait(tabId, 'selector', { selector: String(selector), state, visible: state === 'visible' || msg.visible === true, timeout_ms: timeoutMs, poll_ms: pollMs, stable_ms: stableMs, max_stable_wait_ms: maxStableWaitMs, waitId: msg.waitId, wait_id: msg.wait_id, abortController: msg.abortController });
  const syntaxCheck = await piBrowserEval(tabId, `(() => { try { document.querySelector(${JSON.stringify(String(selector))}); return {ok:true}; } catch (e) { return {ok:false,error:e.message}; } })()`, true).catch(e => ({ ok:false, error:e.message || String(e) }));
  const syntaxData = syntaxCheck?.data || syntaxCheck?.result || syntaxCheck;
  if (syntaxData && syntaxData.ok === false) return finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Invalid selector syntax', { selector:String(selector), syntax_error:syntaxData.error });
  let mutationEpoch = 0;
  const visibleForProbe = msg.visible === true || state === 'visible' || state === 'stable';
  // contract literals: document.querySelector / getBoundingClientRect / visible / IntersectionObserver are inside buildSelectorProbe.
  const evaluate = () => piBrowserEval(tabId, buildSelectorProbe(selector, state, stableMs, { maxStableWaitMs, mutationEpoch, visible: visibleForProbe, useIntersectionObserver: msg.useIntersectionObserver !== false }), true).catch(e => ({ ok:false, error:e.message || String(e), method:'Runtime.evaluate' }));
  const first = await evaluate();
  const firstData = first?.data || first?.result || null;
  if (firstData?.matched) return finishPiBrowserWait(record, true, { element: firstData, state, method: 'Runtime.evaluate', immediate: true });
  if (firstData?.syntaxError) return finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Invalid selector syntax', { selector:String(selector), syntax_error:firstData.syntaxError });
  if (timeoutMs === 0) return finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.TIMEOUT, 'wait.selector immediate check failed', { selector:String(selector), state, timeout_ms:0, snapshot:firstData });
  const deadline = Date.now() + timeoutMs;
  return await new Promise(resolve => {
    let completed = false;
    let timerHandle = null;
    let inFlight = false;
    let pendingTick = false;
    let lastData = firstData || null;
    let lastTickAt = Date.now();
    const clearPollTimer = () => { if (timerHandle) { clearTimeout(timerHandle); const idx = record.timers.indexOf(timerHandle); if (idx >= 0) record.timers.splice(idx, 1); timerHandle = null; } };
    const complete = (res) => { if (completed) return; completed = true; clearPollTimer(); resolve(res); };
    const failIfAbort = () => { if (record.abortController?.signal?.aborted) complete(finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.CANCELLED || 'CANCELLED', waitAbortMessage(record), { selector:String(selector), state })); };
    try { record.abortController.signal.addEventListener('abort', failIfAbort, { once:true }); record.listeners.push({ remove: () => record.abortController.signal.removeEventListener('abort', failIfAbort) }); } catch (_) {}
    const triggerTick = (reason, observedEpoch) => {
      if (completed) return;
      const numericEpoch = Number(observedEpoch);
      if (Number.isFinite(numericEpoch)) mutationEpoch = Math.max(mutationEpoch, numericEpoch);
      if (stableMs > 0 && (reason === 'mutation' || reason === 'observer' || reason === 'binding')) mutationEpoch += 1;
      record.last_selector_tick_reason = reason || 'poll';
      clearPollTimer();
      if (inFlight) { pendingTick = true; return; }
      tick(reason || 'trigger');
    };
    const bindingName = '__piBrowserSelectorSignal_' + String(record.waitId || Date.now()).replace(/[^A-Za-z0-9_$]/g, '_');
    const bindingCleanupKey = String(selector) + '|' + state + '|' + bindingName;
    const cdp = piBrowserPersistentCdp();
    const installBindingObserver = async () => {
      if (!cdp?.send) throw new Error('persistent CDP helper is not loaded');
      await enablePiBrowserCdpDomains(record, ['Runtime']);
      const addResp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.addBinding', { name: bindingName }, { persistent: true, name: 'selector_binding', timeoutMs: Math.min(5000, timeoutMs || 5000) }));
      if (!addResp || addResp.ok === false) throw new Error(addResp?.error?.message || addResp?.message || addResp?.error || 'Runtime.addBinding failed');
      const subId = subscribePiBrowserCdp(tabId, 'Runtime.bindingCalled', (_source, _method, params) => {
        if (completed || params?.name !== bindingName) return;
        let payload = {};
        try { payload = JSON.parse(String(params.payload || '{}')); } catch (_) { payload = { raw: params.payload }; }
        const nextEpoch = Number(payload.mutationTick || payload.epoch || 0);
        recordWaitEvent(record, { kind:'selector_binding', reason:payload.reason || 'binding', mutationTick:nextEpoch, payload });
        record.diagnostics.push({ t:Date.now(), reason:'runtime_binding_called', mutationTick:nextEpoch, bindingName });
        triggerTick(payload.reason || 'binding', nextEpoch);
      }, record);
      if (!subId) throw new Error('Runtime.bindingCalled subscription unavailable');
      const installObserver = `(() => {
        const bindingName = ${JSON.stringify(bindingName)};
        const cleanupKey = ${JSON.stringify(bindingCleanupKey)};
        window.__piBrowserSelectorObserverInstalled = window.__piBrowserSelectorObserverInstalled || {};
        window.__piBrowserSelectorMutationTick = window.__piBrowserSelectorMutationTick || 0;
        const notify = (reason, extra) => {
          window.__piBrowserSelectorMutationTick = (window.__piBrowserSelectorMutationTick || 0) + 1;
          const payload = JSON.stringify(Object.assign({reason, mutationTick: window.__piBrowserSelectorMutationTick, readyState: document.readyState, visibilityState: document.visibilityState, ts: Date.now()}, extra || {}));
          try { if (typeof window[bindingName] === 'function') window[bindingName](payload); } catch (e) { (window.__piBrowserSelectorBindingErrors = window.__piBrowserSelectorBindingErrors || []).push(String(e && (e.message || e))); }
          return window.__piBrowserSelectorMutationTick;
        };
        const prior = window.__piBrowserSelectorObserverInstalled[cleanupKey];
        if (prior && prior.observer) { try { prior.observer.disconnect(); } catch (_) {} }
        if (prior && prior.visibilityHandler) { try { document.removeEventListener('visibilitychange', prior.visibilityHandler, true); } catch (_) {} }
        if (prior && prior.readyHandler) { try { document.removeEventListener('DOMContentLoaded', prior.readyHandler, true); } catch (_) {} }
        const stateRef = window.__piBrowserSelectorObserverInstalled[cleanupKey] = {tick: window.__piBrowserSelectorMutationTick, installedAt: Date.now(), bindingName};
        const observer = new MutationObserver((mutations) => {
          stateRef.lastMutationAt = Date.now();
          stateRef.tick = notify('binding', {mutationCount: mutations ? mutations.length : 0});
        });
        observer.observe(document.documentElement || document, {childList:true, subtree:true, attributes:true, characterData:false});
        const visibilityHandler = () => { stateRef.lastVisibilityAt = Date.now(); stateRef.tick = notify('visibilitychange'); };
        const readyHandler = () => { stateRef.lastReadyAt = Date.now(); stateRef.tick = notify('domcontentloaded'); };
        document.addEventListener('visibilitychange', visibilityHandler, true);
        document.addEventListener('DOMContentLoaded', readyHandler, true);
        stateRef.observer = observer;
        stateRef.visibilityHandler = visibilityHandler;
        stateRef.readyHandler = readyHandler;
        stateRef.cleanup = () => {
          try { observer.disconnect(); } catch (_) {}
          try { document.removeEventListener('visibilitychange', visibilityHandler, true); } catch (_) {}
          try { document.removeEventListener('DOMContentLoaded', readyHandler, true); } catch (_) {}
          try { delete window.__piBrowserSelectorObserverInstalled[cleanupKey]; } catch (_) {}
        };
        notify('observer_installed');
        return {ok:true, mutationTick:window.__piBrowserSelectorMutationTick||0, visibilityState:document.visibilityState, bindingName};
      })()`;
      const installed = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression: installObserver, awaitPromise: true, returnByValue: true }, { persistent: true, name: 'selector_binding_install', timeoutMs: Math.min(5000, timeoutMs || 5000) }));
      if (!installed || installed.ok === false) throw new Error(installed?.error?.message || installed?.message || installed?.error || 'selector binding observer install failed');
      const evalData = installed?.data?.result?.result?.value || installed?.data?.result?.value || installed?.result?.result?.value || installed?.result?.value || installed?.data || installed?.result || installed;
      if (Number.isFinite(Number(evalData?.mutationTick))) mutationEpoch = Math.max(mutationEpoch, Number(evalData.mutationTick));
      record.diagnostics.push({ t:Date.now(), reason:'runtime_binding_observer_installed', bindingName, mutationTick:evalData?.mutationTick });
      record.listeners.push({ remove: () => {
        const cleanupExpr = `(() => { const key=${JSON.stringify(bindingCleanupKey)}; const rec=window.__piBrowserSelectorObserverInstalled&&window.__piBrowserSelectorObserverInstalled[key]; if (rec&&typeof rec.cleanup==='function') rec.cleanup(); return true; })()`;
        try { void cdp.send(tabId, 'Runtime.evaluate', { expression: cleanupExpr, awaitPromise: true, returnByValue: true }, { persistent: true, name: 'selector_binding_cleanup', timeoutMs: 1000 }).catch(() => {}); } catch (_) {}
        try { void cdp.send(tabId, 'Runtime.removeBinding', { name: bindingName }, { persistent: true, name: 'selector_binding_remove', timeoutMs: 1000 }).catch(() => {}); } catch (_) {}
      } });
      return true;
    };
    installBindingObserver().catch(e => {
      record.diagnostics.push({ t:Date.now(), warning:'runtime_binding_observer_unavailable_poll_fallback_active', bindingName, error:e.message || String(e) });
    });
    const armPoll = () => {
      if (completed) return;
      clearPollTimer();
      const tickFromPollTimer = () => triggerTick('poll');
      // Compatibility contract for the legacy polling fallback: setTimeout(tick, pollMs)
      timerHandle = setTimeout(tickFromPollTimer, pollMs);
      record.timers.push(timerHandle);
    };
    const tick = async (reason) => {
      if (completed) return;
      if (record.abortController?.signal?.aborted) return failIfAbort();
      if (Date.now() >= deadline) return complete(finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.TIMEOUT, 'wait.selector timed out', { selector: String(selector), state, timeout_ms: timeoutMs, diagnostics: record.diagnostics, background_throttling_suspected: Date.now() - lastTickAt > Math.max(2000, pollMs * 5), last_state:lastData }));
      lastTickAt = Date.now();
      inFlight = true;
      const res = await evaluate();
      inFlight = false;
      const data = res?.data || res?.result || null;
      if (data) lastData = data;
      if (data?.matched) return complete(finishPiBrowserWait(record, true, { element: data, state, method: 'Runtime.evaluate', reason: reason || 'poll' }));
      if (data?.throttled) record.diagnostics.push({ t:Date.now(), warning:'background_tab_timer_throttling_possible', visibilityState:data.visibilityState });
      if (data?.stableTimedOut) record.diagnostics.push({ t:Date.now(), warning:'selector_stability_max_wait_reached', stableFor:data.stableFor, maxStableWaitMs:data.maxStableWaitMs });
      if (pendingTick) { pendingTick = false; return triggerTick('pending'); }
      armPoll();
    };
    triggerTick('initial');
  });
}
async function waitForAny(tabId, msg) {
  const losers = [];
  const waits = Array.isArray(msg.waits) ? msg.waits : Array.isArray(msg.conditions) ? msg.conditions : [];
  if (!waits.length) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'wait.any requires waits/conditions', {});
  const parentTimeoutMs = normalizePiBrowserTimeoutMs(msg);
  const deadline = Date.now() + parentTimeoutMs;
  const controllers = waits.map(() => new AbortController());
  const childWaitIds = waits.map((w, i) => String((w && (w.waitId || w.wait_id)) || makeWaitId(tabId, 'any_child_' + i)));
  const children = waits.map((w, i) => ({ index:i, wait:w, waitId:childWaitIds[i], wait_id:childWaitIds[i] }));
  const childTimeoutMs = (w) => {
    const requested = normalizePiBrowserTimeoutMs(w || {}, parentTimeoutMs);
    const remaining = Math.max(0, deadline - Date.now());
    return Math.min(requested, remaining);
  };
  const cleanupChildRecord = (i, reason) => {
    const childKey = waitKey(tabId, childWaitIds[i]);
    const record = piBrowserWaits.get(childKey);
    if (record) {
      try { record.abortController?.abort(reason || PI_BROWSER_ERROR_CODES.CANCELLED); } catch (_) {}
      try { clearWait(record, reason || PI_BROWSER_ERROR_CODES.CANCELLED); } catch (_) {}
    }
  };
  const cleanup = (reason, keepIndex) => {
    controllers.forEach((c, i) => {
      if (i === keepIndex) return;
      try { if (!c.signal.aborted) { losers.push(i); c.abort(reason || PI_BROWSER_ERROR_CODES.CANCELLED); } } catch (_) {}
      cleanupChildRecord(i, reason || PI_BROWSER_ERROR_CODES.CANCELLED);
    });
  };
  const tasks = waits.map((w, i) => dispatchPiBrowserWait(tabId, { ...w, waitId: childWaitIds[i], wait_id: childWaitIds[i], abortController: controllers[i], timeoutMs: childTimeoutMs(w) }, w.cmd || w.type || w.kind || 'selector').then(result => { if (result && result.ok) return { index:i, result }; throw result; }));
  let parentTimer = null;
  const parentTimeout = new Promise((_, reject) => { parentTimer = setTimeout(() => {
    cleanup('parent_timeout');
    reject({ error_code: PI_BROWSER_ERROR_CODES.TIMEOUT, error: 'wait.any parent timeout', details: { timeout_ms: parentTimeoutMs } });
  }, parentTimeoutMs); });
  try {
    const winner = await Promise.race([Promise.any(tasks), parentTimeout]);
    if (parentTimer) clearTimeout(parentTimer);
    cleanup('winner', winner.index);
    return { ok: true, data: { winner: winner.index, matched: winner.index, result: winner.result.data, children, losers, timeout_ms: parentTimeoutMs } };
  }
  catch (e) {
    if (parentTimer) clearTimeout(parentTimer);
    cleanup('failed');
    const errors = e && e.errors ? e.errors : [e];
    const firstTimeout = errors.find(x => x && (x.error_code === PI_BROWSER_ERROR_CODES.TIMEOUT || /timeout|timed out|parent timeout/i.test(String(x.error || x.message || ''))));
    if (firstTimeout) return piBrowserError(PI_BROWSER_ERROR_CODES.TIMEOUT, firstTimeout.error || firstTimeout.message || ('wait.any timed out after ' + parentTimeoutMs + 'ms; no condition matched'), { errors, children, losers, timeout_ms: parentTimeoutMs });
    return piBrowserError(PI_BROWSER_ERROR_CODES.TIMEOUT, 'wait.any timed out after ' + parentTimeoutMs + 'ms; no condition matched', { errors, children, losers, timeout_ms: parentTimeoutMs });
  }
}
async function waitForAll(tabId, msg) {
  const waits = Array.isArray(msg.waits) ? msg.waits : Array.isArray(msg.conditions) ? msg.conditions : [];
  const parentTimeoutMs = normalizePiBrowserTimeoutMs(msg);
  const failFast = msg.failFast !== false && msg.fail_fast !== false;
  const children = waits.map((w, i) => ({ index:i, kind:w?.kind || w?.type || w?.cmd || 'selector', timeout_ms: normalizePiBrowserTimeoutMs(w || {}, parentTimeoutMs) }));
  const controllers = waits.map(() => new AbortController());
  const cleanup = (reason, exceptIndex = -1) => { controllers.forEach((c, i) => { try { if (i !== exceptIndex && !c.signal.aborted) c.abort(reason || PI_BROWSER_ERROR_CODES.CANCELLED); } catch (_) {} }); };
  const deadline = Date.now() + parentTimeoutMs;
  let failureIndex = -1;
  const toResult = (settled, i) => {
    if (settled.status === 'fulfilled') return settled.value;
    const reason = settled.reason || {};
    return piBrowserError(reason.error_code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, reason.error || reason.message || 'wait.all child threw', { child_index: i, reason });
  };
  const tasks = waits.map((w, i) => dispatchPiBrowserWait(tabId, { ...w, abortController: controllers[i], timeoutMs: Math.min(normalizePiBrowserTimeoutMs(w || {}, parentTimeoutMs), Math.max(0, deadline - Date.now())) }, w.cmd || w.type || w.kind || 'selector')
    .then(result => {
      if (failFast && (!result || result.ok === false) && failureIndex < 0) { failureIndex = i; cleanup(PI_BROWSER_ERROR_CODES.CANCELLED, i); }
      return result;
    }, error => {
      if (failFast && failureIndex < 0) { failureIndex = i; cleanup(PI_BROWSER_ERROR_CODES.CANCELLED, i); }
      throw error;
    }));
  const settled = await Promise.allSettled(tasks);
  const results = settled.map(toResult);
  const aggregate = { matched: results.filter(r => r && r.ok).length, children, results: results.map(r => (r && (r.data || r)) || r), failFast, failure_index: failureIndex };
  const failures = results.map((r, i) => ({ index: i, result: r })).filter(x => !x.result || x.result.ok === false);
  if (failures.length) {
    cleanup(PI_BROWSER_ERROR_CODES.CANCELLED);
    const first = failures[0];
    return piBrowserError(first.result?.error_code || PI_BROWSER_ERROR_CODES.TIMEOUT, 'wait.all condition failed', { failed_index: first.index, failure_index: first.index, failures, children, results, aggregate });
  }
  return { ok: true, data: aggregate };
}
async function waitForComposite(tabId, msg, mode) { return mode === 'waitForAny' ? await waitForAny(tabId, msg) : await waitForAll(tabId, msg); }
async function dispatchPiBrowserWait(tabId, msg, kind) {
  const raw = String(kind || msg.kind || msg.type || msg.cmd || '').replace(/^piBrowser[._]/, '');
  const k = raw.replace(/[-_]/g, '').toLowerCase();
  if (k === 'waitforloadstate' || k === 'loadstate' || k === 'load' || k === 'domcontentloaded' || k === 'complete') return await waitForLoadState(tabId, msg);
  if (k === 'waitfornetworkidle' || k === 'networkidle') return await waitForNetworkIdle(tabId, msg);
  if (k === 'waitforselector' || k === 'selector' || k === 'css') return await waitForSelector(tabId, msg);
  if (k === 'navigateandwait' || k === 'navigate') return await navigateAndWait(tabId, msg);
  return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown wait condition: ' + kind, { kind, normalized: k, wait: msg });
}
async function cancelWait(tabId, msg) {
  const waitId = msg.waitId || msg.wait_id;
  let cancelled_count = 0;
  if (waitId) { const r = piBrowserWaits.get(waitKey(tabId, waitId)); if (r) { try { r.abortController?.abort('cancelled'); } catch (_) {} clearWait(r, 'cancelled'); cancelled_count = 1; } }
  else cancelled_count = cancelWaitsForTab(tabId, 'cancelled');
  return { ok: true, data: { cancelled: cancelled_count, cancelled_count, waitId: waitId || null, pending: Array.from(piBrowserWaits.values()).filter(r => Number(r.tabId) === Number(tabId)).map(r => ({ waitId:r.waitId, kind:r.kind, age_ms:Date.now()-r.createdAt })) } };
}
function cancelPiBrowserWait(tabId, msg) { return cancelWait(tabId, msg); }

function cleanupEventSubscriptionsForTab(tabId) {
  return piBrowserWaits.cleanupEventSubscriptionsForTab(tabId);
}
async function addEventListener(tabId, msg) {
  const eventType = msg.eventType || msg.event_type;
  if (!eventType) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'hook.addEventListener requires eventType', {});
  const listenerId = msg.listenerId || msg.listener_id || ('listener_' + tabId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2));
  const selector = msg.selector || null;
  const cdp = piBrowserPersistentCdp();
  let pageResult = null;
  if (cdp?.send) {
    const expression = `(() => {
      window.__piBrowserListeners = window.__piBrowserListeners || {};
      const listenerId = ${JSON.stringify(listenerId)};
      const eventType = ${JSON.stringify(eventType)};
      const selector = ${JSON.stringify(selector)};
      const prior = window.__piBrowserListeners[listenerId];
      if (prior && prior.target && prior.handler) { try { prior.target.removeEventListener(prior.eventType, prior.handler, true); } catch (_) {} }
      let target = document;
      if (selector) {
        try { target = document.querySelector(selector); } catch (error) { return { ok:false, code:'INVALID_SELECTOR', message:error && error.message ? error.message : String(error), listenerId, eventType, selector }; }
        if (!target) return { ok:false, code:'ELEMENT_NOT_FOUND', message:'No element matches selector for event listener', listenerId, eventType, selector };
      }
      const handler = function piBrowserEventListener(event) {
        const rec = window.__piBrowserListeners && window.__piBrowserListeners[listenerId];
        if (rec) { rec.lastEventAt = Date.now(); rec.eventCount = (rec.eventCount || 0) + 1; rec.lastEventType = event && event.type; }
      };
      target.addEventListener(eventType, handler, true);
      window.__piBrowserListeners[listenerId] = { listenerId, eventType, selector, target, handler, capture:true, addedAt:Date.now(), eventCount:0 };
      return { ok:true, listenerId, eventType, selector, target: selector || 'document', replaced: !!prior };
    })()`;
    const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true }, { persistent: true, name: 'event_listener', timeoutMs: msg.timeoutMs || 5000 }));
    if (!resp || resp.ok === false) return resp;
    pageResult = resp.data?.result?.result?.value || resp.result?.result?.value || resp.data?.result?.value || resp.result?.value || null;
    if (pageResult && pageResult.ok === false) return piBrowserError(pageResult.code || PI_BROWSER_ERROR_CODES.INVALID_RULE, pageResult.message || 'hook.addEventListener failed', pageResult);
  }
  const sub = { tabId, listenerId, eventType, selector, diagnostics: msg.diagnostics || {}, removeEventListener: true };
  piBrowserWaits.registerEventSubscription(listenerId, sub);
  return { ok: true, data: { listenerId, listener_id: listenerId, eventType, selector, page: pageResult } };
}
async function removeEventListener(tabId, msg) {
  const listenerId = msg.listenerId || msg.listener_id;
  if (!listenerId) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'hook.removeEventListener requires listenerId', {});
  const cdp = piBrowserPersistentCdp();
  let pageRemoved = false;
  if (cdp?.send) {
    const expression = `(() => {
      const listenerId = ${JSON.stringify(listenerId)};
      const store = window.__piBrowserListeners || {};
      const rec = store[listenerId];
      if (!rec) return { removed:false, listenerId };
      try { (rec.target || document).removeEventListener(rec.eventType, rec.handler, rec.capture !== false); } catch (_) {}
      delete store[listenerId];
      return { removed:true, listenerId, eventType:rec.eventType, selector:rec.selector || null, eventCount:rec.eventCount || 0 };
    })()`;
    const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true }, { persistent: true, name: 'event_listener_remove', timeoutMs: msg.timeoutMs || 5000 }));
    if (!resp || resp.ok === false) return resp;
    const pageResult = resp.data?.result?.result?.value || resp.result?.result?.value || resp.data?.result?.value || resp.result?.value || null;
    pageRemoved = pageResult?.removed === true;
  }
  const existed = piBrowserWaits.deleteEventSubscription(listenerId);
  return { ok: true, data: { listenerId, listener_id: listenerId, removed: existed || pageRemoved, registry_removed: existed, page_removed: pageRemoved } };
}
async function getPerformanceEntries(tabId, msg) {
  const entryType = msg.entryType || msg.entry_type || 'resource';
  const nameContains = msg.nameContains || msg.name_contains || '';
  const expression = `(() => { const byType = performance.getEntriesByType(${JSON.stringify(entryType)}); const all = performance.getEntries(); return (byType.length ? byType : all).filter(e => !${JSON.stringify(nameContains)} || String(e.name||'').includes(${JSON.stringify(nameContains)})).map(e => ({ name:e.name, entryType:e.entryType, startTime:e.startTime, duration:e.duration, initiatorType:e.initiatorType || null, transferSize:e.transferSize || 0, encodedBodySize:e.encodedBodySize || 0, decodedBodySize:e.decodedBodySize || 0 })); })()`;
  const cdp = piBrowserPersistentCdp();
  if (cdp?.send) {
    const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true }, { persistent: true, name: 'performance_entries', timeoutMs: msg.timeoutMs || 5000 }));
    if (!resp || resp.ok === false) return resp;
    const result = resp.data?.result || resp.result || resp.data;
    if (result?.exceptionDetails) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, result.exceptionDetails.exception?.description || 'Runtime.evaluate failed', result.exceptionDetails);
    const entries = Array.isArray(result?.result?.value) ? result.result.value : [];
    return { ok: true, data: { entries, entryType, nameContains, count: entries.length, native_cmd: 'hook.getPerformanceEntries' } };
  }
  return { ok: true, data: { entries: [], entryType, nameContains, count: 0, note: 'PerformanceObserver performance.getEntriesByType performance.getEntries Runtime.evaluate unavailable' } };
}

async function diagnosePiBrowser(tabId, msg) {
  const tab = await chrome.tabs.get(tabId).catch(e => ({ error: e.message || String(e) }));
  const status = await callPagePiBrowserWithAutoReinstall(tabId, 'hook.status', {}).catch(e => piBrowserError(PI_BROWSER_ERROR_CODES.NO_SESSION, e.message || String(e), {}));
  const cdp = piBrowserPersistentCdp();
  let debuggerTargets = [];
  let frames = [];
  let inflight = 0;
  let readyState = null;
  let last_errors = [];
  const statusData = (status && status.data && typeof status.data === 'object') ? status.data : ((status && status.result && typeof status.result === 'object') ? status.result : {});
  // installed_marker is an active-session marker, not a dispatcher-loaded marker.
  // hook.status can still return ok after hook.uninstall because the page dispatcher
  // remains loaded in a CLOSED/NO_SESSION state for explicit post-uninstall diagnostics.
  const installed_marker = !!(status && status.ok && statusData.session_id && !['CLOSED', 'CREATED'].includes(String(statusData.state || '').toUpperCase()));
  const dispatcher_version = statusData.dispatcher_version || statusData.pi_browser_version || null;
  const install_epoch = statusData.install_epoch || 0;
  const owner_session_id = statusData.owner_session_id || null;
  const install_fingerprint = statusData.install_fingerprint || '';
  const cleanup_warnings = Array.isArray(statusData.cleanup_warnings) ? statusData.cleanup_warnings : [];
  const residue_signatures = Array.isArray(statusData.residue_signatures) ? statusData.residue_signatures : [];
  const version = 'wait-goal-v1';
  const epoch = Date.now();
  const activeWaits = Array.from(piBrowserWaits.values()).filter(r => Number(r.tabId) === Number(tabId)).map(r => ({ waitId:r.waitId, kind:r.kind, criteria:r.criteria, age_ms:Date.now()-r.createdAt, status:r.status, cdpSubscriptions:r.cdpSubscriptions, lastEventAt:r.lastEventAt, diagnostics:r.diagnostics }));
  const listeners = Array.from(piBrowserWaits.eventSubscriptionValues()).filter(s => Number(s.tabId) === Number(tabId)).map(s => ({ listenerId:s.listenerId, eventType:s.eventType, selector:s.selector, diagnostics:s.diagnostics }));
  const diagnostics = piBrowserWaits.diagnostics(tabId);
  try { if (chrome.debugger?.getTargets) debuggerTargets = await chrome.debugger.getTargets(); } catch (e) { last_errors.push(e.message || String(e)); }
  try {
    const probe = await callPagePiBrowserWithAutoReinstall(tabId, 'hook.evaluate', { expression: `(() => ({ readyState: document.readyState, frames: Array.from(document.frames || []).map((_, i) => ({ index:i })), inflight: (window.__piBrowserInflight || 0), last_errors: window.__piBrowserLastErrors || [] }))()` }).catch(e => ({ ok:false, error:e.message || String(e) }));
    const data = probe?.data?.result || probe?.data || probe?.result || {};
    readyState = data.readyState || readyState;
    frames = Array.isArray(data.frames) ? data.frames : frames;
    inflight = Number(data.inflight || inflight || 0);
    if (Array.isArray(data.last_errors)) last_errors = last_errors.concat(data.last_errors);
  } catch (e) { last_errors.push(e.message || String(e)); }
  const cdpObservability = {
    active_subscriptions: diagnosePiBrowserCdpSubscriptions(tabId),
    domain_refs: diagnosePiBrowserCdpDomainRefs(tabId),
    cleanup_history: diagnosePiBrowserCdpCleanupHistory(tabId),
  };
  const activeCdpSubscriptions = cdpObservability.active_subscriptions;
  const cdpDomainRefs = cdpObservability.domain_refs;
  const cdpCleanupHistory = cdpObservability.cleanup_history;
  const cdpLeaks = {
    domain_ref_leaks: cdpDomainRefs.filter(r => r.count > 0 && !r.holders.length),
    subscription_leaks: activeCdpSubscriptions.filter(s => s.waitId && !piBrowserWaits.has(waitKey(s.tabId, s.waitId))),
  };
  return { ok: true, data: { tabId:Number(tabId), tab, sessions: Array.from(piBrowserSessions.entries()).map(([tid, s]) => ({ tabId: tid, ...s })), session: piBrowserSessions.get(Number(tabId)) || null, queue: getPiBrowserQueueStats(tabId), waits: activeWaits, activeWaits, listeners, frames, inflight, readyState, last_errors, installed_marker, dispatcher_version, install_epoch, owner_session_id, install_fingerprint, cleanup_warnings, residue_signatures, version, epoch, diagnostics, cdp: { persistent: !!cdp, debuggerTargets, ...cdpObservability, leaks: cdpLeaks }, active_subscriptions: activeCdpSubscriptions, cdp_domain_refs: cdpDomainRefs, cdp_cleanup_history: cdpCleanupHistory, domain_ref_leaks: cdpLeaks.domain_ref_leaks, subscription_leaks: cdpLeaks.subscription_leaks, debuggerTargets, dispatcher: status, persistent_cdp: !!cdp, timestamp: new Date(epoch).toISOString() } };
}
