import { chromeApi as chrome } from "./runtimeEnv";
import { PI_BROWSER_ERROR_CODES, normalizePersistentPiBrowserResponse, piBrowserError, piBrowserEval, piBrowserPersistentCdp } from "./runtime";
import { enablePiBrowserCdpDomains, subscribePiBrowserCdp } from "./wait_cdp";
import { cleanupTabWaits, finishPiBrowserWait, makeWaitId, normalizePiBrowserTimeoutMs, normalizeWaitState, recordWaitEvent, registerWait, waitAbortMessage } from "./wait_coordinator";
import { waitForNetworkIdle } from "./wait_network_idle";
import { waitForSelector } from "./wait_selector";
import type { JsonRecord, PiBridgeCommand, PiBridgeResponse, PiChromeTab } from "./types";

type LoadMetrics = JsonRecord & { readyState?: string; url?: string; title?: string; domContentLoaded?: boolean; load?: boolean };
type NavigationDetails = JsonRecord & { tabId?: number; frameId?: number; url?: string; error?: string; transitionType?: string; transitionQualifiers?: unknown };
type NavigationState = { ok: boolean; url: string | null; tab: PiChromeTab | null; metrics: LoadMetrics | null; stage: string | null; reason?: string };

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// wait_navigation.js - Pi browser navigation and load-state wait helpers.
// Loaded after wait_coordinator.js and before wait.js by background.js.

async function navigatePiBrowser(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const url = msg.url;
  if (!url) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'wait.navigate requires url', {});
  cleanupTabWaits(tabId, 'navigate', { includeCdp: false, action: 'navigate_cancel_waits' });
  const cdp = piBrowserPersistentCdp();
  if (cdp?.send) {
    const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Page.navigate', { url }, { persistent: true, name: msg.cdpSessionName || 'navigate' }));
    if (!resp || resp.ok === false) return resp;
    const data = asRecord(resp.data);
    return { ok: true, data: data.result || resp.result || resp.data };
  }
  if (chrome.tabs?.update) return { ok: true, data: await chrome.tabs.update(tabId, { url }) };
  await chrome.debugger.attach({ tabId }, '1.3');
  try { const result = await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url }); await chrome.debugger.detach({ tabId }); return { ok: true, data: result }; }
  catch (e) { try { await chrome.debugger.detach({ tabId }); } catch (detachError) { console.warn('[PI-BROWSER-WAIT] Failed to detach debugger after Page.navigate error', tabId, detachError); } throw e; }
}

async function navigateAndWait(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  if (!msg.url) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'wait.navigateAndWait requires url', {});
  const waitUntil = normalizeWaitState(msg.waitUntil || msg.wait_until || msg.state || 'load');
  const timeoutMs = normalizePiBrowserTimeoutMs(msg);
  const navigation = await navigatePiBrowser(tabId, msg);
  if (!navigation.ok) return navigation;
  let waited: PiBridgeResponse;
  if (waitUntil === 'networkidle') waited = await waitForNetworkIdle(tabId, { ...msg, timeoutMs });
  else if (waitUntil === 'selector') waited = await waitForSelector(tabId, { ...msg, timeoutMs });
  else waited = await waitForLoadState(tabId, { ...msg, state: waitUntil === 'load' ? 'complete' : waitUntil, timeoutMs });
  if (!waited.ok) return waited;
  return { ok: true, data: { navigation: navigation.data, wait: waited.data, url: msg.url, waitUntil } };
}
async function waitForNavigation(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const timeoutMs = normalizePiBrowserTimeoutMs(msg);
  const targetUrl = msg.targetUrl || msg.url || msg.target_url || null;
  const urlContains = msg.urlContains || msg.url_contains || '';
  const sameDocument = msg.sameDocument === true || msg.same_document === true;
  const requestId = msg.requestId || msg.request_id || null;
  const waitUntil = normalizeWaitState(msg.waitUntil || msg.wait_until || msg.state || 'load');
  const wait_id = String(msg.waitId || msg.wait_id || makeWaitId(tabId, 'navigation'));
  const diagnostics = { targetUrl, urlContains, sameDocument, waitUntil, request_id: requestId, epoch: Date.now(), sources: ['chrome.webNavigation.onBeforeNavigate','chrome.webNavigation.onCommitted','chrome.webNavigation.onCompleted','chrome.webNavigation.onErrorOccurred','chrome.webNavigation.onHistoryStateUpdated','chrome.webNavigation.onReferenceFragmentUpdated','chrome.tabs.onUpdated','Page.frameNavigated','Page.navigatedWithinDocument','Page.lifecycleEvent','Page.loadEventFired','Page.domContentEventFired','Page.frameStoppedLoading','same-document','hash','redirect'] };
  const record = registerWait(tabId, 'navigation', { waitId: wait_id, wait_id, requestId, request_id: requestId, targetUrl, urlContains, sameDocument, waitUntil, timeout_ms: timeoutMs, diagnostics, epoch: diagnostics.epoch, abortController: new AbortController(), cleanup: () => {} });
  // chrome.webNavigation.onBeforeNavigate / onCommitted / onCompleted / onErrorOccurred are the MV3 navigation backbone.
  // Persistent CDP Page.frameNavigated/Page.lifecycleEvent and tabs.onUpdated cover debugger-enabled and fallback paths.
  const urlMatches = (url: unknown): boolean => {
    const value = String(url || '');
    if (!value) return !targetUrl && !urlContains;
    if (urlContains && value.includes(String(urlContains))) return true;
    if (!targetUrl) return !urlContains;
    const target = String(targetUrl);
    return value === target || value.startsWith(target + '#') || value.startsWith(target + '?');
  };
  const currentNavigationState = async (source: string): Promise<NavigationState> => {
    const tab = await chrome.tabs.get(tabId).catch(e => { record.lastError = errorText(e); return null; });
    const metrics = await queryLoadMetrics(tabId).catch(() => null);
    const url = metrics?.url || tab?.url || null;
    recordWaitEvent(record, { method:'wait.navigation.currentUrl', source, url, tabStatus:tab?.status, readyState:metrics?.readyState });
    if (!urlMatches(url)) return { ok:false, url, tab, metrics, stage:null, reason:'url_mismatch' };
    if ((sameDocument === true) && (targetUrl || urlContains)) return { ok:true, url, tab, metrics, stage:'same-document' };
    if (waitUntil === 'commit' || waitUntil === 'committed') return { ok:true, url, tab, metrics, stage:'commit' };
    if (waitUntil === 'domcontentloaded' && loadStateSatisfied('domcontentloaded', tab, metrics)) return { ok:true, url, tab, metrics, stage:'domcontentloaded' };
    if ((waitUntil === 'load' || waitUntil === 'complete') && loadStateSatisfied('complete', tab, metrics)) return { ok:true, url, tab, metrics, stage:'complete' };
    return { ok:false, url, tab, metrics, stage:null, reason:'state_not_ready' };
  };
  if (timeoutMs === 0) {
    const current = await currentNavigationState('immediate');
    if (current.ok) return finishPiBrowserWait(record, true, { wait_id, request_id: requestId, targetUrl, urlContains, sameDocument, waitUntil, source:'immediate', url:current.url, stage:current.stage, immediate:true, tabStatus:current.tab?.status, readyState:current.metrics?.readyState, diagnostics, events: record.cdpEvents.slice(-50) });
    return finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.TIMEOUT, 'wait.navigation immediate check failed', { wait_id, request_id: requestId, timeout_ms:0, targetUrl, urlContains, sameDocument, waitUntil, source:'immediate', url:current.url, tabStatus:current.tab?.status, readyState:current.metrics?.readyState, reason:current.reason, diagnostics, events: record.cdpEvents.slice(-50) });
  }
  const isMainWebNavigation = (details: NavigationDetails): boolean => Number(details?.tabId) === Number(tabId) && Number(details?.frameId || 0) === 0;
  const cdp = piBrowserPersistentCdp();
  if (cdp?.send) {
    try {
      const probe = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true }, { persistent: true, name: 'wait_navigation_probe', timeoutMs: Math.min(timeoutMs, 1000) }));
      const data = asRecord(probe?.data);
      const dataResult = asRecord(data.result);
      const dataRuntimeResult = asRecord(dataResult.result);
      const result = asRecord(probe?.result);
      const resultResult = asRecord(result.result);
      const currentUrl = dataRuntimeResult.value || resultResult.value || null;
      if (currentUrl) record.diagnostics.push({ source:'Runtime.evaluate', currentUrl });
    } catch (error) {
      console.warn('[PI-BROWSER-WAIT] wait.navigation probe Runtime.evaluate failed', tabId, error);
    }
  }
  return await new Promise<PiBridgeResponse>(resolve => {
    let completed = false;
    let lastUrl: string | null = null;
    let mainFrameId: string | null = null;
    const terminalData = (source: string, extra: JsonRecord = {}): JsonRecord => ({ wait_id, request_id: requestId, targetUrl, urlContains, sameDocument, waitUntil, source, url: typeof extra.url === 'string' ? extra.url : (lastUrl || null), diagnostics, events: record.cdpEvents.slice(-50), ...extra });
    const finish = (ok: boolean, source: string, extra: JsonRecord = {}, code?: string, message?: string): void => {
      if (completed) return;
      completed = true;
      if (ok) resolve(finishPiBrowserWait(record, true, terminalData(source, extra)));
      else resolve(finishPiBrowserWait(record, false, null, code || PI_BROWSER_ERROR_CODES.NAVIGATION_TIMEOUT, message || 'waitForNavigation timed out', terminalData(source, extra)));
    };
    const completeIfReady = (source: string, url: unknown, stage: string, extra: JsonRecord = {}): boolean => {
      if (url) lastUrl = String(url);
      if (!urlMatches(lastUrl)) return false;
      if (stage === 'error') { finish(false, source, { ...(extra || {}), url:lastUrl, stage }, PI_BROWSER_ERROR_CODES.NAVIGATION_TIMEOUT, 'waitForNavigation failed'); return true; }
      if (waitUntil === 'commit' || waitUntil === 'committed') { finish(true, source, { ...(extra || {}), url:lastUrl, stage }); return true; }
      if (waitUntil === 'domcontentloaded' && (stage === 'domcontentloaded' || stage === 'load' || stage === 'complete')) { finish(true, source, { ...(extra || {}), url:lastUrl, stage }); return true; }
      if ((waitUntil === 'load' || waitUntil === 'complete') && (stage === 'load' || stage === 'complete')) { finish(true, source, { ...(extra || {}), url:lastUrl, stage }); return true; }
      return false;
    };
    const timeoutHandle = setTimeout(() => finish(false, 'timeout', { error_code: 'NAVIGATION_TIMEOUT' }, PI_BROWSER_ERROR_CODES.NAVIGATION_TIMEOUT, 'waitForNavigation timed out'), Math.max(1, timeoutMs));
    record.timers.push(timeoutHandle);
    const checkCurrent = async (source: string): Promise<void> => {
      if (completed) return;
      const tab = await chrome.tabs.get(tabId).catch(e => { record.lastError = errorText(e); return null; });
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
    try { record.abortController.signal.addEventListener('abort', failIfAbort, { once:true }); record.listeners.push({ remove: () => record.abortController.signal.removeEventListener('abort', failIfAbort) }); } catch (_) { /* best-effort abort listener registration */ }
    const onTabsUpdated = (changedTabId: number, changeInfo: JsonRecord, updatedTab: PiChromeTab) => {
      if (Number(changedTabId) !== Number(tabId)) return;
      const url = changeInfo?.url || updatedTab?.url || lastUrl;
      recordWaitEvent(record, { method:'chrome.tabs.onUpdated', changeInfo, url });
      if (changeInfo?.url) completeIfReady('chrome.tabs.onUpdated', url, 'commit', { changeInfo });
      if (changeInfo?.status === 'complete' || updatedTab?.status === 'complete') completeIfReady('chrome.tabs.onUpdated', url, 'complete', { changeInfo, title: updatedTab?.title });
    };
    chrome.tabs.onUpdated.addListener(onTabsUpdated);
    record.listeners.push({ remove: () => chrome.tabs.onUpdated.removeListener(onTabsUpdated) });
    if (chrome.webNavigation) {
      const onBeforeNavigate = (details: NavigationDetails) => { if (!isMainWebNavigation(details)) return; recordWaitEvent(record, { method:'chrome.webNavigation.onBeforeNavigate', url:details.url, frameId:details.frameId }); };
      const onCommitted = (details: NavigationDetails) => { if (!isMainWebNavigation(details)) return; recordWaitEvent(record, { method:'chrome.webNavigation.onCommitted', url:details.url, transitionType:details.transitionType }); completeIfReady('chrome.webNavigation.onCommitted', details.url, 'commit', { transitionType:details.transitionType, transitionQualifiers:details.transitionQualifiers }); };
      const onCompleted = (details: NavigationDetails) => { if (!isMainWebNavigation(details)) return; recordWaitEvent(record, { method:'chrome.webNavigation.onCompleted', url:details.url }); completeIfReady('chrome.webNavigation.onCompleted', details.url, 'complete', {}); };
      const onErrorOccurred = (details: NavigationDetails) => { if (!isMainWebNavigation(details)) return; recordWaitEvent(record, { method:'chrome.webNavigation.onErrorOccurred', url:details.url, error:details.error }); if (urlMatches(details.url)) completeIfReady('chrome.webNavigation.onErrorOccurred', details.url, 'error', { error:details.error }); };
      const onSameDocument = (details: NavigationDetails) => { if (!isMainWebNavigation(details)) return; recordWaitEvent(record, { method:'chrome.webNavigation.sameDocument', url:details.url }); if (sameDocument && urlMatches(details.url)) finish(true, 'chrome.webNavigation.sameDocument', { url:details.url, sameDocument:true, transitionType:details.transitionType }); };
      chrome.webNavigation.onBeforeNavigate?.addListener(onBeforeNavigate);
      chrome.webNavigation.onCommitted?.addListener(onCommitted);
      chrome.webNavigation.onCompleted?.addListener(onCompleted);
      chrome.webNavigation.onErrorOccurred?.addListener(onErrorOccurred);
      chrome.webNavigation.onHistoryStateUpdated?.addListener(onSameDocument);
      chrome.webNavigation.onReferenceFragmentUpdated?.addListener(onSameDocument);
      record.listeners.push({ remove: () => {
        try { chrome.webNavigation.onBeforeNavigate?.removeListener(onBeforeNavigate); } catch (_) { /* best-effort webNavigation listener cleanup */ }
        try { chrome.webNavigation.onCommitted?.removeListener(onCommitted); } catch (_) { /* best-effort webNavigation listener cleanup */ }
        try { chrome.webNavigation.onCompleted?.removeListener(onCompleted); } catch (_) { /* best-effort webNavigation listener cleanup */ }
        try { chrome.webNavigation.onErrorOccurred?.removeListener(onErrorOccurred); } catch (_) { /* best-effort webNavigation listener cleanup */ }
        try { chrome.webNavigation.onHistoryStateUpdated?.removeListener(onSameDocument); } catch (_) { /* best-effort webNavigation listener cleanup */ }
        try { chrome.webNavigation.onReferenceFragmentUpdated?.removeListener(onSameDocument); } catch (_) { /* best-effort webNavigation listener cleanup */ }
      } });
    } else record.diagnostics.push({ warning:'chrome.webNavigation unavailable; using tabs/CDP listeners only' });
    enablePiBrowserCdpDomains(record, ['Page']).then(() => {
      const sub = subscribePiBrowserCdp(tabId, ['Page.frameNavigated','Page.navigatedWithinDocument','Page.lifecycleEvent','Page.domContentEventFired','Page.loadEventFired','Page.frameStoppedLoading'], (_source, method, params) => {
        const frame = asRecord(params?.frame);
        const frameId = params?.frameId ? String(params.frameId) : (frame.id ? String(frame.id) : null);
        const isMainFrame = method === 'Page.frameNavigated' ? !frame.parentId : (!mainFrameId || !frameId || String(frameId) === String(mainFrameId));
        if (!isMainFrame) return;
        if (method === 'Page.frameNavigated') { mainFrameId = frame.id ? String(frame.id) : mainFrameId; lastUrl = frame.url ? String(frame.url) : lastUrl; recordWaitEvent(record, { method, frameId: mainFrameId, url:lastUrl }); completeIfReady('Page.frameNavigated', lastUrl, 'commit', { frameId:mainFrameId }); }
        else if (method === 'Page.navigatedWithinDocument') { lastUrl = params?.url ? String(params.url) : lastUrl; recordWaitEvent(record, { method, frameId, url:lastUrl }); if (sameDocument && urlMatches(lastUrl)) finish(true, 'Page.navigatedWithinDocument', { url:lastUrl, frameId, sameDocument:true }); }
        else if (method === 'Page.lifecycleEvent') { recordWaitEvent(record, { method, frameId, name:params?.name }); if (params?.name === 'DOMContentLoaded') completeIfReady('Page.lifecycleEvent', lastUrl, 'domcontentloaded', { frameId, name:params.name }); if (params?.name === 'load') completeIfReady('Page.lifecycleEvent', lastUrl, 'load', { frameId, name:params.name }); }
        else if (method === 'Page.domContentEventFired') { recordWaitEvent(record, { method, frameId }); completeIfReady(method, lastUrl, 'domcontentloaded', { frameId }); }
        else if (method === 'Page.loadEventFired' || method === 'Page.frameStoppedLoading') { recordWaitEvent(record, { method, frameId }); completeIfReady(method, lastUrl, 'load', { frameId }); }
      }, record);
      record.diagnostics.push({ cdp_subscription: sub });
      chrome.debugger.sendCommand({ tabId }, 'Page.setLifecycleEventsEnabled', { enabled: true }).catch(e => { record.lastError = errorText(e); });
    }).catch(e => { record.lastError = errorText(e); record.diagnostics.push({ cdp_error: record.lastError }); });
  });
}

function loadStateSatisfied(state: string, tab: PiChromeTab | null | undefined, metrics: LoadMetrics | null | undefined): boolean {
  const rs = metrics?.readyState || '';
  if (state === 'domcontentloaded') return rs === 'interactive' || rs === 'complete' || metrics?.domContentLoaded === true;
  if (state === 'load' || state === 'complete') return tab?.status === 'complete' || rs === 'complete' || metrics?.load === true;
  return false;
}
async function queryLoadMetrics(tabId: number): Promise<LoadMetrics | null> {
  const expr = `(() => ({readyState:document.readyState, url:location.href, title:document.title, domContentLoaded:document.readyState==='interactive'||document.readyState==='complete', load:document.readyState==='complete'}))()`;
  const res = await piBrowserEval(tabId, expr, true).catch(e => ({ ok:false, error:errorText(e) } as PiBridgeResponse));
  const value = res && res.ok ? (res.data || res.result || null) : null;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as LoadMetrics : null;
}
async function waitForLoadState(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const targetState = normalizeWaitState(msg.state || msg.loadState || msg.load_state || 'complete'); // Page.lifecycleEvent document.readyState timeoutMs === 0
  if (!['domcontentloaded','load','complete'].includes(targetState)) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'wait.loadState unsupported state', { state: targetState });
  const timeoutMs = normalizePiBrowserTimeoutMs(msg);
  const record = registerWait(tabId, 'load_state', { state: targetState, timeout_ms: timeoutMs, waitId: msg.waitId, wait_id: msg.wait_id, abortController: msg.abortController });
  const tab = await chrome.tabs.get(tabId).catch(e => { record.lastError = errorText(e); return null; });
  const metrics = await queryLoadMetrics(tabId).catch(() => null);
  if (loadStateSatisfied(targetState, tab, metrics)) return finishPiBrowserWait(record, true, { state: targetState, url: metrics?.url || tab?.url, title: metrics?.title || tab?.title, immediate: true, readyState: metrics?.readyState });
  if (timeoutMs === 0) return finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.TIMEOUT, 'wait.loadState immediate check failed', { timeout_ms:0, targetState, readyState:metrics?.readyState, tabStatus:tab?.status });
  return await new Promise<PiBridgeResponse>(resolve => {
    const complete = (res: PiBridgeResponse): void => resolve(res);
    const failIfAbort = () => { if (record.abortController?.signal?.aborted) complete(finishPiBrowserWait(record, false, null, 'CANCELLED', waitAbortMessage(record), { targetState })); };
    try { record.abortController.signal.addEventListener('abort', failIfAbort, { once:true }); record.listeners.push({ remove: () => record.abortController.signal.removeEventListener('abort', failIfAbort) }); } catch (_) { /* best-effort abort listener registration */ }
    const timeoutHandle = setTimeout(() => complete(finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.TIMEOUT, 'wait.loadState timed out', { timeout_ms: timeoutMs, targetState, last_error: record.lastError, events: record.cdpEvents.slice(-50) })), timeoutMs);
    record.timers.push(timeoutHandle);
    void enablePiBrowserCdpDomains(record, ['Page']).then(() => {
      const sub = subscribePiBrowserCdp(tabId, ['Page.lifecycleEvent','Page.domContentEventFired','Page.loadEventFired','Page.frameStoppedLoading'], (_source, method, params) => {
        recordWaitEvent(record, { method, name: params.name, frameId: params.frameId });
        if ((targetState === 'domcontentloaded' && (method === 'Page.domContentEventFired' || params.name === 'DOMContentLoaded')) || ((targetState === 'load' || targetState === 'complete') && (method === 'Page.loadEventFired' || params.name === 'load' || method === 'Page.frameStoppedLoading'))) {
          complete(finishPiBrowserWait(record, true, { state: targetState, method, params, cdp: true }));
        }
      }, record);
      record.diagnostics.push({ cdp_subscription: sub });
      chrome.debugger.sendCommand({ tabId }, 'Page.setLifecycleEventsEnabled', { enabled: true }).catch(e => { record.lastError = errorText(e); });
    }).catch(e => { record.lastError = errorText(e); record.diagnostics.push({ cdp_error: record.lastError }); });
    const onUpdated = (changedTabId: number, changeInfo: JsonRecord, updatedTab: PiChromeTab) => {
      if (Number(changedTabId) !== Number(tabId)) return;
      recordWaitEvent(record, { method:'chrome.tabs.onUpdated', changeInfo });
      if ((targetState === 'complete' || targetState === 'load') && (changeInfo.status === 'complete' || updatedTab?.status === 'complete')) complete(finishPiBrowserWait(record, true, { state: targetState, changeInfo, url: updatedTab?.url, title: updatedTab?.title, fallback: 'tabs.onUpdated' }));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    record.listeners.push({ remove: () => chrome.tabs.onUpdated.removeListener(onUpdated) });
  });
}
// CDP contract literal: 'Network.enable'
export { navigatePiBrowser, navigateAndWait, waitForNavigation, loadStateSatisfied, queryLoadMetrics, waitForLoadState };
// ESM module metadata
export const __piBridgeModule_wait_navigation = { name: "wait_navigation", symbols: { navigatePiBrowser, navigateAndWait, waitForNavigation, loadStateSatisfied, queryLoadMetrics, waitForLoadState } };
