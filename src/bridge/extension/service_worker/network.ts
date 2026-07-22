// network.js - Browser Pilot Network recorder CDP event, lifecycle and command runtime.
// Loaded after network_model.js by background.js.
import { chromeApi as chrome } from "./runtimeEnv";
import { BROWSER_PILOT_ERROR_CODES, normalizePersistentBrowserPilotResponse, browserPilotError, browserPilotPersistentCdp, browserPilotWithTimeout, redactSensitive, runtimeErrorMessage as errorText, runtimeRecord as asRecord } from "./runtimeSupport.js";
import { findLostRuntimeSession, persist as persistState, forget as forgetState, recover as recoverState, registerRecovery, summarizeLostRuntimeSession } from "./state_store.js";
import { enableBrowserPilotCdpDomains, releaseBrowserPilotCdpDomains, subscribeBrowserPilotCdp, unsubscribeBrowserPilotCdp } from "./wait_cdp";
import { makeWaitId, normalizeBrowserPilotTimeoutMs } from "./wait_coordinator";
import { appendBounded, browserPilotNetworkHandleRecorderCdpEvent, browserPilotNetworkMaybeCaptureBody } from "./network_events";
import { classifyNetworkBodyError, createNetworkRecorder, defaultNetworkSessionId, getActiveNetworkRecorder, getNetworkRecorder, estimateStringBytes, getHeaderValue, networkRecordClone, networkCriterionMatchesText, networkRecordMatchesList, networkRecordSummary, networkRecorderKey, networkRecorderSummary, headersObjectToArray, numberInRange, browserPilotNetworkRecorders, recorderPublicConfig, rememberNetworkError, normalizeNetworkRecorderConfig, truncateBase64Body, truncateStringByBytes, networkSseEventMatches, networkWsFrameMatches, setNetworkWaitNotifier } from "./network_model";
import type { JsonRecord, NetworkClearResult, NetworkHarContent, NetworkHarEntry, NetworkRecorderSummary, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse } from "./types";
import type { NetworkBodyStoreEntry, NetworkFrameRecord, NetworkRecord, NetworkRecorder, NetworkRecorderWait } from "./network_model";

const findLostNetworkRuntimeSession = typeof findLostRuntimeSession === "function" ? findLostRuntimeSession : async () => undefined;
const summarizeLostNetworkRuntimeSession = typeof summarizeLostRuntimeSession === "function" ? summarizeLostRuntimeSession : () => undefined;
type NetworkCommandResult = Record<string, unknown>;
type NetworkRecorderLookup = { recorder: NetworkRecorder; error?: never } | { recorder?: never; error: BrowserPilotBridgeResponse };
type HarContent = NetworkHarContent;
setNetworkWaitNotifier(wakeNetworkWaits);
const NETWORK_RECORDER_EVENTS = ['Network.requestWillBeSent','Network.requestWillBeSentExtraInfo','Network.responseReceived','Network.responseReceivedExtraInfo','Network.dataReceived','Network.requestServedFromCache','Network.loadingFinished','Network.loadingFailed','Network.webSocketCreated','Network.webSocketWillSendHandshakeRequest','Network.webSocketHandshakeResponseReceived','Network.webSocketFrameSent','Network.webSocketFrameReceived','Network.webSocketFrameError','Network.webSocketClosed','Network.eventSourceMessageReceived','Page.frameNavigated','Page.loadEventFired','Page.domContentEventFired','Page.lifecycleEvent','Page.frameStoppedLoading'];
const NETWORK_DIAGNOSTICS_MAX = 100;
const NETWORK_WAIT_EVENT_ALIASES: Record<string, string[]> = {
  request:['request','request_extra'], response:['response','response_extra'], body:['body'], bodycontains:['body'], finished:['finished'], failed:['failed'], websocket:['websocket'], ws:['websocket'], wsframe:['websocket'], sse:['sse'], eventsource:['sse'], sseevent:['sse'], any:['request','response','body','finished','failed','websocket','sse'],
};

function rememberNetworkDiagnostic(recorder: NetworkRecorder, entry: JsonRecord): void {
  appendBounded(recorder.diagnostics, entry, NETWORK_DIAGNOSTICS_MAX);
}

async function cdpSendNetworkCommand(tabId: number, method: string, params: JsonRecord = {}, timeoutMs?: number): Promise<NetworkCommandResult> {
  const cdp = browserPilotPersistentCdp();
  if (cdp?.send) {
    const resp = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, method, params || {}, { persistent:true, name:'network_recorder', timeoutMs }));
    const error = asRecord(resp?.error);
    if (!resp || resp.ok === false) throw new Error(String(error.message || resp?.message || resp?.error || (method + ' failed')));
    const data = asRecord(resp.data);
    return asRecord(data.result || resp.result || resp.data || {});
  }
  return asRecord(await browserPilotWithTimeout(chrome.debugger.sendCommand({ tabId:Number(tabId) }, method, params || {}), timeoutMs || 5000, method));
}
async function maybeCaptureNetworkBody(recorder: NetworkRecorder, rec: NetworkRecord): Promise<void> {
  return await browserPilotNetworkMaybeCaptureBody(recorder, rec, { cdpSendNetworkCommand, classifyNetworkBodyError, wakeNetworkWaits });
}
function handleNetworkRecorderCdpEvent(recorder: NetworkRecorder, source: { tabId?: number }, method: string, params: JsonRecord = {}): void {
  browserPilotNetworkHandleRecorderCdpEvent(recorder, source, method, params, { wakeNetworkWaits, maybeCaptureNetworkBody });
}
async function activateNetworkRecorder(recorder: NetworkRecorder): Promise<void> {
  const { tabId, config } = recorder;
  await enableBrowserPilotCdpDomains(recorder.cdpRecord, ['Network', 'Page']);
  if (config.storePostData) try { await cdpSendNetworkCommand(tabId, 'Network.enable', { maxPostDataSize:config.maxPostDataBytes }, 2000); } catch (error) { rememberNetworkError(recorder, 'Network.enable.maxPostDataSize', error); }
  subscribeBrowserPilotCdp(tabId, NETWORK_RECORDER_EVENTS, (source, method, params) => handleNetworkRecorderCdpEvent(recorder, source, method, params), recorder.cdpRecord);
  try { await cdpSendNetworkCommand(tabId, 'Page.setLifecycleEventsEnabled', { enabled:true }, 2000); } catch (error) { rememberNetworkError(recorder, 'Page.setLifecycleEventsEnabled', error); }
  recorder.active = true; recorder.startedAt = Date.now();
}
async function persistNetworkRecorderState(recorder: NetworkRecorder, action: string): Promise<void> {
  try {
    const persisted = await persistState('network', networkRecorderKey(recorder.tabId, recorder.config.sessionId), recorderPublicConfig(recorder.config), { tabId:recorder.tabId, sessionId:recorder.config.sessionId, recoveryPolicy:'auto' });
    if (persisted.generation !== undefined) recorder.stateGeneration = Number(persisted.generation);
    if (!persisted.ok && persisted.error) rememberNetworkDiagnostic(recorder, { t:Date.now(), action:'persist_failed', error:persisted.error });
  } catch (error) { console.warn(`[BROWSER-PILOT-NET] Failed to persist recorder state during ${action}`, recorder.config.sessionId, error); }
}
async function startNetworkRecorder(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const config = normalizeNetworkRecorderConfig(msg || {});
  const key = networkRecorderKey(tabId, config.sessionId);
  let recorder = browserPilotNetworkRecorders.get(key);
  if (recorder && recorder.active && msg.reconfigure !== false) {
    recorder.config = config; recorder.filter = config.filter;
    if (config.clearOnStart) clearNetworkRecorderBuffer(recorder);
    rememberNetworkDiagnostic(recorder, { t:Date.now(), action:'reconfigure', config:recorderPublicConfig(config) });
    await persistNetworkRecorderState(recorder, 'reconfigure');
    return { ok:true, data:{ ...networkRecorderSummary(recorder), reconfigured:true } };
  }
  if (recorder && recorder.active) return browserPilotError(BROWSER_PILOT_ERROR_CODES.ALREADY_INSTALLED, 'network recorder already started', { tabId, sessionId:config.sessionId });
  if (recorder) await stopNetworkRecorder(tabId, { sessionId:config.sessionId, keepBuffer:false, reason:'restart' }).catch(() => {});
  recorder = createNetworkRecorder(tabId, config);
  browserPilotNetworkRecorders.set(key, recorder);
  try {
    await activateNetworkRecorder(recorder);
    rememberNetworkDiagnostic(recorder, { t:Date.now(), action:'start', events:NETWORK_RECORDER_EVENTS, config:recorderPublicConfig(config) });
    await persistNetworkRecorderState(recorder, 'start');
    return { ok:true, data:networkRecorderSummary(recorder) };
  } catch (e) {
    rememberNetworkError(recorder, 'start', e);
    cleanupNetworkRecorder(recorder, 'start_failed', { keepBuffer:false });
    browserPilotNetworkRecorders.delete(key);
    return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, 'network.start failed', { tabId, sessionId:config.sessionId, error:errorText(e) });
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
  rememberNetworkDiagnostic(recorder, { t:Date.now(), action:'clear', entries, bodies });
  return { entries, bodies };
}
function cleanupNetworkRecorder(recorder: NetworkRecorder | null | undefined, reason?: string, options: { keepBuffer?: boolean } = {}): { stopped: boolean; summary?: NetworkRecorderSummary | null } {
  if (!recorder) return { stopped:false };
  options = options || {};
  recorder.active = false;
  recorder.stoppedAt = Date.now();
  for (const wait of Array.from(recorder.waits.values())) finishNetworkRecorderWait(recorder, wait, false, BROWSER_PILOT_ERROR_CODES.CANCELLED, 'network recorder stopped', { reason:reason || 'stopped' });
  for (const sid of Array.from(recorder.cdpRecord.cdpSubscriptions || [])) {
    try {
      unsubscribeBrowserPilotCdp(sid);
    } catch (_error) {
      /* best-effort network recorder CDP subscription cleanup */
    }
  }
  recorder.cdpRecord.cdpSubscriptions = [];
  releaseBrowserPilotCdpDomains(recorder.cdpRecord, Array.from(recorder.cdpRecord.cdpDomains || []), reason || 'network_recorder_stop');
  recorder.cdpRecord.cdpAttached = false;
  if (options.keepBuffer === false) clearNetworkRecorderBuffer(recorder);
  rememberNetworkDiagnostic(recorder, { t:Date.now(), action:'stop', reason:reason || 'stopped', keepBuffer:options.keepBuffer !== false });
  return { stopped:true, summary:networkRecorderSummary(recorder) };
}
async function stopNetworkRecorder(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const sessionId = defaultNetworkSessionId(msg || {});
  const recorder = getNetworkRecorder(tabId, sessionId);
  if (!recorder) return browserPilotError(BROWSER_PILOT_ERROR_CODES.NETWORK_RECORDER_NOT_STARTED, 'network recorder is not started', { tabId, sessionId });
  const keepBuffer = msg.keepBuffer !== false && msg.keep_buffer !== false && msg.clear !== true;
  const result = cleanupNetworkRecorder(recorder, String(msg.reason || 'stop'), { keepBuffer });
  if (!keepBuffer || msg.remove === true) browserPilotNetworkRecorders.delete(recorder.key);
  // Forget persisted state on explicit stop
  try { await forgetState('network', networkRecorderKey(tabId, sessionId)); } catch (error) { console.warn('[BROWSER-PILOT-NET] Failed to forget recorder state on stop', sessionId, error); }
  return { ok:true, data:{ ...result.summary, stopped:true, keepBuffer } };
}
function cleanupNetworkRecorderTab(tabId: number, reason?: string): Array<{ sessionId: string; recorderId: string }> {
  const out: Array<{ sessionId: string; recorderId: string }> = [];
  for (const recorder of Array.from(browserPilotNetworkRecorders.values())) {
    if (Number(recorder.tabId) !== Number(tabId)) continue;
    cleanupNetworkRecorder(recorder, reason || 'tab_cleanup', { keepBuffer:false });
    browserPilotNetworkRecorders.delete(recorder.key);
    // Forget persisted state on tab cleanup
    void forgetState('network', recorder.key).catch((error) => console.warn('[BROWSER-PILOT-NET] Failed to forget recorder state during tab cleanup', recorder.key, error));
    out.push({ sessionId:recorder.sessionId, recorderId:recorder.recorderId });
  }
  return out;
}
async function requireNetworkRecorder(tabId: number, msg: BrowserPilotBridgeCommand): Promise<NetworkRecorderLookup> {
  const recorder = getActiveNetworkRecorder(tabId, msg || {});
  if (!recorder) {
    const sessionId = defaultNetworkSessionId(msg || {});
    return { error: browserPilotError(BROWSER_PILOT_ERROR_CODES.NETWORK_RECORDER_NOT_STARTED, 'network recorder is not started', { tabId, sessionId, lostSession: summarizeLostNetworkRuntimeSession(await findLostNetworkRuntimeSession('network', tabId, sessionId)) }) };
  }
  return { recorder };
}
async function listNetworkRecorderEntries(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
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
async function getNetworkRecorderEntry(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const found = await requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const id = String(msg.requestId || msg.request_id || msg.id || '');
  if (!id) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'network.get requires requestId or id', { tabId });
  const rec = findNetworkRecorderEntry(recorder, id);
  if (!rec) return browserPilotError(BROWSER_PILOT_ERROR_CODES.REQUEST_NOT_FOUND || 'REQUEST_NOT_FOUND', 'network request not found', { tabId, sessionId:recorder.sessionId, requestId:id });
  return { ok:true, data:networkRecordClone(rec, { includeBody: msg.includeBody === true || msg.include_body === true }) };
}
function findNetworkRecorderEntry(recorder: NetworkRecorder, id: string): NetworkRecord | undefined {
  return recorder.byRequestId.get(id) || recorder.entries.find((entry) => String(entry.id) === id || String(entry.requestId) === id);
}
function unavailableNetworkBody(tabId: number, recorder: NetworkRecorder, requestId: string, ref: string, rec: NetworkRecord | undefined): BrowserPilotBridgeResponse {
  const reason = firstTruthyOr(requestId ? 'body_not_captured' : 'missing_request_id', rec?.bodyUnavailableReason);
  return browserPilotError(BROWSER_PILOT_ERROR_CODES.BODY_UNAVAILABLE, `network body is unavailable (${reason})`, {
    tabId,
    sessionId:recorder.sessionId,
    requestId,
    bodyRef:ref,
    bodyAvailability:firstTruthyOr('not_requested', rec?.bodyAvailability),
    bodyUnavailableReason:reason,
    bodyError:firstTruthyOr(null, rec?.bodyError),
    request:rec ? networkRecordSummary(rec) : null,
  });
}
async function getNetworkRecorderBody(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const found = await requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const ref = String(firstTruthyOr('', msg.bodyRef, msg.body_ref));
  const requestId = String(firstTruthyOr('', msg.requestId, msg.request_id, msg.id));
  const rec = requestId ? findNetworkRecorderEntry(recorder, requestId) : undefined;
  const bodyRef = firstTruthyOr<string | undefined>(undefined, ref, rec?.bodyRef, recorder.bodyByRequestId.get(requestId));
  if (!bodyRef) return unavailableNetworkBody(tabId, recorder, requestId, ref, rec);
  const body = recorder.bodyStore.get(bodyRef);
  if (!body) return browserPilotError(BROWSER_PILOT_ERROR_CODES.BODY_UNAVAILABLE, 'network body ref not found (body_ref_missing: the captured body was evicted from the recorder store; re-record with a fresh entry)', { tabId, sessionId:recorder.sessionId, requestId, bodyRef, bodyAvailability:'expired', bodyUnavailableReason:'body_ref_missing', request:rec ? networkRecordSummary(rec) : null });
  const maxBytesRaw = firstDefinedOr<unknown>(undefined, msg.maxBytes, msg.max_bytes);
  let out = { ...body };
  if (maxBytesRaw !== undefined) {
    const maxBytes = numberInRange(maxBytesRaw, body.bytes, 0, Math.max(body.bytes || 0, body.originalLength || 0, 10 * 1024 * 1024));
    const trunc = body.base64Encoded ? truncateBase64Body(body.body || '', maxBytes) : truncateStringByBytes(body.body || '', maxBytes);
    out = { ...out, body:trunc.value, bodyTruncated:firstTruthyOr(false, body.bodyTruncated, trunc.truncated), bytes:trunc.bytes };
  }
  return { ok:true, data:redactSensitive(out) };
}
function firstTruthyOr<T>(fallback: T, ...values: unknown[]): T {
  for (const value of values) if (value) return value as T;
  return fallback;
}
function firstDefinedOr<T>(fallback: T, ...values: unknown[]): T {
  for (const value of values) if (value !== undefined && value !== null) return value as T;
  return fallback;
}
function makeHarEntry(rec: NetworkRecord, body: NetworkBodyStoreEntry | null): NetworkHarEntry {
  const request = rec.request;
  const response: NonNullable<NetworkRecord['response']> = rec.response || {};
  const requestExtra: NonNullable<NetworkRecord['requestExtraInfo']> = rec.requestExtraInfo || {};
  const responseExtra: NonNullable<NetworkRecord['responseExtraInfo']> = rec.responseExtraInfo || {};
  const startedDateTime = rec.wallTime ? new Date(rec.wallTime * 1000).toISOString() : new Date(rec.createdAt || Date.now()).toISOString();
  const requestHeaders = headersObjectToArray(firstTruthyOr({}, request.headers, requestExtra.headers));
  const responseHeaders = headersObjectToArray(firstTruthyOr({}, response.headers, responseExtra.headers));
  const bodyAvailability = firstTruthyOr(rec.bodyRef ? 'captured' : 'not_requested', rec.bodyAvailability);
  const postData = request.postData;
  const content: HarContent = {
    size:firstTruthyOr(-1, rec.data.dataLength, rec.encodedDataLength),
    mimeType:firstTruthyOr('', response.mimeType, getHeaderValue(response.headers, 'content-type')),
    compression:0,
  };
  if (body) { content.text = body.body; content.encoding = body.base64Encoded ? 'base64' : undefined; content._bodyRef = body.bodyRef; content._bodyTruncated = !!body.bodyTruncated; }
  content._bodyAvailability = bodyAvailability;
  content._bodyUnavailableReason = firstTruthyOr(null, rec.bodyUnavailableReason);
  return {
    startedDateTime,
    time:Math.max(0, Number(firstTruthyOr(Date.now(), rec.finishedAt, rec.updatedAt)) - Number(firstTruthyOr(Date.now(), rec.createdAt))),
    request:{ method:firstTruthyOr('GET', request.method), url:firstTruthyOr('', request.url, response.url), httpVersion:firstTruthyOr('HTTP/1.1', response.protocol), headers:requestHeaders, queryString:[], cookies:[], headersSize:-1, bodySize:postData ? estimateStringBytes(postData) : 0, postData:postData ? { mimeType:getHeaderValue(request.headers, 'content-type'), text:postData, _truncated:!!request.postDataTruncated } : undefined },
    response:{ status:Number(firstTruthyOr(0, response.status, responseExtra.statusCode)), statusText:firstTruthyOr('', response.statusText), httpVersion:firstTruthyOr('HTTP/1.1', response.protocol), headers:responseHeaders, cookies:[], content, redirectURL:getHeaderValue(response.headers, 'location'), headersSize:-1, bodySize:firstTruthyOr(-1, rec.data.encodedDataLength, rec.encodedDataLength), _error:firstTruthyOr(undefined, rec.errorText) },
    cache:{},
    timings:{ blocked:-1, dns:-1, connect:-1, send:0, wait:-1, receive:-1, ssl:-1 },
    serverIPAddress:response.remoteIPAddress,
    connection:String(firstTruthyOr('', response.connectionId)),
    _requestId:rec.requestId,
    _seq:rec.seq,
    _type:firstTruthyOr('', rec.type, rec.resourceType),
    _initiator:rec.initiator,
    _redirects:firstTruthyOr([], rec.redirects),
    _wsFrames:firstTruthyOr([], rec.wsFrames),
    _sseEvents:firstTruthyOr([], rec.sseEvents),
    _bodyRef:firstTruthyOr(null, rec.bodyRef),
    _bodyError:firstTruthyOr(null, rec.bodyError),
    _bodyAvailability:bodyAvailability,
    _bodyUnavailableReason:firstTruthyOr(null, rec.bodyUnavailableReason),
  };
}
async function exportNetworkRecorderHar(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
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
  return { ok:true, data:{ log:{ version:'1.2', creator:{ name:'Browser Pilot NetworkRecorder', version:'1.0' }, pages:[], entries }, diagnostics:networkRecorderSummary(recorder) } };
}
function networkWaitListFilters(criteria: JsonRecord): JsonRecord {
  return {
    requestId:firstTruthyOr(undefined, criteria.requestId, criteria.request_id),
    url:criteria.url,
    urlContains:firstDefinedOr(undefined, criteria.urlContains, criteria.url_contains),
    urlPattern:firstDefinedOr(undefined, criteria.urlPattern, criteria.url_pattern),
    method:criteria.method,
    type:firstTruthyOr(undefined, criteria.type, criteria.resourceType, criteria.resource_type),
    mime:firstTruthyOr(undefined, criteria.mime, criteria.mimeType, criteria.mime_type),
    status:criteria.status,
    includeUrls:firstTruthyOr(undefined, criteria.includeUrls, criteria.include_urls),
    excludeUrls:firstTruthyOr(undefined, criteria.excludeUrls, criteria.exclude_urls),
  };
}
function networkRecordMatchesWaitCriteria(recorder: NetworkRecorder, record: NetworkRecord, criteria: JsonRecord): boolean {
  if (!networkRecordMatchesList(record, networkWaitListFilters(criteria))) return false;
  const bodyContains = firstDefinedOr(undefined, criteria.bodyContains, criteria.body_contains);
  if (bodyContains !== undefined) {
    const stored = record.bodyRef ? recorder.bodyStore.get(record.bodyRef) : undefined;
    if (!stored || !networkCriterionMatchesText(stored.body, bodyContains)) return false;
  }
  const wsFrame = firstDefinedOr(undefined, criteria.wsFrame, criteria.ws_frame);
  if (wsFrame !== undefined && !firstTruthyOr<NetworkFrameRecord[]>([], record.wsFrames).some((frame) => networkWsFrameMatches(frame, wsFrame))) return false;
  const sseEvent = firstDefinedOr(undefined, criteria.sseEvent, criteria.sse_event);
  if (sseEvent !== undefined && !firstTruthyOr<NetworkFrameRecord[]>([], record.sseEvents).some((event) => networkSseEventMatches(event, sseEvent))) return false;
  return true;
}
function networkWaitMatches(recorder: NetworkRecorder, wait: Pick<NetworkRecorderWait, "condition" | "criteria" | "idleMs" | "count">, eventType: string, rec: NetworkRecord | null): boolean {
  const { condition } = wait;
  const criteria = firstTruthyOr<JsonRecord>({}, wait.criteria);
  if (rec && !networkRecordMatchesWaitCriteria(recorder, rec, criteria)) return false;
  if (condition === 'idle') {
    const quietFor = Date.now() - Number(firstTruthyOr(recorder.createdAt, recorder.lastEventAt, recorder.startedAt));
    return quietFor >= wait.idleMs;
  }
  if (condition === 'count') {
    const count = recorder.entries.filter((r: NetworkRecord) => networkRecordMatchesList(r, criteria)).length;
    return count >= wait.count;
  }
  const allowed = firstTruthyOr([condition], NETWORK_WAIT_EVENT_ALIASES[condition]);
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
    if (errorCode === BROWSER_PILOT_ERROR_CODES.TIMEOUT || errorCode === BROWSER_PILOT_ERROR_CODES.NETWORK_RECORDER_TIMEOUT) recorder.counters.waitsTimedOut += 1;
    if (errorCode === BROWSER_PILOT_ERROR_CODES.CANCELLED) recorder.counters.waitsCancelled += 1;
    wait.resolve(browserPilotError(errorCode || BROWSER_PILOT_ERROR_CODES.NETWORK_RECORDER_TIMEOUT, message || 'network.wait failed', { waitId:wait.waitId, condition:wait.condition, elapsed_ms, ...(details || {}), recorder:networkRecorderSummary(recorder) }));
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
function networkWaitIdleMs(msg: BrowserPilotBridgeCommand, timeoutMs: number): number {
  return numberInRange(firstDefinedOr<unknown>(undefined, msg.idleMs, msg.idle_ms), 500, 50, Math.max(50, firstTruthyOr(300000, timeoutMs)));
}
function networkWaitCount(msg: BrowserPilotBridgeCommand): number {
  return numberInRange(firstDefinedOr<unknown>(undefined, msg.count, msg.minCount, msg.min_count), 1, 1, 1000000);
}
function immediateIdleNetworkMatch(recorder: NetworkRecorder, idleMs: number): JsonRecord | null {
  const quietFor = Date.now() - Number(firstTruthyOr(recorder.createdAt, recorder.lastEventAt, recorder.startedAt));
  return quietFor >= idleMs ? { event:'idle', idle_ms:idleMs, quietFor } : null;
}
function immediateCountNetworkMatch(recorder: NetworkRecorder, criteria: JsonRecord, count: number): JsonRecord | null {
  const matches = recorder.entries.filter((record) => networkRecordMatchesList(record, criteria));
  return matches.length >= count ? { event:'count', count:matches.length, required:count, requests:matches.slice(-10).map((record) => networkRecordSummary(record)) } : null;
}
function immediateNetworkRecordEvents(record: NetworkRecord, condition: string): string[] {
  const events = ['request'];
  if (record.response) events.push('response');
  if (record.bodyRef) events.push('body');
  if (record.phase === 'finished') events.push('finished');
  if (record.phase === 'failed') events.push('failed');
  if ((condition === 'websocket' || condition === 'ws') && firstTruthyOr<NetworkFrameRecord[]>([], record.wsFrames).length) events.push('websocket');
  if ((condition === 'sse' || condition === 'eventsource') && firstTruthyOr<NetworkFrameRecord[]>([], record.sseEvents).length) events.push('sse');
  return events;
}
function immediateEventNetworkMatch(recorder: NetworkRecorder, condition: string, criteria: JsonRecord): JsonRecord | null {
  const wait = { condition, criteria, idleMs:0, count:0 };
  for (const record of recorder.entries) {
    for (const event of immediateNetworkRecordEvents(record, condition)) {
      if (networkWaitMatches(recorder, wait, event, record)) return { event, request:networkRecordSummary(record, { includeDetails:true }) };
    }
  }
  return null;
}
function immediateNetworkWaitMatch(recorder: NetworkRecorder, condition: string, criteria: JsonRecord, msg: BrowserPilotBridgeCommand, timeoutMs: number): JsonRecord | null {
  if (condition === 'idle') return immediateIdleNetworkMatch(recorder, networkWaitIdleMs(msg, timeoutMs));
  if (condition === 'count') return immediateCountNetworkMatch(recorder, criteria, networkWaitCount(msg));
  return immediateEventNetworkMatch(recorder, condition, criteria);
}
async function waitNetworkRecorder(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const found = await requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const conditionRaw = firstTruthyOr('response', msg.condition, msg.state, msg.event);
  const condition = String(conditionRaw).toLowerCase().replace(/[-_]/g, '');
  const timeoutMs = normalizeBrowserPilotTimeoutMs(msg, 30000);
  const requestedWaitId = firstTruthyOr('', msg.waitId, msg.wait_id);
  const waitId = String(requestedWaitId || makeWaitId(tabId, 'network_recorder'));
  const criteria = { ...msg };
  const immediateMatch = () => immediateNetworkWaitMatch(recorder, condition, criteria, msg, timeoutMs);
  const instant = immediateMatch();
  if (instant || timeoutMs === 0) {
    if (instant) return { ok:true, data:{ waitId, wait_id:waitId, condition, elapsed_ms:0, ...instant, recorder:networkRecorderSummary(recorder), immediate:true } };
    return browserPilotError(BROWSER_PILOT_ERROR_CODES.NETWORK_RECORDER_TIMEOUT, 'network.wait immediate check failed', { waitId, condition, timeout_ms:0, criteria:redactSensitive(criteria), recorder:networkRecorderSummary(recorder) });
  }
  return await new Promise<BrowserPilotBridgeResponse>(resolve => {
    const abortController = msg.abortController || new AbortController();
    const wait: NetworkRecorderWait = { waitId, condition, criteria, createdAt:Date.now(), resolve, abortController, done:false, idleMs:networkWaitIdleMs(msg, timeoutMs), count:networkWaitCount(msg), lastMatchSeq:0 };
    wait.abortHandler = () => finishNetworkRecorderWait(recorder, wait, false, BROWSER_PILOT_ERROR_CODES.CANCELLED, 'network.wait cancelled', { criteria:redactSensitive(criteria) });
    try {
      abortController.signal.addEventListener('abort', wait.abortHandler, { once:true });
    } catch (_error) {
      /* best-effort network wait abort listener registration */
    }
    wait.timeoutHandle = setTimeout(() => finishNetworkRecorderWait(recorder, wait, false, BROWSER_PILOT_ERROR_CODES.NETWORK_RECORDER_TIMEOUT, 'network.wait timed out', { timeout_ms:timeoutMs, criteria:redactSensitive(criteria), lastEntries:recorder.entries.slice(-20).map((r: NetworkRecord) => networkRecordSummary(r)) }), timeoutMs);
    if (condition === 'idle' || condition === 'count') wait.intervalHandle = setInterval(() => {
      const m = immediateMatch();
      if (m) finishNetworkRecorderWait(recorder, wait, true, null, null, m);
    }, Math.min(250, Math.max(50, wait.idleMs || 250)));
    recorder.waits.set(waitId, wait);
  });
}
async function handleNetworkRecorderCommand(tabId: number, cmd: string, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const command = msg || {} as BrowserPilotBridgeCommand;
  switch (cmd) {
    case 'network.start': return await startNetworkRecorder(tabId, command);
    case 'network.stop': return await stopNetworkRecorder(tabId, command);
    case 'network.status': {
      const recorder = getActiveNetworkRecorder(tabId, command);
      if (!recorder) {
        const sessionId = defaultNetworkSessionId(command);
        const lost = summarizeLostNetworkRuntimeSession(await findLostNetworkRuntimeSession('network', tabId, sessionId));
        return { ok:true, data:{ tabId:Number(tabId), sessionId, active:false, stateLost: !!lost, lostSession: lost, recorders:Array.from(browserPilotNetworkRecorders.values()).filter(r => Number(r.tabId) === Number(tabId)).map(networkRecorderSummary) } };
      }
      return { ok:true, data:networkRecorderSummary(recorder) };
    }
    case 'network.clear': {
      const found = await requireNetworkRecorder(tabId, command); if (found.error) return found.error;
      const cleared = clearNetworkRecorderBuffer(found.recorder);
      return { ok:true, data:{ ...networkRecorderSummary(found.recorder), cleared } };
    }
    case 'network.list': return await listNetworkRecorderEntries(tabId, command);
    case 'network.get': return await getNetworkRecorderEntry(tabId, command);
    case 'network.body': return await getNetworkRecorderBody(tabId, command);
    case 'network.exportHar': return await exportNetworkRecorderHar(tabId, command);
    case 'network.wait': return await waitNetworkRecorder(tabId, command);
  }
  return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'Unknown network recorder command: ' + cmd, { cmd, tabId });
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
      if (browserPilotNetworkRecorders.has(key)) return { recovered: false, historyLost: true, reason: 'recorder already exists' };
      try {
        const recorder = createNetworkRecorder(tabId, config);
        recorder.recoveredAt = Date.now();
        recorder.historyLost = true;
        recorder.stateGeneration = Number(record.generation || 0);
        browserPilotNetworkRecorders.set(key, recorder);
        await activateNetworkRecorder(recorder);
        rememberNetworkDiagnostic(recorder, { t: Date.now(), action: 'recovered', historyLost: true, previousWorkerBootId: record.workerBootId, generation: record.generation });
        return { recovered: true, historyLost: true };
      } catch (error) {
        console.warn('[BROWSER-PILOT-NET] Failed to recover network recorder', key, error);
        return { recovered: false, historyLost: true, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  results.push(result);
});

export { cdpSendNetworkCommand, maybeCaptureNetworkBody, appendBounded, handleNetworkRecorderCdpEvent, startNetworkRecorder, clearNetworkRecorderBuffer, cleanupNetworkRecorder, stopNetworkRecorder, cleanupNetworkRecorderTab, requireNetworkRecorder, listNetworkRecorderEntries, getNetworkRecorderEntry, getNetworkRecorderBody, makeHarEntry, exportNetworkRecorderHar, networkWaitMatches, finishNetworkRecorderWait, wakeNetworkWaits, waitNetworkRecorder, handleNetworkRecorderCommand };
