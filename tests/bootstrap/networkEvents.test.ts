import test from "node:test";
import assert from "node:assert/strict";
import type { NetworkRecord } from "../../src/bridge/extension/service_worker/types.ts";

Object.assign(globalThis, {
	chrome: { debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} } } },
	self: globalThis,
});

const { browserPilotNetworkHandleRecorderCdpEvent } = await import("../../src/bridge/extension/service_worker/network_events.ts");
const { browserPilotNetworkRecorders, createNetworkRecorder, networkRecorderKey, normalizeNetworkRecorderConfig } = await import("../../src/bridge/extension/service_worker/network_model.ts");
const { getNetworkRecorderBody, makeHarEntry, networkWaitMatches, waitNetworkRecorder } = await import("../../src/bridge/extension/service_worker/network.ts");

function activeRecorder(config: Record<string, unknown> = {}) {
	const recorder = createNetworkRecorder(7, normalizeNetworkRecorderConfig(config));
	recorder.active = true;
	return recorder;
}

test("network recorder events preserve the request-response-finish projection", () => {
	const recorder = activeRecorder({ maxPostDataBytes: 4, captureBodies: true });
	const wakes: string[] = [];
	const bodyCaptures: NetworkRecord[] = [];
	const deps = {
		wakeNetworkWaits: (_recorder: typeof recorder, eventType: string) => { wakes.push(eventType); },
		maybeCaptureNetworkBody: async (_recorder: typeof recorder, record: NetworkRecord) => { bodyCaptures.push(record); },
	};
	browserPilotNetworkHandleRecorderCdpEvent(recorder, {}, "Network.requestWillBeSent", { requestId: "req-1", type: "Fetch", request: { url: "https://example.test/api", method: "POST", headers: { accept: "application/json" }, postData: "abcdef" } }, deps);
	browserPilotNetworkHandleRecorderCdpEvent(recorder, {}, "Network.responseReceived", { requestId: "req-1", type: "Fetch", response: { status: 201, statusText: "Created", mimeType: "application/json", encodedDataLength: 9 } }, deps);
	browserPilotNetworkHandleRecorderCdpEvent(recorder, {}, "Network.dataReceived", { requestId: "req-1", dataLength: 8, encodedDataLength: 9 }, deps);
	browserPilotNetworkHandleRecorderCdpEvent(recorder, {}, "Network.loadingFinished", { requestId: "req-1", encodedDataLength: 12 }, deps);

	const record = recorder.byRequestId.get("req-1");
	assert.ok(record);
	assert.deepEqual(wakes, ["request", "response", "data", "finished"]);
	assert.deepEqual({ request: recorder.counters.request, response: recorder.counters.response, data: recorder.counters.data, finished: recorder.counters.finished }, { request: 1, response: 1, data: 1, finished: 1 });
	assert.equal(record.request.url, "https://example.test/api");
	assert.equal(record.request.postData, "abcd");
	assert.equal(record.request.postDataTruncated, true);
	assert.equal(record.response?.status, 201);
	assert.equal(record.data?.dataLength, 8);
	assert.equal(record.data?.encodedDataLength, 12);
	assert.equal(record.phase, "finished");
	assert.deepEqual(bodyCaptures, [record]);
});

test("network recorder events keep websocket, SSE, page, and failure streams bounded", () => {
	const recorder = activeRecorder({ maxFrames: 1, maxSseEvents: 1, maxFrameBytes: 4 });
	const wakes: string[] = [];
	const deps = {
		wakeNetworkWaits: (_recorder: typeof recorder, eventType: string) => { wakes.push(eventType); },
		maybeCaptureNetworkBody: async () => {},
	};
	browserPilotNetworkHandleRecorderCdpEvent(recorder, {}, "Network.webSocketCreated", { requestId: "ws-1", url: "wss://example.test/socket" }, deps);
	browserPilotNetworkHandleRecorderCdpEvent(recorder, {}, "Network.webSocketFrameReceived", { requestId: "ws-1", response: { opcode: 1, payloadData: "first" } }, deps);
	browserPilotNetworkHandleRecorderCdpEvent(recorder, {}, "Network.webSocketFrameReceived", { requestId: "ws-1", response: { opcode: 1, payloadData: "second" } }, deps);
	browserPilotNetworkHandleRecorderCdpEvent(recorder, {}, "Network.eventSourceMessageReceived", { requestId: "sse-1", eventName: "first", data: "12345" }, deps);
	browserPilotNetworkHandleRecorderCdpEvent(recorder, {}, "Network.eventSourceMessageReceived", { requestId: "sse-1", eventName: "second", data: "67890" }, deps);
	browserPilotNetworkHandleRecorderCdpEvent(recorder, {}, "Network.loadingFailed", { requestId: "req-fail", errorText: "blocked", canceled: true, blockedReason: "inspector" }, deps);
	browserPilotNetworkHandleRecorderCdpEvent(recorder, {}, "Page.lifecycleEvent", { frameId: "frame-1", name: "load", loaderId: "loader-1" }, deps);

	const ws = recorder.byRequestId.get("ws-1");
	const sse = recorder.byRequestId.get("sse-1");
	const failed = recorder.byRequestId.get("req-fail");
	assert.equal(ws?.request.url, "wss://example.test/socket");
	assert.deepEqual(ws?.wsFrames.map((frame) => frame.payloadData), ["seco"]);
	assert.deepEqual(sse?.sseEvents.map((event) => [event.eventName, event.data]), [["second", "6789"]]);
	assert.equal(failed?.phase, "failed");
	assert.equal(failed?.canceled, true);
	assert.deepEqual((recorder.lifecycleEvents as Array<{ name?: unknown }>).map((event) => event.name), ["load"]);
	assert.deepEqual(wakes.slice(-3), ["sse", "failed", "page"]);
});

test("network recorder event failures stay contained in recorder diagnostics", () => {
	const recorder = activeRecorder();
	assert.doesNotThrow(() => browserPilotNetworkHandleRecorderCdpEvent(recorder, {}, "Network.requestServedFromCache", { requestId: "req-error" }, {
		wakeNetworkWaits: () => { throw new Error("wake failed"); },
		maybeCaptureNetworkBody: async () => {},
	}));
	const lastError = recorder.lastErrors.at(-1) as Record<string, unknown>;
	assert.equal(lastError.where, "Network.requestServedFromCache");
	assert.match(String(lastError.error), /wake failed/);
});

test("HAR projection preserves request, response, body, and recorder metadata", () => {
	const record: NetworkRecord = {
		id: "entry-1",
		requestId: "request-1",
		tabId: 7,
		sessionId: "session-1",
		seq: 3,
		createdAt: 1_000,
		updatedAt: 1_150,
		finishedAt: 1_250,
		wallTime: 1_700_000_000,
		type: "Fetch",
		request: { method: "POST", url: "https://example.test/api?q=1", headers: { "content-type": "application/json", authorization: "secret" }, postData: "{\"ok\":true}", postDataTruncated: true },
		response: { status: 201, statusText: "Created", protocol: "h2", headers: { "content-type": "application/json", location: "/next" }, mimeType: "application/json", remoteIPAddress: "127.0.0.1", connectionId: 12 },
		redirects: [{ status: 302 }],
		data: { dataLength: 14, encodedDataLength: 20 },
		timing: {},
		fromCache: false,
		initiator: { type: "script" },
		wsFrames: [{ payloadData: "frame" }],
		sseEvents: [{ data: "event" }],
		bodyRef: "body-1",
		bodyAvailability: "captured",
		bodyError: null,
	};
	const entry = makeHarEntry(record, {
		bodyRef: "body-1",
		requestId: "request-1",
		tabId: 7,
		sessionId: "session-1",
		base64Encoded: true,
		body: "eyJvayI6dHJ1ZX0=",
		bodyTruncated: true,
		originalLength: 11,
		bytes: 11,
		mimeType: "application/json",
		createdAt: 1_200,
	});

	assert.equal(entry.startedDateTime, "2023-11-14T22:13:20.000Z");
	assert.equal(entry.time, 250);
	assert.deepEqual(entry.request, {
		method: "POST",
		url: "https://example.test/api?q=1",
		httpVersion: "h2",
		headers: [{ name: "content-type", value: "application/json" }, { name: "authorization", value: "secret" }],
		queryString: [], cookies: [], headersSize: -1, bodySize: 11,
		postData: { mimeType: "application/json", text: "{\"ok\":true}", _truncated: true },
	});
	assert.deepEqual(entry.response.content, {
		size: 14,
		mimeType: "application/json",
		compression: 0,
		text: "eyJvayI6dHJ1ZX0=",
		encoding: "base64",
		_bodyRef: "body-1",
		_bodyTruncated: true,
		_bodyAvailability: "captured",
		_bodyUnavailableReason: null,
	});
	assert.deepEqual({ status: entry.response.status, redirectURL: entry.response.redirectURL, bodySize: entry.response.bodySize, serverIPAddress: entry.serverIPAddress, connection: entry.connection }, { status: 201, redirectURL: "/next", bodySize: 20, serverIPAddress: "127.0.0.1", connection: "12" });
	assert.deepEqual({ requestId: entry._requestId, seq: entry._seq, type: entry._type, redirects: entry._redirects, wsFrames: entry._wsFrames, sseEvents: entry._sseEvents, bodyRef: entry._bodyRef }, { requestId: "request-1", seq: 3, type: "Fetch", redirects: [{ status: 302 }], wsFrames: [{ payloadData: "frame" }], sseEvents: [{ data: "event" }], bodyRef: "body-1" });
});

test("HAR projection keeps stable defaults when response and body data are absent", () => {
	const record: NetworkRecord = {
		id: "entry-empty",
		requestId: "request-empty",
		tabId: 7,
		sessionId: "session-1",
		seq: 4,
		createdAt: 2_000,
		updatedAt: 1_500,
		request: { headers: {} },
		response: null,
		redirects: [],
		data: {},
		timing: {},
		fromCache: false,
		wsFrames: [],
		sseEvents: [],
	};
	const entry = makeHarEntry(record, null);
	assert.equal(entry.time, 0);
	assert.deepEqual({ method: entry.request.method, url: entry.request.url, bodySize: entry.request.bodySize }, { method: "GET", url: "", bodySize: 0 });
	assert.deepEqual({ status: entry.response.status, statusText: entry.response.statusText, bodySize: entry.response.bodySize }, { status: 0, statusText: "", bodySize: -1 });
	assert.deepEqual(entry.response.content, { size: -1, mimeType: "", compression: 0, _bodyAvailability: "not_requested", _bodyUnavailableReason: null });
	assert.equal(entry._bodyAvailability, "not_requested");
	assert.equal(entry._bodyRef, null);
});

test("network wait matching preserves filters, body, frame, idle, count, and event aliases", () => {
	const recorder = activeRecorder();
	const record: NetworkRecord = {
		id: "entry-wait",
		requestId: "request-wait",
		tabId: 7,
		sessionId: "session-1",
		seq: 5,
		createdAt: 1_000,
		updatedAt: 1_100,
		type: "Fetch",
		request: { method: "GET", url: "https://example.test/events", headers: {} },
		response: { status: 200, mimeType: "text/event-stream" },
		redirects: [],
		data: {},
		timing: {},
		fromCache: false,
		wsFrames: [{ method: "received", opcode: 1, payloadData: "hello socket" }],
		sseEvents: [{ eventName: "update", eventId: "7", data: "hello stream" }],
		bodyRef: "body-wait",
	};
	recorder.entries.push(record);
	recorder.bodyStore.set("body-wait", { bodyRef: "body-wait", requestId: "request-wait", tabId: 7, sessionId: "session-1", base64Encoded: false, body: "hello body", bodyTruncated: false, originalLength: 10, bytes: 10, mimeType: "text/plain", createdAt: 1_100 });

	const matches = (condition: string, criteria: Record<string, unknown>, eventType: string, candidate: NetworkRecord | null = record) => networkWaitMatches(recorder, { condition, criteria, idleMs: 500, count: 1 }, eventType, candidate);
	assert.equal(matches("request", { urlContains: "/events", method: "GET" }, "request"), true);
	assert.equal(matches("request", { status: 404 }, "request"), false);
	assert.equal(matches("body", { bodyContains: "hello body" }, "body"), true);
	assert.equal(matches("body", { bodyContains: "missing" }, "body"), false);
	assert.equal(matches("websocket", { wsFrame: { opcode: 1, payloadContains: "socket" } }, "websocket"), true);
	assert.equal(matches("sse", { sseEvent: { eventName: "update", dataContains: "stream" } }, "sse"), true);
	assert.equal(matches("any", {}, "failed"), true);
	assert.equal(matches("response", {}, "request"), false);
	recorder.lastEventAt = Date.now() - 1_000;
	assert.equal(matches("idle", {}, "tick", null), true);
	assert.equal(matches("count", { url: "example.test/events" }, "tick", null), true);
});

test("network waits resolve immediate phase, websocket, count, and idle matches", async () => {
	const recorder = activeRecorder();
	const record: NetworkRecord = {
		id: "entry-immediate",
		requestId: "request-immediate",
		tabId: 7,
		sessionId: "default",
		seq: 6,
		createdAt: 1_000,
		updatedAt: 1_100,
		type: "Fetch",
		phase: "finished",
		request: { method: "GET", url: "https://example.test/immediate", headers: {} },
		response: { status: 200 },
		redirects: [],
		data: {},
		timing: {},
		fromCache: false,
		wsFrames: [{ payloadData: "socket" }],
		sseEvents: [],
	};
	recorder.entries.push(record);
	recorder.byRequestId.set(record.requestId, record);
	recorder.lastEventAt = Date.now() - 1_000;
	browserPilotNetworkRecorders.set(networkRecorderKey(7, "default"), recorder);
	try {
		const response = await waitNetworkRecorder(7, { cmd: "network.wait", condition: "response", timeoutMs: 0 });
		const websocket = await waitNetworkRecorder(7, { cmd: "network.wait", condition: "websocket", timeoutMs: 0 });
		const count = await waitNetworkRecorder(7, { cmd: "network.wait", condition: "count", count: 1, timeoutMs: 0 });
		const idle = await waitNetworkRecorder(7, { cmd: "network.wait", condition: "idle", idleMs: 500, timeoutMs: 0 });
		const data = [response, websocket, count, idle].map((result) => result.data as Record<string, unknown>);
		assert.deepEqual([response.ok, websocket.ok, count.ok, idle.ok], [true, true, true, true]);
		assert.deepEqual(data.map((item) => item.event), ["response", "websocket", "count", "idle"]);
		assert.equal(data[0].immediate, true);
	} finally {
		browserPilotNetworkRecorders.clear();
	}
});

test("network body lookup shares request resolution and preserves truncation diagnostics", async () => {
	const recorder = activeRecorder();
	const record: NetworkRecord = {
		id: "entry-body",
		requestId: "request-body",
		tabId: 7,
		sessionId: "default",
		seq: 7,
		createdAt: 1_000,
		updatedAt: 1_100,
		request: { method: "GET", url: "https://example.test/body", headers: {} },
		redirects: [],
		data: {},
		timing: {},
		fromCache: false,
		wsFrames: [],
		sseEvents: [],
		bodyRef: "body-stored",
		bodyAvailability: "captured",
	};
	recorder.entries.push(record);
	recorder.byRequestId.set(record.requestId, record);
	recorder.bodyByRequestId.set(record.requestId, "body-stored");
	recorder.bodyStore.set("body-stored", { bodyRef: "body-stored", requestId: "request-body", tabId: 7, sessionId: "default", base64Encoded: false, body: "hello world", bodyTruncated: false, originalLength: 11, bytes: 11, mimeType: "text/plain", createdAt: 1_100 });
	browserPilotNetworkRecorders.set(networkRecorderKey(7, "default"), recorder);
	try {
		const found = await getNetworkRecorderBody(7, { cmd: "network.body", request_id: "request-body", max_bytes: 5 });
		assert.equal(found.ok, true);
		assert.deepEqual(found.data, { bodyRef: "body-stored", requestId: "request-body", tabId: 7, sessionId: "default", base64Encoded: false, body: "hello", bodyTruncated: true, originalLength: 11, bytes: 5, mimeType: "text/plain", createdAt: 1_100 });

		recorder.bodyStore.clear();
		const evicted = await getNetworkRecorderBody(7, { cmd: "network.body", requestId: "request-body" });
		assert.equal(evicted.ok, false);
		assert.equal(evicted.details?.bodyAvailability, "expired");
		assert.equal(evicted.details?.bodyUnavailableReason, "body_ref_missing");
	} finally {
		browserPilotNetworkRecorders.clear();
	}
});
