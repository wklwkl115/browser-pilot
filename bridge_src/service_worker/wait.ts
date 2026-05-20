import { chromeApi as chrome } from "./runtimeEnv";
import { PI_BROWSER_ERROR_CODES, callPagePiBrowser, getPiBrowserQueueStats, normalizePersistentPiBrowserResponse, piBrowserError, piBrowserPersistentCdp, piBrowserSessions } from "./runtime";
import { diagnosePiBrowserCdpCleanupHistory, diagnosePiBrowserCdpDomainRefs, diagnosePiBrowserCdpSubscriptions } from "./wait_cdp";
import { cancelWaitsForTab, clearWait, cleanupTabWaits, finishPiBrowserWait, makeWaitId, normalizePiBrowserTimeoutMs, piBrowserWaits, waitAbortMessage, waitKey } from "./wait_coordinator";
import { navigateAndWait, waitForLoadState, waitForNavigation } from "./wait_navigation";
import { waitForNetworkIdle } from "./wait_network_idle";
import { waitForSelector } from "./wait_selector";

// wait.js - Pi browser native wait, event listener and CDP wait coordination commands.

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
  const cleanup = (reason, keepIndex = undefined) => {
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
  if (!waits.length) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'wait.all requires waits/conditions', {});
  const parentTimeoutMs = normalizePiBrowserTimeoutMs(msg);
  const failFast = msg.failFast !== false && msg.fail_fast !== false;
  const children = waits.map((w, i) => ({ index:i, kind:w?.kind || w?.type || w?.cmd || 'selector', timeout_ms: normalizePiBrowserTimeoutMs(w || {}, parentTimeoutMs) }));
  const controllers = waits.map(() => new AbortController());
  const cleanup = (reason = undefined, exceptIndex = -1) => { controllers.forEach((c, i) => { try { if (i !== exceptIndex && !c.signal.aborted) c.abort(reason || PI_BROWSER_ERROR_CODES.CANCELLED); } catch (_) {} }); };
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
function normalizePiBrowserWaitKind(kind, msg) {
  const raw = String(kind || msg?.kind || msg?.type || msg?.cmd || 'selector').trim().replace(/^piBrowser[._-]/i, '');
  const withoutWaitPrefix = raw.replace(/^wait[._-]/i, '');
  return withoutWaitPrefix.replace(/[._-]/g, '').toLowerCase();
}
async function dispatchPiBrowserWait(tabId, msg, kind) {
  const k = normalizePiBrowserWaitKind(kind, msg);
  if (k === 'waitforloadstate' || k === 'loadstate' || k === 'load' || k === 'domcontentloaded' || k === 'complete') return await waitForLoadState(tabId, msg);
  if (k === 'waitfornetworkidle' || k === 'networkidle') return await waitForNetworkIdle(tabId, msg);
  if (k === 'waitfornavigation' || k === 'navigation') return await waitForNavigation(tabId, msg);
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

function extractPiBrowserRuntimeValue(resp) {
  return resp?.data?.result?.result?.value || resp?.result?.result?.value || resp?.data?.result?.value || resp?.result?.value || null;
}
async function cleanupPiBrowserPageListenersForTab(tabId, reason, timeoutMs = undefined) {
  const cdp = piBrowserPersistentCdp();
  if (!cdp?.send) return { ok: true, data: { tabId:Number(tabId), removed:0, listenerIds:[], skipped:true, reason:reason || 'cleanup', warning:'persistent CDP unavailable' } };
  const expression = `(() => {
    const store = window.__piBrowserListeners || {};
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
  const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true }, { persistent: true, name: 'event_listener_cleanup', timeoutMs: timeoutMs || 5000 }));
  if (!resp || resp.ok === false) return resp;
  const pageResult = extractPiBrowserRuntimeValue(resp) || { ok:true, removed:0, listenerIds:[] };
  return { ok: pageResult.ok !== false, data: { tabId:Number(tabId), reason:reason || 'cleanup', ...pageResult } };
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
    pageResult = extractPiBrowserRuntimeValue(resp);
    if (pageResult && pageResult.ok === false) return piBrowserError(pageResult.code || PI_BROWSER_ERROR_CODES.INVALID_RULE, pageResult.message || 'hook.addEventListener failed', pageResult);
  }
  const sub = { tabId:Number(tabId), listenerId:String(listenerId), eventType, selector, diagnostics: msg.diagnostics || {}, removeEventListener: true };
  piBrowserWaits.registerEventSubscription(listenerId, sub);
  return { ok: true, data: { tabId:Number(tabId), listenerId, listener_id: listenerId, eventType, selector, page: pageResult } };
}
async function removeEventListener(tabId, msg) {
  const listenerId = msg.listenerId || msg.listener_id;
  if (!listenerId) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'hook.removeEventListener requires listenerId', {});
  const existingSub = piBrowserWaits.eventSubscription(listenerId, tabId);
  const cdp = piBrowserPersistentCdp();
  let pageRemoved = false;
  let pageResult = null;
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
    pageResult = extractPiBrowserRuntimeValue(resp);
    pageRemoved = pageResult?.removed === true;
  }
  const existed = existingSub ? piBrowserWaits.deleteEventSubscription(listenerId, tabId) : false;
  return { ok: true, data: { tabId:Number(tabId), listenerId, listener_id: listenerId, removed: existed || pageRemoved, registry_removed: existed, page_removed: pageRemoved, page: pageResult } };
}
async function getPerformanceEntries(tabId, msg) {
  const input = msg || {};
  const hasEntryType = input.entryType !== undefined || input.entry_type !== undefined;
  const entryType = String(hasEntryType ? (input.entryType ?? input.entry_type) : 'resource');
  const nameContains = String(input.nameContains ?? input.name_contains ?? '');
  const timeoutMs = normalizePiBrowserTimeoutMs(input, 5000);
  const expression = `(() => { const entries = performance.getEntriesByType(${JSON.stringify(entryType)}); return entries.filter(e => !${JSON.stringify(nameContains)} || String(e.name||'').includes(${JSON.stringify(nameContains)})).map(e => ({ name:e.name, entryType:e.entryType, startTime:e.startTime, duration:e.duration, initiatorType:e.initiatorType || null, transferSize:e.transferSize || 0, encodedBodySize:e.encodedBodySize || 0, decodedBodySize:e.decodedBodySize || 0 })); })()`;
  const cdp = piBrowserPersistentCdp();
  if (cdp?.send) {
    const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true }, { persistent: true, name: 'performance_entries', timeoutMs }));
    if (!resp || resp.ok === false) return resp;
    const result = resp.data?.result || resp.result || resp.data;
    if (result?.exceptionDetails) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, result.exceptionDetails.exception?.description || 'Runtime.evaluate failed', result.exceptionDetails);
    const entries = Array.isArray(result?.result?.value) ? result.result.value : [];
    return { ok: true, data: { entries, entryType, nameContains, count: entries.length, explicit_entry_type: hasEntryType, native_cmd: 'hook.getPerformanceEntries' } };
  }
  return { ok: true, data: { entries: [], entryType, nameContains, count: 0, explicit_entry_type: hasEntryType, note: 'PerformanceObserver performance.getEntriesByType Runtime.evaluate unavailable' } };
}

async function diagnosePiBrowser(tabId, msg) {
  const tab = await chrome.tabs.get(tabId).catch(e => ({ error: e.message || String(e) }));
  const status = await callPagePiBrowser(tabId, 'hook.status', {}).catch(e => piBrowserError(PI_BROWSER_ERROR_CODES.NO_SESSION, e.message || String(e), {}));
  const cdp = piBrowserPersistentCdp();
  let debuggerTargets = [];
  let frames = [];
  let frameCount = 0;
  let iframeCount = 0;
  let inflight = 0;
  let readyState = null;
  let last_errors = [];
  const statusData = /** @type {PiBridgeData} */ ((status && status.data && typeof status.data === 'object') ? status.data : ((status && status.result && typeof status.result === 'object') ? status.result : {}));
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
  try { if (chrome.debugger?.getTargets) debuggerTargets = (await chrome.debugger.getTargets()).filter(t => Number(t.tabId) === Number(tabId)); } catch (e) { last_errors.push(e.message || String(e)); }
  try {
    const probe = /** @type {PiBridgeResponse} */ (await callPagePiBrowser(tabId, 'hook.evaluate', { expression: `(() => {
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
      return { readyState: document.readyState, frameCount, iframeCount: frames.length, frames, inflight: (window.__piBrowserInflight || 0), last_errors: window.__piBrowserLastErrors || [] };
    })()` }).catch(e => ({ ok:false, error:e.message || String(e) })));
    const data = /** @type {PiBridgeData} */ (probe?.data?.result || probe?.data || probe?.result || {});
    readyState = data.readyState || readyState;
    frames = Array.isArray(data.frames) ? data.frames : frames;
    frameCount = Number(data.frameCount || frames.length || 0);
    iframeCount = Number(data.iframeCount || frames.length || 0);
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
  return { ok: true, data: { tabId:Number(tabId), tab, sessions: Array.from(piBrowserSessions.entries()).map(([tid, s]) => ({ tabId: tid, ...s })), session: piBrowserSessions.get(Number(tabId)) || null, queue: getPiBrowserQueueStats(tabId), waits: activeWaits, activeWaits, listeners, frames, frameCount, iframeCount, inflight, readyState, last_errors, installed_marker, dispatcher_version, install_epoch, owner_session_id, install_fingerprint, cleanup_warnings, residue_signatures, version, epoch, diagnostics, cdp: { persistent: !!cdp, debuggerTargets, ...cdpObservability, leaks: cdpLeaks }, active_subscriptions: activeCdpSubscriptions, cdp_domain_refs: cdpDomainRefs, cdp_cleanup_history: cdpCleanupHistory, domain_ref_leaks: cdpLeaks.domain_ref_leaks, subscription_leaks: cdpLeaks.subscription_leaks, debuggerTargets, dispatcher: status, persistent_cdp: !!cdp, timestamp: new Date(epoch).toISOString() } };
}
export { waitForAny, waitForAll, waitForComposite, normalizePiBrowserWaitKind, dispatchPiBrowserWait, cancelWait, cancelPiBrowserWait, extractPiBrowserRuntimeValue, cleanupPiBrowserPageListenersForTab, addEventListener, removeEventListener, getPerformanceEntries, diagnosePiBrowser };
// ESM module boundary marker for TODO 189
export const __piBridgeModule_wait = { name: "wait", symbols: { waitForAny, waitForAll, waitForComposite, normalizePiBrowserWaitKind, dispatchPiBrowserWait, cancelWait, cancelPiBrowserWait, extractPiBrowserRuntimeValue, cleanupPiBrowserPageListenersForTab, addEventListener, removeEventListener, getPerformanceEntries, diagnosePiBrowser } };
