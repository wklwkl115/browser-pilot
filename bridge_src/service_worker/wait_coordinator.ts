import { PI_BROWSER_ERROR_CODES, piBrowserError } from "./runtime";
import { cleanupPiBrowserCdpTab, releasePiBrowserCdpDomains, rememberPiBrowserCdpCleanup, unsubscribePiBrowserCdp } from "./wait_cdp";
import type { JsonRecord, PiBridgeCommand, PiBridgeResponse, PiBrowserWaitRecord } from "./types";

// wait_coordinator.js - Pi browser wait registry, cleanup, timeout and event subscription helpers.
// Loaded after wait_cdp.js and before wait.js by background.js.

type PiBrowserEventSubscription = JsonRecord & { key?: string; listenerId: string; tabId: number };
type CleanupTabWaitsOptions = { includeCdp?: boolean; action?: string; remember?: boolean };

class WaitCoordinator {
  activeWaits = new Map<string, PiBrowserWaitRecord>();
  eventSubscriptions = new Map<string, PiBrowserEventSubscription>();
  epoch = 0;
  constructor() { this.activeWaits = new Map<string, PiBrowserWaitRecord>(); this.eventSubscriptions = new Map<string, PiBrowserEventSubscription>(); this.epoch = 0; }
  makeWaitId(tabId: unknown, kind: unknown): string { return makeWaitId(tabId, kind); }
  waitKey(tabId: unknown, waitId: unknown): string { return waitKey(tabId, waitId); }
  eventSubscriptionKey(tabId: unknown, listenerId: unknown): string { return eventSubscriptionKey(tabId, listenerId); }
  register(record: PiBrowserWaitRecord): PiBrowserWaitRecord {
    const key = record.key || waitKey(record.tabId, record.wait_id || record.waitId);
    record.key = key;
    this.activeWaits.set(key, record);
    return record;
  }
  get(key: string): PiBrowserWaitRecord | undefined { return this.activeWaits.get(key); }
  set(key: string, record: PiBrowserWaitRecord): this { this.activeWaits.set(key, record); return this; }
  has(key: string): boolean { return this.activeWaits.has(key); }
  delete(key: string): boolean { return this.activeWaits.delete(key); }
  values(): IterableIterator<PiBrowserWaitRecord> { return this.activeWaits.values(); }
  entries(): IterableIterator<[string, PiBrowserWaitRecord]> { return this.activeWaits.entries(); }
  keys(): IterableIterator<string> { return this.activeWaits.keys(); }
  get size() { return this.activeWaits.size; }
  [Symbol.iterator](): IterableIterator<[string, PiBrowserWaitRecord]> { return this.activeWaits[Symbol.iterator](); }
  registerEventSubscription(listenerId: unknown, sub: PiBrowserEventSubscription): PiBrowserEventSubscription {
    const key = eventSubscriptionKey(sub.tabId, listenerId);
    sub.key = key;
    this.eventSubscriptions.set(key, sub);
    return sub;
  }
  eventSubscription(listenerId: unknown, tabId?: unknown): PiBrowserEventSubscription | null {
    if (tabId !== undefined && tabId !== null) return this.eventSubscriptions.get(eventSubscriptionKey(tabId, listenerId)) || null;
    const matches = Array.from(this.eventSubscriptions.values()).filter(s => String(s.listenerId) === String(listenerId));
    return matches.length === 1 ? matches[0] : null;
  }
  deleteEventSubscription(listenerId: unknown, tabId?: unknown): boolean {
    if (tabId !== undefined && tabId !== null) return this.eventSubscriptions.delete(eventSubscriptionKey(tabId, listenerId));
    let deleted = false;
    for (const [key, sub] of Array.from(this.eventSubscriptions.entries())) {
      if (String(sub.listenerId) === String(listenerId)) { this.eventSubscriptions.delete(key); deleted = true; }
    }
    return deleted;
  }
  eventSubscriptionValues(): IterableIterator<PiBrowserEventSubscription> { return this.eventSubscriptions.values(); }
  cleanupEventSubscriptionsForTab(tabId: unknown): number {
    let n = 0;
    for (const [listenerId, sub] of Array.from(this.eventSubscriptions.entries())) {
      if (Number(sub.tabId) === Number(tabId)) { this.eventSubscriptions.delete(listenerId); n++; }
    }
    return n;
  }
  cleanupWait(record: PiBrowserWaitRecord, reason?: string): void { return cleanupWait(record, reason); }
  cleanupWaitsForFrame(tabId: unknown, frameId: unknown, reason?: string): number { return cleanupWaitsForFrame(tabId, frameId, reason); }
  cleanupWaitsForUninstall(tabId: unknown): number { return cleanupWaitsForUninstall(tabId); }
  diagnostics(tabId?: unknown) { const scopedEvents = Array.from(this.eventSubscriptions.values()).filter(s => !tabId || Number(s.tabId) === Number(tabId)); return { activeWaits: Array.from(this.activeWaits.values()).filter(w => !tabId || Number(w.tabId) === Number(tabId)).map(w => ({ wait_id: w.wait_id || w.waitId, request_id: w.request_id || w.requestId, kind: w.kind, epoch: w.epoch, diagnostics: w.diagnostics || {} })), eventSubscriptions: scopedEvents.length, epoch: this.epoch }; }
}
function cleanupWait(record: PiBrowserWaitRecord, reason?: string): void { return cleanupPiBrowserWait(record, reason); }
function cleanupWaitsForFrame(tabId: unknown, frameId: unknown, reason?: string): number { let n = 0; for (const r of Array.from(piBrowserWaits.values())) if (Number(r.tabId) === Number(tabId) && String(r.frameId || '') === String(frameId || '')) { cleanupPiBrowserWait(r, reason || 'FRAME_DETACHED'); n++; } return n; }
function cleanupWaitsForUninstall(tabId: unknown): number { cleanupEventSubscriptionsForTab(tabId); return cancelWaitsForTab(tabId, 'uninstall'); }

const piBrowserWaits = new WaitCoordinator();
// Legacy Map-compatible wait registry contract: const piBrowserWaits = new Map
const PI_BROWSER_ORPHAN_WAIT_MAX_AGE_MS = 300000;
function cleanupPiBrowserOrphanWaits(reason?: string, maxAgeMs?: unknown): number {
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
try {
  const waitGlobal = self as typeof self & { __piBrowserUnhandledRejectionCleanupInstalled?: boolean };
  if (typeof self !== 'undefined' && self.addEventListener && !waitGlobal.__piBrowserUnhandledRejectionCleanupInstalled) {
    waitGlobal.__piBrowserUnhandledRejectionCleanupInstalled = true;
    self.addEventListener('unhandledrejection', () => { try { cleanupPiBrowserOrphanWaits('unhandledRejection', 0); } catch (_) {} });
  }
} catch (_) {}
let piBrowserWaitSeq = 0;
const PI_BROWSER_DEFAULT_WAIT_TIMEOUT_MS = 30000;
function normalizePiBrowserTimeoutMs(msg: PiBridgeCommand | null | undefined, fallback = PI_BROWSER_DEFAULT_WAIT_TIMEOUT_MS): number {
  const hasExplicit = msg && (msg.timeoutMs !== undefined || msg.timeout_ms !== undefined || msg.timeout !== undefined);
  if (hasExplicit && Number(msg.timeoutMs ?? msg.timeout_ms ?? msg.timeout) === 0) return 0;
  const raw = msg?.timeoutMs ?? msg?.timeout_ms ?? msg?.timeout ?? fallback ?? PI_BROWSER_DEFAULT_WAIT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback === 0 ? 0 : (fallback || PI_BROWSER_DEFAULT_WAIT_TIMEOUT_MS);
  if (n === 0) return 0;
  return Math.max(50, Math.min(300000, Math.floor(n)));
}
function makeWaitId(tabId: unknown, kind: unknown): string { return 'wait_' + Number(tabId) + '_' + String(kind || 'generic') + '_' + Date.now() + '_' + (++piBrowserWaitSeq); }
function waitKey(tabId: unknown, waitId: unknown): string { return Number(tabId) + ':' + String(waitId); }
function eventSubscriptionKey(tabId: unknown, listenerId: unknown): string { return Number(tabId) + '::' + String(listenerId); }
function isAbortError(e: unknown): boolean { const err = e && typeof e === 'object' ? e as JsonRecord : {}; return !!e && (err.name === 'AbortError' || /aborted|cancelled/i.test(String(err.message || e))); }
function waitAbortMessage(record: PiBrowserWaitRecord): string { return 'piBrowser wait ' + record.waitId + ' cancelled'; }
function normalizeWaitState(value: unknown, fallback = 'complete'): string {
  const s = String(value || fallback || '').toLowerCase().replace(/_/g, '');
  if (s === 'domcontentloaded' || s === 'dominteractive') return 'domcontentloaded';
  if (s === 'load' || s === 'loaded') return 'load';
  if (s === 'complete' || s === 'networkalmostidle') return 'complete';
  if (s === 'networkidle') return 'networkidle';
  return s || 'complete';
}
function registerWait(tabId: number, kind: string, criteria: PiBridgeCommand = {}): PiBrowserWaitRecord {
  const waitId = (criteria && (criteria.waitId || criteria.wait_id)) || makeWaitId(tabId, kind);
  const requestId = criteria && (criteria.requestId || criteria.request_id);
  const abortController = criteria?.abortController || new AbortController();
  const record: PiBrowserWaitRecord = { waitId: String(waitId), wait_id: String(waitId), requestId: requestId ? String(requestId) : '', request_id: requestId ? String(requestId) : '', tabId: Number(tabId), kind, criteria, createdAt: Date.now(), status: 'pending', listeners: [], timers: [], cdpAttached: false, cdpDomains: new Set<string>(), cdpSubscriptions: [], cdpEvents: [], diagnostics: [], lastEventAt: 0, lastError: null, abortController, key: '' };
  record.key = waitKey(tabId, record.waitId);
  // lifecycle identity: key: waitKey(tabId, record.waitId)
  piBrowserWaits.register(record);
  const onAbort = () => { record.status = 'cancelled'; };
  try { abortController.signal.addEventListener('abort', onAbort, { once: true }); record.listeners.push({ remove: () => abortController.signal.removeEventListener('abort', onAbort) }); } catch (_) {}
  return record;
}
function recordWaitEvent(record: PiBrowserWaitRecord, event?: JsonRecord): void {
  record.lastEventAt = Date.now();
  record.cdpEvents.push({ t: record.lastEventAt, ...(event || {}) });
  if (record.cdpEvents.length > 200) record.cdpEvents.splice(0, record.cdpEvents.length - 200);
}
function shouldAbortWaitCleanupReason(reason?: string): boolean {
  // Completing a wait is cleanup, not cancellation.  Aborting the wait's own
  // controller while finishPiBrowserWait() is building an OK/TIMEOUT/failed result
  // synchronously fires abort listeners and can race the Promise into returning
  // CANCELLED instead of the terminal result that already happened.
  const r = String(reason || 'cleaned').toLowerCase();
  return !['completed', 'timeout', 'failed', 'cleaned'].includes(r);
}
function clearWait(record: PiBrowserWaitRecord | null | undefined, reason?: string): void {
  if (!record || record.status === 'cleaned') return;
  if (shouldAbortWaitCleanupReason(reason)) { try { record.abortController?.abort(reason || 'cleaned'); } catch (_) { /* best-effort abort during wait cleanup */ } }
  for (const t of record.timers.splice(0)) { try { clearTimeout(t); } catch (_) { /* best-effort timer cleanup */ } }
  for (const item of record.listeners.splice(0)) { try { item.remove(); } catch (_) { /* best-effort listener cleanup */ } }
  for (const sid of record.cdpSubscriptions.splice(0)) { try { unsubscribePiBrowserCdp(sid); } catch (error) { console.warn('[PI-BROWSER-WAIT] Failed to unsubscribe CDP wait subscription', sid, error); } }
  releasePiBrowserCdpDomains(record, Array.from(record.cdpDomains || []), reason || 'cleaned');
  if (record.cdpAttached) record.cdpAttached = false;
  record.status = reason || record.status || 'cleaned';
  piBrowserWaits.delete(record.key);
}
function cleanupPiBrowserWait(record: PiBrowserWaitRecord, reason?: string): void { return clearWait(record, reason); }
function isWaitRecordForTab(record: PiBrowserWaitRecord | null | undefined, tabId: unknown): boolean { return !!record && Number(record.tabId) === Number(tabId); }
function cleanupTabWaits(tabId: unknown, reason?: string, options: CleanupTabWaitsOptions = {}) {
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
    try { clearWait(r, cleanupReason); cleaned += 1; } catch (error) { console.warn('[PI-BROWSER-WAIT] Failed to clear orphaned wait record', key, error); try { piBrowserWaits.delete(key); cleaned += 1; } catch (__) { /* best-effort orphan registry cleanup */ } }
  }
  if (opts.includeCdp !== false) cleanupPiBrowserCdpTab(tabId, cleanupReason);
  cleanupEventSubscriptionsForTab(tabId);
  if (cleaned || orphaned || opts.remember !== false) rememberPiBrowserCdpCleanup({ tabId:Number(tabId), reason: cleanupReason, action: opts.action || 'cleanup_tab_waits', waits_cleaned: cleaned, waits_aborted: aborted, orphan_waits: orphaned, remaining_waits: Array.from(piBrowserWaits.values()).filter(r => isWaitRecordForTab(r, tabId)).length });
  return { tabId:Number(tabId), reason:cleanupReason, cleaned, aborted, orphaned };
}
function cancelWaitsForTab(tabId: unknown, reason?: string): number {
  return cleanupTabWaits(tabId, reason || 'cancelled', { includeCdp: true, action: 'cancel_waits_for_tab' }).cleaned;
}
function cleanupEventSubscriptionsForTab(tabId: unknown): number {
  return piBrowserWaits.cleanupEventSubscriptionsForTab(tabId);
}
function waitWithTimeout<T>(record: PiBrowserWaitRecord, promise: Promise<T>, timeoutMs: number, label?: string): Promise<T> {
  if (timeoutMs === 0) return promise;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error((label || record.kind) + ' timed out')), timeoutMs); });
  if (timeoutHandle) record.timers.push(timeoutHandle);
  return Promise.race([promise, timeout]).finally(() => timeoutHandle && clearTimeout(timeoutHandle));
}
function finishPiBrowserWait(record: PiBrowserWaitRecord, ok: boolean, data: JsonRecord | null = null, errorCode?: string, message?: string, details: JsonRecord = {}): PiBridgeResponse {
  const elapsed_ms = Date.now() - record.createdAt;
  const base = { waitId: record.waitId, nativeWaitId: record.waitId, kind: record.kind, tabId: record.tabId, elapsed_ms, criteria: record.criteria };
  clearWait(record, ok ? 'completed' : (errorCode === PI_BROWSER_ERROR_CODES.TIMEOUT ? 'timeout' : (errorCode === 'CANCELLED' ? 'cancelled' : 'failed')));
  if (ok) return { ok: true, data: { ...base, ...(data || {}) } };
  return piBrowserError(errorCode || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, message || 'wait failed', { ...base, ...(details || {}) });
}
function rejectIfAborted(record: PiBrowserWaitRecord): void {
  if (record.abortController?.signal?.aborted || record.status === 'cancelled') throw new DOMException(waitAbortMessage(record), 'AbortError');
}
export { WaitCoordinator, cleanupWait, cleanupWaitsForFrame, cleanupWaitsForUninstall, piBrowserWaits, PI_BROWSER_ORPHAN_WAIT_MAX_AGE_MS, cleanupPiBrowserOrphanWaits, piBrowserWaitSeq, PI_BROWSER_DEFAULT_WAIT_TIMEOUT_MS, normalizePiBrowserTimeoutMs, makeWaitId, waitKey, eventSubscriptionKey, isAbortError, waitAbortMessage, normalizeWaitState, registerWait, recordWaitEvent, shouldAbortWaitCleanupReason, clearWait, cleanupPiBrowserWait, isWaitRecordForTab, cleanupTabWaits, cancelWaitsForTab, cleanupEventSubscriptionsForTab, waitWithTimeout, finishPiBrowserWait, rejectIfAborted };
// ESM module boundary marker for TODO 189
export const __piBridgeModule_wait_coordinator = { name: "wait_coordinator", symbols: { WaitCoordinator, cleanupWait, cleanupWaitsForFrame, cleanupWaitsForUninstall, piBrowserWaits, PI_BROWSER_ORPHAN_WAIT_MAX_AGE_MS, cleanupPiBrowserOrphanWaits, piBrowserWaitSeq, PI_BROWSER_DEFAULT_WAIT_TIMEOUT_MS, normalizePiBrowserTimeoutMs, makeWaitId, waitKey, eventSubscriptionKey, isAbortError, waitAbortMessage, normalizeWaitState, registerWait, recordWaitEvent, shouldAbortWaitCleanupReason, clearWait, cleanupPiBrowserWait, isWaitRecordForTab, cleanupTabWaits, cancelWaitsForTab, cleanupEventSubscriptionsForTab, waitWithTimeout, finishPiBrowserWait, rejectIfAborted } };
