import { matchNetworkPattern } from "./patterns";
import { PI_BROWSER_ERROR_CODES } from "./runtime";
import { attachDebuggerForWait, subscribePiBrowserCdp } from "./wait_cdp";
import { finishPiBrowserWait, makeWaitId, normalizePiBrowserTimeoutMs, recordWaitEvent, registerWait, waitAbortMessage } from "./wait_coordinator";
import type { JsonRecord, PiBridgeCommand, PiBridgeResponse } from "./types";

type NetworkIdleRequest = JsonRecord & { requestId: string; url: string; type: string; method: string; initiatorType?: string; startedAt?: number; ignoreLongPollingMs?: number; status?: unknown; mimeType?: unknown; fromServiceWorker?: boolean; fromDiskCache?: boolean };
type NetworkIdleDecision = { track: boolean; reason: string; ignoreLongPollingMs?: number };

function networkRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function stringList(value: unknown): string[] { return Array.isArray(value) ? value.map((x: unknown) => String(x)) : []; }

// wait_network_idle.js - Pi browser network-idle wait helpers.
// Loaded before wait.js by background.js.

function compileNetworkIdleFilter(msg: PiBridgeCommand): (req: NetworkIdleRequest) => NetworkIdleDecision {
  const ignoreUrl = stringList(Array.isArray(msg.ignoreUrls) ? msg.ignoreUrls : Array.isArray(msg.ignore_urls) ? msg.ignore_urls : []);
  const includeUrl = stringList(Array.isArray(msg.includeUrls) ? msg.includeUrls : Array.isArray(msg.include_urls) ? msg.include_urls : []);
  const resourceTypes = new Set(stringList(Array.isArray(msg.resourceTypes) ? msg.resourceTypes : Array.isArray(msg.resource_types) ? msg.resource_types : []).map((x) => x.toLowerCase()));
  const ignoreResourceTypes = new Set(stringList(Array.isArray(msg.ignoreResourceTypes) ? msg.ignoreResourceTypes : Array.isArray(msg.ignore_resource_types) ? msg.ignore_resource_types : ['eventsource','websocket']).map((x) => x.toLowerCase()));
  const ignoreSchemes = new Set(stringList(Array.isArray(msg.ignoreSchemes) ? msg.ignoreSchemes : Array.isArray(msg.ignore_schemes) ? msg.ignore_schemes : ['data','blob']).map((x) => x.toLowerCase()));
  const ignoreMethods = new Set(stringList(Array.isArray(msg.ignoreMethods) ? msg.ignoreMethods : Array.isArray(msg.ignore_methods) ? msg.ignore_methods : []).map((x) => x.toUpperCase()));
  const includePreflight = msg.includePreflight === true || msg.include_preflight === true;
  const includeBeacon = msg.includeBeacon === true || msg.include_beacon === true;
  const ignoreLongPollingMs = Math.max(0, Number(msg.ignoreLongPollingMs || msg.ignore_long_polling_ms || 30000));
  const matchAny = (url: string, list: string[]) => list.some((p) => matchNetworkPattern(url, p));
  return function shouldTrack(req: NetworkIdleRequest): NetworkIdleDecision {
    const url = req.url || '';
    const type = String(req.type || '').toLowerCase();
    const method = String(req.method || 'GET').toUpperCase();
    if (includeUrl.length && !matchAny(url, includeUrl)) return { track:false, reason:'not_included' };
    if (ignoreUrl.length && matchAny(url, ignoreUrl)) return { track:false, reason:'ignored_url' };
    const scheme = (url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/) || [undefined, ''])[1].toLowerCase();
    if (scheme && ignoreSchemes.has(scheme)) return { track:false, reason:'ignored_scheme' };
    if (resourceTypes.size && !resourceTypes.has(type)) return { track:false, reason:'resource_type_not_included' };
    if (ignoreResourceTypes.has(type)) return { track:false, reason:'ignored_resource_type' };
    if (!includePreflight && (type === 'preflight' || method === 'OPTIONS')) return { track:false, reason:'preflight' };
    if (!includeBeacon && (type === 'ping' || req.initiatorType === 'beacon')) return { track:false, reason:'beacon' };
    if (ignoreMethods.has(method)) return { track:false, reason:'ignored_method' };
    return { track:true, reason:'tracked', ignoreLongPollingMs };
  };
}
async function waitForNetworkIdle(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const timeoutMs = normalizePiBrowserTimeoutMs(msg);
  const idleMs = Math.max(100, Math.min(Math.max(timeoutMs, 100), Number(msg.idleMs || msg.idle_ms || 500))); // idleMs Network.requestWillBeSent Network.requestServedFromCache Network.responseReceived Network.loadingFinished Network.loadingFailed redirectResponse preflight serviceWorker beacon WebSocket EventSource long_polling NETWORK_IDLE_TIMEOUT
  const maxInflight = Math.max(0, Number(msg.maxInflight ?? msg.max_inflight ?? 0)); // maxInflight
  const record = registerWait(tabId, 'network_idle', { idle_ms: idleMs, max_inflight: maxInflight, timeout_ms: timeoutMs, filters: msg.filters || null, waitId: msg.waitId, wait_id: msg.wait_id, abortController: msg.abortController });
  const shouldTrack = compileNetworkIdleFilter(msg || {});
  const inflight = new Map<string, NetworkIdleRequest>();
  const ignored: JsonRecord[] = [];
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const maybeExpireLongPolling = () => {
    const now = Date.now();
    for (const [id, item] of Array.from(inflight.entries())) {
      if (item.ignoreLongPollingMs && now - Number(item.startedAt || now) >= item.ignoreLongPollingMs) { inflight.delete(id); ignored.push({ requestId:id, reason:'long_polling', url:item.url, age_ms:now-Number(item.startedAt || now) }); }
    }
  };
  if (timeoutMs === 0) return finishPiBrowserWait(record, true, { state:'network_idle', idle_ms:0, inflight:0, immediate:true });
  await attachDebuggerForWait(record, ['Network']).catch((e: unknown) => { record.lastError = e instanceof Error ? e.message : String(e); });
  return await new Promise<PiBridgeResponse>(resolve => {
    const complete = (res: PiBridgeResponse) => { try { if (idleTimer) clearTimeout(idleTimer); } catch (_) { /* best-effort idle timer cleanup */ } resolve(res); };
    const failIfAbort = () => { if (record.abortController?.signal?.aborted) complete(finishPiBrowserWait(record, false, null, 'CANCELLED', waitAbortMessage(record), { inflight:Array.from(inflight.values()) })); };
    try { record.abortController.signal.addEventListener('abort', failIfAbort, { once:true }); record.listeners.push({ remove: () => record.abortController.signal.removeEventListener('abort', failIfAbort) }); } catch (_) { /* best-effort abort listener registration */ }
    const armIdle = () => {
      maybeExpireLongPolling();
      try { if (idleTimer) clearTimeout(idleTimer); } catch (_) { /* best-effort idle timer cleanup */ }
      if (inflight.size <= maxInflight) idleTimer = setTimeout(() => complete(finishPiBrowserWait(record, true, { state: 'network_idle', idle_ms: idleMs, inflight: inflight.size, ignored: ignored.slice(-100), events: record.cdpEvents.slice(-50) })), idleMs);
    };
    const timeoutHandle = setTimeout(() => complete(finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.TIMEOUT, 'wait.networkIdle timed out', { timeout_ms: timeoutMs, idle_ms: idleMs, inflight: Array.from(inflight.values()), ignored: ignored.slice(-100), events: record.cdpEvents.slice(-50), last_error: record.lastError })), timeoutMs);
    record.timers.push(timeoutHandle);
    const onEvent = (source: { tabId?: number }, method: string, params: JsonRecord = {}) => {
      if (!source || Number(source.tabId) !== Number(tabId)) return;
      if (method === 'Network.requestWillBeSent') {
        const request = networkRecord(params.request); const initiator = networkRecord(params.initiator); const req: NetworkIdleRequest = { requestId: String(params.requestId || makeWaitId(tabId, 'request')), url: String(request.url || ''), type: String(params.type || params.resourceType || ''), method: String(request.method || 'GET'), initiatorType: String(initiator.type || ''), redirectResponse: params.redirectResponse || null };
        const decision = shouldTrack(req);
        recordWaitEvent(record, { method, requestId:req.requestId, url:req.url, type:req.type, decision:decision.reason });
        if (params?.redirectResponse && inflight.has(req.requestId)) inflight.delete(req.requestId);
        if (decision.track) inflight.set(req.requestId, { ...req, startedAt:Date.now(), ignoreLongPollingMs:decision.ignoreLongPollingMs }); else ignored.push({ requestId:req.requestId, url:req.url, reason:decision.reason });
      } else if (method === 'Network.requestServedFromCache') {
        recordWaitEvent(record, { method, requestId:params?.requestId });
        inflight.delete(String(params.requestId || ''));
      } else if (method === 'Network.responseReceived') {
        const response = networkRecord(params.response);
        const item = inflight.get(String(params.requestId || ''));
        if (item) { item.status = response.status; item.mimeType = response.mimeType; item.fromServiceWorker = !!response.fromServiceWorker; item.fromDiskCache = !!response.fromDiskCache; }
        recordWaitEvent(record, { method, requestId:params.requestId, status:response.status, fromServiceWorker:!!response.fromServiceWorker });
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        inflight.delete(String(params.requestId || ''));
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
export { compileNetworkIdleFilter, waitForNetworkIdle };
// ESM module metadata
export const __piBridgeModule_wait_network_idle = { name: "wait_network_idle", symbols: { compileNetworkIdleFilter, waitForNetworkIdle } };
