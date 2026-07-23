import { chromeApi as chrome } from "./runtimeEnv";
import { BROWSER_PILOT_ERROR_CODES, callPageBrowserPilot, normalizePersistentBrowserPilotResponse, browserPilotError, browserPilotPersistentCdp, runtimeErrorMessage as waitErrorMessage, runtimeRecord as waitRecord } from "./runtimeSupport.js";
import { browserPilotSessions } from "./state_store.js";
import { diagnoseBrowserPilotCdpCleanupHistory, diagnoseBrowserPilotCdpDomainRefs, diagnoseBrowserPilotCdpSubscriptions } from "./wait_cdp";
import { cancelWaitsForTab, clearWait, makeWaitId, normalizeBrowserPilotTimeoutMs, browserPilotWaits, waitKey } from "./wait_coordinator";
import { navigateAndWait, waitForLoadState, waitForNavigation } from "./wait_navigation";
import { waitForNetworkIdle } from "./wait_network_idle";
import { waitForSelector } from "./wait_selector";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse } from "./types";

type WaitChild = BrowserPilotBridgeCommand & { cmd?: string; type?: string; kind?: string };
type SettledWait = PromiseSettledResult<BrowserPilotBridgeResponse>;

// wait.js - Browser Pilot wait, event listener and CDP wait coordination commands.

async function waitForAny(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const losers: number[] = [];
  const waits = (Array.isArray(msg.waits) ? msg.waits : Array.isArray(msg.conditions) ? msg.conditions : []) as WaitChild[];
  if (!waits.length) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'wait.any requires waits/conditions', {});
  const parentTimeoutMs = normalizeBrowserPilotTimeoutMs(msg);
  const deadline = Date.now() + parentTimeoutMs;
  const controllers = waits.map(() => new AbortController());
  const childWaitIds = waits.map((w, i) => String((w && (w.waitId || w.wait_id)) || makeWaitId(tabId, 'any_child_' + i)));
  const children = waits.map((w: WaitChild, i: number) => ({ index:i, wait:w, waitId:childWaitIds[i], wait_id:childWaitIds[i] }));
  const childTimeoutMs = (w: WaitChild): number => {
    const requested = normalizeBrowserPilotTimeoutMs(w || {}, parentTimeoutMs);
    const remaining = Math.max(0, deadline - Date.now());
    return Math.min(requested, remaining);
  };
  const cleanupChildRecord = (i: number, reason?: string) => {
    const childKey = waitKey(tabId, childWaitIds[i]);
    const record = browserPilotWaits.get(childKey);
    if (record) {
      try {
        record.abortController?.abort(reason || BROWSER_PILOT_ERROR_CODES.CANCELLED);
      } catch (_error) {
        /* best-effort child wait abort */
      }
      try {
        clearWait(record, reason || BROWSER_PILOT_ERROR_CODES.CANCELLED);
      } catch (_error) {
        /* best-effort child wait cleanup */
      }
    }
  };
  const cleanup = (reason?: string, keepIndex?: number) => {
    controllers.forEach((c: AbortController, i: number) => {
      if (i === keepIndex) return;
      try {
        if (!c.signal.aborted) {
          losers.push(i);
          c.abort(reason || BROWSER_PILOT_ERROR_CODES.CANCELLED);
        }
      } catch (_error) {
        /* best-effort sibling wait abort */
      }
      cleanupChildRecord(i, reason || BROWSER_PILOT_ERROR_CODES.CANCELLED);
    });
  };
  const tasks = waits.map((w: WaitChild, i: number) => dispatchBrowserPilotWait(tabId, { ...w, waitId: childWaitIds[i], wait_id: childWaitIds[i], abortController: controllers[i], timeoutMs: childTimeoutMs(w) }, w.cmd || w.type || w.kind || 'selector').then((result: BrowserPilotBridgeResponse) => { if (result && result.ok) return { index:i, result }; throw result; }));
  let parentTimer: ReturnType<typeof setTimeout> | null = null;
  const parentTimeout = new Promise<never>((_, reject) => { parentTimer = setTimeout(() => {
    cleanup('parent_timeout');
    reject({ error_code: BROWSER_PILOT_ERROR_CODES.TIMEOUT, error: 'wait.any parent timeout', details: { timeout_ms: parentTimeoutMs } });
  }, parentTimeoutMs); });
  try {
    const winner = await Promise.race([Promise.any(tasks), parentTimeout]);
    if (parentTimer) clearTimeout(parentTimer);
    const won = winner as { index: number; result: BrowserPilotBridgeResponse };
    cleanup('winner', won.index);
    return { ok: true, data: { winner: won.index, matched: won.index, result: won.result.data, children, losers, timeout_ms: parentTimeoutMs } };
  }
  catch (e) {
    if (parentTimer) clearTimeout(parentTimer);
    cleanup('failed');
    const aggregateError = waitRecord(e);
    const errors = Array.isArray(aggregateError.errors) ? aggregateError.errors as JsonRecord[] : [waitRecord(e)];
    const firstTimeout = errors.find((x: JsonRecord) => x && (x.error_code === BROWSER_PILOT_ERROR_CODES.TIMEOUT || /timeout|timed out|parent timeout/i.test(String(x.error || x.message || ''))));
    if (firstTimeout) return browserPilotError(BROWSER_PILOT_ERROR_CODES.TIMEOUT, firstTimeout.error || firstTimeout.message || ('wait.any timed out after ' + parentTimeoutMs + 'ms; no condition matched'), { errors, children, losers, timeout_ms: parentTimeoutMs });
    return browserPilotError(BROWSER_PILOT_ERROR_CODES.TIMEOUT, 'wait.any timed out after ' + parentTimeoutMs + 'ms; no condition matched', { errors, children, losers, timeout_ms: parentTimeoutMs });
  }
}
async function waitForAll(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const waits = (Array.isArray(msg.waits) ? msg.waits : Array.isArray(msg.conditions) ? msg.conditions : []) as WaitChild[];
  if (!waits.length) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'wait.all requires waits/conditions', {});
  const parentTimeoutMs = normalizeBrowserPilotTimeoutMs(msg);
  const failFast = msg.failFast !== false && msg.fail_fast !== false;
  const children = waits.map((w: WaitChild, i: number) => ({ index:i, kind:w?.kind || w?.type || w?.cmd || 'selector', timeout_ms: normalizeBrowserPilotTimeoutMs(w || {}, parentTimeoutMs) }));
  const controllers = waits.map(() => new AbortController());
  const cleanup = (reason?: string, exceptIndex = -1) => {
    controllers.forEach((c, i) => {
      try {
        if (i !== exceptIndex && !c.signal.aborted) c.abort(reason || BROWSER_PILOT_ERROR_CODES.CANCELLED);
      } catch (_error) {
        /* best-effort fail-fast abort */
      }
    });
  };
  const deadline = Date.now() + parentTimeoutMs;
  let failureIndex = -1;
  const toResult = (settled: SettledWait, i: number): BrowserPilotBridgeResponse => {
    if (settled.status === 'fulfilled') return settled.value;
    const reason = settled.reason || {};
    return browserPilotError(reason.error_code || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, reason.error || reason.message || 'wait.all child threw', { child_index: i, reason });
  };
  const tasks = waits.map((w: WaitChild, i: number) => dispatchBrowserPilotWait(tabId, { ...w, abortController: controllers[i], timeoutMs: Math.min(normalizeBrowserPilotTimeoutMs(w || {}, parentTimeoutMs), Math.max(0, deadline - Date.now())) }, w.cmd || w.type || w.kind || 'selector')
    .then((result: BrowserPilotBridgeResponse) => {
      if (failFast && (!result || result.ok === false) && failureIndex < 0) { failureIndex = i; cleanup(BROWSER_PILOT_ERROR_CODES.CANCELLED, i); }
      return result;
    }, (error: unknown) => {
      if (failFast && failureIndex < 0) { failureIndex = i; cleanup(BROWSER_PILOT_ERROR_CODES.CANCELLED, i); }
      throw error;
    }));
  const settled = await Promise.allSettled(tasks);
  const results = settled.map(toResult);
  const aggregate = { matched: results.filter((r) => r && r.ok).length, children, results: results.map((r) => (r && (r.data || r)) || r), failFast, failure_index: failureIndex };
  const failures = results.map((r, i) => ({ index: i, result: r })).filter((x) => !x.result || x.result.ok === false);
  if (failures.length) {
    cleanup(BROWSER_PILOT_ERROR_CODES.CANCELLED);
    const first = failures[0];
    return browserPilotError(first.result?.error_code || BROWSER_PILOT_ERROR_CODES.TIMEOUT, 'wait.all condition failed', { failed_index: first.index, failure_index: first.index, failures, children, results, aggregate });
  }
  return { ok: true, data: aggregate };
}
function normalizeBrowserPilotWaitKind(kind: unknown, msg?: BrowserPilotBridgeCommand): string {
  const raw = String(kind || msg?.kind || msg?.type || msg?.cmd || 'selector').trim().replace(/^browserPilot[._-]/i, '');
  const withoutWaitPrefix = raw.replace(/^wait[._-]/i, '');
  return withoutWaitPrefix.replace(/[._-]/g, '').toLowerCase();
}
async function dispatchBrowserPilotWait(tabId: number, msg: BrowserPilotBridgeCommand, kind: unknown): Promise<BrowserPilotBridgeResponse> {
  const k = normalizeBrowserPilotWaitKind(kind, msg);
  if (k === 'waitforloadstate' || k === 'loadstate' || k === 'load' || k === 'domcontentloaded' || k === 'complete') {
    // Ergonomics: agents routinely call loadState with state:"networkidle", conflating the two waits.
    // networkidle is a separate wait kind, not a loadState value -- reroute instead of rejecting with
    // "wait.loadState unsupported state" (observed in a real agent session, 2026-06-05).
    const st = String(msg.state ?? msg.loadState ?? msg.load_state ?? '').replace(/[._-]/g, '').toLowerCase();
    if (st === 'networkidle') return await waitForNetworkIdle(tabId, msg) as BrowserPilotBridgeResponse;
    return await waitForLoadState(tabId, msg) as BrowserPilotBridgeResponse;
  }
  if (k === 'waitfornetworkidle' || k === 'networkidle') return await waitForNetworkIdle(tabId, msg) as BrowserPilotBridgeResponse;
  if (k === 'waitfornavigation' || k === 'navigation') return await waitForNavigation(tabId, msg) as BrowserPilotBridgeResponse;
  if (k === 'waitforselector' || k === 'selector' || k === 'css') return await waitForSelector(tabId, msg) as BrowserPilotBridgeResponse;
  if (k === 'navigateandwait' || k === 'navigate') return await navigateAndWait(tabId, msg) as BrowserPilotBridgeResponse;
  return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'Unknown wait condition: ' + kind, { kind, normalized: k, wait: msg });
}
async function cancelWait(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const waitId = msg.waitId || msg.wait_id;
  let cancelled_count = 0;
  if (waitId) {
    const r = browserPilotWaits.get(waitKey(tabId, waitId));
    if (r) {
      try {
        r.abortController?.abort('cancelled');
      } catch (_error) {
        /* best-effort explicit wait cancellation */
      }
      clearWait(r, 'cancelled');
      cancelled_count = 1;
    }
  }
  else cancelled_count = cancelWaitsForTab(tabId, 'cancelled');
  return { ok: true, data: { cancelled: cancelled_count, cancelled_count, waitId: waitId || null, pending: Array.from(browserPilotWaits.values()).filter(r => Number(r.tabId) === Number(tabId)).map(r => ({ waitId:r.waitId, kind:r.kind, age_ms:Date.now()-r.createdAt })) } };
}

function extractBrowserPilotRuntimeValue(resp: BrowserPilotBridgeResponse): JsonRecord | null {
  const data = waitRecord(resp.data); const result = waitRecord(resp.result); return waitRecord(waitRecord(data.result).result).value as JsonRecord || waitRecord(result.result).value as JsonRecord || waitRecord(data.result).value as JsonRecord || result.value as JsonRecord || null;
}
async function cleanupBrowserPilotPageListenersForTab(tabId: number, reason?: string, timeoutMs?: number): Promise<BrowserPilotBridgeResponse> {
  const cdp = browserPilotPersistentCdp();
  if (!cdp?.send) return { ok: true, data: { tabId:Number(tabId), removed:0, listenerIds:[], skipped:true, reason:reason || 'cleanup', warning:'persistent CDP unavailable' } };
  const expression = `(() => {
    const store = window.__browserPilotListeners || {};
    const listenerIds = Object.keys(store);
    const errors = [];
    let removed = 0;
    for (const listenerId of listenerIds) {
      const rec = store[listenerId];
      try {
        if (rec && rec.target && rec.handler) (rec.target || document).removeEventListener(rec.eventType, rec.handler, rec.capture !== false);
        removed += 1;
      } catch (error) {
        errors.push({ listenerId, message:error && error.message ? error.message : String(error) });
      }
      try { delete store[listenerId]; } catch (_) {}
    }
    return { ok:true, removed, listenerIds, errors, reason:${JSON.stringify(reason || 'cleanup')} };
  })()`;
  const resp = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true }, { persistent: true, name: 'event_listener_cleanup', timeoutMs: timeoutMs || 5000 }));
  if (!resp || resp.ok === false) return resp;
  const pageResult = extractBrowserPilotRuntimeValue(resp) || { ok:true, removed:0, listenerIds:[] };
  return { ok: pageResult.ok !== false, data: { tabId:Number(tabId), reason:reason || 'cleanup', ...pageResult } };
}
async function addEventListener(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const eventType = msg.eventType || msg.event_type;
  if (!eventType) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'hook.addEventListener requires eventType', {});
  const listenerId = msg.listenerId || msg.listener_id || ('listener_' + tabId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2));
  const selector = msg.selector || null;
  const cdp = browserPilotPersistentCdp();
  let pageResult = null;
  if (cdp?.send) {
    const expression = `(() => {
      window.__browserPilotListeners = window.__browserPilotListeners || {};
      const listenerId = ${JSON.stringify(listenerId)};
      const eventType = ${JSON.stringify(eventType)};
      const selector = ${JSON.stringify(selector)};
      const prior = window.__browserPilotListeners[listenerId];
      if (prior && prior.target && prior.handler) { try { prior.target.removeEventListener(prior.eventType, prior.handler, true); } catch (_) {} }
      let target = document;
      if (selector) {
        try { target = document.querySelector(selector); } catch (error) { return { ok:false, code:'INVALID_SELECTOR', message:error && error.message ? error.message : String(error), listenerId, eventType, selector }; }
        if (!target) return { ok:false, code:'ELEMENT_NOT_FOUND', message:'No element matches selector for event listener', listenerId, eventType, selector };
      }
      const handler = function browserPilotEventListener(event) {
        const rec = window.__browserPilotListeners && window.__browserPilotListeners[listenerId];
        if (rec) { rec.lastEventAt = Date.now(); rec.eventCount = (rec.eventCount || 0) + 1; rec.lastEventType = event && event.type; }
      };
      target.addEventListener(eventType, handler, true);
      window.__browserPilotListeners[listenerId] = { listenerId, eventType, selector, target, handler, capture:true, addedAt:Date.now(), eventCount:0 };
      return { ok:true, listenerId, eventType, selector, target: selector || 'document', replaced: !!prior };
    })()`;
    const resp = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true }, { persistent: true, name: 'event_listener', timeoutMs: msg.timeoutMs || 5000 }));
    if (!resp || resp.ok === false) return resp;
    pageResult = extractBrowserPilotRuntimeValue(resp);
    if (pageResult && pageResult.ok === false) return browserPilotError(String(pageResult.code || BROWSER_PILOT_ERROR_CODES.INVALID_RULE), pageResult.message || 'hook.addEventListener failed', pageResult);
  }
  const sub: JsonRecord & { tabId: number; listenerId: string } = { tabId:Number(tabId), listenerId:String(listenerId), eventType, selector, diagnostics: msg.diagnostics || {}, removeEventListener: true };
  browserPilotWaits.registerEventSubscription(listenerId, sub);
  return { ok: true, data: { tabId:Number(tabId), listenerId, listener_id: listenerId, eventType, selector, page: pageResult } };
}
async function removeEventListener(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const listenerId = msg.listenerId || msg.listener_id;
  if (!listenerId) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'hook.removeEventListener requires listenerId', {});
  const existingSub = browserPilotWaits.eventSubscription(listenerId, tabId);
  const cdp = browserPilotPersistentCdp();
  let pageRemoved = false;
  let pageResult = null;
  if (cdp?.send) {
    const expression = `(() => {
      const listenerId = ${JSON.stringify(listenerId)};
      const store = window.__browserPilotListeners || {};
      const rec = store[listenerId];
      if (!rec) return { removed:false, listenerId };
      try { (rec.target || document).removeEventListener(rec.eventType, rec.handler, rec.capture !== false); } catch (_) {}
      delete store[listenerId];
      return { removed:true, listenerId, eventType:rec.eventType, selector:rec.selector || null, eventCount:rec.eventCount || 0 };
    })()`;
    const resp = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true }, { persistent: true, name: 'event_listener_remove', timeoutMs: msg.timeoutMs || 5000 }));
    if (!resp || resp.ok === false) return resp;
    pageResult = extractBrowserPilotRuntimeValue(resp);
    pageRemoved = pageResult?.removed === true;
  }
  const existed = existingSub ? browserPilotWaits.deleteEventSubscription(listenerId, tabId) : false;
  return { ok: true, data: { tabId:Number(tabId), listenerId, listener_id: listenerId, removed: existed || pageRemoved, registry_removed: existed, page_removed: pageRemoved, page: pageResult } };
}
async function getPerformanceEntries(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const input = msg || {};
  const hasEntryType = input.entryType !== undefined || input.entry_type !== undefined;
  const entryType = String(hasEntryType ? (input.entryType ?? input.entry_type) : 'resource');
  const nameContains = String(input.nameContains ?? input.name_contains ?? '');
  const timeoutMs = normalizeBrowserPilotTimeoutMs(input, 5000);
  const expression = `(() => { const entries = performance.getEntriesByType(${JSON.stringify(entryType)}); return entries.filter(e => !${JSON.stringify(nameContains)} || String(e.name||'').includes(${JSON.stringify(nameContains)})).map(e => ({ name:e.name, entryType:e.entryType, startTime:e.startTime, duration:e.duration, initiatorType:e.initiatorType || null, transferSize:e.transferSize || 0, encodedBodySize:e.encodedBodySize || 0, decodedBodySize:e.decodedBodySize || 0 })); })()`;
  const cdp = browserPilotPersistentCdp();
  if (cdp?.send) {
    const resp = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true }, { persistent: true, name: 'performance_entries', timeoutMs }));
    if (!resp || resp.ok === false) return resp;
    const result = waitRecord(waitRecord(resp.data).result || resp.result || resp.data);
    const exceptionDetails = waitRecord(result.exceptionDetails);
    if (result.exceptionDetails) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, waitRecord(exceptionDetails.exception).description || 'Runtime.evaluate failed', exceptionDetails);
    const value = waitRecord(result.result).value;
    const entries = Array.isArray(value) ? value : [];
    return { ok: true, data: { entries, entryType, nameContains, count: entries.length, explicit_entry_type: hasEntryType, native_cmd: 'hook.getPerformanceEntries' } };
  }
  return { ok: true, data: { entries: [], entryType, nameContains, count: 0, explicit_entry_type: hasEntryType, note: 'PerformanceObserver performance.getEntriesByType Runtime.evaluate unavailable' } };
}

function selectorDiagnoseExpression(selector: string): string {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    function cleanText(value, limit) { return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit); }
    function compactNode(node) {
      if (!node) return null;
      let rect = null;
      try { const r = node.getBoundingClientRect ? node.getBoundingClientRect() : null; if (r) rect = { x:r.x, y:r.y, width:r.width, height:r.height, top:r.top, left:r.left, right:r.right, bottom:r.bottom }; } catch (_) {}
      let style = null;
      try { style = window.getComputedStyle ? window.getComputedStyle(node) : null; } catch (_) {}
      const display = style ? String(style.display || '') : '';
      const visibility = style ? String(style.visibility || '') : '';
      const opacity = style ? Number(style.opacity === '' || style.opacity === undefined ? 1 : style.opacity) : 1;
      const visible = !!(rect && (rect.width || rect.height) && display !== 'none' && visibility !== 'hidden' && opacity !== 0);
      return { tagName: node.tagName ? String(node.tagName).toLowerCase() : '', id: node.id || '', role: node.getAttribute && node.getAttribute('role') || '', name: node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('name')) || '', text: cleanText(node.innerText || node.textContent || '', 160), visible, rect };
    }
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(selector)); }
    catch (e) { return { selector, validSyntax:false, syntaxError: String(e && (e.message || e) || e), matchCount:0, readyState:document.readyState }; }
    return { selector, validSyntax:true, matchCount:nodes.length, visibleCount:nodes.filter(node => compactNode(node)?.visible).length, firstMatch: compactNode(nodes[0]), sampleMatches:nodes.slice(0,5).map(compactNode), readyState:document.readyState, visibilityState:document.visibilityState };
  })()`;
}

async function diagnoseSelectorForWait(tabId: number, msg: BrowserPilotBridgeCommand): Promise<JsonRecord | null> {
  const waitId = msg.waitId ?? msg.wait_id;
  const terminal = waitId ? browserPilotWaits.terminal(waitId, tabId) : null;
  const active = waitId ? browserPilotWaits.get(waitKey(tabId, waitId)) : null;
  const source = active || terminal || null;
  const criteria = waitRecord(source?.criteria);
  const details = waitRecord(source?.details);
  const explicitSelector = typeof msg.selector === 'string' ? msg.selector : '';
  const selector = String(explicitSelector || criteria.selector || criteria.css || criteria.target || '').trim();
  if (!selector) return waitId ? { waitId:String(waitId), foundWait:false, selector:null, note:'no selector was found for waitId; pass selector explicitly for selector diagnostics' } : null;
  const probe = await callPageBrowserPilot(tabId, 'hook.evaluate', { expression: selectorDiagnoseExpression(selector) }).catch((e: unknown) => browserPilotError(BROWSER_PILOT_ERROR_CODES.NO_SESSION, waitErrorMessage(e), {}));
  const data = waitRecord(waitRecord(probe.data).result || probe.data || probe.result);
  return {
    waitId: waitId ? String(waitId) : undefined,
    foundWait: !!source,
    waitStatus: source?.status,
    kind: source?.kind,
    selector,
    expectedState: criteria.state || (criteria.visible === true ? 'visible' : undefined),
    lastState: details.last_state || details.snapshot || null,
    current: data,
    recoveryCommands: [
      `browser_observe to refresh selectors around ${selector}`,
      `browser_command html.get with selector=${selector} can inspect the current DOM match`,
      'use browser_command frame.list when iframe placement is suspected',
    ],
  };
}

async function diagnoseBrowserPilot(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const tab = await chrome.tabs.get(tabId).catch((e: unknown) => ({ error: waitErrorMessage(e) }));
  const status = await callPageBrowserPilot(tabId, 'hook.status', {}).catch((e: unknown) => browserPilotError(BROWSER_PILOT_ERROR_CODES.NO_SESSION, waitErrorMessage(e), {}));
  const cdp = browserPilotPersistentCdp();
  let debuggerTargets: JsonRecord[] = [];
  let frames: JsonRecord[] = [];
  let frameCount = 0;
  let iframeCount = 0;
  let inflight = 0;
  let readyState = null;
  let last_errors: unknown[] = [];
  const statusData = waitRecord(status.data || status.result);
  // installed_marker is an active-session marker, not a dispatcher-loaded marker.
  // hook.status can still return ok after hook.uninstall because the page dispatcher
  // remains loaded in a CLOSED/NO_SESSION state for explicit post-uninstall diagnostics.
  const installed_marker = !!(status && status.ok && statusData.session_id && !['CLOSED', 'CREATED'].includes(String(statusData.state || '').toUpperCase()));
  const dispatcher_version = statusData.dispatcher_version || statusData.browser_pilot_version || null;
  const install_epoch = statusData.install_epoch || 0;
  const owner_session_id = statusData.owner_session_id || null;
  const install_fingerprint = statusData.install_fingerprint || '';
  const cleanup_warnings = Array.isArray(statusData.cleanup_warnings) ? statusData.cleanup_warnings : [];
  const residue_signatures = Array.isArray(statusData.residue_signatures) ? statusData.residue_signatures : [];
  const version = 'wait-goal-v1';
  const epoch = Date.now();
  const activeWaits = Array.from(browserPilotWaits.values()).filter(r => Number(r.tabId) === Number(tabId)).map(r => ({ waitId:r.waitId, kind:r.kind, criteria:r.criteria, age_ms:Date.now()-r.createdAt, status:r.status, cdpSubscriptions:r.cdpSubscriptions, lastEventAt:r.lastEventAt, diagnostics:r.diagnostics }));
  const recentWaits = browserPilotWaits.terminalValues(tabId).slice(-20);
  const selectorDiagnostics = await diagnoseSelectorForWait(tabId, msg || {}).catch((e: unknown) => ({ error: waitErrorMessage(e) }));
  const listeners = Array.from(browserPilotWaits.eventSubscriptionValues()).filter(s => Number(s.tabId) === Number(tabId)).map(s => ({ listenerId:s.listenerId, eventType:s.eventType, selector:s.selector, diagnostics:s.diagnostics }));
  const diagnostics = browserPilotWaits.diagnostics(tabId);
  try { if (chrome.debugger?.getTargets) debuggerTargets = (await chrome.debugger.getTargets()).filter((t: JsonRecord) => Number(t.tabId) === Number(tabId)); } catch (e) { last_errors.push(waitErrorMessage(e)); }
  try {
    const probe = await callPageBrowserPilot(tabId, 'hook.evaluate', { expression: `(() => {
      const nodes = Array.from(document.querySelectorAll ? document.querySelectorAll('iframe') : []);
      const frameCount = window.frames ? Number(window.frames.length || 0) : nodes.length;
      const frames = nodes.map((node, index) => {
        let rect = null;
        try {
          const r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
          if (r) rect = { x:r.x, y:r.y, top:r.top, left:r.left, right:r.right, bottom:r.bottom, width:r.width, height:r.height };
        } catch (_) {}
        let style = null;
        try { style = window.getComputedStyle ? window.getComputedStyle(node) : null; } catch (_) {}
        const width = rect ? Number(rect.width || 0) : 0;
        const height = rect ? Number(rect.height || 0) : 0;
        const display = style ? String(style.display || '') : '';
        const visibility = style ? String(style.visibility || '') : '';
        const opacity = style ? Number(style.opacity === '' || style.opacity === undefined ? 1 : style.opacity) : 1;
        return {
          index,
          id: node.id || '',
          name: (node.getAttribute && node.getAttribute('name')) || node.name || '',
          src: (node.getAttribute && node.getAttribute('src')) || node.src || '',
          title: (node.getAttribute && node.getAttribute('title')) || node.title || '',
          loading: (node.getAttribute && node.getAttribute('loading')) || node.loading || '',
          visible: width > 0 && height > 0 && display !== 'none' && visibility !== 'hidden' && opacity !== 0,
          rect
        };
      });
      return { readyState: document.readyState, frameCount, iframeCount: frames.length, frames, inflight: (window.__browserPilotInflight || 0), last_errors: window.__browserPilotLastErrors || [] };
    })()` }).catch((e: unknown) => browserPilotError(BROWSER_PILOT_ERROR_CODES.NO_SESSION, waitErrorMessage(e), {}));
    const data = waitRecord(waitRecord(probe.data).result || probe.data || probe.result);
    readyState = data.readyState || readyState;
    frames = Array.isArray(data.frames) ? data.frames : frames;
    frameCount = Number(data.frameCount || frames.length || 0);
    iframeCount = Number(data.iframeCount || frames.length || 0);
    inflight = Number(data.inflight || inflight || 0);
    if (Array.isArray(data.last_errors)) last_errors = last_errors.concat(data.last_errors);
  } catch (e) { last_errors.push(waitErrorMessage(e)); }
  const cdpObservability = {
    active_subscriptions: diagnoseBrowserPilotCdpSubscriptions(tabId),
    domain_refs: diagnoseBrowserPilotCdpDomainRefs(tabId),
    cleanup_history: diagnoseBrowserPilotCdpCleanupHistory(tabId),
  };
  const activeCdpSubscriptions = cdpObservability.active_subscriptions;
  const cdpDomainRefs = cdpObservability.domain_refs;
  const cdpCleanupHistory = cdpObservability.cleanup_history;
  const cdpLeaks = {
    domain_ref_leaks: cdpDomainRefs.filter(r => r.count > 0 && !r.holders.length),
    subscription_leaks: activeCdpSubscriptions.filter(s => s.waitId && !browserPilotWaits.has(waitKey(s.tabId, s.waitId))),
  };
  return { ok: true, data: { tabId:Number(tabId), tab, sessions: Array.from(browserPilotSessions.entries()).map(([tid, s]) => ({ tabId: tid, ...s })), session: browserPilotSessions.get(Number(tabId)) || null, waits: activeWaits, activeWaits, recentWaits, selectorDiagnostics, listeners, frames, frameCount, iframeCount, inflight, readyState, last_errors, installed_marker, dispatcher_version, install_epoch, owner_session_id, install_fingerprint, cleanup_warnings, residue_signatures, version, epoch, diagnostics, cdp: { persistent: !!cdp, debuggerTargets, ...cdpObservability, leaks: cdpLeaks }, active_subscriptions: activeCdpSubscriptions, cdp_domain_refs: cdpDomainRefs, cdp_cleanup_history: cdpCleanupHistory, domain_ref_leaks: cdpLeaks.domain_ref_leaks, subscription_leaks: cdpLeaks.subscription_leaks, debuggerTargets, dispatcher: status, persistent_cdp: !!cdp, timestamp: new Date(epoch).toISOString() } };
}
export { waitForAny, waitForAll, normalizeBrowserPilotWaitKind, dispatchBrowserPilotWait, cancelWait, extractBrowserPilotRuntimeValue, cleanupBrowserPilotPageListenersForTab, addEventListener, removeEventListener, getPerformanceEntries, diagnoseBrowserPilot };
