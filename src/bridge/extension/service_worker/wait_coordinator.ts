import { BROWSER_PILOT_ERROR_CODES, browserPilotError } from "./runtimeSupport.js";
import { cleanupBrowserPilotCdpTab, releaseBrowserPilotCdpDomains, rememberBrowserPilotCdpCleanup, unsubscribeBrowserPilotCdp } from "./wait_cdp";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse, BrowserPilotWaitRecord } from "./types";

// wait_coordinator.js - Browser Pilot wait registry, cleanup, timeout and event subscription helpers.
// Loaded after wait_cdp.js and before wait.js by background.js.

type BrowserPilotEventSubscription = JsonRecord & { key?: string; listenerId: string; tabId: number };
type CleanupTabWaitsOptions = { includeCdp?: boolean; action?: string; remember?: boolean };
type TerminalWaitRecord = JsonRecord & { key: string; waitId: string; tabId: number; kind: string; status: string; completedAt: number; criteria: JsonRecord };

const BROWSER_PILOT_TERMINAL_WAIT_MAX_AGE_MS = 300000;
const BROWSER_PILOT_TERMINAL_WAIT_MAX_RECORDS = 200;

class WaitCoordinator {
  activeWaits = new Map<string, BrowserPilotWaitRecord>();
  eventSubscriptions = new Map<string, BrowserPilotEventSubscription>();
  terminalWaits = new Map<string, TerminalWaitRecord>();
  epoch = 0;
  constructor() { this.activeWaits = new Map<string, BrowserPilotWaitRecord>(); this.eventSubscriptions = new Map<string, BrowserPilotEventSubscription>(); this.terminalWaits = new Map<string, TerminalWaitRecord>(); this.epoch = 0; }
  makeWaitId(tabId: unknown, kind: unknown): string { return makeWaitId(tabId, kind); }
  waitKey(tabId: unknown, waitId: unknown): string { return waitKey(tabId, waitId); }
  eventSubscriptionKey(tabId: unknown, listenerId: unknown): string { return eventSubscriptionKey(tabId, listenerId); }
  register(record: BrowserPilotWaitRecord): BrowserPilotWaitRecord {
    const key = record.key || waitKey(record.tabId, record.wait_id || record.waitId);
    record.key = key;
    this.activeWaits.set(key, record);
    return record;
  }
  get(key: string): BrowserPilotWaitRecord | undefined { return this.activeWaits.get(key); }
  set(key: string, record: BrowserPilotWaitRecord): this { this.activeWaits.set(key, record); return this; }
  has(key: string): boolean { return this.activeWaits.has(key); }
  delete(key: string): boolean { return this.activeWaits.delete(key); }
  rememberTerminal(record: BrowserPilotWaitRecord, status: string, details: JsonRecord = {}): TerminalWaitRecord {
    const terminal = terminalWaitRecord(record, status, details);
    this.terminalWaits.set(terminal.key, terminal);
    this.pruneTerminal();
    return terminal;
  }
  terminal(waitId: unknown, tabId?: unknown): TerminalWaitRecord | null {
    this.pruneTerminal();
    if (tabId !== undefined && tabId !== null) return this.terminalWaits.get(waitKey(tabId, waitId)) || null;
    const matches = Array.from(this.terminalWaits.values()).filter(w => String(w.waitId) === String(waitId));
    return matches.length === 1 ? matches[0] : null;
  }
  terminalValues(tabId?: unknown): TerminalWaitRecord[] {
    this.pruneTerminal();
    return Array.from(this.terminalWaits.values()).filter(w => tabId === undefined || tabId === null || Number(w.tabId) === Number(tabId));
  }
  pruneTerminal(): void {
    const now = Date.now();
    for (const [key, wait] of Array.from(this.terminalWaits.entries())) if (now - Number(wait.completedAt || 0) > BROWSER_PILOT_TERMINAL_WAIT_MAX_AGE_MS) this.terminalWaits.delete(key);
    const overflow = this.terminalWaits.size - BROWSER_PILOT_TERMINAL_WAIT_MAX_RECORDS;
    if (overflow > 0) for (const key of Array.from(this.terminalWaits.keys()).slice(0, overflow)) this.terminalWaits.delete(key);
  }
  values(): IterableIterator<BrowserPilotWaitRecord> { return this.activeWaits.values(); }
  entries(): IterableIterator<[string, BrowserPilotWaitRecord]> { return this.activeWaits.entries(); }
  keys(): IterableIterator<string> { return this.activeWaits.keys(); }
  get size() { return this.activeWaits.size; }
  [Symbol.iterator](): IterableIterator<[string, BrowserPilotWaitRecord]> { return this.activeWaits[Symbol.iterator](); }
  registerEventSubscription(listenerId: unknown, sub: BrowserPilotEventSubscription): BrowserPilotEventSubscription {
    const key = eventSubscriptionKey(sub.tabId, listenerId);
    sub.key = key;
    this.eventSubscriptions.set(key, sub);
    return sub;
  }
  eventSubscription(listenerId: unknown, tabId?: unknown): BrowserPilotEventSubscription | null {
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
  eventSubscriptionValues(): IterableIterator<BrowserPilotEventSubscription> { return this.eventSubscriptions.values(); }
  cleanupEventSubscriptionsForTab(tabId: unknown): number {
    let n = 0;
    for (const [listenerId, sub] of Array.from(this.eventSubscriptions.entries())) {
      if (Number(sub.tabId) === Number(tabId)) { this.eventSubscriptions.delete(listenerId); n++; }
    }
    return n;
  }
  cleanupWait(record: BrowserPilotWaitRecord, reason?: string): void { return cleanupWait(record, reason); }
  cleanupWaitsForFrame(tabId: unknown, frameId: unknown, reason?: string): number { return cleanupWaitsForFrame(tabId, frameId, reason); }
  cleanupWaitsForUninstall(tabId: unknown): number { return cleanupWaitsForUninstall(tabId); }
  diagnostics(tabId?: unknown) { const scopedEvents = Array.from(this.eventSubscriptions.values()).filter(s => !tabId || Number(s.tabId) === Number(tabId)); return { activeWaits: Array.from(this.activeWaits.values()).filter(w => !tabId || Number(w.tabId) === Number(tabId)).map(w => ({ wait_id: w.wait_id || w.waitId, request_id: w.request_id || w.requestId, kind: w.kind, epoch: w.epoch, diagnostics: w.diagnostics || {} })), recentWaits: this.terminalValues(tabId).slice(-20), eventSubscriptions: scopedEvents.length, epoch: this.epoch }; }
}
function cleanupWait(record: BrowserPilotWaitRecord, reason?: string): void { return cleanupBrowserPilotWait(record, reason); }
function cleanupWaitsForFrame(tabId: unknown, frameId: unknown, reason?: string): number { let n = 0; for (const r of Array.from(browserPilotWaits.values())) if (Number(r.tabId) === Number(tabId) && String(r.frameId || '') === String(frameId || '')) { cleanupBrowserPilotWait(r, reason || 'FRAME_DETACHED'); n++; } return n; }
function cleanupWaitsForUninstall(tabId: unknown): number { cleanupEventSubscriptionsForTab(tabId); return cancelWaitsForTab(tabId, 'uninstall'); }

const browserPilotWaits = new WaitCoordinator();
// Map-like registry used by the wait handlers below.
const BROWSER_PILOT_ORPHAN_WAIT_MAX_AGE_MS = 300000;
function cleanupBrowserPilotOrphanWaits(reason?: string, maxAgeMs?: unknown): number {
  const now = Date.now();
  const limit = Number.isFinite(Number(maxAgeMs)) ? Number(maxAgeMs) : BROWSER_PILOT_ORPHAN_WAIT_MAX_AGE_MS;
  let cleaned = 0;
  for (const record of Array.from(browserPilotWaits.values())) {
    const age = now - Number(record.createdAt || now);
    if (!record || record.status === 'cleaned') continue;
    if (limit >= 0 && age < limit) continue;
    try {
      record.abortController?.abort(reason || 'orphan_cleanup');
    } catch (_error) {
      /* best-effort orphan wait abort */
    }
    try {
      clearWait(record, reason || 'orphan_cleanup');
      cleaned += 1;
    } catch (_error) {
      /* best-effort orphan wait cleanup */
    }
  }
  if (cleaned) rememberBrowserPilotCdpCleanup({ reason: reason || 'orphan_cleanup', orphan_waits: cleaned });
  return cleaned;
}
try {
  const waitGlobal = self as typeof self & { __browserPilotUnhandledRejectionCleanupInstalled?: boolean };
  if (typeof self !== 'undefined' && self.addEventListener && !waitGlobal.__browserPilotUnhandledRejectionCleanupInstalled) {
    waitGlobal.__browserPilotUnhandledRejectionCleanupInstalled = true;
    self.addEventListener('unhandledrejection', () => {
      try {
        cleanupBrowserPilotOrphanWaits('unhandledRejection', 0);
      } catch (_error) {
        /* best-effort orphan wait cleanup on unhandled rejection */
      }
    });
  }
} catch (_error) {
  /* best-effort unhandled rejection cleanup bootstrap */
}
let browserPilotWaitSeq = 0;
const BROWSER_PILOT_DEFAULT_WAIT_TIMEOUT_MS = 30000;
function normalizeBrowserPilotTimeoutMs(msg: BrowserPilotBridgeCommand | null | undefined, fallback = BROWSER_PILOT_DEFAULT_WAIT_TIMEOUT_MS): number {
  const hasExplicit = msg && (msg.timeoutMs !== undefined || msg.timeout_ms !== undefined || msg.timeout !== undefined);
  if (hasExplicit && Number(msg.timeoutMs ?? msg.timeout_ms ?? msg.timeout) === 0) return 0;
  const raw = msg?.timeoutMs ?? msg?.timeout_ms ?? msg?.timeout ?? fallback ?? BROWSER_PILOT_DEFAULT_WAIT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback === 0 ? 0 : (fallback || BROWSER_PILOT_DEFAULT_WAIT_TIMEOUT_MS);
  if (n === 0) return 0;
  return Math.max(50, Math.min(300000, Math.floor(n)));
}
function makeWaitId(tabId: unknown, kind: unknown): string { return 'wait_' + Number(tabId) + '_' + String(kind || 'generic') + '_' + Date.now() + '_' + (++browserPilotWaitSeq); }
function waitKey(tabId: unknown, waitId: unknown): string { return Number(tabId) + ':' + String(waitId); }
function eventSubscriptionKey(tabId: unknown, listenerId: unknown): string { return Number(tabId) + '::' + String(listenerId); }
function terminalWaitRecord(record: BrowserPilotWaitRecord, status: string, details: JsonRecord = {}): TerminalWaitRecord {
  return {
    key: record.key || waitKey(record.tabId, record.waitId),
    waitId: String(record.waitId || record.wait_id || ''),
    wait_id: String(record.wait_id || record.waitId || ''),
    requestId: String(record.requestId || record.request_id || ''),
    request_id: String(record.request_id || record.requestId || ''),
    tabId: Number(record.tabId),
    kind: String(record.kind || ''),
    status: String(status || record.status || ''),
    criteria: record.criteria || {},
    createdAt: record.createdAt,
    completedAt: Date.now(),
    elapsed_ms: Date.now() - Number(record.createdAt || Date.now()),
    diagnostics: record.diagnostics || [],
    lastEventAt: record.lastEventAt,
    cdpEvents: Array.isArray(record.cdpEvents) ? record.cdpEvents.slice(-20) : [],
    details,
  };
}
function waitAbortMessage(record: BrowserPilotWaitRecord): string { return 'browserPilot wait ' + record.waitId + ' cancelled'; }
function normalizeWaitState(value: unknown, fallback = 'complete'): string {
  const s = String(value || fallback || '').toLowerCase().replace(/_/g, '');
  if (s === 'domcontentloaded' || s === 'dominteractive') return 'domcontentloaded';
  if (s === 'load' || s === 'loaded') return 'load';
  if (s === 'complete' || s === 'networkalmostidle') return 'complete';
  if (s === 'networkidle') return 'networkidle';
  return s || 'complete';
}
function registerWait(tabId: number, kind: string, criteria: BrowserPilotBridgeCommand = {}): BrowserPilotWaitRecord {
  const waitId = (criteria && (criteria.waitId || criteria.wait_id)) || makeWaitId(tabId, kind);
  const requestId = criteria && (criteria.requestId || criteria.request_id);
  const abortController = criteria?.abortController || new AbortController();
  const record: BrowserPilotWaitRecord = { waitId: String(waitId), wait_id: String(waitId), requestId: requestId ? String(requestId) : '', request_id: requestId ? String(requestId) : '', tabId: Number(tabId), kind, criteria, createdAt: Date.now(), status: 'pending', listeners: [], timers: [], cdpAttached: false, cdpDomains: new Set<string>(), cdpSubscriptions: [], cdpEvents: [], diagnostics: [], lastEventAt: 0, lastError: null, abortController, key: '' };
  record.key = waitKey(tabId, record.waitId);
  // lifecycle identity: key: waitKey(tabId, record.waitId)
  browserPilotWaits.register(record);
  const onAbort = () => { record.status = 'cancelled'; };
  try {
    abortController.signal.addEventListener('abort', onAbort, { once: true });
    record.listeners.push({ remove: () => abortController.signal.removeEventListener('abort', onAbort) });
  } catch (_error) {
    /* best-effort wait abort listener registration */
  }
  return record;
}
function recordWaitEvent(record: BrowserPilotWaitRecord, event?: JsonRecord): void {
  record.lastEventAt = Date.now();
  record.cdpEvents.push({ t: record.lastEventAt, ...(event || {}) });
  if (record.cdpEvents.length > 200) record.cdpEvents.splice(0, record.cdpEvents.length - 200);
}
function shouldAbortWaitCleanupReason(reason?: string): boolean {
  // Completing a wait is cleanup, not cancellation.  Aborting the wait's own
  // controller while finishBrowserPilotWait() is building an OK/TIMEOUT/failed result
  // synchronously fires abort listeners and can race the Promise into returning
  // CANCELLED instead of the terminal result that already happened.
  const r = String(reason || 'cleaned').toLowerCase();
  return !['completed', 'timeout', 'failed', 'cleaned'].includes(r);
}
function clearWait(record: BrowserPilotWaitRecord | null | undefined, reason?: string): void {
  if (!record || record.status === 'cleaned') return;
  if (shouldAbortWaitCleanupReason(reason)) { try { record.abortController?.abort(reason || 'cleaned'); } catch (_) { /* best-effort abort during wait cleanup */ } }
  for (const t of record.timers.splice(0)) { try { clearTimeout(t); } catch (_) { /* best-effort timer cleanup */ } }
  for (const item of record.listeners.splice(0)) { try { item.remove(); } catch (_) { /* best-effort listener cleanup */ } }
  for (const sid of record.cdpSubscriptions.splice(0)) { try { unsubscribeBrowserPilotCdp(sid); } catch (error) { console.warn('[BROWSER-PILOT-WAIT] Failed to unsubscribe CDP wait subscription', sid, error); } }
  releaseBrowserPilotCdpDomains(record, Array.from(record.cdpDomains || []), reason || 'cleaned');
  if (record.cdpAttached) record.cdpAttached = false;
  record.status = reason || record.status || 'cleaned';
  browserPilotWaits.delete(record.key);
}
function cleanupBrowserPilotWait(record: BrowserPilotWaitRecord, reason?: string): void { return clearWait(record, reason); }
function isWaitRecordForTab(record: BrowserPilotWaitRecord | null | undefined, tabId: unknown): boolean { return !!record && Number(record.tabId) === Number(tabId); }
function cleanupTabWaits(tabId: unknown, reason?: string, options: CleanupTabWaitsOptions = {}) {
  const opts = options || {};
  const cleanupReason = reason || 'tab_cleanup';
  const records = Array.from(browserPilotWaits.values()).filter(r => isWaitRecordForTab(r, tabId));
  let cleaned = 0;
  let aborted = 0;
  let orphaned = 0;
  for (const r of records) {
    const wasMissingKey = !r.key || browserPilotWaits.get(r.key) !== r;
    try {
      r.abortController?.abort(cleanupReason);
      aborted += 1;
    } catch (_error) {
      /* best-effort tab wait abort */
    }
    try {
      clearWait(r, cleanupReason);
      cleaned += 1;
    } catch (_error) {
      /* best-effort tab wait cleanup */
    }
    if (wasMissingKey) orphaned += 1;
  }
  // Defensive second pass: clear any wait inserted or left behind while tab cleanup was running.
  for (const [key, r] of Array.from(browserPilotWaits.entries())) {
    if (!isWaitRecordForTab(r, tabId)) continue;
    orphaned += 1;
    try {
      r.abortController?.abort(cleanupReason);
      aborted += 1;
    } catch (_error) {
      /* best-effort orphan wait abort */
    }
    try {
      clearWait(r, cleanupReason);
      cleaned += 1;
    } catch (error) {
      console.warn('[BROWSER-PILOT-WAIT] Failed to clear orphaned wait record', key, error);
      try {
        browserPilotWaits.delete(key);
        cleaned += 1;
      } catch (_cleanupError) {
        /* best-effort orphan registry cleanup */
      }
    }
  }
  if (opts.includeCdp !== false) cleanupBrowserPilotCdpTab(tabId, cleanupReason);
  cleanupEventSubscriptionsForTab(tabId);
  if (cleaned || orphaned || opts.remember !== false) rememberBrowserPilotCdpCleanup({ tabId:Number(tabId), reason: cleanupReason, action: opts.action || 'cleanup_tab_waits', waits_cleaned: cleaned, waits_aborted: aborted, orphan_waits: orphaned, remaining_waits: Array.from(browserPilotWaits.values()).filter(r => isWaitRecordForTab(r, tabId)).length });
  return { tabId:Number(tabId), reason:cleanupReason, cleaned, aborted, orphaned };
}
function cancelWaitsForTab(tabId: unknown, reason?: string): number {
  return cleanupTabWaits(tabId, reason || 'cancelled', { includeCdp: true, action: 'cancel_waits_for_tab' }).cleaned;
}
function cleanupEventSubscriptionsForTab(tabId: unknown): number {
  return browserPilotWaits.cleanupEventSubscriptionsForTab(tabId);
}
function finishBrowserPilotWait(record: BrowserPilotWaitRecord, ok: boolean, data: JsonRecord | null = null, errorCode?: string, message?: string, details: JsonRecord = {}): BrowserPilotBridgeResponse {
  const elapsed_ms = Date.now() - record.createdAt;
  const base = { waitId: record.waitId, nativeWaitId: record.waitId, kind: record.kind, tabId: record.tabId, elapsed_ms, criteria: record.criteria };
  const status = ok ? 'completed' : (errorCode === BROWSER_PILOT_ERROR_CODES.TIMEOUT ? 'timeout' : (errorCode === 'CANCELLED' ? 'cancelled' : 'failed'));
  browserPilotWaits.rememberTerminal(record, status, ok ? (data || {}) : details);
  clearWait(record, status);
  if (ok) return { ok: true, data: { ...base, ...(data || {}) } };
  return browserPilotError(errorCode || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, message || 'wait failed', { ...base, ...(details || {}) });
}
export { WaitCoordinator, cleanupWait, cleanupWaitsForFrame, cleanupWaitsForUninstall, browserPilotWaits, BROWSER_PILOT_ORPHAN_WAIT_MAX_AGE_MS, cleanupBrowserPilotOrphanWaits, browserPilotWaitSeq, BROWSER_PILOT_DEFAULT_WAIT_TIMEOUT_MS, normalizeBrowserPilotTimeoutMs, makeWaitId, waitKey, eventSubscriptionKey, waitAbortMessage, normalizeWaitState, registerWait, recordWaitEvent, shouldAbortWaitCleanupReason, clearWait, cleanupBrowserPilotWait, isWaitRecordForTab, cleanupTabWaits, cancelWaitsForTab, cleanupEventSubscriptionsForTab, finishBrowserPilotWait };
