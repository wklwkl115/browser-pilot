// @ts-nocheck
// wait_network_idle.js - Pi browser network-idle wait helpers.
// Loaded before wait.js by background.js.

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
  const matchAny = (url, list) => list.some(p => matchNetworkPattern(url, p));
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
