// network.js - Pi browser native Network recorder commands.

const PI_BROWSER_NETWORK_DEFAULT_MAX_ENTRIES = 1000;
const PI_BROWSER_NETWORK_DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
const PI_BROWSER_NETWORK_DEFAULT_MAX_BODY_BYTES = 262144;
const PI_BROWSER_NETWORK_MAX_WS_FRAMES = 200;
const PI_BROWSER_NETWORK_MAX_SSE_EVENTS = 200;
const PI_BROWSER_NETWORK_DEFAULT_BODY_MIME_ALLOW = ['json', 'text', 'html'];
const PI_BROWSER_NETWORK_DEFAULT_BODY_RESOURCE_TYPES = ['XHR', 'Fetch', 'Document'];
const piBrowserNetworkRecorders = new Map();
let piBrowserNetworkRecorderSeq = 0;
let piBrowserNetworkEntrySeq = 0;
let piBrowserNetworkBodySeq = 0;

function networkRecorderKey(tabId, sessionId) { return Number(tabId) + ':' + String(sessionId || 'default'); }
function defaultNetworkSessionId(msg) { return String(msg?.sessionId || msg?.session_id || 'default'); }
function numberInRange(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function getHeaderValue(headers, name) {
  if (!headers || !name) return '';
  const target = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) if (String(k).toLowerCase() === target) return String(v == null ? '' : v);
  return '';
}
function headersObjectToArray(headers) {
  return Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value == null ? '' : value) }));
}
function normalizeNetworkStringList(value, fallback) {
  if (value === true) return ['all'];
  if (value === false || value === null) return [];
  const raw = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[,\s]+/) : fallback);
  return (Array.isArray(raw) ? raw : []).map(x => String(x || '').trim()).filter(Boolean);
}
function estimateStringBytes(str) {
  str = String(str == null ? '' : str);
  try { return new TextEncoder().encode(str).length; } catch (_) { return str.length; }
}
function truncateStringByBytes(str, maxBytes) {
  str = String(str == null ? '' : str);
  if (!Number.isFinite(Number(maxBytes)) || Number(maxBytes) < 0) return { value: str, truncated: false, originalLength: estimateStringBytes(str), bytes: estimateStringBytes(str) };
  const originalLength = estimateStringBytes(str);
  const limit = Math.floor(Number(maxBytes));
  if (originalLength <= limit) return { value: str, truncated: false, originalLength, bytes: originalLength };
  let lo = 0, hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateStringBytes(str.slice(0, mid)) <= limit) lo = mid; else hi = mid - 1;
  }
  const value = str.slice(0, lo);
  return { value, truncated: true, originalLength, bytes: estimateStringBytes(value) };
}
function truncateBase64Body(body, maxBytes) {
  const text = String(body == null ? '' : body).replace(/\s+/g, '');
  if (!Number.isFinite(Number(maxBytes)) || Number(maxBytes) < 0) {
    try { const decoded = atob(text); return { value:text, truncated:false, originalLength:decoded.length, bytes:decoded.length }; }
    catch (_) { return { value:text, truncated:false, originalLength:Math.ceil(text.length * 3 / 4), bytes:Math.ceil(text.length * 3 / 4) }; }
  }
  const limit = Math.floor(Number(maxBytes));
  try {
    const decoded = atob(text);
    const originalLength = decoded.length;
    if (originalLength <= limit) return { value:text, truncated:false, originalLength, bytes:originalLength };
    return { value:btoa(decoded.slice(0, limit)), truncated:true, originalLength, bytes:limit };
  } catch (_) {
    const originalLength = Math.ceil(text.length * 3 / 4);
    if (originalLength <= limit) return { value:text, truncated:false, originalLength, bytes:originalLength };
    const chars = Math.max(0, Math.floor(limit / 3) * 4);
    return { value:text.slice(0, chars), truncated:true, originalLength, bytes:Math.floor(chars * 3 / 4) };
  }
}
function makeNetworkRecorderFilter(config) {
  const includeUrls = Array.isArray(config.includeUrls) ? config.includeUrls.map(String) : [];
  const excludeUrls = Array.isArray(config.excludeUrls) ? config.excludeUrls.map(String) : [];
  const resourceTypes = new Set((Array.isArray(config.resourceTypes) ? config.resourceTypes : []).map(x => String(x).toLowerCase()));
  const allResourceTypes = resourceTypes.has('*') || resourceTypes.has('all');
  const methods = new Set((Array.isArray(config.methods) ? config.methods : []).map(x => String(x).toUpperCase()));
  const statuses = new Set((Array.isArray(config.statuses) ? config.statuses : []).map(x => Number(x)).filter(Number.isFinite));
  return function networkRecorderFilter(rec, phase) {
    const url = rec?.request?.url || rec?.url || '';
    const type = String(rec?.type || rec?.resourceType || '').toLowerCase();
    const method = String(rec?.request?.method || rec?.method || 'GET').toUpperCase();
    const status = Number(rec?.response?.status ?? rec?.status);
    if (includeUrls.length && !includeUrls.some(p => matchNetworkPattern(url, p))) return { match:false, reason:'include_url' };
    if (excludeUrls.length && excludeUrls.some(p => matchNetworkPattern(url, p))) return { match:false, reason:'exclude_url' };
    if (resourceTypes.size && !allResourceTypes && !resourceTypes.has(type)) return { match:false, reason:'resource_type' };
    if (methods.size && !methods.has(method)) return { match:false, reason:'method' };
    if (phase === 'body' || Number.isFinite(status)) {
      if (statuses.size && !statuses.has(status)) return { match:false, reason:'status' };
    }
    return { match:true, reason:'matched' };
  };
}
function normalizeNetworkBodyMimeAllow(msg) {
  const raw = msg.bodyMimeAllow ?? msg.body_mime_allow ?? msg.bodyMimeTypes ?? msg.body_mime_types;
  return normalizeNetworkStringList(raw, PI_BROWSER_NETWORK_DEFAULT_BODY_MIME_ALLOW).map(x => String(x).toLowerCase());
}
function networkResponseMimeType(rec) {
  return String(rec?.response?.mimeType || getHeaderValue(rec?.response?.headers, 'content-type') || getHeaderValue(rec?.responseExtraInfo?.headers, 'content-type') || '').toLowerCase();
}
function isLikelyBinaryNetworkMime(mime) {
  if (!mime) return false;
  return /^(image|audio|video|font)\//i.test(mime) || /(octet-stream|pdf|zip|gzip|br|protobuf|wasm|msword|excel|powerpoint)/i.test(mime);
}
function networkMimeMatchesToken(mime, token) {
  token = String(token || '').toLowerCase();
  if (!token || token === '*' || token === 'all') return true;
  if (token === 'json') return /(^|[/+.-])json($|[;+.-])/.test(mime) || mime.includes('+json');
  if (token === 'text') return mime.startsWith('text/');
  if (token === 'html') return mime.includes('html');
  if (token === 'xml') return mime.includes('xml');
  if (token === 'js' || token === 'javascript') return mime.includes('javascript') || mime.includes('ecmascript');
  return mime.includes(token);
}
function networkBodyMimeDecision(config, rec) {
  const allow = Array.isArray(config.bodyMimeAllow) ? config.bodyMimeAllow : PI_BROWSER_NETWORK_DEFAULT_BODY_MIME_ALLOW;
  if (allow.some(token => token === '*' || token === 'all')) return { match:true, reason:'all' };
  const mime = networkResponseMimeType(rec);
  if (!mime) return { match:false, availability:'not_requested', reason:'mime_missing', mimeType:mime };
  if (allow.some(token => networkMimeMatchesToken(mime, token))) return { match:true, reason:'mime_allowed', mimeType:mime };
  return { match:false, availability:isLikelyBinaryNetworkMime(mime) ? 'binary' : 'not_requested', reason:isLikelyBinaryNetworkMime(mime) ? 'binary_mime' : 'mime_not_allowed', mimeType:mime };
}
function classifyNetworkBodyError(error) {
  const text = String(error && (error.message || error) || 'error');
  if (/No resource with given identifier|No data found|no resource|not found|expired|evicted/i.test(text)) return { availability:'expired', reason:'cdp_body_expired' };
  if (/timed out|timeout/i.test(text)) return { availability:'cdp_failed', reason:'cdp_timeout' };
  return { availability:'cdp_failed', reason:'cdp_get_response_body_failed' };
}
function setNetworkBodyAvailability(rec, availability, reason, extra) {
  if (!rec) return;
  rec.bodyAvailability = availability || 'not_requested';
  rec.bodyUnavailableReason = reason || null;
  if (extra && typeof extra === 'object') Object.assign(rec, extra);
}
function normalizeNetworkRecorderConfig(msg) {
  msg = msg || {};
  const pickArr = (...names) => {
    for (const name of names) if (Array.isArray(msg[name])) return msg[name];
    return [];
  };
  const sessionId = defaultNetworkSessionId(msg);
  const maxEntries = numberInRange(msg.maxEntries ?? msg.max_entries, PI_BROWSER_NETWORK_DEFAULT_MAX_ENTRIES, 1, 20000);
  const maxAgeMs = numberInRange(msg.maxAgeMs ?? msg.max_age_ms, PI_BROWSER_NETWORK_DEFAULT_MAX_AGE_MS, 0, 24 * 60 * 60 * 1000);
  const maxBodyBytes = numberInRange(msg.maxBodyBytes ?? msg.max_body_bytes, PI_BROWSER_NETWORK_DEFAULT_MAX_BODY_BYTES, 0, 10 * 1024 * 1024);
  const maxPostDataBytes = numberInRange(msg.maxPostDataBytes ?? msg.max_post_data_bytes, Math.min(maxBodyBytes, 65536), 0, 1024 * 1024);
  const maxFrames = numberInRange(msg.maxFrames ?? msg.max_frames ?? msg.maxWebSocketFrames ?? msg.max_websocket_frames, PI_BROWSER_NETWORK_MAX_WS_FRAMES, 0, 5000);
  const maxFrameBytes = numberInRange(msg.maxFrameBytes ?? msg.max_frame_bytes ?? msg.maxWebSocketFrameBytes ?? msg.max_websocket_frame_bytes, 65536, 0, 1024 * 1024);
  const maxSseEvents = numberInRange(msg.maxSseEvents ?? msg.max_sse_events, PI_BROWSER_NETWORK_MAX_SSE_EVENTS, 0, 5000);
  const captureBodies = msg.captureBodies !== false && msg.capture_bodies !== false;
  const captureRequestPostData = msg.captureRequestPostData !== false && msg.capture_request_post_data !== false;
  const includeWebSocketFrames = msg.includeWebSocketFrames !== false && msg.include_websocket_frames !== false;
  const includeSse = msg.includeSse !== false && msg.include_sse !== false;
  const bodyTimeoutMs = numberInRange(msg.bodyTimeoutMs ?? msg.body_timeout_ms, 3000, 100, 30000);
  const rawResourceTypes = pickArr('resourceTypes', 'resource_types');
  const resourceTypes = rawResourceTypes.length ? rawResourceTypes : (captureBodies ? PI_BROWSER_NETWORK_DEFAULT_BODY_RESOURCE_TYPES : []);
  const config = {
    sessionId, maxEntries, maxAgeMs, maxBodyBytes, maxPostDataBytes, maxFrames, maxFrameBytes, maxSseEvents,
    captureBodies, captureRequestPostData, includeWebSocketFrames, includeSse, bodyTimeoutMs,
    bodyMimeAllow: normalizeNetworkBodyMimeAllow(msg),
    includeUrls: pickArr('includeUrls', 'include_urls'),
    excludeUrls: pickArr('excludeUrls', 'exclude_urls'),
    resourceTypes,
    methods: pickArr('methods'),
    statuses: pickArr('statuses'),
    clearOnStart: msg.clear !== false,
    storeHeaders: msg.storeHeaders !== false && msg.store_headers !== false,
    storePostData: captureRequestPostData,
    createdFrom: redactSensitive({ cmd: msg.cmd, waitId: msg.waitId || msg.wait_id })
  };
  config.filter = makeNetworkRecorderFilter(config);
  return config;
}
function makeNetworkCdpRecord(tabId, sessionId) {
  return { tabId:Number(tabId), waitId:'network_recorder_' + String(sessionId || 'default'), wait_id:'network_recorder_' + String(sessionId || 'default'), kind:'network_recorder', key:networkRecorderKey(tabId, sessionId), timers:[], listeners:[], cdpSubscriptions:[], cdpDomains:new Set(), cdpAttached:false, diagnostics:[], cdpEvents:[], createdAt:Date.now(), status:'active', abortController:new AbortController() };
}
function createNetworkRecorder(tabId, config) {
  const sessionId = config.sessionId || 'default';
  const recorder = {
    tabId:Number(tabId), sessionId, key:networkRecorderKey(tabId, sessionId), recorderId:'netrec_' + Number(tabId) + '_' + (++piBrowserNetworkRecorderSeq),
    active:false, createdAt:Date.now(), startedAt:0, stoppedAt:0, config, filter:config.filter,
    cdpRecord:makeNetworkCdpRecord(tabId, sessionId), entries:[], byRequestId:new Map(), bodyStore:new Map(), bodyByRequestId:new Map(), waits:new Map(), seqBase:piBrowserNetworkEntrySeq,
    counters:{ request:0, requestExtraInfo:0, response:0, responseExtraInfo:0, data:0, finished:0, failed:0, servedFromCache:0, webSocket:0, sse:0, page:0, bodyCaptured:0, bodyErrors:0, waitsResolved:0, waitsTimedOut:0, waitsCancelled:0 },
    overflowCount:0, bodyOverflowCount:0, lastErrors:[], diagnostics:[], lifecycleEvents:[], lastEventAt:0, pendingBodyCount:0
  };
  return recorder;
}
function recorderPublicConfig(config) {
  const { filter, ...rest } = config || {};
  return redactSensitive(rest);
}
function getNetworkRecorder(tabId, sessionId) { return piBrowserNetworkRecorders.get(networkRecorderKey(tabId, sessionId || 'default')) || null; }
function getActiveNetworkRecorder(tabId, msg) {
  const sessionId = defaultNetworkSessionId(msg);
  return getNetworkRecorder(tabId, sessionId);
}
function rememberNetworkError(recorder, where, error, extra) {
  if (!recorder) return;
  const item = { t:Date.now(), where, error:String(error && (error.message || error) || 'error'), ...(extra || {}) };
  recorder.lastErrors.push(redactSensitive(item));
  if (recorder.lastErrors.length > 50) recorder.lastErrors.splice(0, recorder.lastErrors.length - 50);
}
function networkRecorderSummary(recorder) {
  if (!recorder) return null;
  const activeWaits = Array.from(recorder.waits.values()).map(w => ({ waitId:w.waitId, condition:w.condition, age_ms:Date.now()-w.createdAt, criteria:redactSensitive(w.criteria || {}), lastMatchSeq:w.lastMatchSeq || 0 }));
  return {
    tabId:recorder.tabId, sessionId:recorder.sessionId, recorderId:recorder.recorderId, active:!!recorder.active,
    createdAt:recorder.createdAt, startedAt:recorder.startedAt, stoppedAt:recorder.stoppedAt, age_ms:Date.now()-(recorder.startedAt || recorder.createdAt),
    entries:recorder.entries.length, requestCount:recorder.byRequestId.size, bodyCount:recorder.bodyStore.size, pendingBodyCount:recorder.pendingBodyCount,
    maxEntries:recorder.config.maxEntries, maxAgeMs:recorder.config.maxAgeMs, maxBodyBytes:recorder.config.maxBodyBytes, overflowCount:recorder.overflowCount, bodyOverflowCount:recorder.bodyOverflowCount,
    counters:{ ...recorder.counters }, lastErrors:recorder.lastErrors.slice(-10), lifecycleEvents:recorder.lifecycleEvents.slice(-10), activeWaits, activeWaitCount:activeWaits.length,
    cdp:{ subscriptions:(recorder.cdpRecord.cdpSubscriptions || []).slice(), domains:Array.from(recorder.cdpRecord.cdpDomains || []), attached:!!recorder.cdpRecord.cdpAttached, refs:diagnosePiBrowserCdpDomainRefs(recorder.tabId).filter(r => (r.holders || []).some(h => h.holderId === recorder.cdpRecord.key)) },
    config:recorderPublicConfig(recorder.config), diagnostics:recorder.diagnostics.slice(-20)
  };
}
function ensureNetworkEntry(recorder, requestId) {
  requestId = String(requestId || makeWaitId(recorder.tabId, 'network_request'));
  let rec = recorder.byRequestId.get(requestId);
  if (!rec) {
    rec = { id:requestId, requestId, tabId:recorder.tabId, sessionId:recorder.sessionId, seq:++piBrowserNetworkEntrySeq, createdAt:Date.now(), updatedAt:Date.now(), wallTime:null, timestamp:null, type:'', resourceType:'', phase:'created', request:{ headers:{} }, response:null, redirects:[], data:{ encodedDataLength:0, dataLength:0, chunks:0 }, timing:{}, fromCache:false, failed:null, errorText:null, canceled:false, blockedReason:null, initiator:null, wsFrames:[], sseEvents:[], bodyRef:null, bodyPreview:null, bodyTruncated:false, bodyError:null, bodyPending:false, bodyAvailability:'not_requested', bodyUnavailableReason:'pending_response' };
    recorder.byRequestId.set(requestId, rec);
    recorder.entries.push(rec);
    pruneNetworkRecorder(recorder);
  }
  rec.updatedAt = Date.now();
  recorder.lastEventAt = rec.updatedAt;
  return rec;
}
function deleteNetworkBodyForRecord(recorder, rec) {
  if (!rec) return;
  if (rec.bodyRef) recorder.bodyStore.delete(rec.bodyRef);
  recorder.bodyByRequestId.delete(rec.requestId);
  rec.bodyRef = null;
}
function pruneNetworkRecorder(recorder) {
  if (!recorder) return;
  const now = Date.now();
  const maxAgeMs = Number(recorder.config.maxAgeMs || 0);
  let removed = 0;
  while (recorder.entries.length > recorder.config.maxEntries) {
    const old = recorder.entries.shift();
    if (old) { recorder.byRequestId.delete(old.requestId); deleteNetworkBodyForRecord(recorder, old); removed += 1; }
  }
  if (maxAgeMs > 0) {
    while (recorder.entries.length && now - Number(recorder.entries[0].updatedAt || recorder.entries[0].createdAt || now) > maxAgeMs) {
      const old = recorder.entries.shift();
      if (old) { recorder.byRequestId.delete(old.requestId); deleteNetworkBodyForRecord(recorder, old); removed += 1; }
    }
  }
  if (removed) recorder.overflowCount += removed;
}
function networkRecordMatchesList(rec, filters) {
  filters = filters || {};
  if (filters.sinceSeq !== undefined && Number(rec.seq) <= Number(filters.sinceSeq)) return false;
  if (filters.requestId && String(rec.requestId) !== String(filters.requestId)) return false;
  const urlFilter = filters.url ?? filters.urlContains ?? filters.url_contains;
  if (urlFilter && !String(rec.request?.url || '').includes(String(urlFilter))) return false;
  const urlPattern = filters.urlPattern ?? filters.url_pattern;
  if (urlPattern && !matchNetworkPattern(rec.request?.url || '', String(urlPattern))) return false;
  if (filters.method && String(rec.request?.method || '').toUpperCase() !== String(filters.method).toUpperCase()) return false;
  if (filters.type && String(rec.type || '').toLowerCase() !== String(filters.type).toLowerCase()) return false;
  const mime = filters.mime || filters.mimeType || filters.mime_type;
  if (mime && !matchNetworkPattern(String(rec.response?.mimeType || getHeaderValue(rec.response?.headers, 'content-type') || ''), String(mime))) return false;
  if (filters.status !== undefined && Number(rec.response?.status) !== Number(filters.status)) return false;
  if (Array.isArray(filters.includeUrls) && filters.includeUrls.length && !filters.includeUrls.some(p => matchNetworkPattern(rec.request?.url || '', p))) return false;
  if (Array.isArray(filters.excludeUrls) && filters.excludeUrls.length && filters.excludeUrls.some(p => matchNetworkPattern(rec.request?.url || '', p))) return false;
  return true;
}
function networkCriterionMatchesText(value, criterion) {
  if (criterion === undefined || criterion === null || criterion === '') return true;
  return matchNetworkPattern(String(value == null ? '' : value), String(criterion));
}
function networkWsFrameMatches(frame, criterion) {
  if (criterion === undefined || criterion === null || criterion === '') return true;
  if (criterion && typeof criterion === 'object') {
    if (criterion.method && String(frame.method || '') !== String(criterion.method)) return false;
    if (criterion.opcode !== undefined && Number(frame.opcode) !== Number(criterion.opcode)) return false;
    if (criterion.payloadContains !== undefined && !networkCriterionMatchesText(frame.payloadData, criterion.payloadContains)) return false;
    if (criterion.payload_contains !== undefined && !networkCriterionMatchesText(frame.payloadData, criterion.payload_contains)) return false;
    return true;
  }
  return networkCriterionMatchesText(frame.payloadData, criterion);
}
function networkSseEventMatches(event, criterion) {
  if (criterion === undefined || criterion === null || criterion === '') return true;
  if (criterion && typeof criterion === 'object') {
    if (criterion.eventName !== undefined && !networkCriterionMatchesText(event.eventName, criterion.eventName)) return false;
    if (criterion.event_name !== undefined && !networkCriterionMatchesText(event.eventName, criterion.event_name)) return false;
    if (criterion.eventId !== undefined && !networkCriterionMatchesText(event.eventId, criterion.eventId)) return false;
    if (criterion.event_id !== undefined && !networkCriterionMatchesText(event.eventId, criterion.event_id)) return false;
    if (criterion.dataContains !== undefined && !networkCriterionMatchesText(event.data, criterion.dataContains)) return false;
    if (criterion.data_contains !== undefined && !networkCriterionMatchesText(event.data, criterion.data_contains)) return false;
    return true;
  }
  return networkCriterionMatchesText([event.eventName, event.eventId, event.data].join('\n'), criterion);
}
function networkRecordSummary(rec, options) {
  options = options || {};
  const out = {
    id:rec.id, requestId:rec.requestId, seq:rec.seq, tabId:rec.tabId, sessionId:rec.sessionId, url:rec.request?.url || '', method:rec.request?.method || '', type:rec.type || rec.resourceType || '', phase:rec.phase,
    status:rec.response?.status, statusText:rec.response?.statusText, mimeType:rec.response?.mimeType, protocol:rec.response?.protocol,
    fromCache:!!rec.fromCache, fromServiceWorker:!!rec.response?.fromServiceWorker, failed:!!rec.failed, errorText:rec.errorText || null, canceled:!!rec.canceled, blockedReason:rec.blockedReason || null,
    createdAt:rec.createdAt, updatedAt:rec.updatedAt, wallTime:rec.wallTime, timestamp:rec.timestamp, encodedDataLength:rec.data?.encodedDataLength || 0, dataLength:rec.data?.dataLength || 0,
    bodyRef:rec.bodyRef || null, bodyPreview:rec.bodyPreview || null, bodyTruncated:!!rec.bodyTruncated, bodyError:rec.bodyError || null, bodyPending:!!rec.bodyPending,
    bodyAvailability:rec.bodyAvailability || (rec.bodyRef ? 'captured' : 'not_requested'), bodyUnavailableReason:rec.bodyUnavailableReason || null,
    hasPostData:!!rec.request?.hasPostData || rec.request?.postData !== undefined, postDataTruncated:!!rec.request?.postDataTruncated, postDataBytes:rec.request?.postData !== undefined ? estimateStringBytes(rec.request.postData) : undefined,
    redirects:(rec.redirects || []).length, wsFrameCount:(rec.wsFrames || []).length, sseEventCount:(rec.sseEvents || []).length
  };
  if (options.includeDetails) Object.assign(out, networkRecordClone(rec, { includeBody: options.includeBody }));
  return redactSensitive(out);
}
function networkRecordClone(rec, options) {
  options = options || {};
  const clone = JSON.parse(JSON.stringify(rec || {}));
  if (!options.includeBody) delete clone.body;
  return redactSensitive(clone);
}
function storeNetworkBody(recorder, rec, bodyResult) {
  const body = String(bodyResult?.body ?? '');
  const base64Encoded = !!bodyResult?.base64Encoded;
  const rawBytes = base64Encoded ? Math.ceil(body.length * 3 / 4) : estimateStringBytes(body);
  const trunc = base64Encoded
    ? truncateBase64Body(body, recorder.config.maxBodyBytes)
    : truncateStringByBytes(body, recorder.config.maxBodyBytes);
  const bodyRef = rec.bodyRef || ('body_' + recorder.recorderId + '_' + (++piBrowserNetworkBodySeq));
  const stored = { bodyRef, requestId:rec.requestId, tabId:rec.tabId, sessionId:rec.sessionId, base64Encoded, body:trunc.value, bodyTruncated:!!trunc.truncated, originalLength:trunc.originalLength, bytes:trunc.bytes, mimeType:rec.response?.mimeType || '', status:rec.response?.status, url:rec.request?.url || '', createdAt:Date.now() };
  stored.bodyAvailability = trunc.truncated ? 'too_large' : 'captured';
  stored.bodyUnavailableReason = trunc.truncated ? 'max_body_bytes_exceeded' : null;
  recorder.bodyStore.set(bodyRef, stored);
  recorder.bodyByRequestId.set(rec.requestId, bodyRef);
  rec.bodyRef = bodyRef;
  rec.bodyPreview = base64Encoded ? null : truncateStringByBytes(trunc.value, Math.min(2048, recorder.config.maxBodyBytes)).value;
  rec.bodyTruncated = !!trunc.truncated;
  rec.bodyError = null;
  rec.bodyPending = false;
  rec.bodyCapturedAt = Date.now();
  setNetworkBodyAvailability(rec, trunc.truncated ? 'too_large' : 'captured', trunc.truncated ? 'max_body_bytes_exceeded' : null);
  rec.body = undefined;
  if (trunc.truncated) recorder.bodyOverflowCount += 1;
  recorder.counters.bodyCaptured += 1;
  wakeNetworkWaits(recorder, 'body', rec);
}
async function cdpSendNetworkCommand(tabId, method, params, timeoutMs) {
  const cdp = piBrowserPersistentCdp();
  if (cdp?.send) {
    const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, method, params || {}, { persistent:true, name:'network_recorder', timeoutMs }));
    if (!resp || resp.ok === false) throw new Error(resp?.error?.message || resp?.message || resp?.error || (method + ' failed'));
    return resp.data?.result || resp.result || resp.data || {};
  }
  return await piWithTimeout(chrome.debugger.sendCommand({ tabId:Number(tabId) }, method, params || {}), timeoutMs || 5000, method);
}
async function maybeCaptureNetworkBody(recorder, rec) {
  if (!recorder?.active || !rec || rec.bodyPending || rec.bodyRef) return;
  if (!recorder.config.captureBodies) { setNetworkBodyAvailability(rec, 'not_requested', 'capture_bodies_disabled'); return; }
  const decision = recorder.filter(rec, 'body');
  if (!decision.match) { rec.bodySkipped = decision.reason; setNetworkBodyAvailability(rec, 'not_requested', decision.reason + '_filtered'); return; }
  const mimeDecision = networkBodyMimeDecision(recorder.config, rec);
  if (!mimeDecision.match) { rec.bodySkipped = mimeDecision.reason; setNetworkBodyAvailability(rec, mimeDecision.availability, mimeDecision.reason, { bodyMimeType:mimeDecision.mimeType }); return; }
  rec.bodyPending = true;
  rec.bodyCaptureAttemptedAt = Date.now();
  setNetworkBodyAvailability(rec, 'pending', null);
  recorder.pendingBodyCount += 1;
  try {
    const result = await cdpSendNetworkCommand(recorder.tabId, 'Network.getResponseBody', { requestId: rec.requestId }, recorder.config.bodyTimeoutMs);
    storeNetworkBody(recorder, rec, result || {});
  } catch (e) {
    rec.bodyError = e.message || String(e);
    rec.bodyPending = false;
    const classified = classifyNetworkBodyError(e);
    setNetworkBodyAvailability(rec, classified.availability, classified.reason);
    recorder.counters.bodyErrors += 1;
    rememberNetworkError(recorder, 'Network.getResponseBody', e, { requestId: rec.requestId, url: rec.request?.url });
    wakeNetworkWaits(recorder, 'body_error', rec);
  } finally {
    recorder.pendingBodyCount = Math.max(0, recorder.pendingBodyCount - 1);
  }
}
function appendBounded(arr, item, max, overflowCounterTarget) {
  if (max <= 0) return;
  arr.push(redactSensitive(item));
  if (arr.length > max) { arr.splice(0, arr.length - max); if (overflowCounterTarget) overflowCounterTarget.overflow = (overflowCounterTarget.overflow || 0) + 1; }
}
function handleNetworkRecorderCdpEvent(recorder, _source, method, params) {
  if (!recorder || !recorder.active) return;
  params = params || {};
  recorder.lastEventAt = Date.now();
  try {
    if (method === 'Network.requestWillBeSent') {
      recorder.counters.request += 1;
      const requestId = String(params.requestId || makeWaitId(recorder.tabId, 'request'));
      let rec = ensureNetworkEntry(recorder, requestId);
      if (params.redirectResponse) {
        rec.redirects = rec.redirects || [];
        rec.redirects.push({ t:Date.now(), response:params.redirectResponse, previousUrl:rec.request?.url || '' });
      }
      rec.phase = 'request';
      rec.loaderId = params.loaderId || rec.loaderId;
      rec.documentURL = params.documentURL || rec.documentURL;
      rec.frameId = params.frameId || rec.frameId;
      rec.wallTime = params.wallTime ?? rec.wallTime;
      rec.timestamp = params.timestamp ?? rec.timestamp;
      rec.type = params.type || rec.type || '';
      rec.resourceType = params.type || rec.resourceType || '';
      rec.initiator = params.initiator || rec.initiator;
      rec.request = { ...(rec.request || {}), url:params.request?.url || rec.request?.url || '', method:params.request?.method || rec.request?.method || 'GET', headers:recorder.config.storeHeaders ? (params.request?.headers || rec.request?.headers || {}) : {}, mixedContentType:params.request?.mixedContentType, initialPriority:params.request?.initialPriority, referrerPolicy:params.request?.referrerPolicy, hasPostData:!!params.request?.hasPostData };
      if (recorder.config.storePostData && params.request?.postData !== undefined) {
        const trunc = truncateStringByBytes(String(params.request.postData || ''), recorder.config.maxPostDataBytes);
        rec.request.postData = trunc.value; rec.request.postDataTruncated = trunc.truncated; rec.request.postDataOriginalLength = trunc.originalLength;
      }
      wakeNetworkWaits(recorder, 'request', rec);
    } else if (method === 'Network.requestWillBeSentExtraInfo') {
      recorder.counters.requestExtraInfo += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.requestExtraInfo = { headers:recorder.config.storeHeaders ? (params.headers || {}) : {}, associatedCookies:params.associatedCookies || [], connectTiming:params.connectTiming || null, clientSecurityState:params.clientSecurityState || null };
      wakeNetworkWaits(recorder, 'request_extra', rec);
    } else if (method === 'Network.responseReceived') {
      recorder.counters.response += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      const r = params.response || {};
      rec.phase = 'response';
      rec.type = params.type || rec.type || '';
      rec.resourceType = params.type || rec.resourceType || '';
      rec.response = { url:r.url || rec.request?.url || '', status:r.status, statusText:r.statusText || '', headers:recorder.config.storeHeaders ? (r.headers || {}) : {}, mimeType:r.mimeType || '', charset:r.charset || '', connectionReused:!!r.connectionReused, connectionId:r.connectionId, remoteIPAddress:r.remoteIPAddress, remotePort:r.remotePort, fromDiskCache:!!r.fromDiskCache, fromPrefetchCache:!!r.fromPrefetchCache, fromServiceWorker:!!r.fromServiceWorker, encodedDataLength:r.encodedDataLength, protocol:r.protocol || '', securityState:r.securityState || '', securityDetails:r.securityDetails || null, timing:r.timing || null };
      rec.timing = r.timing || rec.timing || {};
      wakeNetworkWaits(recorder, 'response', rec);
    } else if (method === 'Network.responseReceivedExtraInfo') {
      recorder.counters.responseExtraInfo += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.responseExtraInfo = { headers:recorder.config.storeHeaders ? (params.headers || {}) : {}, blockedCookies:params.blockedCookies || [], statusCode:params.statusCode, headersText:params.headersText || '', resourceIPAddressSpace:params.resourceIPAddressSpace || '' };
      if (!rec.response) rec.response = { status:params.statusCode, headers:recorder.config.storeHeaders ? (params.headers || {}) : {} }; else if (params.statusCode && !rec.response.status) rec.response.status = params.statusCode;
      wakeNetworkWaits(recorder, 'response_extra', rec);
    } else if (method === 'Network.dataReceived') {
      recorder.counters.data += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.phase = rec.phase === 'created' ? 'data' : rec.phase;
      rec.data = rec.data || { encodedDataLength:0, dataLength:0, chunks:0 };
      rec.data.encodedDataLength += Number(params.encodedDataLength || 0);
      rec.data.dataLength += Number(params.dataLength || 0);
      rec.data.chunks += 1;
      wakeNetworkWaits(recorder, 'data', rec);
    } else if (method === 'Network.requestServedFromCache') {
      recorder.counters.servedFromCache += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.fromCache = true;
      wakeNetworkWaits(recorder, 'cache', rec);
    } else if (method === 'Network.loadingFinished') {
      recorder.counters.finished += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.phase = 'finished';
      rec.finishedAt = Date.now();
      rec.encodedDataLength = params.encodedDataLength;
      rec.data = rec.data || {};
      if (params.encodedDataLength !== undefined) rec.data.encodedDataLength = Math.max(Number(rec.data.encodedDataLength || 0), Number(params.encodedDataLength || 0));
      wakeNetworkWaits(recorder, 'finished', rec);
      void maybeCaptureNetworkBody(recorder, rec);
    } else if (method === 'Network.loadingFailed') {
      recorder.counters.failed += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.phase = 'failed';
      rec.failed = { errorText:params.errorText || '', canceled:!!params.canceled, blockedReason:params.blockedReason || null, corsErrorStatus:params.corsErrorStatus || null, type:params.type || rec.type || '' };
      rec.errorText = rec.failed.errorText; rec.canceled = !!params.canceled; rec.blockedReason = params.blockedReason || null;
      wakeNetworkWaits(recorder, 'failed', rec);
    } else if (method.indexOf('Network.webSocket') === 0) {
      recorder.counters.webSocket += 1;
      const requestId = String(params.requestId || params.identifier || makeWaitId(recorder.tabId, 'websocket'));
      const rec = ensureNetworkEntry(recorder, requestId);
      rec.type = rec.type || 'WebSocket'; rec.resourceType = rec.resourceType || 'WebSocket';
      if (method === 'Network.webSocketCreated') { rec.request.url = params.url || rec.request.url || ''; rec.phase = 'websocket'; }
      if (method === 'Network.webSocketWillSendHandshakeRequest') rec.webSocketRequest = params.request || params;
      if (method === 'Network.webSocketHandshakeResponseReceived') rec.webSocketResponse = params.response || params;
      if (recorder.config.includeWebSocketFrames && (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived')) {
        const payload = params.response?.payloadData ?? '';
        const trunc = truncateStringByBytes(String(payload), recorder.config.maxFrameBytes);
        appendBounded(rec.wsFrames, { t:Date.now(), method, opcode:params.response?.opcode, mask:params.response?.mask, payloadData:trunc.value, payloadTruncated:trunc.truncated, originalLength:trunc.originalLength }, recorder.config.maxFrames, rec);
      }
      if (method === 'Network.webSocketClosed') rec.webSocketClosedAt = Date.now();
      if (method === 'Network.webSocketFrameError') rec.webSocketError = params.errorMessage || params;
      wakeNetworkWaits(recorder, 'websocket', rec);
    } else if (method === 'Network.eventSourceMessageReceived') {
      recorder.counters.sse += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.type = rec.type || 'EventSource'; rec.resourceType = rec.resourceType || 'EventSource';
      if (recorder.config.includeSse) {
        const trunc = truncateStringByBytes(String(params.data || ''), recorder.config.maxFrameBytes);
        appendBounded(rec.sseEvents, { t:Date.now(), eventName:params.eventName || '', eventId:params.eventId || '', data:trunc.value, dataTruncated:trunc.truncated, originalLength:trunc.originalLength }, recorder.config.maxSseEvents, rec);
      }
      wakeNetworkWaits(recorder, 'sse', rec);
    } else if (method.indexOf('Page.') === 0) {
      recorder.counters.page += 1;
      appendBounded(recorder.lifecycleEvents, { t:Date.now(), method, frameId:params.frameId, name:params.name, loaderId:params.loaderId }, 100);
      wakeNetworkWaits(recorder, 'page', null);
    }
    pruneNetworkRecorder(recorder);
  } catch (e) {
    rememberNetworkError(recorder, method, e, { params:redactSensitive(params) });
  }
}
async function startNetworkRecorder(tabId, msg) {
  const config = normalizeNetworkRecorderConfig(msg || {});
  const key = networkRecorderKey(tabId, config.sessionId);
  let recorder = piBrowserNetworkRecorders.get(key);
  if (recorder && recorder.active && msg.reconfigure !== false) {
    recorder.config = config; recorder.filter = config.filter;
    if (config.clearOnStart) clearNetworkRecorderBuffer(recorder);
    recorder.diagnostics.push({ t:Date.now(), action:'reconfigure', config:recorderPublicConfig(config) });
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
    const events = [
      'Network.requestWillBeSent','Network.requestWillBeSentExtraInfo','Network.responseReceived','Network.responseReceivedExtraInfo','Network.dataReceived','Network.requestServedFromCache','Network.loadingFinished','Network.loadingFailed',
      'Network.webSocketCreated','Network.webSocketWillSendHandshakeRequest','Network.webSocketHandshakeResponseReceived','Network.webSocketFrameSent','Network.webSocketFrameReceived','Network.webSocketFrameError','Network.webSocketClosed','Network.eventSourceMessageReceived',
      'Page.frameNavigated','Page.loadEventFired','Page.domContentEventFired','Page.lifecycleEvent','Page.frameStoppedLoading'
    ];
    subscribePiBrowserCdp(tabId, events, (source, method, params) => handleNetworkRecorderCdpEvent(recorder, source, method, params), recorder.cdpRecord);
    try { await cdpSendNetworkCommand(tabId, 'Page.setLifecycleEventsEnabled', { enabled:true }, 2000); } catch (e) { rememberNetworkError(recorder, 'Page.setLifecycleEventsEnabled', e); }
    recorder.active = true; recorder.startedAt = Date.now(); recorder.diagnostics.push({ t:Date.now(), action:'start', events, config:recorderPublicConfig(config) });
    return { ok:true, data:networkRecorderSummary(recorder) };
  } catch (e) {
    rememberNetworkError(recorder, 'start', e);
    cleanupNetworkRecorder(recorder, 'start_failed', { keepBuffer:false });
    piBrowserNetworkRecorders.delete(key);
    return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'network.start failed', { tabId, sessionId:config.sessionId, error:e.message || String(e) });
  }
}
function clearNetworkRecorderBuffer(recorder) {
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
function cleanupNetworkRecorder(recorder, reason, options) {
  if (!recorder) return { stopped:false };
  options = options || {};
  recorder.active = false;
  recorder.stoppedAt = Date.now();
  for (const wait of Array.from(recorder.waits.values())) finishNetworkRecorderWait(recorder, wait, false, PI_BROWSER_ERROR_CODES.CANCELLED, 'network recorder stopped', { reason:reason || 'stopped' });
  for (const sid of Array.from(recorder.cdpRecord.cdpSubscriptions || [])) { try { unsubscribePiBrowserCdp(sid); } catch (_) {} }
  recorder.cdpRecord.cdpSubscriptions = [];
  releasePiBrowserCdpDomains(recorder.cdpRecord, Array.from(recorder.cdpRecord.cdpDomains || []), reason || 'network_recorder_stop');
  recorder.cdpRecord.cdpAttached = false;
  if (options.keepBuffer === false) clearNetworkRecorderBuffer(recorder);
  recorder.diagnostics.push({ t:Date.now(), action:'stop', reason:reason || 'stopped', keepBuffer:options.keepBuffer !== false });
  return { stopped:true, summary:networkRecorderSummary(recorder) };
}
async function stopNetworkRecorder(tabId, msg) {
  const sessionId = defaultNetworkSessionId(msg || {});
  const recorder = getNetworkRecorder(tabId, sessionId);
  if (!recorder) return piBrowserError(PI_BROWSER_ERROR_CODES.NETWORK_RECORDER_NOT_STARTED, 'network recorder is not started', { tabId, sessionId });
  const keepBuffer = msg.keepBuffer !== false && msg.keep_buffer !== false && msg.clear !== true;
  const result = cleanupNetworkRecorder(recorder, msg.reason || 'stop', { keepBuffer });
  if (!keepBuffer || msg.remove === true) piBrowserNetworkRecorders.delete(recorder.key);
  return { ok:true, data:{ ...result.summary, stopped:true, keepBuffer } };
}
function cleanupNetworkRecorderTab(tabId, reason) {
  const out = [];
  for (const recorder of Array.from(piBrowserNetworkRecorders.values())) {
    if (Number(recorder.tabId) !== Number(tabId)) continue;
    cleanupNetworkRecorder(recorder, reason || 'tab_cleanup', { keepBuffer:false });
    piBrowserNetworkRecorders.delete(recorder.key);
    out.push({ sessionId:recorder.sessionId, recorderId:recorder.recorderId });
  }
  return out;
}
function requireNetworkRecorder(tabId, msg) {
  const recorder = getActiveNetworkRecorder(tabId, msg || {});
  if (!recorder) return { error: piBrowserError(PI_BROWSER_ERROR_CODES.NETWORK_RECORDER_NOT_STARTED, 'network recorder is not started', { tabId, sessionId:defaultNetworkSessionId(msg || {}) }) };
  return { recorder };
}
function listNetworkRecorderEntries(tabId, msg) {
  const found = requireNetworkRecorder(tabId, msg);
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
function getNetworkRecorderEntry(tabId, msg) {
  const found = requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const id = String(msg.requestId || msg.request_id || msg.id || '');
  if (!id) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'network.get requires requestId or id', { tabId });
  const rec = recorder.byRequestId.get(id) || recorder.entries.find(x => String(x.id) === id || String(x.requestId) === id);
  if (!rec) return piBrowserError(PI_BROWSER_ERROR_CODES.REQUEST_NOT_FOUND || 'REQUEST_NOT_FOUND', 'network request not found', { tabId, sessionId:recorder.sessionId, requestId:id });
  return { ok:true, data:networkRecordClone(rec, { includeBody: msg.includeBody === true || msg.include_body === true }) };
}
function getNetworkRecorderBody(tabId, msg) {
  const found = requireNetworkRecorder(tabId, msg);
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
function makeHarEntry(rec, body) {
  const startedDateTime = rec.wallTime ? new Date(rec.wallTime * 1000).toISOString() : new Date(rec.createdAt || Date.now()).toISOString();
  const requestHeaders = headersObjectToArray(rec.request?.headers || rec.requestExtraInfo?.headers || {});
  const responseHeaders = headersObjectToArray(rec.response?.headers || rec.responseExtraInfo?.headers || {});
  const content = { size:rec.data?.dataLength || rec.encodedDataLength || -1, mimeType:rec.response?.mimeType || getHeaderValue(rec.response?.headers, 'content-type') || '', compression:0 };
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
function exportNetworkRecorderHar(tabId, msg) {
  const found = requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const includeBodies = msg.includeBody === true || msg.include_body === true || msg.includeBodies === true || msg.include_bodies === true;
  const filters = { sinceSeq: msg.sinceSeq ?? msg.since_seq, url:msg.url, urlContains:msg.urlContains ?? msg.url_contains, urlPattern:msg.urlPattern ?? msg.url_pattern, method:msg.method, type:msg.type || msg.resourceType || msg.resource_type, mime:msg.mime || msg.mimeType || msg.mime_type, status:msg.status, includeUrls:msg.includeUrls || msg.include_urls, excludeUrls:msg.excludeUrls || msg.exclude_urls };
  const records = recorder.entries.filter(rec => networkRecordMatchesList(rec, filters));
  if (String(msg.format || '').toLowerCase() === 'json') {
    const bodyRefs = new Set(records.map(r => r.bodyRef).filter(Boolean));
    const bodies = includeBodies ? Array.from(bodyRefs).map(ref => recorder.bodyStore.get(ref)).filter(Boolean).map(b => redactSensitive(b)) : undefined;
    return { ok:true, data:{ recorder:networkRecorderSummary(recorder), entries:records.map(r => networkRecordClone(r, { includeBody:includeBodies })), bodies } };
  }
  const entries = records.map(rec => makeHarEntry(rec, includeBodies && rec.bodyRef ? recorder.bodyStore.get(rec.bodyRef) : null));
  return { ok:true, data:{ log:{ version:'1.2', creator:{ name:'Pi Browser NetworkRecorder', version:'1.0' }, pages:[], entries }, diagnostics:networkRecorderSummary(recorder) } };
}
function networkWaitMatches(recorder, wait, eventType, rec) {
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
    if (wsFrame !== undefined && !(record.wsFrames || []).some(frame => networkWsFrameMatches(frame, wsFrame))) return false;
    const sseEvent = criteria.sseEvent ?? criteria.sse_event;
    if (sseEvent !== undefined && !(record.sseEvents || []).some(event => networkSseEventMatches(event, sseEvent))) return false;
  }
  if (condition === 'idle') {
    const quietFor = Date.now() - Number(recorder.lastEventAt || recorder.startedAt || recorder.createdAt);
    return quietFor >= wait.idleMs;
  }
  if (condition === 'count') {
    const count = recorder.entries.filter(r => networkRecordMatchesList(r, criteria)).length;
    return count >= wait.count;
  }
  const aliases = {
    request:['request','request_extra'], response:['response','response_extra'], body:['body'], bodycontains:['body'], finished:['finished'], failed:['failed'], websocket:['websocket'], ws:['websocket'], wsframe:['websocket'], sse:['sse'], eventsource:['sse'], sseevent:['sse'], any:['request','response','body','finished','failed','websocket','sse']
  };
  const allowed = aliases[condition] || [condition];
  return allowed.includes(eventType);
}
function finishNetworkRecorderWait(recorder, wait, ok, errorCode, message, details) {
  if (!wait || wait.done) return;
  wait.done = true;
  try { clearTimeout(wait.timeoutHandle); } catch (_) {}
  try { clearInterval(wait.intervalHandle); } catch (_) {}
  try { wait.abortController?.signal?.removeEventListener('abort', wait.abortHandler); } catch (_) {}
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
function wakeNetworkWaits(recorder, eventType, rec) {
  if (!recorder || !recorder.waits.size) return;
  for (const wait of Array.from(recorder.waits.values())) {
    if (wait.done) continue;
    if (networkWaitMatches(recorder, wait, eventType, rec)) {
      wait.lastMatchSeq = rec?.seq || wait.lastMatchSeq || 0;
      finishNetworkRecorderWait(recorder, wait, true, null, null, { event:eventType, request:rec ? networkRecordSummary(rec, { includeDetails:true }) : null });
    }
  }
}
async function waitNetworkRecorder(tabId, msg) {
  const found = requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const conditionRaw = msg.condition || msg.state || msg.event || 'response';
  const condition = String(conditionRaw).toLowerCase().replace(/[-_]/g, '');
  const timeoutMs = normalizePiBrowserTimeoutMs(msg, 30000);
  const waitId = String(msg.waitId || msg.wait_id || makeWaitId(tabId, 'network_recorder'));
  const criteria = { ...msg };
  const immediateMatch = () => {
    if (condition === 'idle') {
      const idleMs = numberInRange(msg.idleMs ?? msg.idle_ms, 500, 50, Math.max(50, timeoutMs || 300000));
      const quietFor = Date.now() - Number(recorder.lastEventAt || recorder.startedAt || recorder.createdAt);
      if (quietFor >= idleMs) return { event:'idle', idle_ms:idleMs, quietFor };
      return null;
    }
    if (condition === 'count') {
      const count = numberInRange(msg.count ?? msg.minCount ?? msg.min_count, 1, 1, 1000000);
      const matches = recorder.entries.filter(r => networkRecordMatchesList(r, criteria));
      if (matches.length >= count) return { event:'count', count:matches.length, required:count, requests:matches.slice(-10).map(r => networkRecordSummary(r)) };
      return null;
    }
    const pseudoWait = { condition, criteria };
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
  return await new Promise(resolve => {
    const abortController = msg.abortController || new AbortController();
    const wait = { waitId, condition, criteria, createdAt:Date.now(), resolve, abortController, done:false, idleMs:numberInRange(msg.idleMs ?? msg.idle_ms, 500, 50, Math.max(50, timeoutMs || 300000)), count:numberInRange(msg.count ?? msg.minCount ?? msg.min_count, 1, 1, 1000000), lastMatchSeq:0 };
    wait.abortHandler = () => finishNetworkRecorderWait(recorder, wait, false, PI_BROWSER_ERROR_CODES.CANCELLED, 'network.wait cancelled', { criteria:redactSensitive(criteria) });
    try { abortController.signal.addEventListener('abort', wait.abortHandler, { once:true }); } catch (_) {}
    wait.timeoutHandle = setTimeout(() => finishNetworkRecorderWait(recorder, wait, false, PI_BROWSER_ERROR_CODES.NETWORK_RECORDER_TIMEOUT, 'network.wait timed out', { timeout_ms:timeoutMs, criteria:redactSensitive(criteria), lastEntries:recorder.entries.slice(-20).map(r => networkRecordSummary(r)) }), timeoutMs);
    if (condition === 'idle' || condition === 'count') wait.intervalHandle = setInterval(() => {
      const m = immediateMatch();
      if (m) finishNetworkRecorderWait(recorder, wait, true, null, null, m);
    }, Math.min(250, Math.max(50, wait.idleMs || 250)));
    recorder.waits.set(waitId, wait);
  });
}
async function handleNetworkRecorderCommand(tabId, cmd, msg) {
  switch (cmd) {
    case 'network.start': return await startNetworkRecorder(tabId, msg);
    case 'network.stop': return await stopNetworkRecorder(tabId, msg || {});
    case 'network.status': {
      const recorder = getActiveNetworkRecorder(tabId, msg || {});
      if (!recorder) return { ok:true, data:{ tabId:Number(tabId), sessionId:defaultNetworkSessionId(msg || {}), active:false, recorders:Array.from(piBrowserNetworkRecorders.values()).filter(r => Number(r.tabId) === Number(tabId)).map(networkRecorderSummary) } };
      return { ok:true, data:networkRecorderSummary(recorder) };
    }
    case 'network.clear': {
      const found = requireNetworkRecorder(tabId, msg || {}); if (found.error) return found.error;
      const cleared = clearNetworkRecorderBuffer(found.recorder);
      return { ok:true, data:{ ...networkRecorderSummary(found.recorder), cleared } };
    }
    case 'network.list': return listNetworkRecorderEntries(tabId, msg || {});
    case 'network.get': return getNetworkRecorderEntry(tabId, msg || {});
    case 'network.body': return getNetworkRecorderBody(tabId, msg || {});
    case 'network.exportHar': return exportNetworkRecorderHar(tabId, msg || {});
    case 'network.wait': return await waitNetworkRecorder(tabId, msg || {});
  }
  return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown network recorder command: ' + cmd, { cmd, tabId });
}
