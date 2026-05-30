import { makeWaitId } from "./wait_coordinator";
import { ensureNetworkEntry, rememberNetworkError, networkBodyMimeDecision, setNetworkBodyAvailability, storeNetworkBody, pruneNetworkRecorder, truncateStringByBytes } from "./network_model";
import type { JsonRecord } from "./types";
import type { NetworkRecord, NetworkRecorder } from "./network_model";

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function appendBounded<T>(arr: T[], item: T, max: number, overflowCounterTarget: { overflow?: number } | null = null): void {
  if (max <= 0) return;
  arr.push(item);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
    if (overflowCounterTarget) overflowCounterTarget.overflow = (overflowCounterTarget.overflow || 0) + 1;
  }
}

export async function piNetworkMaybeCaptureBody(recorder: NetworkRecorder, rec: NetworkRecord, deps: {
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

export function piNetworkHandleRecorderCdpEvent(recorder: NetworkRecorder, _source: { tabId?: number }, method: string, params: JsonRecord = {}, deps: {
  wakeNetworkWaits: (recorder: NetworkRecorder, eventType: string, rec: NetworkRecord | null) => void;
  maybeCaptureNetworkBody: (recorder: NetworkRecorder, rec: NetworkRecord) => Promise<void>;
}): void {
  if (!recorder || !recorder.active) return;
  params = params || {};
  recorder.lastEventAt = Date.now();
  try {
    if (method === "Network.requestWillBeSent") {
      recorder.counters.request += 1;
      const requestId = String(params.requestId || makeWaitId(recorder.tabId, "request"));
      const rec = ensureNetworkEntry(recorder, requestId);
      const request = asRecord(params.request);
      if (params.redirectResponse) {
        rec.redirects = rec.redirects || [];
        rec.redirects.push({ t: Date.now(), response: params.redirectResponse, previousUrl: rec.request?.url || "" });
      }
      rec.phase = "request";
      rec.loaderId = params.loaderId || rec.loaderId;
      rec.documentURL = params.documentURL || rec.documentURL;
      rec.frameId = params.frameId || rec.frameId;
      rec.wallTime = params.wallTime === undefined || params.wallTime === null ? rec.wallTime : Number(params.wallTime);
      rec.timestamp = params.timestamp === undefined || params.timestamp === null ? rec.timestamp : Number(params.timestamp);
      rec.type = params.type ? String(params.type) : (rec.type || "");
      rec.resourceType = params.type ? String(params.type) : (rec.resourceType || "");
      rec.initiator = params.initiator || rec.initiator;
      rec.request = { ...(rec.request || {}), url: String(request.url || rec.request?.url || ""), method: String(request.method || rec.request?.method || "GET"), headers: recorder.config.storeHeaders ? asRecord(request.headers || rec.request?.headers || {}) : {}, mixedContentType: request.mixedContentType, initialPriority: request.initialPriority, referrerPolicy: request.referrerPolicy, hasPostData: !!request.hasPostData };
      if (recorder.config.storePostData && request.postData !== undefined) {
        const trunc = truncateStringByBytes(String(request.postData || ""), recorder.config.maxPostDataBytes);
        rec.request.postData = trunc.value;
        rec.request.postDataTruncated = trunc.truncated;
        rec.request.postDataOriginalLength = trunc.originalLength;
      }
      deps.wakeNetworkWaits(recorder, "request", rec);
    } else if (method === "Network.requestWillBeSentExtraInfo") {
      recorder.counters.requestExtraInfo += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.requestExtraInfo = { headers: recorder.config.storeHeaders ? asRecord(params.headers) : {}, associatedCookies: Array.isArray(params.associatedCookies) ? params.associatedCookies : [], connectTiming: params.connectTiming || null, clientSecurityState: params.clientSecurityState || null };
      deps.wakeNetworkWaits(recorder, "request_extra", rec);
    } else if (method === "Network.responseReceived") {
      recorder.counters.response += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      const r = asRecord(params.response);
      rec.phase = "response";
      rec.type = params.type ? String(params.type) : (rec.type || "");
      rec.resourceType = params.type ? String(params.type) : (rec.resourceType || "");
      rec.response = { url: String(r.url || rec.request?.url || ""), status: Number(r.status || 0), statusText: String(r.statusText || ""), headers: recorder.config.storeHeaders ? asRecord(r.headers) : {}, mimeType: String(r.mimeType || ""), charset: String(r.charset || ""), connectionReused: !!r.connectionReused, connectionId: r.connectionId == null ? undefined : String(r.connectionId), remoteIPAddress: String(r.remoteIPAddress || ""), remotePort: r.remotePort, fromDiskCache: !!r.fromDiskCache, fromPrefetchCache: !!r.fromPrefetchCache, fromServiceWorker: !!r.fromServiceWorker, encodedDataLength: r.encodedDataLength, protocol: String(r.protocol || ""), securityState: String(r.securityState || ""), securityDetails: r.securityDetails || null, timing: r.timing || null };
      rec.timing = asRecord(r.timing || rec.timing || {});
      deps.wakeNetworkWaits(recorder, "response", rec);
    } else if (method === "Network.responseReceivedExtraInfo") {
      recorder.counters.responseExtraInfo += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      const statusCode = params.statusCode === undefined ? undefined : Number(params.statusCode);
      rec.responseExtraInfo = { headers: recorder.config.storeHeaders ? asRecord(params.headers) : {}, blockedCookies: Array.isArray(params.blockedCookies) ? params.blockedCookies : [], statusCode, headersText: String(params.headersText || ""), resourceIPAddressSpace: String(params.resourceIPAddressSpace || "") };
      if (!rec.response) rec.response = { status: statusCode, headers: recorder.config.storeHeaders ? asRecord(params.headers) : {} };
      else if (statusCode && !rec.response.status) rec.response.status = statusCode;
      deps.wakeNetworkWaits(recorder, "response_extra", rec);
    } else if (method === "Network.dataReceived") {
      recorder.counters.data += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.phase = rec.phase === "created" ? "data" : rec.phase;
      rec.data = rec.data || { encodedDataLength: 0, dataLength: 0, chunks: 0 };
      rec.data.encodedDataLength = Number(rec.data.encodedDataLength || 0) + Number(params.encodedDataLength || 0);
      rec.data.dataLength = Number(rec.data.dataLength || 0) + Number(params.dataLength || 0);
      rec.data.chunks = Number(rec.data.chunks || 0) + 1;
      deps.wakeNetworkWaits(recorder, "data", rec);
    } else if (method === "Network.requestServedFromCache") {
      recorder.counters.servedFromCache += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.fromCache = true;
      deps.wakeNetworkWaits(recorder, "cache", rec);
    } else if (method === "Network.loadingFinished") {
      recorder.counters.finished += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.phase = "finished";
      rec.finishedAt = Date.now();
      rec.encodedDataLength = params.encodedDataLength === undefined ? undefined : Number(params.encodedDataLength);
      rec.data = rec.data || {};
      if (params.encodedDataLength !== undefined) rec.data.encodedDataLength = Math.max(Number(rec.data.encodedDataLength || 0), Number(params.encodedDataLength || 0));
      deps.wakeNetworkWaits(recorder, "finished", rec);
      void deps.maybeCaptureNetworkBody(recorder, rec);
    } else if (method === "Network.loadingFailed") {
      recorder.counters.failed += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.phase = "failed";
      rec.failed = { errorText: params.errorText || "", canceled: !!params.canceled, blockedReason: params.blockedReason || null, corsErrorStatus: params.corsErrorStatus || null, type: params.type || rec.type || "" };
      rec.errorText = String(rec.failed.errorText || "");
      rec.canceled = !!params.canceled;
      rec.blockedReason = params.blockedReason ? String(params.blockedReason) : null;
      deps.wakeNetworkWaits(recorder, "failed", rec);
    } else if (method.indexOf("Network.webSocket") === 0) {
      recorder.counters.webSocket += 1;
      const requestId = String(params.requestId || params.identifier || makeWaitId(recorder.tabId, "websocket"));
      const rec = ensureNetworkEntry(recorder, requestId);
      rec.type = rec.type || "WebSocket";
      rec.resourceType = rec.resourceType || "WebSocket";
      if (method === "Network.webSocketCreated") { rec.request.url = String(params.url || rec.request.url || ""); rec.phase = "websocket"; }
      if (method === "Network.webSocketWillSendHandshakeRequest") rec.webSocketRequest = params.request || params;
      if (method === "Network.webSocketHandshakeResponseReceived") rec.webSocketResponse = params.response || params;
      if (recorder.config.includeWebSocketFrames && (method === "Network.webSocketFrameSent" || method === "Network.webSocketFrameReceived")) {
        const response = asRecord(params.response);
        const payload = response.payloadData ?? "";
        const trunc = truncateStringByBytes(String(payload), recorder.config.maxFrameBytes);
        appendBounded(rec.wsFrames, { t: Date.now(), method, opcode: Number(response.opcode || 0), mask: response.mask, payloadData: trunc.value, payloadTruncated: trunc.truncated, originalLength: trunc.originalLength }, recorder.config.maxFrames, rec);
      }
      if (method === "Network.webSocketClosed") rec.webSocketClosedAt = Date.now();
      if (method === "Network.webSocketFrameError") rec.webSocketError = params.errorMessage || params;
      deps.wakeNetworkWaits(recorder, "websocket", rec);
    } else if (method === "Network.eventSourceMessageReceived") {
      recorder.counters.sse += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.type = rec.type || "EventSource";
      rec.resourceType = rec.resourceType || "EventSource";
      if (recorder.config.includeSse) {
        const trunc = truncateStringByBytes(String(params.data || ""), recorder.config.maxFrameBytes);
        appendBounded(rec.sseEvents, { t: Date.now(), eventName: String(params.eventName || ""), eventId: String(params.eventId || ""), data: trunc.value, dataTruncated: trunc.truncated, originalLength: trunc.originalLength }, recorder.config.maxSseEvents, rec);
      }
      deps.wakeNetworkWaits(recorder, "sse", rec);
    } else if (method.indexOf("Page.") === 0) {
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
// ESM module metadata
export const __piBridgeModule_network_events = { name: "network_events", symbols: { asRecord, errorText, appendBounded, piNetworkMaybeCaptureBody, piNetworkHandleRecorderCdpEvent } };
