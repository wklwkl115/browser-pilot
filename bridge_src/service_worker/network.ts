// network.js - Pi browser native Network recorder CDP event, lifecycle and command runtime.
// Loaded after network_model.js by background.js.
import { chromeApi as chrome } from "./runtimeEnv";
import { PI_BROWSER_ERROR_CODES, findLostRuntimeSession, forgetRuntimeSession, normalizePersistentPiBrowserResponse, piBrowserError, piBrowserPersistentCdp, piWithTimeout, redactSensitive, rememberRuntimeSession, summarizeLostRuntimeSession } from "./runtime";
import { persist as persistState, forget as forgetState, recover as recoverState, registerRecovery } from "./state_store";
import { enablePiBrowserCdpDomains, releasePiBrowserCdpDomains, subscribePiBrowserCdp, unsubscribePiBrowserCdp } from "./wait_cdp";
import { makeWaitId, normalizePiBrowserTimeoutMs } from "./wait_coordinator";
import { appendBounded, asRecord, errorText, piNetworkHandleRecorderCdpEvent, piNetworkMaybeCaptureBody } from "./network_events";
import { classifyNetworkBodyError, createNetworkRecorder, defaultNetworkSessionId, getActiveNetworkRecorder, getNetworkRecorder, estimateStringBytes, getHeaderValue, networkRecordClone, networkCriterionMatchesText, networkRecordMatchesList, networkRecordSummary, networkRecorderKey, networkRecorderSummary, headersObjectToArray, numberInRange, piBrowserNetworkRecorders, recorderPublicConfig, rememberNetworkError, normalizeNetworkRecorderConfig, truncateBase64Body, truncateStringByBytes, networkSseEventMatches, networkWsFrameMatches, setNetworkWaitNotifier } from "./network_model";
import type { JsonRecord, NetworkClearResult, NetworkHarContent, NetworkHarEntry, NetworkRecorderSummary, PiBridgeCommand, PiBridgeResponse } from "./types";
import type { NetworkBodyStoreEntry, NetworkFrameRecord, NetworkRecord, NetworkRecorder, NetworkRecorderWait } from "./network_model";

const rememberNetworkRuntimeSession = typeof rememberRuntimeSession === "function" ? rememberRuntimeSession : async () => {};
const forgetNetworkRuntimeSession = typeof forgetRuntimeSession === "function" ? forgetRuntimeSession : async () => {};
const findLostNetworkRuntimeSession = typeof findLostRuntimeSession === "function" ? findLostRuntimeSession : async () => undefined;
const summarizeLostNetworkRuntimeSession = typeof summarizeLostRuntimeSession === "function" ? summarizeLostRuntimeSession : () => undefined;
type NetworkCommandResult = Record<string, unknown>;
type NetworkRecorderLookup = { recorder: NetworkRecorder; error?: never } | { recorder?: never; error: PiBridgeResponse };
type HarContent = NetworkHarContent;
setNetworkWaitNotifier(wakeNetworkWaits);
const NETWORK_RECORDER_EVENTS = ['Network.requestWillBeSent','Network.requestWillBeSentExtraInfo','Network.responseReceived','Network.responseReceivedExtraInfo','Network.dataReceived','Network.requestServedFromCache','Network.loadingFinished','Network.loadingFailed','Network.webSocketCreated','Network.webSocketWillSendHandshakeRequest','Network.webSocketHandshakeResponseReceived','Network.webSocketFrameSent','Network.webSocketFrameReceived','Network.webSocketFrameError','Network.webSocketClosed','Network.eventSourceMessageReceived','Page.frameNavigated','Page.loadEventFired','Page.domContentEventFired','Page.lifecycleEvent','Page.frameStoppedLoading'];

async function cdpSendNetworkCommand(tabId: number, method: string, params: JsonRecord = {}, timeoutMs?: number): Promise<NetworkCommandResult> {
  const cdp = piBrowserPersistentCdp();
  if (cdp?.send) {
    const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, method, params || {}, { persistent:true, name:'network_recorder', timeoutMs }));
    const error = asRecord(resp?.error);
    if (!resp || resp.ok === false) throw new Error(String(error.message || resp?.message || resp?.error || (method + ' failed')));
    const data = asRecord(resp.data);
    return asRecord(data.result || resp.result || resp.data || {});
  }
  return asRecord(await piWithTimeout(chrome.debugger.sendCommand({ tabId:Number(tabId) }, method, params || {}), timeoutMs || 5000, method));
}
async function maybeCaptureNetworkBody(recorder: NetworkRecorder, rec: NetworkRecord): Promise<void> {
  return await piNetworkMaybeCaptureBody(recorder, rec, { cdpSendNetworkCommand, classifyNetworkBodyError, wakeNetworkWaits });
}
function handleNetworkRecorderCdpEvent(recorder: NetworkRecorder, source: { tabId?: number }, method: string, params: JsonRecord = {}): void {
  piNetworkHandleRecorderCdpEvent(recorder, source, method, params, { wakeNetworkWaits, maybeCaptureNetworkBody });
}
async function startNetworkRecorder(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const config = normalizeNetworkRecorderConfig(msg || {});
  const key = networkRecorderKey(tabId, config.sessionId);
  let recorder = piBrowserNetworkRecorders.get(key);
  if (recorder && recorder.active && msg.reconfigure !== false) {
    recorder.config = config; recorder.filter = config.filter;
    if (config.clearOnStart) clearNetworkRecorderBuffer(recorder);
    recorder.diagnostics.push({ t:Date.now(), action:'reconfigure', config:recorderPublicConfig(config) });
    try {
      const persisted = await persistState('network', networkRecorderKey(tabId, config.sessionId), recorderPublicConfig(config), { tabId, sessionId: config.sessionId, recoveryPolicy: 'auto' });
      if (persisted.generation !== undefined) recorder.stateGeneration = Number(persisted.generation);
      if (!persisted.ok && persisted.error) recorder.diagnostics.push({ t:Date.now(), action:'persist_failed', error:persisted.error });
    } catch (error) {
      console.warn('[PI-BROWSER-NET] Failed to persist recorder state during reconfigure', config.sessionId, error);
    }
    return { ok:true, data:{ ...networkRecorderSummary(recorder), reconfigured:true } };
  }
  if (recorder && recorder.active) return piBrowserError(PI_BROWSER_ERROR_CODES.ALREADY_INSTALLED, 'network recorder already started', { tabId, sessionId:config.sessionId });
  if (recorder) await stopNetworkRecorder(tabId, { sessionId:config.sessionId, keepBuffer:false, reason:'restart' }).catch(() => {});
  recorder = createNetworkRecorder(tabId, config);
  piBrowserNetworkRecorders.set(key, recorder);
  try {
    await enablePiBrowserCdpDomains(recorder.cdpRecord, ['Network', 'Page']);
    if (config.storePostData) {
      try { await cdpSendNetworkCommand(tabId, 'Network.enable', { maxPostDataSize: config.maxPostDataBytes }, 2000); }
      catch (e) { rememberNetworkError(recorder, 'Network.enable.maxPostDataSize', e); }
    }
    subscribePiBrowserCdp(tabId, NETWORK_RECORDER_EVENTS, (source, method, params) => handleNetworkRecorderCdpEvent(recorder, source, method, params), recorder.cdpRecord);
    try { await cdpSendNetworkCommand(tabId, 'Page.setLifecycleEventsEnabled', { enabled:true }, 2000); } catch (e) { rememberNetworkError(recorder, 'Page.setLifecycleEventsEnabled', e); }
    recorder.active = true; recorder.startedAt = Date.now(); recorder.diagnostics.push({ t:Date.now(), action:'start', events:NETWORK_RECORDER_EVENTS, config:recorderPublicConfig(config) });
    await rememberNetworkRuntimeSession('network', tabId, config.sessionId, { recorderId: recorder.recorderId, config: recorderPublicConfig(config) });
    try {
      const persisted = await persistState('network', networkRecorderKey(tabId, config.sessionId), recorderPublicConfig(config), { tabId, sessionId: config.sessionId, recoveryPolicy: 'auto' });
      if (persisted.generation !== undefined) recorder.stateGeneration = Number(persisted.generation);
      if (!persisted.ok && persisted.error) recorder.diagnostics.push({ t:Date.now(), action:'persist_failed', error:persisted.error });
    } catch (error) {
      console.warn('[PI-BROWSER-NET] Failed to persist recorder state during start', config.sessionId, error);
    }
    return { ok:true, data:networkRecorderSummary(recorder) };
  } catch (e) {
    rememberNetworkError(recorder, 'start', e);
    cleanupNetworkRecorder(recorder, 'start_failed', { keepBuffer:false });
    piBrowserNetworkRecorders.delete(key);
    return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'network.start failed', { tabId, sessionId:config.sessionId, error:errorText(e) });
  }
}
function clearNetworkRecorderBuffer(recorder: NetworkRecorder | null | undefined): NetworkClearResult {
  if (!recorder) return { entries:0, bodies:0 };
  const entries = recorder.entries.length;
  const bodies = recorder.bodyStore.size;
  recorder.entries.splice(0);
  recorder.byRequestId.clear();
  recorder.bodyStore.clear();
  recorder.bodyByRequestId.clear();
  recorder.overflowCount = 0;
  recorder.bodyOverflowCount = 0;
  recorder.diagnostics.push({ t:Date.now(), action:'clear', entries, bodies });
  return { entries, bodies };
}
function cleanupNetworkRecorder(recorder: NetworkRecorder | null | undefined, reason?: string, options: { keepBuffer?: boolean } = {}): { stopped: boolean; summary?: NetworkRecorderSummary | null } {
  if (!recorder) return { stopped:false };
  options = options || {};
  recorder.active = false;
  recorder.stoppedAt = Date.now();
  for (const wait of Array.from(recorder.waits.values())) finishNetworkRecorderWait(recorder, wait, false, PI_BROWSER_ERROR_CODES.CANCELLED, 'network recorder stopped', { reason:reason || 'stopped' });
  for (const sid of Array.from(recorder.cdpRecord.cdpSubscriptions || [])) {
    try {
      unsubscribePiBrowserCdp(sid);
    } catch (_error) {
      /* best-effort network recorder CDP subscription cleanup */
    }
  }
  recorder.cdpRecord.cdpSubscriptions = [];
  releasePiBrowserCdpDomains(recorder.cdpRecord, Array.from(recorder.cdpRecord.cdpDomains || []), reason || 'network_recorder_stop');
  recorder.cdpRecord.cdpAttached = false;
  if (options.keepBuffer === false) clearNetworkRecorderBuffer(recorder);
  recorder.diagnostics.push({ t:Date.now(), action:'stop', reason:reason || 'stopped', keepBuffer:options.keepBuffer !== false });
  void forgetNetworkRuntimeSession('network', recorder.tabId, recorder.sessionId);
  return { stopped:true, summary:networkRecorderSummary(recorder) };
}
async function stopNetworkRecorder(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const sessionId = defaultNetworkSessionId(msg || {});
  const recorder = getNetworkRecorder(tabId, sessionId);
  if (!recorder) return piBrowserError(PI_BROWSER_ERROR_CODES.NETWORK_RECORDER_NOT_STARTED, 'network recorder is not started', { tabId, sessionId });
  const keepBuffer = msg.keepBuffer !== false && msg.keep_buffer !== false && msg.clear !== true;
  const result = cleanupNetworkRecorder(recorder, String(msg.reason || 'stop'), { keepBuffer });
  if (!keepBuffer || msg.remove === true) piBrowserNetworkRecorders.delete(recorder.key);
  // Forget persisted state on explicit stop
  try { await forgetState('network', networkRecorderKey(tabId, sessionId)); } catch (error) { console.warn('[PI-BROWSER-NET] Failed to forget recorder state on stop', sessionId, error); }
  return { ok:true, data:{ ...result.summary, stopped:true, keepBuffer } };
}
function cleanupNetworkRecorderTab(tabId: number, reason?: string): Array<{ sessionId: string; recorderId: string }> {
  const out: Array<{ sessionId: string; recorderId: string }> = [];
  for (const recorder of Array.from(piBrowserNetworkRecorders.values())) {
    if (Number(recorder.tabId) !== Number(tabId)) continue;
    cleanupNetworkRecorder(recorder, reason || 'tab_cleanup', { keepBuffer:false });
    piBrowserNetworkRecorders.delete(recorder.key);
    // Forget persisted state on tab cleanup
    void forgetState('network', recorder.key).catch((error) => console.warn('[PI-BROWSER-NET] Failed to forget recorder state during tab cleanup', recorder.key, error));
    out.push({ sessionId:recorder.sessionId, recorderId:recorder.recorderId });
  }
  return out;
}
async function requireNetworkRecorder(tabId: number, msg: PiBridgeCommand): Promise<NetworkRecorderLookup> {
  const recorder = getActiveNetworkRecorder(tabId, msg || {});
  if (!recorder) {
    const sessionId = defaultNetworkSessionId(msg || {});
    return { error: piBrowserError(PI_BROWSER_ERROR_CODES.NETWORK_RECORDER_NOT_STARTED, 'network recorder is not started', { tabId, sessionId, lostSession: summarizeLostNetworkRuntimeSession(await findLostNetworkRuntimeSession('network', tabId, sessionId)) }) };
  }
  return { recorder };
}
async function listNetworkRecorderEntries(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const found = await requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const limit = numberInRange(msg.limit, 100, 0, 5000);
  const offset = numberInRange(msg.offset, 0, 0, Math.max(0, recorder.entries.length));
  const filters = { sinceSeq: msg.sinceSeq ?? msg.since_seq, requestId: msg.requestId || msg.request_id, url:msg.url, urlContains:msg.urlContains ?? msg.url_contains, urlPattern:msg.urlPattern ?? msg.url_pattern, method:msg.method, type:msg.type || msg.resourceType || msg.resource_type, mime:msg.mime || msg.mimeType || msg.mime_type, status:msg.status, includeUrls:msg.includeUrls || msg.include_urls, excludeUrls:msg.excludeUrls || msg.exclude_urls };
  const all = recorder.entries.filter(rec => networkRecordMatchesList(rec, filters));
  const items = all.slice(offset, limit ? offset + limit : undefined).map(rec => networkRecordSummary(rec, { includeDetails: msg.includeDetails === true || msg.include_details === true, includeBody: msg.includeBody === true || msg.include_body === true }));
  const nextOffset = offset + items.length < all.length ? offset + items.length : null;
  return { ok:true, data:{ tabId:Number(tabId), sessionId:recorder.sessionId, total:all.length, offset, limit, items, nextOffset, overflowCount:recorder.overflowCount } };
}
async function getNetworkRecorderEntry(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const found = await requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const id = String(msg.requestId || msg.request_id || msg.id || '');
  if (!id) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'network.get requires requestId or id', { tabId });
  const rec = recorder.byRequestId.get(id) || recorder.entries.find(x => String(x.id) === id || String(x.requestId) === id);
  if (!rec) return piBrowserError(PI_BROWSER_ERROR_CODES.REQUEST_NOT_FOUND || 'REQUEST_NOT_FOUND', 'network request not found', { tabId, sessionId:recorder.sessionId, requestId:id });
  return { ok:true, data:networkRecordClone(rec, { includeBody: msg.includeBody === true || msg.include_body === true }) };
}
async function getNetworkRecorderBody(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const found = await requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const ref = String(msg.bodyRef || msg.body_ref || '');
  const requestId = String(msg.requestId || msg.request_id || msg.id || '');
  const rec = requestId ? (recorder.byRequestId.get(requestId) || recorder.entries.find(x => String(x.id) === requestId || String(x.requestId) === requestId)) : null;
  const bodyRef = ref || rec?.bodyRef || recorder.bodyByRequestId.get(requestId);
  if (!bodyRef) return piBrowserError(PI_BROWSER_ERROR_CODES.BODY_UNAVAILABLE, 'network body is unavailable', { tabId, sessionId:recorder.sessionId, requestId, bodyRef:ref, bodyAvailability:rec?.bodyAvailability || 'not_requested', bodyUnavailableReason:rec?.bodyUnavailableReason || (requestId ? 'body_not_captured' : 'missing_request_id'), bodyError:rec?.bodyError || null, request:rec ? networkRecordSummary(rec) : null });
  const body = recorder.bodyStore.get(bodyRef);
  if (!body) return piBrowserError(PI_BROWSER_ERROR_CODES.BODY_UNAVAILABLE, 'network body ref not found', { tabId, sessionId:recorder.sessionId, requestId, bodyRef, bodyAvailability:'expired', bodyUnavailableReason:'body_ref_missing', request:rec ? networkRecordSummary(rec) : null });
  const maxBytesRaw = msg.maxBytes ?? msg.max_bytes;
  let out = { ...body };
  if (maxBytesRaw !== undefined) {
    const maxBytes = numberInRange(maxBytesRaw, body.bytes, 0, Math.max(body.bytes || 0, body.originalLength || 0, 10 * 1024 * 1024));
    const trunc = body.base64Encoded ? truncateBase64Body(body.body || '', maxBytes) : truncateStringByBytes(body.body || '', maxBytes);
    out = { ...out, body:trunc.value, bodyTruncated:body.bodyTruncated || trunc.truncated, bytes:trunc.bytes };
  }
  return { ok:true, data:redactSensitive(out) };
}
function makeHarEntry(rec: NetworkRecord, body: NetworkBodyStoreEntry | null): NetworkHarEntry {
  const startedDateTime = rec.wallTime ? new Date(rec.wallTime * 1000).toISOString() : new Date(rec.createdAt || Date.now()).toISOString();
  const requestHeaders = headersObjectToArray(rec.request?.headers || rec.requestExtraInfo?.headers || {});
  const responseHeaders = headersObjectToArray(rec.response?.headers || rec.responseExtraInfo?.headers || {});
  const content: HarContent = { size:rec.data?.dataLength || rec.encodedDataLength || -1, mimeType:rec.response?.mimeType || getHeaderValue(rec.response?.headers, 'content-type') || '', compression:0 };
  if (body) { content.text = body.body; content.encoding = body.base64Encoded ? 'base64' : undefined; content._bodyRef = body.bodyRef; content._bodyTruncated = !!body.bodyTruncated; }
  content._bodyAvailability = rec.bodyAvailability || (rec.bodyRef ? 'captured' : 'not_requested');
  content._bodyUnavailableReason = rec.bodyUnavailableReason || null;
  return {
    startedDateTime, time:Math.max(0, Number(rec.finishedAt || rec.updatedAt || Date.now()) - Number(rec.createdAt || Date.now())),
    request:{ method:rec.request?.method || 'GET', url:rec.request?.url || rec.response?.url || '', httpVersion:rec.response?.protocol || 'HTTP/1.1', headers:requestHeaders, queryString:[], cookies:[], headersSize:-1, bodySize:rec.request?.postData ? estimateStringBytes(rec.request.postData) : 0, postData:rec.request?.postData ? { mimeType:getHeaderValue(rec.request?.headers, 'content-type'), text:rec.request.postData, _truncated:!!rec.request.postDataTruncated } : undefined },
    response:{ status:Number(rec.response?.status || rec.responseExtraInfo?.statusCode || 0), statusText:rec.response?.statusText || '', httpVersion:rec.response?.protocol || 'HTTP/1.1', headers:responseHeaders, cookies:[], content, redirectURL:getHeaderValue(rec.response?.headers, 'location'), headersSize:-1, bodySize:rec.data?.encodedDataLength || rec.encodedDataLength || -1, _error:rec.errorText || undefined },
    cache:{}, timings:{ blocked:-1, dns:-1, connect:-1, send:0, wait:-1, receive:-1, ssl:-1 }, serverIPAddress:rec.response?.remoteIPAddress, connection:String(rec.response?.connectionId || ''), _requestId:rec.requestId, _seq:rec.seq, _type:rec.type || rec.resourceType || '', _initiator:rec.initiator, _redirects:rec.redirects || [], _wsFrames:rec.wsFrames || [], _sseEvents:rec.sseEvents || [], _bodyRef:rec.bodyRef || null, _bodyError:rec.bodyError || null, _bodyAvailability:rec.bodyAvailability || (rec.bodyRef ? 'captured' : 'not_requested'), _bodyUnavailableReason:rec.bodyUnavailableReason || null
  };
}
async function exportNetworkRecorderHar(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const found = await requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const includeBodies = msg.includeBody === true || msg.include_body === true || msg.includeBodies === true || msg.include_bodies === true;
  const filters = { sinceSeq: msg.sinceSeq ?? msg.since_seq, url:msg.url, urlContains:msg.urlContains ?? msg.url_contains, urlPattern:msg.urlPattern ?? msg.url_pattern, method:msg.method, type:msg.type || msg.resourceType || msg.resource_type, mime:msg.mime || msg.mimeType || msg.mime_type, status:msg.status, includeUrls:msg.includeUrls || msg.include_urls, excludeUrls:msg.excludeUrls || msg.exclude_urls };
  const records = recorder.entries.filter(rec => networkRecordMatchesList(rec, filters));
  if (String(msg.format || '').toLowerCase() === 'json') {
    const bodyRefs = new Set(records.map(r => r.bodyRef).filter(Boolean));
    const bodies = includeBodies ? Array.from(bodyRefs).map(ref => recorder.bodyStore.get(String(ref))).filter((b): b is NetworkBodyStoreEntry => Boolean(b)).map(b => redactSensitive(b)) : undefined;
    return { ok:true, data:{ recorder:networkRecorderSummary(recorder), entries:records.map(r => networkRecordClone(r, { includeBody:includeBodies })), bodies } };
  }
  const entries = records.map(rec => makeHarEntry(rec, includeBodies && rec.bodyRef ? (recorder.bodyStore.get(rec.bodyRef) || null) : null));
  return { ok:true, data:{ log:{ version:'1.2', creator:{ name:'Pi Browser NetworkRecorder', version:'1.0' }, pages:[], entries }, diagnostics:networkRecorderSummary(recorder) } };
}
function networkWaitMatches(recorder: NetworkRecorder, wait: Pick<NetworkRecorderWait, "condition" | "criteria" | "idleMs" | "count">, eventType: string, rec: NetworkRecord | null): boolean {
  const condition = wait.condition;
  const criteria = wait.criteria || {};
  const record = rec || null;
  if (record && !networkRecordMatchesList(record, { requestId:criteria.requestId || criteria.request_id, url:criteria.url, urlContains:criteria.urlContains ?? criteria.url_contains, urlPattern:criteria.urlPattern ?? criteria.url_pattern, method:criteria.method, type:criteria.type || criteria.resourceType || criteria.resource_type, mime:criteria.mime || criteria.mimeType || criteria.mime_type, status:criteria.status, includeUrls:criteria.includeUrls || criteria.include_urls, excludeUrls:criteria.excludeUrls || criteria.exclude_urls })) return false;
  if (record) {
    const bodyContains = criteria.bodyContains ?? criteria.body_contains;
    if (bodyContains !== undefined) {
      const stored = record.bodyRef ? recorder.bodyStore.get(record.bodyRef) : null;
      if (!stored || !networkCriterionMatchesText(stored.body, bodyContains)) return false;
    }
    const wsFrame = criteria.wsFrame ?? criteria.ws_frame;
    if (wsFrame !== undefined && !(record.wsFrames || []).some((frame: NetworkFrameRecord) => networkWsFrameMatches(frame, wsFrame))) return false;
    const sseEvent = criteria.sseEvent ?? criteria.sse_event;
    if (sseEvent !== undefined && !(record.sseEvents || []).some((event: NetworkFrameRecord) => networkSseEventMatches(event, sseEvent))) return false;
  }
  if (condition === 'idle') {
    const quietFor = Date.now() - Number(recorder.lastEventAt || recorder.startedAt || recorder.createdAt);
    return quietFor >= wait.idleMs;
  }
  if (condition === 'count') {
    const count = recorder.entries.filter((r: NetworkRecord) => networkRecordMatchesList(r, criteria)).length;
    return count >= wait.count;
  }
  const aliases: Record<string, string[]> = {
    request:['request','request_extra'], response:['response','response_extra'], body:['body'], bodycontains:['body'], finished:['finished'], failed:['failed'], websocket:['websocket'], ws:['websocket'], wsframe:['websocket'], sse:['sse'], eventsource:['sse'], sseevent:['sse'], any:['request','response','body','finished','failed','websocket','sse']
  };
  const allowed = aliases[condition] || [condition];
  return allowed.includes(eventType);
}
function finishNetworkRecorderWait(recorder: NetworkRecorder, wait: NetworkRecorderWait, ok: boolean, errorCode?: string | null, message?: string | null, details: JsonRecord = {}): void {
  if (!wait || wait.done) return;
  wait.done = true;
  try {
    clearTimeout(wait.timeoutHandle);
  } catch (_error) {
    /* best-effort network wait timeout cleanup */
  }
  try {
    clearInterval(wait.intervalHandle);
  } catch (_error) {
    /* best-effort network wait interval cleanup */
  }
  if (wait.abortHandler) {
    try {
      wait.abortController?.signal?.removeEventListener('abort', wait.abortHandler);
    } catch (_error) {
      /* best-effort network wait abort listener cleanup */
    }
  }
  recorder.waits.delete(wait.waitId);
  const elapsed_ms = Date.now() - wait.createdAt;
  if (ok) {
    recorder.counters.waitsResolved += 1;
    wait.resolve({ ok:true, data:{ waitId:wait.waitId, wait_id:wait.waitId, condition:wait.condition, elapsed_ms, ...(details || {}), recorder:networkRecorderSummary(recorder) } });
  } else {
    if (errorCode === PI_BROWSER_ERROR_CODES.TIMEOUT || errorCode === PI_BROWSER_ERROR_CODES.NETWORK_RECORDER_TIMEOUT) recorder.counters.waitsTimedOut += 1;
    if (errorCode === PI_BROWSER_ERROR_CODES.CANCELLED) recorder.counters.waitsCancelled += 1;
    wait.resolve(piBrowserError(errorCode || PI_BROWSER_ERROR_CODES.NETWORK_RECORDER_TIMEOUT, message || 'network.wait failed', { waitId:wait.waitId, condition:wait.condition, elapsed_ms, ...(details || {}), recorder:networkRecorderSummary(recorder) }));
  }
}
function wakeNetworkWaits(recorder: NetworkRecorder | null | undefined, eventType: string, rec: NetworkRecord | null): void {
  if (!recorder || !recorder.waits.size) return;
  for (const wait of Array.from(recorder.waits.values())) {
    if (wait.done) continue;
    if (networkWaitMatches(recorder, wait, eventType, rec)) {
      wait.lastMatchSeq = rec?.seq || wait.lastMatchSeq || 0;
      finishNetworkRecorderWait(recorder, wait, true, null, null, { event:eventType, request:rec ? networkRecordSummary(rec, { includeDetails:true }) : null });
    }
  }
}
async function waitNetworkRecorder(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const found = await requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const conditionRaw = msg.condition || msg.state || msg.event || 'response';
  const condition = String(conditionRaw).toLowerCase().replace(/[-_]/g, '');
  const timeoutMs = normalizePiBrowserTimeoutMs(msg, 30000);
  const waitId = String(msg.waitId || msg.wait_id || makeWaitId(tabId, 'network_recorder'));
  const criteria = { ...msg };
  const immediateMatch = (): JsonRecord | null => {
    if (condition === 'idle') {
      const idleMs = numberInRange(msg.idleMs ?? msg.idle_ms, 500, 50, Math.max(50, timeoutMs || 300000));
      const quietFor = Date.now() - Number(recorder.lastEventAt || recorder.startedAt || recorder.createdAt);
      if (quietFor >= idleMs) return { event:'idle', idle_ms:idleMs, quietFor };
      return null;
    }
    if (condition === 'count') {
      const count = numberInRange(msg.count ?? msg.minCount ?? msg.min_count, 1, 1, 1000000);
      const matches = recorder.entries.filter((r: NetworkRecord) => networkRecordMatchesList(r, criteria));
      if (matches.length >= count) return { event:'count', count:matches.length, required:count, requests:matches.slice(-10).map((r: NetworkRecord) => networkRecordSummary(r)) };
      return null;
    }
    const pseudoWait = { condition, criteria, idleMs:0, count:0 };
    for (const r of recorder.entries) {
      const phaseEvents = ['request'];
      if (r.response) phaseEvents.push('response');
      if (r.bodyRef) phaseEvents.push('body');
      if (r.phase === 'finished') phaseEvents.push('finished');
      if (r.phase === 'failed') phaseEvents.push('failed');
      for (const phaseEvent of phaseEvents) {
        if (networkWaitMatches(recorder, pseudoWait, phaseEvent, r)) return { event:phaseEvent, request:networkRecordSummary(r, { includeDetails:true }) };
      }
      if ((condition === 'websocket' || condition === 'ws') && (r.wsFrames || []).length && networkRecordMatchesList(r, criteria)) return { event:'websocket', request:networkRecordSummary(r, { includeDetails:true }) };
      if ((condition === 'sse' || condition === 'eventsource') && (r.sseEvents || []).length && networkRecordMatchesList(r, criteria)) return { event:'sse', request:networkRecordSummary(r, { includeDetails:true }) };
    }
    return null;
  };
  const instant = immediateMatch();
  if (instant || timeoutMs === 0) {
    if (instant) return { ok:true, data:{ waitId, wait_id:waitId, condition, elapsed_ms:0, ...instant, recorder:networkRecorderSummary(recorder), immediate:true } };
    return piBrowserError(PI_BROWSER_ERROR_CODES.NETWORK_RECORDER_TIMEOUT, 'network.wait immediate check failed', { waitId, condition, timeout_ms:0, criteria:redactSensitive(criteria), recorder:networkRecorderSummary(recorder) });
  }
  return await new Promise<PiBridgeResponse>(resolve => {
    const abortController = msg.abortController || new AbortController();
    const wait: NetworkRecorderWait = { waitId, condition, criteria, createdAt:Date.now(), resolve, abortController, done:false, idleMs:numberInRange(msg.idleMs ?? msg.idle_ms, 500, 50, Math.max(50, timeoutMs || 300000)), count:numberInRange(msg.count ?? msg.minCount ?? msg.min_count, 1, 1, 1000000), lastMatchSeq:0 };
    wait.abortHandler = () => finishNetworkRecorderWait(recorder, wait, false, PI_BROWSER_ERROR_CODES.CANCELLED, 'network.wait cancelled', { criteria:redactSensitive(criteria) });
    try {
      abortController.signal.addEventListener('abort', wait.abortHandler, { once:true });
    } catch (_error) {
      /* best-effort network wait abort listener registration */
    }
    wait.timeoutHandle = setTimeout(() => finishNetworkRecorderWait(recorder, wait, false, PI_BROWSER_ERROR_CODES.NETWORK_RECORDER_TIMEOUT, 'network.wait timed out', { timeout_ms:timeoutMs, criteria:redactSensitive(criteria), lastEntries:recorder.entries.slice(-20).map((r: NetworkRecord) => networkRecordSummary(r)) }), timeoutMs);
    if (condition === 'idle' || condition === 'count') wait.intervalHandle = setInterval(() => {
      const m = immediateMatch();
      if (m) finishNetworkRecorderWait(recorder, wait, true, null, null, m);
    }, Math.min(250, Math.max(50, wait.idleMs || 250)));
    recorder.waits.set(waitId, wait);
  });
}
async function handleNetworkRecorderCommand(tabId: number, cmd: string, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  switch (cmd) {
    case 'network.start': return await startNetworkRecorder(tabId, msg);
    case 'network.stop': return await stopNetworkRecorder(tabId, msg || {});
    case 'network.status': {
      const recorder = getActiveNetworkRecorder(tabId, msg || {});
      if (!recorder) {
        const sessionId = defaultNetworkSessionId(msg || {});
        const lost = summarizeLostNetworkRuntimeSession(await findLostNetworkRuntimeSession('network', tabId, sessionId));
        return { ok:true, data:{ tabId:Number(tabId), sessionId, active:false, stateLost: !!lost, lostSession: lost, recorders:Array.from(piBrowserNetworkRecorders.values()).filter(r => Number(r.tabId) === Number(tabId)).map(networkRecorderSummary) } };
      }
      return { ok:true, data:networkRecorderSummary(recorder) };
    }
    case 'network.clear': {
      const found = await requireNetworkRecorder(tabId, msg || {}); if (found.error) return found.error;
      const cleared = clearNetworkRecorderBuffer(found.recorder);
      return { ok:true, data:{ ...networkRecorderSummary(found.recorder), cleared } };
    }
    case 'network.list': return await listNetworkRecorderEntries(tabId, msg || {});
    case 'network.get': return await getNetworkRecorderEntry(tabId, msg || {});
    case 'network.body': return await getNetworkRecorderBody(tabId, msg || {});
    case 'network.exportHar': return await exportNetworkRecorderHar(tabId, msg || {});
    case 'network.wait': return await waitNetworkRecorder(tabId, msg || {});
  }
  return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown network recorder command: ' + cmd, { cmd, tabId });
}

// --- Startup recovery registration ---
registerRecovery(async (results) => {
  const result = await recoverState('network', {
    validateTab: true,
    recover: async (record) => {
      const tabId = record.tabId;
      const configRecord = record.config as JsonRecord | undefined;
      if (!tabId || !configRecord) return { recovered: false, historyLost: true, reason: 'missing tabId or config' };
      const config = normalizeNetworkRecorderConfig(configRecord);
      const key = networkRecorderKey(tabId, config.sessionId || 'default');
      // Don't overwrite an existing active recorder
      if (piBrowserNetworkRecorders.has(key)) return { recovered: false, historyLost: true, reason: 'recorder already exists' };
      try {
        const recorder = createNetworkRecorder(tabId, config);
        recorder.recoveredAt = Date.now();
        recorder.historyLost = true;
        recorder.stateGeneration = Number(record.generation || 0);
        piBrowserNetworkRecorders.set(key, recorder);
        await enablePiBrowserCdpDomains(recorder.cdpRecord, ['Network', 'Page']);
        if (config.storePostData) {
          try { await cdpSendNetworkCommand(tabId, 'Network.enable', { maxPostDataSize: config.maxPostDataBytes }, 2000); }
          catch (e) { rememberNetworkError(recorder, 'Network.enable.maxPostDataSize', e); }
        }
        subscribePiBrowserCdp(tabId, NETWORK_RECORDER_EVENTS, (source, method, params) => handleNetworkRecorderCdpEvent(recorder, source, method, params), recorder.cdpRecord);
        try { await cdpSendNetworkCommand(tabId, 'Page.setLifecycleEventsEnabled', { enabled:true }, 2000); } catch (e) { rememberNetworkError(recorder, 'Page.setLifecycleEventsEnabled', e); }
        recorder.active = true;
        recorder.startedAt = Date.now();
        recorder.diagnostics.push({ t: Date.now(), action: 'recovered', historyLost: true, previousWorkerBootId: record.workerBootId, generation: record.generation });
        console.log('[PI-BROWSER-NET] Recovered network recorder', key, 'historyLost=true');
        return { recovered: true, historyLost: true };
      } catch (error) {
        console.warn('[PI-BROWSER-NET] Failed to recover network recorder', key, error);
        return { recovered: false, historyLost: true, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  results.push(result);
});

export { cdpSendNetworkCommand, maybeCaptureNetworkBody, appendBounded, handleNetworkRecorderCdpEvent, startNetworkRecorder, clearNetworkRecorderBuffer, cleanupNetworkRecorder, stopNetworkRecorder, cleanupNetworkRecorderTab, requireNetworkRecorder, listNetworkRecorderEntries, getNetworkRecorderEntry, getNetworkRecorderBody, makeHarEntry, exportNetworkRecorderHar, networkWaitMatches, finishNetworkRecorderWait, wakeNetworkWaits, waitNetworkRecorder, handleNetworkRecorderCommand };
// ESM module metadata
export const __piBridgeModule_network = { name: "network", symbols: { cdpSendNetworkCommand, maybeCaptureNetworkBody, appendBounded, handleNetworkRecorderCdpEvent, startNetworkRecorder, clearNetworkRecorderBuffer, cleanupNetworkRecorder, stopNetworkRecorder, cleanupNetworkRecorderTab, requireNetworkRecorder, listNetworkRecorderEntries, getNetworkRecorderEntry, getNetworkRecorderBody, makeHarEntry, exportNetworkRecorderHar, networkWaitMatches, finishNetworkRecorderWait, wakeNetworkWaits, waitNetworkRecorder, handleNetworkRecorderCommand } };
