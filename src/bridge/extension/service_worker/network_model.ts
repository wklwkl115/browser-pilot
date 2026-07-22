// network_model.js - Browser Pilot Network recorder state, config, filtering and body storage helpers.

import { matchNetworkPattern } from "./patterns";
import { integerInRange as numberInRange, redactSensitive, runtimeErrorMessage as errorText, runtimeRecord as asRecord } from "./runtimeSupport.js";
import { diagnoseBrowserPilotCdpDomainRefs } from "./wait_cdp";
import { makeWaitId } from "./wait_coordinator";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotWaitRecord, NetworkBodyMimeDecision, NetworkBodyStoreEntry, NetworkFilterDecision, NetworkFrameRecord, NetworkRecord, NetworkRecordSnapshot, NetworkRecordSummary, NetworkRecorder, NetworkRecorderConfig, NetworkRecorderSummary, NetworkStringList, NetworkWaitNotifier } from "./types";

const BROWSER_PILOT_NETWORK_DEFAULT_MAX_ENTRIES = 1000;
const BROWSER_PILOT_NETWORK_DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
const BROWSER_PILOT_NETWORK_DEFAULT_MAX_BODY_BYTES = 262144;
const BROWSER_PILOT_NETWORK_MAX_WS_FRAMES = 200;
const BROWSER_PILOT_NETWORK_MAX_SSE_EVENTS = 200;
const BROWSER_PILOT_NETWORK_DEFAULT_BODY_MIME_ALLOW = ['json', 'text', 'html'];
const BROWSER_PILOT_NETWORK_DEFAULT_BODY_RESOURCE_TYPES = ['XHR', 'Fetch', 'Document'];
const browserPilotNetworkRecorders = new Map<string, NetworkRecorder>();
let browserPilotNetworkRecorderSeq = 0;
let browserPilotNetworkEntrySeq = 0;
let browserPilotNetworkBodySeq = 0;
let browserPilotNetworkWaitNotifier: NetworkWaitNotifier | null = null;

function setNetworkWaitNotifier(notifier: unknown): void {
  browserPilotNetworkWaitNotifier = typeof notifier === 'function' ? notifier as NetworkWaitNotifier : null;
}

function notifyNetworkWaits(recorder: NetworkRecorder, eventType: string, rec: NetworkRecord | null): void {
  if (browserPilotNetworkWaitNotifier) browserPilotNetworkWaitNotifier(recorder, eventType, rec);
}

function networkRecorderKey(tabId: unknown, sessionId: unknown): string { return Number(tabId) + ':' + String(sessionId || 'default'); }
function defaultNetworkSessionId(msg: BrowserPilotBridgeCommand | JsonRecord | null | undefined): string { return String(msg?.sessionId || msg?.session_id || 'default'); }
function getHeaderValue(headers: unknown, name: unknown): string {
  if (!headers || !name) return '';
  const target = String(name).toLowerCase();
  for (const [k, v] of Object.entries(asRecord(headers))) if (String(k).toLowerCase() === target) return String(v == null ? '' : v);
  return '';
}
function headersObjectToArray(headers: unknown): Array<{ name: string; value: string }> {
  return Object.entries(asRecord(headers)).map(([name, value]) => ({ name, value: String(value == null ? '' : value) }));
}
function normalizeNetworkStringList(value: unknown, fallback: NetworkStringList): string[] {
  if (value === true) return ['all'];
  if (value === false || value === null) return [];
  const raw = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[,\s]+/) : fallback);
  return (Array.isArray(raw) ? raw : []).map(x => String(x || '').trim()).filter(Boolean);
}
function estimateStringBytes(str: unknown): number {
  const text = String(str == null ? '' : str);
  try { return new TextEncoder().encode(text).length; } catch (_) { return text.length; }
}
function truncateStringByBytes(str: unknown, maxBytes: unknown): { value: string; truncated: boolean; originalLength: number; bytes: number } {
  const text = String(str == null ? '' : str);
  if (!Number.isFinite(Number(maxBytes)) || Number(maxBytes) < 0) return { value: text, truncated: false, originalLength: estimateStringBytes(text), bytes: estimateStringBytes(text) };
  const originalLength = estimateStringBytes(text);
  const limit = Math.floor(Number(maxBytes));
  if (originalLength <= limit) return { value: text, truncated: false, originalLength, bytes: originalLength };
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateStringBytes(text.slice(0, mid)) <= limit) lo = mid; else hi = mid - 1;
  }
  const value = text.slice(0, lo);
  return { value, truncated: true, originalLength, bytes: estimateStringBytes(value) };
}
function truncateBase64Body(body: unknown, maxBytes: unknown): { value: string; truncated: boolean; originalLength: number; bytes: number } {
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
function networkRecordFilterView(rec: NetworkRecord) {
  const request = asRecord(rec.request);
  const response = asRecord(rec.response);
  return { url:String(request.url || rec.url || ''), type:String(rec.type || rec.resourceType || '').toLowerCase(), method:String(request.method || rec.method || 'GET').toUpperCase(), status:Number(response.status ?? rec.status) };
}
function makeNetworkRecorderFilter(config: NetworkRecorderConfig): NetworkRecorderConfig["filter"] {
  const includeUrls = Array.isArray(config.includeUrls) ? config.includeUrls.map(String) : [];
  const excludeUrls = Array.isArray(config.excludeUrls) ? config.excludeUrls.map(String) : [];
  const resourceTypes = new Set((Array.isArray(config.resourceTypes) ? config.resourceTypes : []).map(x => String(x).toLowerCase()));
  const allResourceTypes = resourceTypes.has('*') || resourceTypes.has('all');
  const methods = new Set((Array.isArray(config.methods) ? config.methods : []).map(x => String(x).toUpperCase()));
  const statuses = new Set((Array.isArray(config.statuses) ? config.statuses : []).map(x => Number(x)).filter(Number.isFinite));
  return function networkRecorderFilter(rec: NetworkRecord, phase: string): NetworkFilterDecision {
    const view = networkRecordFilterView(rec);
    if (includeUrls.length && !includeUrls.some(p => matchNetworkPattern(view.url, p))) return { match:false, reason:'include_url' };
    if (excludeUrls.length && excludeUrls.some(p => matchNetworkPattern(view.url, p))) return { match:false, reason:'exclude_url' };
    if (resourceTypes.size && !allResourceTypes && !resourceTypes.has(view.type)) return { match:false, reason:'resource_type' };
    if (methods.size && !methods.has(view.method)) return { match:false, reason:'method' };
    if (phase === 'body' || Number.isFinite(view.status)) {
      if (statuses.size && !statuses.has(view.status)) return { match:false, reason:'status' };
    }
    return { match:true, reason:'matched' };
  };
}
function normalizeNetworkBodyMimeAllow(msg: BrowserPilotBridgeCommand | JsonRecord): string[] {
  const raw = msg.bodyMimeAllow ?? msg.body_mime_allow ?? msg.bodyMimeTypes ?? msg.body_mime_types;
  return normalizeNetworkStringList(raw, BROWSER_PILOT_NETWORK_DEFAULT_BODY_MIME_ALLOW).map(x => String(x).toLowerCase());
}
function networkResponseMimeType(rec: NetworkRecord): string {
  return String(rec?.response?.mimeType || getHeaderValue(rec?.response?.headers, 'content-type') || getHeaderValue(rec?.responseExtraInfo?.headers, 'content-type') || '').toLowerCase();
}
function isLikelyBinaryNetworkMime(mime: unknown): boolean {
  if (!mime) return false;
  const text = String(mime);
  return /^(image|audio|video|font)\//i.test(text) || /(octet-stream|pdf|zip|gzip|br|protobuf|wasm|msword|excel|powerpoint)/i.test(text);
}
function networkMimeMatchesToken(mime: string, token: unknown): boolean {
  const normalizedToken = String(token || '').toLowerCase();
  if (!normalizedToken || normalizedToken === '*' || normalizedToken === 'all') return true;
  if (normalizedToken === 'json') return /(^|[/+.-])json($|[;+.-])/.test(mime) || mime.includes('+json');
  if (normalizedToken === 'text') return mime.startsWith('text/');
  if (normalizedToken === 'html') return mime.includes('html');
  if (normalizedToken === 'xml') return mime.includes('xml');
  if (normalizedToken === 'js' || normalizedToken === 'javascript') return mime.includes('javascript') || mime.includes('ecmascript');
  return mime.includes(normalizedToken);
}
function networkBodyMimeDecision(config: NetworkRecorderConfig, rec: NetworkRecord): NetworkBodyMimeDecision {
  const allow = Array.isArray(config.bodyMimeAllow) ? config.bodyMimeAllow : BROWSER_PILOT_NETWORK_DEFAULT_BODY_MIME_ALLOW;
  if (allow.some(token => token === '*' || token === 'all')) return { match:true, reason:'all' };
  const mime = networkResponseMimeType(rec);
  if (!mime) return { match:false, availability:'not_requested', reason:'mime_missing', mimeType:mime };
  if (allow.some(token => networkMimeMatchesToken(mime, token))) return { match:true, reason:'mime_allowed', mimeType:mime };
  return { match:false, availability:isLikelyBinaryNetworkMime(mime) ? 'binary' : 'not_requested', reason:isLikelyBinaryNetworkMime(mime) ? 'binary_mime' : 'mime_not_allowed', mimeType:mime };
}
function classifyNetworkBodyError(error: unknown): { availability: string; reason: string } {
  const text = errorText(error || 'error');
  if (/No resource with given identifier|No data found|no resource|not found|expired|evicted/i.test(text)) return { availability:'expired', reason:'cdp_body_expired' };
  if (/timed out|timeout/i.test(text)) return { availability:'cdp_failed', reason:'cdp_timeout' };
  return { availability:'cdp_failed', reason:'cdp_get_response_body_failed' };
}
function setNetworkBodyAvailability(rec: NetworkRecord | null | undefined, availability: string, reason: string | null, extra: JsonRecord | null = null): void {
  if (!rec) return;
  rec.bodyAvailability = availability || 'not_requested';
  rec.bodyUnavailableReason = reason || null;
  if (extra && typeof extra === 'object') Object.assign(rec, extra);
}
function networkConfigValue(msg: BrowserPilotBridgeCommand | JsonRecord, ...names: string[]): unknown {
  for (const name of names) if (msg[name] !== undefined && msg[name] !== null) return msg[name];
  return undefined;
}
function networkConfigArray(msg: BrowserPilotBridgeCommand | JsonRecord, ...names: string[]): NetworkStringList {
  for (const name of names) if (Array.isArray(msg[name])) return msg[name];
  return [];
}
function networkConfigEnabled(msg: BrowserPilotBridgeCommand | JsonRecord, ...names: string[]): boolean { return names.every(name => msg[name] !== false); }
function normalizeNetworkRecorderConfig(msg: BrowserPilotBridgeCommand | JsonRecord = {}): NetworkRecorderConfig {
  msg = msg || {};
  const sessionId = defaultNetworkSessionId(msg);
  const maxEntries = numberInRange(networkConfigValue(msg, 'maxEntries', 'max_entries'), BROWSER_PILOT_NETWORK_DEFAULT_MAX_ENTRIES, 1, 20000);
  const maxAgeMs = numberInRange(networkConfigValue(msg, 'maxAgeMs', 'max_age_ms'), BROWSER_PILOT_NETWORK_DEFAULT_MAX_AGE_MS, 0, 24 * 60 * 60 * 1000);
  const maxBodyBytes = numberInRange(networkConfigValue(msg, 'maxBodyBytes', 'max_body_bytes'), BROWSER_PILOT_NETWORK_DEFAULT_MAX_BODY_BYTES, 0, 10 * 1024 * 1024);
  const maxPostDataBytes = numberInRange(networkConfigValue(msg, 'maxPostDataBytes', 'max_post_data_bytes'), Math.min(maxBodyBytes, 65536), 0, 1024 * 1024);
  const maxFrames = numberInRange(networkConfigValue(msg, 'maxFrames', 'max_frames', 'maxWebSocketFrames', 'max_websocket_frames'), BROWSER_PILOT_NETWORK_MAX_WS_FRAMES, 0, 5000);
  const maxFrameBytes = numberInRange(networkConfigValue(msg, 'maxFrameBytes', 'max_frame_bytes', 'maxWebSocketFrameBytes', 'max_websocket_frame_bytes'), 65536, 0, 1024 * 1024);
  const maxSseEvents = numberInRange(networkConfigValue(msg, 'maxSseEvents', 'max_sse_events'), BROWSER_PILOT_NETWORK_MAX_SSE_EVENTS, 0, 5000);
  const captureBodies = networkConfigEnabled(msg, 'captureBodies', 'capture_bodies');
  const captureRequestPostData = networkConfigEnabled(msg, 'captureRequestPostData', 'capture_request_post_data');
  const includeWebSocketFrames = networkConfigEnabled(msg, 'includeWebSocketFrames', 'include_websocket_frames');
  const includeSse = networkConfigEnabled(msg, 'includeSse', 'include_sse');
  const bodyTimeoutMs = numberInRange(networkConfigValue(msg, 'bodyTimeoutMs', 'body_timeout_ms'), 3000, 100, 30000);
  const rawResourceTypes = networkConfigArray(msg, 'resourceTypes', 'resource_types');
  const resourceTypes = rawResourceTypes.length ? rawResourceTypes : (captureBodies ? BROWSER_PILOT_NETWORK_DEFAULT_BODY_RESOURCE_TYPES : []);
  const config: NetworkRecorderConfig = {
    sessionId, maxEntries, maxAgeMs, maxBodyBytes, maxPostDataBytes, maxFrames, maxFrameBytes, maxSseEvents,
    captureBodies, captureRequestPostData, includeWebSocketFrames, includeSse, bodyTimeoutMs,
    bodyMimeAllow: normalizeNetworkBodyMimeAllow(msg),
    includeUrls: networkConfigArray(msg, 'includeUrls', 'include_urls'),
    excludeUrls: networkConfigArray(msg, 'excludeUrls', 'exclude_urls'),
    resourceTypes,
    methods: networkConfigArray(msg, 'methods'),
    statuses: networkConfigArray(msg, 'statuses'),
    clearOnStart: msg.clear !== false,
    storeHeaders: msg.storeHeaders !== false && msg.store_headers !== false,
    storePostData: captureRequestPostData,
    createdFrom: redactSensitive({ cmd: msg.cmd, waitId: msg.waitId || msg.wait_id }),
    filter: () => ({ match:true, reason:'uninitialized' })
  };
  config.filter = makeNetworkRecorderFilter(config);
  return config;
}
function makeNetworkCdpRecord(tabId: unknown, sessionId: unknown): BrowserPilotWaitRecord {
  const waitId = 'network_recorder_' + String(sessionId || 'default');
  return {
    tabId:Number(tabId), waitId, wait_id:waitId, requestId:'', request_id:'', kind:'network_recorder',
    key:networkRecorderKey(tabId, sessionId), criteria:{}, timers:[], listeners:[], cdpSubscriptions:[], cdpDomains:new Set<string>(),
    cdpAttached:false, diagnostics:[], cdpEvents:[], createdAt:Date.now(), status:'active', abortController:new AbortController(),
    lastEventAt:null, lastError:null
  };
}
function createNetworkRecorder(tabId: unknown, config: NetworkRecorderConfig): NetworkRecorder {
  const sessionId = config.sessionId || 'default';
  const recorder = {
    tabId:Number(tabId), sessionId, key:networkRecorderKey(tabId, sessionId), recorderId:'netrec_' + Number(tabId) + '_' + (++browserPilotNetworkRecorderSeq),
    active:false, createdAt:Date.now(), startedAt:0, stoppedAt:0, config, filter:config.filter,
    cdpRecord:makeNetworkCdpRecord(tabId, sessionId), entries:[], byRequestId:new Map(), bodyStore:new Map(), bodyByRequestId:new Map(), waits:new Map(), seqBase:browserPilotNetworkEntrySeq,
    counters:{ request:0, requestExtraInfo:0, response:0, responseExtraInfo:0, data:0, finished:0, failed:0, servedFromCache:0, webSocket:0, sse:0, page:0, bodyCaptured:0, bodyErrors:0, waitsResolved:0, waitsTimedOut:0, waitsCancelled:0 },
    overflowCount:0, bodyOverflowCount:0, lastErrors:[], diagnostics:[], lifecycleEvents:[], lastEventAt:0, pendingBodyCount:0, stateGeneration:0
  };
  return recorder;
}
function recorderPublicConfig(config: NetworkRecorderConfig | null | undefined): unknown {
  const { filter: _filter, ...rest } = config || {};
  return redactSensitive(rest);
}
function getNetworkRecorder(tabId: unknown, sessionId: unknown): NetworkRecorder | null { return browserPilotNetworkRecorders.get(networkRecorderKey(tabId, sessionId || 'default')) || null; }
function getActiveNetworkRecorder(tabId: unknown, msg: BrowserPilotBridgeCommand | JsonRecord | null | undefined): NetworkRecorder | null {
  const sessionId = defaultNetworkSessionId(msg);
  return getNetworkRecorder(tabId, sessionId);
}
function rememberNetworkError(recorder: NetworkRecorder | null | undefined, where: unknown, error: unknown, extra: JsonRecord | null = null): void {
  if (!recorder) return;
  const item = { t:Date.now(), where, error:errorText(error || 'error'), ...(extra || {}) };
  recorder.lastErrors.push(redactSensitive(item));
  if (recorder.lastErrors.length > 50) recorder.lastErrors.splice(0, recorder.lastErrors.length - 50);
}
function networkRecorderSummary(recorder: NetworkRecorder | null | undefined): NetworkRecorderSummary | null {
  if (!recorder) return null;
  const activeWaits = Array.from(recorder.waits.values()).map(w => ({ waitId:w.waitId, condition:w.condition, age_ms:Date.now()-w.createdAt, criteria:asRecord(redactSensitive(w.criteria || {})), lastMatchSeq:w.lastMatchSeq || 0 }));
  const summary: NetworkRecorderSummary = {
    tabId:recorder.tabId, sessionId:recorder.sessionId, recorderId:recorder.recorderId, active:!!recorder.active,
    createdAt:recorder.createdAt, startedAt:recorder.startedAt, stoppedAt:recorder.stoppedAt, age_ms:Date.now()-(recorder.startedAt || recorder.createdAt),
    entries:recorder.entries.length, requestCount:recorder.byRequestId.size, bodyCount:recorder.bodyStore.size, pendingBodyCount:recorder.pendingBodyCount,
    lastSeq:recorder.entries.length ? Number(recorder.entries[recorder.entries.length - 1].seq) : Number(recorder.seqBase || 0),
    maxEntries:recorder.config.maxEntries, maxAgeMs:recorder.config.maxAgeMs, maxBodyBytes:recorder.config.maxBodyBytes, overflowCount:recorder.overflowCount, bodyOverflowCount:recorder.bodyOverflowCount,
    counters:{ ...recorder.counters }, lastErrors:recorder.lastErrors.slice(-10), lifecycleEvents:recorder.lifecycleEvents.slice(-10), activeWaits, activeWaitCount:activeWaits.length,
    cdp:{ subscriptions:(recorder.cdpRecord.cdpSubscriptions || []).slice(), domains:Array.from(recorder.cdpRecord.cdpDomains || []), attached:!!recorder.cdpRecord.cdpAttached, refs:diagnoseBrowserPilotCdpDomainRefs(recorder.tabId).filter(r => (r.holders || []).some(h => h.holderId === recorder.cdpRecord.key)) },
    config:recorderPublicConfig(recorder.config), diagnostics:recorder.diagnostics.slice(-20)
  };
  if (recorder.recoveredAt) summary.recoveredAt = recorder.recoveredAt;
  if (recorder.historyLost) summary.historyLost = true;
  if (Number.isFinite(Number(recorder.stateGeneration))) summary.generation = Number(recorder.stateGeneration);
  return summary;
}
function ensureNetworkEntry(recorder: NetworkRecorder, requestId: unknown): NetworkRecord {
  const normalizedRequestId = String(requestId || makeWaitId(recorder.tabId, 'network_request'));
  let rec = recorder.byRequestId.get(normalizedRequestId);
  if (!rec) {
    rec = { id:normalizedRequestId, requestId:normalizedRequestId, tabId:recorder.tabId, sessionId:recorder.sessionId, seq:++browserPilotNetworkEntrySeq, createdAt:Date.now(), updatedAt:Date.now(), wallTime:null, timestamp:null, type:'', resourceType:'', phase:'created', request:{ headers:{} }, response:null, redirects:[], data:{ encodedDataLength:0, dataLength:0, chunks:0 }, timing:{}, fromCache:false, failed:null, errorText:null, canceled:false, blockedReason:null, initiator:null, wsFrames:[], sseEvents:[], bodyRef:null, bodyPreview:null, bodyTruncated:false, bodyError:null, bodyPending:false, bodyAvailability:'not_requested', bodyUnavailableReason:'pending_response' };
    recorder.byRequestId.set(normalizedRequestId, rec);
    recorder.entries.push(rec);
    pruneNetworkRecorder(recorder);
  }
  rec.updatedAt = Date.now();
  recorder.lastEventAt = rec.updatedAt;
  return rec;
}
function deleteNetworkBodyForRecord(recorder: NetworkRecorder, rec: NetworkRecord | null | undefined): void {
  if (!rec) return;
  if (rec.bodyRef) recorder.bodyStore.delete(rec.bodyRef);
  recorder.bodyByRequestId.delete(rec.requestId);
  rec.bodyRef = null;
}
function pruneNetworkRecorder(recorder: NetworkRecorder | null | undefined): void {
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
function networkRecordMatchesIdentity(rec: NetworkRecord, filters: JsonRecord): boolean {
  if (filters.sinceSeq !== undefined && Number(rec.seq) <= Number(filters.sinceSeq)) return false;
  if (filters.requestId && String(rec.requestId) !== String(filters.requestId)) return false;
  if (filters.method && String(rec.request?.method || '').toUpperCase() !== String(filters.method).toUpperCase()) return false;
  if (filters.type && String(rec.type || '').toLowerCase() !== String(filters.type).toLowerCase()) return false;
  return true;
}
function networkRecordMatchesUrl(rec: NetworkRecord, filters: JsonRecord): boolean {
  const url = String(rec.request?.url || '');
  const urlFilter = filters.url ?? filters.urlContains ?? filters.url_contains;
  if (urlFilter && !url.includes(String(urlFilter))) return false;
  const urlPattern = filters.urlPattern ?? filters.url_pattern;
  if (urlPattern && !matchNetworkPattern(url, String(urlPattern))) return false;
  if (Array.isArray(filters.includeUrls) && filters.includeUrls.length && !filters.includeUrls.some(p => matchNetworkPattern(url, String(p)))) return false;
  if (Array.isArray(filters.excludeUrls) && filters.excludeUrls.length && filters.excludeUrls.some(p => matchNetworkPattern(url, String(p)))) return false;
  return true;
}
function networkRecordMatchesResponse(rec: NetworkRecord, filters: JsonRecord): boolean {
  const mime = filters.mime || filters.mimeType || filters.mime_type;
  if (mime && !matchNetworkPattern(String(rec.response?.mimeType || getHeaderValue(rec.response?.headers, 'content-type') || ''), String(mime))) return false;
  if (filters.status !== undefined && Number(rec.response?.status) !== Number(filters.status)) return false;
  return true;
}
function networkRecordMatchesList(rec: NetworkRecord, filters: JsonRecord | null | undefined): boolean { const normalized = filters || {}; return networkRecordMatchesIdentity(rec, normalized) && networkRecordMatchesUrl(rec, normalized) && networkRecordMatchesResponse(rec, normalized); }
function networkCriterionMatchesText(value: unknown, criterion: unknown): boolean {
  if (criterion === undefined || criterion === null || criterion === '') return true;
  return matchNetworkPattern(String(value == null ? '' : value), String(criterion));
}
function networkWsFrameMatches(frame: NetworkFrameRecord, criterion: unknown): boolean {
  if (criterion === undefined || criterion === null || criterion === '') return true;
  if (criterion && typeof criterion === 'object') {
    const criterionRecord = criterion as JsonRecord;
    if (criterionRecord.method && String(frame.method || '') !== String(criterionRecord.method)) return false;
    if (criterionRecord.opcode !== undefined && Number(frame.opcode) !== Number(criterionRecord.opcode)) return false;
    if (criterionRecord.payloadContains !== undefined && !networkCriterionMatchesText(frame.payloadData, criterionRecord.payloadContains)) return false;
    if (criterionRecord.payload_contains !== undefined && !networkCriterionMatchesText(frame.payloadData, criterionRecord.payload_contains)) return false;
    return true;
  }
  return networkCriterionMatchesText(frame.payloadData, criterion);
}
function networkSseEventMatches(event: NetworkFrameRecord, criterion: unknown): boolean {
  if (criterion === undefined || criterion === null || criterion === '') return true;
  if (criterion && typeof criterion === 'object') {
    const criterionRecord = criterion as JsonRecord;
    if (criterionRecord.eventName !== undefined && !networkCriterionMatchesText(event.eventName, criterionRecord.eventName)) return false;
    if (criterionRecord.event_name !== undefined && !networkCriterionMatchesText(event.eventName, criterionRecord.event_name)) return false;
    if (criterionRecord.eventId !== undefined && !networkCriterionMatchesText(event.eventId, criterionRecord.eventId)) return false;
    if (criterionRecord.event_id !== undefined && !networkCriterionMatchesText(event.eventId, criterionRecord.event_id)) return false;
    if (criterionRecord.dataContains !== undefined && !networkCriterionMatchesText(event.data, criterionRecord.dataContains)) return false;
    if (criterionRecord.data_contains !== undefined && !networkCriterionMatchesText(event.data, criterionRecord.data_contains)) return false;
    return true;
  }
  return networkCriterionMatchesText([event.eventName, event.eventId, event.data].join('\n'), criterion);
}
function networkRecordResponseSummary(rec: NetworkRecord): JsonRecord {
  const response = asRecord(rec.response);
  return { status:response.status, statusText:response.statusText, mimeType:response.mimeType, protocol:response.protocol, fromCache:!!rec.fromCache, fromServiceWorker:!!response.fromServiceWorker, failed:rec.failed, errorText:rec.errorText || null, canceled:!!rec.canceled, blockedReason:rec.blockedReason || null };
}
function networkRecordBodySummary(rec: NetworkRecord): JsonRecord {
  const bodyRef = rec.bodyRef || null;
  return { bodyRef, bodyPreview:rec.bodyPreview || null, bodyTruncated:!!rec.bodyTruncated, bodyError:rec.bodyError || null, bodyPending:!!rec.bodyPending, bodyAvailability:rec.bodyAvailability || (bodyRef ? 'captured' : 'not_requested'), bodyUnavailableReason:rec.bodyUnavailableReason || null };
}
function networkRecordTrafficSummary(rec: NetworkRecord): JsonRecord {
  const request = asRecord(rec.request);
  const data = asRecord(rec.data);
  return { encodedDataLength:data.encodedDataLength || 0, dataLength:data.dataLength || 0, hasPostData:!!request.hasPostData || request.postData !== undefined, postDataTruncated:!!request.postDataTruncated, postDataBytes:request.postData !== undefined ? estimateStringBytes(request.postData) : undefined, redirects:(rec.redirects || []).length, wsFrameCount:(rec.wsFrames || []).length, sseEventCount:(rec.sseEvents || []).length };
}
function networkRecordSummary(rec: NetworkRecord, options: { includeDetails?: boolean; includeBody?: boolean } = {}): NetworkRecordSummary {
  options = options || {};
  const out: NetworkRecordSummary = {
    ...rec,
    type:rec.type || rec.resourceType || '',
    ...networkRecordResponseSummary(rec),
    ...networkRecordBodySummary(rec),
    ...networkRecordTrafficSummary(rec)
  };
  if (options.includeDetails) Object.assign(out, networkRecordClone(rec, { includeBody: options.includeBody }));
  return redactSensitive(out) as NetworkRecordSummary;
}
function networkRecordClone(rec: NetworkRecord, options: { includeBody?: boolean } = {}): NetworkRecordSnapshot {
  options = options || {};
  const clone = JSON.parse(JSON.stringify(rec || {})) as NetworkRecord;
  if (!options.includeBody) delete clone.body;
  return redactSensitive(clone) as NetworkRecordSnapshot;
}
function storeNetworkBody(recorder: NetworkRecorder, rec: NetworkRecord, bodyResult: JsonRecord | null | undefined): void {
  const body = String(bodyResult?.body ?? '');
  const base64Encoded = !!bodyResult?.base64Encoded;
  const trunc = base64Encoded
    ? truncateBase64Body(body, recorder.config.maxBodyBytes)
    : truncateStringByBytes(body, recorder.config.maxBodyBytes);
  const bodyRef = rec.bodyRef || ('body_' + recorder.recorderId + '_' + (++browserPilotNetworkBodySeq));
  const stored: NetworkBodyStoreEntry = { bodyRef, requestId:rec.requestId, tabId:rec.tabId, sessionId:rec.sessionId, base64Encoded, body:trunc.value, bodyTruncated:!!trunc.truncated, originalLength:trunc.originalLength, bytes:trunc.bytes, mimeType:rec.response?.mimeType || '', status:rec.response?.status, url:rec.request?.url || '', createdAt:Date.now() };
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
  notifyNetworkWaits(recorder, 'body', rec);
}
export type { NetworkBodyStoreEntry, NetworkFilterDecision, NetworkFrameRecord, NetworkRecord, NetworkRecorder, NetworkRecorderConfig, NetworkRecorderWait } from "./types";
export { BROWSER_PILOT_NETWORK_DEFAULT_MAX_ENTRIES, BROWSER_PILOT_NETWORK_DEFAULT_MAX_AGE_MS, BROWSER_PILOT_NETWORK_DEFAULT_MAX_BODY_BYTES, BROWSER_PILOT_NETWORK_MAX_WS_FRAMES, BROWSER_PILOT_NETWORK_MAX_SSE_EVENTS, BROWSER_PILOT_NETWORK_DEFAULT_BODY_MIME_ALLOW, BROWSER_PILOT_NETWORK_DEFAULT_BODY_RESOURCE_TYPES, browserPilotNetworkRecorders, browserPilotNetworkRecorderSeq, browserPilotNetworkEntrySeq, browserPilotNetworkBodySeq, browserPilotNetworkWaitNotifier, setNetworkWaitNotifier, notifyNetworkWaits, networkRecorderKey, defaultNetworkSessionId, numberInRange, getHeaderValue, headersObjectToArray, normalizeNetworkStringList, estimateStringBytes, truncateStringByBytes, truncateBase64Body, makeNetworkRecorderFilter, normalizeNetworkBodyMimeAllow, networkResponseMimeType, isLikelyBinaryNetworkMime, networkMimeMatchesToken, networkBodyMimeDecision, classifyNetworkBodyError, setNetworkBodyAvailability, normalizeNetworkRecorderConfig, makeNetworkCdpRecord, createNetworkRecorder, recorderPublicConfig, getNetworkRecorder, getActiveNetworkRecorder, rememberNetworkError, networkRecorderSummary, ensureNetworkEntry, deleteNetworkBodyForRecord, pruneNetworkRecorder, networkRecordMatchesList, networkCriterionMatchesText, networkWsFrameMatches, networkSseEventMatches, networkRecordSummary, networkRecordClone, storeNetworkBody };
