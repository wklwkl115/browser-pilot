import { makeWaitId } from "./wait_coordinator";
import { ensureNetworkEntry, rememberNetworkError, networkBodyMimeDecision, setNetworkBodyAvailability, storeNetworkBody, pruneNetworkRecorder, truncateStringByBytes } from "./network_model";
import { runtimeErrorMessage as errorText, runtimeRecord as asRecord } from "./runtimeSupport.js";
import type { JsonRecord } from "./types";
import type { NetworkRecord, NetworkRecorder } from "./network_model";

export function appendBounded<T>(arr: T[], item: T, max: number, overflowCounterTarget: { overflow?: number } | null = null): void {
  if (max <= 0) return;
  arr.push(item);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
    if (overflowCounterTarget) overflowCounterTarget.overflow = (overflowCounterTarget.overflow || 0) + 1;
  }
}

export async function browserPilotNetworkMaybeCaptureBody(recorder: NetworkRecorder, rec: NetworkRecord, deps: {
  cdpSendNetworkCommand: (tabId: number, method: string, params?: JsonRecord, timeoutMs?: number) => Promise<JsonRecord>;
  classifyNetworkBodyError: (error: unknown) => { availability: string; reason: string };
  wakeNetworkWaits: (recorder: NetworkRecorder, eventType: string, rec: NetworkRecord | null) => void;
}): Promise<void> {
  if (!recorder?.active || !rec || rec.bodyPending || rec.bodyRef) return;
  if (!recorder.config.captureBodies) { setNetworkBodyAvailability(rec, "not_requested", "capture_bodies_disabled"); return; }
  const decision = recorder.filter(rec, "body");
  if (!decision.match) { rec.bodySkipped = decision.reason; setNetworkBodyAvailability(rec, "not_requested", decision.reason + "_filtered"); return; }
  const mimeDecision = networkBodyMimeDecision(recorder.config, rec);
  if (!mimeDecision.match) { rec.bodySkipped = mimeDecision.reason; setNetworkBodyAvailability(rec, mimeDecision.availability || "not_requested", mimeDecision.reason, { bodyMimeType: mimeDecision.mimeType }); return; }
  rec.bodyPending = true;
  rec.bodyCaptureAttemptedAt = Date.now();
  setNetworkBodyAvailability(rec, "pending", null);
  recorder.pendingBodyCount += 1;
  try {
    const result = await deps.cdpSendNetworkCommand(recorder.tabId, "Network.getResponseBody", { requestId: rec.requestId }, recorder.config.bodyTimeoutMs);
    storeNetworkBody(recorder, rec, result || {});
  } catch (e) {
    rec.bodyError = errorText(e);
    rec.bodyPending = false;
    const classified = deps.classifyNetworkBodyError(e);
    setNetworkBodyAvailability(rec, classified.availability, classified.reason);
    recorder.counters.bodyErrors += 1;
    rememberNetworkError(recorder, "Network.getResponseBody", e, { requestId: rec.requestId, url: rec.request?.url });
    deps.wakeNetworkWaits(recorder, "body_error", rec);
  } finally {
    recorder.pendingBodyCount = Math.max(0, recorder.pendingBodyCount - 1);
  }
}

type RecorderEventDeps = {
  wakeNetworkWaits: (recorder: NetworkRecorder, eventType: string, rec: NetworkRecord | null) => void;
  maybeCaptureNetworkBody: (recorder: NetworkRecorder, rec: NetworkRecord) => Promise<void>;
};
type RecorderEventHandler = (recorder: NetworkRecorder, params: JsonRecord, deps: RecorderEventDeps) => void;
type RecorderCounter = keyof NetworkRecorder["counters"];

function recordNetworkEvent(recorder: NetworkRecorder, params: JsonRecord, deps: RecorderEventDeps, counter: RecorderCounter, eventType: string, update: (rec: NetworkRecord) => void, requestId: unknown = params.requestId): NetworkRecord {
  recorder.counters[counter] += 1;
  const rec = ensureNetworkEntry(recorder, requestId);
  update(rec);
  deps.wakeNetworkWaits(recorder, eventType, rec);
  return rec;
}

function requestDetails(recorder: NetworkRecorder, rec: NetworkRecord, request: JsonRecord): NetworkRecord["request"] {
  return { ...(rec.request || {}), url: String(request.url || rec.request?.url || ""), method: String(request.method || rec.request?.method || "GET"), headers: recorder.config.storeHeaders ? asRecord(request.headers || rec.request?.headers || {}) : {}, mixedContentType: request.mixedContentType, initialPriority: request.initialPriority, referrerPolicy: request.referrerPolicy, hasPostData: !!request.hasPostData };
}

function responseDetails(recorder: NetworkRecorder, rec: NetworkRecord, response: JsonRecord): NonNullable<NetworkRecord["response"]> {
  return { url: String(response.url || rec.request?.url || ""), status: Number(response.status || 0), statusText: String(response.statusText || ""), headers: recorder.config.storeHeaders ? asRecord(response.headers) : {}, mimeType: String(response.mimeType || ""), charset: String(response.charset || ""), connectionReused: !!response.connectionReused, connectionId: response.connectionId == null ? undefined : String(response.connectionId), remoteIPAddress: String(response.remoteIPAddress || ""), remotePort: response.remotePort, fromDiskCache: !!response.fromDiskCache, fromPrefetchCache: !!response.fromPrefetchCache, fromServiceWorker: !!response.fromServiceWorker, encodedDataLength: response.encodedDataLength, protocol: String(response.protocol || ""), securityState: String(response.securityState || ""), securityDetails: response.securityDetails || null, timing: response.timing || null };
}

function handleRequestWillBeSent(recorder: NetworkRecorder, params: JsonRecord, deps: RecorderEventDeps): void {
  const request = asRecord(params.request);
  recordNetworkEvent(recorder, params, deps, "request", "request", (rec) => {
    if (params.redirectResponse) {
      rec.redirects = rec.redirects || [];
      rec.redirects.push({ t: Date.now(), response: params.redirectResponse, previousUrl: rec.request?.url || "" });
    }
    rec.phase = "request";
    rec.loaderId = params.loaderId || rec.loaderId;
    rec.documentURL = params.documentURL || rec.documentURL;
    rec.frameId = params.frameId || rec.frameId;
    rec.wallTime = params.wallTime == null ? rec.wallTime : Number(params.wallTime);
    rec.timestamp = params.timestamp == null ? rec.timestamp : Number(params.timestamp);
    rec.type = params.type ? String(params.type) : (rec.type || "");
    rec.resourceType = params.type ? String(params.type) : (rec.resourceType || "");
    rec.initiator = params.initiator || rec.initiator;
    rec.request = requestDetails(recorder, rec, request);
    if (recorder.config.storePostData && request.postData !== undefined) {
      const trunc = truncateStringByBytes(String(request.postData || ""), recorder.config.maxPostDataBytes);
      rec.request.postData = trunc.value;
      rec.request.postDataTruncated = trunc.truncated;
      rec.request.postDataOriginalLength = trunc.originalLength;
    }
  }, String(params.requestId || makeWaitId(recorder.tabId, "request")));
}

function handleRequestExtraInfo(recorder: NetworkRecorder, params: JsonRecord, deps: RecorderEventDeps): void {
  recordNetworkEvent(recorder, params, deps, "requestExtraInfo", "request_extra", (rec) => {
    rec.requestExtraInfo = { headers: recorder.config.storeHeaders ? asRecord(params.headers) : {}, associatedCookies: Array.isArray(params.associatedCookies) ? params.associatedCookies : [], connectTiming: params.connectTiming || null, clientSecurityState: params.clientSecurityState || null };
  });
}

function handleResponseReceived(recorder: NetworkRecorder, params: JsonRecord, deps: RecorderEventDeps): void {
  const response = asRecord(params.response);
  recordNetworkEvent(recorder, params, deps, "response", "response", (rec) => {
    rec.phase = "response";
    rec.type = params.type ? String(params.type) : (rec.type || "");
    rec.resourceType = params.type ? String(params.type) : (rec.resourceType || "");
    rec.response = responseDetails(recorder, rec, response);
    rec.timing = asRecord(response.timing || rec.timing || {});
  });
}

function handleResponseExtraInfo(recorder: NetworkRecorder, params: JsonRecord, deps: RecorderEventDeps): void {
  recordNetworkEvent(recorder, params, deps, "responseExtraInfo", "response_extra", (rec) => {
    const statusCode = params.statusCode === undefined ? undefined : Number(params.statusCode);
    rec.responseExtraInfo = { headers: recorder.config.storeHeaders ? asRecord(params.headers) : {}, blockedCookies: Array.isArray(params.blockedCookies) ? params.blockedCookies : [], statusCode, headersText: String(params.headersText || ""), resourceIPAddressSpace: String(params.resourceIPAddressSpace || "") };
    if (!rec.response) rec.response = { status: statusCode, headers: recorder.config.storeHeaders ? asRecord(params.headers) : {} };
    else if (statusCode && !rec.response.status) rec.response.status = statusCode;
  });
}

function handleDataReceived(recorder: NetworkRecorder, params: JsonRecord, deps: RecorderEventDeps): void {
  recordNetworkEvent(recorder, params, deps, "data", "data", (rec) => {
    rec.phase = rec.phase === "created" ? "data" : rec.phase;
    rec.data = rec.data || { encodedDataLength: 0, dataLength: 0, chunks: 0 };
    rec.data.encodedDataLength = Number(rec.data.encodedDataLength || 0) + Number(params.encodedDataLength || 0);
    rec.data.dataLength = Number(rec.data.dataLength || 0) + Number(params.dataLength || 0);
    rec.data.chunks = Number(rec.data.chunks || 0) + 1;
  });
}

function handleServedFromCache(recorder: NetworkRecorder, params: JsonRecord, deps: RecorderEventDeps): void {
  recordNetworkEvent(recorder, params, deps, "servedFromCache", "cache", (rec) => { rec.fromCache = true; });
}

function handleLoadingFinished(recorder: NetworkRecorder, params: JsonRecord, deps: RecorderEventDeps): void {
  const rec = recordNetworkEvent(recorder, params, deps, "finished", "finished", (entry) => {
    entry.phase = "finished";
    entry.finishedAt = Date.now();
    entry.encodedDataLength = params.encodedDataLength === undefined ? undefined : Number(params.encodedDataLength);
    entry.data = entry.data || {};
    if (params.encodedDataLength !== undefined) entry.data.encodedDataLength = Math.max(Number(entry.data.encodedDataLength || 0), Number(params.encodedDataLength || 0));
  });
  void deps.maybeCaptureNetworkBody(recorder, rec);
}

function handleLoadingFailed(recorder: NetworkRecorder, params: JsonRecord, deps: RecorderEventDeps): void {
  recordNetworkEvent(recorder, params, deps, "failed", "failed", (rec) => {
    rec.phase = "failed";
    rec.failed = { errorText: params.errorText || "", canceled: !!params.canceled, blockedReason: params.blockedReason || null, corsErrorStatus: params.corsErrorStatus || null, type: params.type || rec.type || "" };
    rec.errorText = String(rec.failed.errorText || "");
    rec.canceled = !!params.canceled;
    rec.blockedReason = params.blockedReason ? String(params.blockedReason) : null;
  });
}

function captureWebSocketFrame(recorder: NetworkRecorder, rec: NetworkRecord, method: string, params: JsonRecord): void {
  if (!recorder.config.includeWebSocketFrames || (method !== "Network.webSocketFrameSent" && method !== "Network.webSocketFrameReceived")) return;
  const response = asRecord(params.response);
  const trunc = truncateStringByBytes(String(response.payloadData ?? ""), recorder.config.maxFrameBytes);
  appendBounded(rec.wsFrames, { t: Date.now(), method, opcode: Number(response.opcode || 0), mask: response.mask, payloadData: trunc.value, payloadTruncated: trunc.truncated, originalLength: trunc.originalLength }, recorder.config.maxFrames, rec);
}

function handleWebSocketEvent(recorder: NetworkRecorder, method: string, params: JsonRecord, deps: RecorderEventDeps): void {
  recorder.counters.webSocket += 1;
  const requestId = String(params.requestId || params.identifier || makeWaitId(recorder.tabId, "websocket"));
  const rec = ensureNetworkEntry(recorder, requestId);
  rec.type = rec.type || "WebSocket";
  rec.resourceType = rec.resourceType || "WebSocket";
  if (method === "Network.webSocketCreated") { rec.request.url = String(params.url || rec.request.url || ""); rec.phase = "websocket"; }
  if (method === "Network.webSocketWillSendHandshakeRequest") rec.webSocketRequest = params.request || params;
  if (method === "Network.webSocketHandshakeResponseReceived") rec.webSocketResponse = params.response || params;
  captureWebSocketFrame(recorder, rec, method, params);
  if (method === "Network.webSocketClosed") rec.webSocketClosedAt = Date.now();
  if (method === "Network.webSocketFrameError") rec.webSocketError = params.errorMessage || params;
  deps.wakeNetworkWaits(recorder, "websocket", rec);
}

function handleSseEvent(recorder: NetworkRecorder, params: JsonRecord, deps: RecorderEventDeps): void {
  recordNetworkEvent(recorder, params, deps, "sse", "sse", (rec) => {
    rec.type = rec.type || "EventSource";
    rec.resourceType = rec.resourceType || "EventSource";
    if (!recorder.config.includeSse) return;
    const trunc = truncateStringByBytes(String(params.data || ""), recorder.config.maxFrameBytes);
    appendBounded(rec.sseEvents, { t: Date.now(), eventName: String(params.eventName || ""), eventId: String(params.eventId || ""), data: trunc.value, dataTruncated: trunc.truncated, originalLength: trunc.originalLength }, recorder.config.maxSseEvents, rec);
  });
}

const NETWORK_EVENT_HANDLERS: Readonly<Record<string, RecorderEventHandler>> = {
  "Network.requestWillBeSent": handleRequestWillBeSent,
  "Network.requestWillBeSentExtraInfo": handleRequestExtraInfo,
  "Network.responseReceived": handleResponseReceived,
  "Network.responseReceivedExtraInfo": handleResponseExtraInfo,
  "Network.dataReceived": handleDataReceived,
  "Network.requestServedFromCache": handleServedFromCache,
  "Network.loadingFinished": handleLoadingFinished,
  "Network.loadingFailed": handleLoadingFailed,
};

export function browserPilotNetworkHandleRecorderCdpEvent(recorder: NetworkRecorder, _source: { tabId?: number }, method: string, params: JsonRecord = {}, deps: RecorderEventDeps): void {
  if (!recorder || !recorder.active) return;
  params = params || {};
  recorder.lastEventAt = Date.now();
  try {
    const handler = NETWORK_EVENT_HANDLERS[method];
    if (handler) {
      handler(recorder, params, deps);
    } else if (method.startsWith("Network.webSocket")) {
      handleWebSocketEvent(recorder, method, params, deps);
    } else if (method === "Network.eventSourceMessageReceived") {
      handleSseEvent(recorder, params, deps);
    } else if (method.startsWith("Page.")) {
      recorder.counters.page += 1;
      appendBounded(recorder.lifecycleEvents, { t: Date.now(), method, frameId: params.frameId, name: params.name, loaderId: params.loaderId }, 100);
      deps.wakeNetworkWaits(recorder, "page", null);
    }
    pruneNetworkRecorder(recorder);
  } catch (e) {
    rememberNetworkError(recorder, method, e, { params });
  }
}

export { asRecord, errorText };
