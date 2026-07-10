import assert from "node:assert/strict";
import test from "node:test";
import type { JsonRecord, NetworkRecord, NetworkRecorderConfig } from "../../src/bridge/extension/service_worker/types.ts";

Object.assign(globalThis, {
	chrome: { debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} } } },
	self: globalThis,
});

const model = await import("../../src/bridge/extension/service_worker/network_model.ts");

function recorder(config: JsonRecord = {}) {
	return model.createNetworkRecorder(7, model.normalizeNetworkRecorderConfig(config));
}

function populatedRecord(config: JsonRecord = {}) {
	const owner = recorder(config);
	const record = model.ensureNetworkEntry(owner, "request-1");
	record.type = "Fetch";
	record.resourceType = "Fetch";
	record.phase = "finished";
	record.request = { method: "POST", url: "https://api.example.test/users?q=1", headers: { accept: "application/json" }, postData: "payload", hasPostData: true };
	record.response = { status: 201, statusText: "Created", mimeType: "application/json", protocol: "h2", headers: { "content-type": "application/json" }, fromServiceWorker: true };
	record.data = { dataLength: 7, encodedDataLength: 9 };
	record.wsFrames = [{ method: "received", opcode: 1, payloadData: "socket payload" }];
	record.sseEvents = [{ eventName: "update", eventId: "7", data: "stream payload" }];
	return { owner, record };
}

test("network model normalizes recorder config and preserves every recorder filter decision", () => {
	const config = model.normalizeNetworkRecorderConfig({
		session_id: "session-1",
		maxEntries: null,
		max_entries: 50_000,
		max_age_ms: -1,
		max_body_bytes: 42,
		max_post_data_bytes: 99,
		max_websocket_frames: 7,
		max_websocket_frame_bytes: 8,
		max_sse_events: 9,
		body_timeout_ms: 50,
		capture_bodies: false,
		capture_request_post_data: false,
		include_websocket_frames: false,
		include_sse: false,
		body_mime_allow: "json,text",
		includeUrls: "ignored-non-array-alias",
		include_urls: ["api.example.test"],
		exclude_urls: ["logout"],
		resource_types: ["Fetch"],
		methods: ["POST"],
		statuses: [201],
		clear: false,
		storeHeaders: false,
	});
	assert.deepEqual({
		sessionId: config.sessionId,
		limits: [config.maxEntries, config.maxAgeMs, config.maxBodyBytes, config.maxPostDataBytes, config.maxFrames, config.maxFrameBytes, config.maxSseEvents, config.bodyTimeoutMs],
		capture: [config.captureBodies, config.captureRequestPostData, config.includeWebSocketFrames, config.includeSse],
		lists: [config.bodyMimeAllow, config.includeUrls, config.excludeUrls, config.resourceTypes, config.methods, config.statuses],
		storage: [config.clearOnStart, config.storeHeaders, config.storePostData],
	}, {
		sessionId: "session-1",
		limits: [20_000, 0, 42, 99, 7, 8, 9, 100],
		capture: [false, false, false, false],
		lists: [["json", "text"], ["api.example.test"], ["logout"], ["Fetch"], ["POST"], [201]],
		storage: [false, false, false],
	});

	const { record } = populatedRecord();
	const decision = (overrides: Partial<NetworkRecorderConfig>, phase = "response") => model.makeNetworkRecorderFilter({ ...config, includeUrls: [], excludeUrls: [], resourceTypes: [], methods: [], statuses: [], ...overrides } as NetworkRecorderConfig)(record, phase);
	assert.deepEqual(decision({ includeUrls: ["missing"] }), { match: false, reason: "include_url" });
	assert.deepEqual(decision({ excludeUrls: ["api.example.test"] }), { match: false, reason: "exclude_url" });
	assert.deepEqual(decision({ resourceTypes: ["Document"] }), { match: false, reason: "resource_type" });
	assert.deepEqual(decision({ methods: ["GET"] }), { match: false, reason: "method" });
	assert.deepEqual(decision({ statuses: [404] }), { match: false, reason: "status" });
	assert.deepEqual(decision({ resourceTypes: ["all"], statuses: [404] }, "request"), { match: false, reason: "status" });
	const noStatus = { ...record, response: null, status: undefined } as NetworkRecord;
	assert.deepEqual(model.makeNetworkRecorderFilter({ ...config, includeUrls: [], excludeUrls: [], resourceTypes: ["*"], methods: [], statuses: [404] } as NetworkRecorderConfig)(noStatus, "request"), { match: true, reason: "matched" });
	assert.deepEqual(decision({ includeUrls: ["api.example.test"], excludeUrls: ["logout"], resourceTypes: ["Fetch"], methods: ["POST"], statuses: [201] }), { match: true, reason: "matched" });
});

test("network model classifies MIME/body errors and stores bounded text and base64 bodies", () => {
	const { owner, record } = populatedRecord({ maxBodyBytes: 4 });
	assert.deepEqual(model.networkBodyMimeDecision({ ...owner.config, bodyMimeAllow: ["all"] }, record), { match: true, reason: "all" });
	assert.deepEqual(model.networkBodyMimeDecision({ ...owner.config, bodyMimeAllow: ["json"] }, record), { match: true, reason: "mime_allowed", mimeType: "application/json" });
	assert.deepEqual(model.networkBodyMimeDecision({ ...owner.config, bodyMimeAllow: ["text"] }, { ...record, response: null }), { match: false, availability: "not_requested", reason: "mime_missing", mimeType: "" });
	assert.deepEqual(model.networkBodyMimeDecision({ ...owner.config, bodyMimeAllow: ["json"] }, { ...record, response: { mimeType: "application/pdf" } }), { match: false, availability: "binary", reason: "binary_mime", mimeType: "application/pdf" });
	assert.deepEqual(model.networkBodyMimeDecision({ ...owner.config, bodyMimeAllow: ["json"] }, { ...record, response: { mimeType: "application/yaml" } }), { match: false, availability: "not_requested", reason: "mime_not_allowed", mimeType: "application/yaml" });
	assert.deepEqual(model.classifyNetworkBodyError(new Error("No resource with given identifier")), { availability: "expired", reason: "cdp_body_expired" });
	assert.deepEqual(model.classifyNetworkBodyError(new Error("request timed out")), { availability: "cdp_failed", reason: "cdp_timeout" });
	assert.deepEqual(model.classifyNetworkBodyError(new Error("debugger detached")), { availability: "cdp_failed", reason: "cdp_get_response_body_failed" });

	const notifications: string[] = [];
	model.setNetworkWaitNotifier((_recorder: ReturnType<typeof recorder>, eventType: string) => notifications.push(eventType));
	model.storeNetworkBody(owner, record, { body: "abcdef", base64Encoded: false });
	assert.equal(record.bodyPreview, "abcd");
	assert.equal(record.bodyTruncated, true);
	assert.equal(record.bodyAvailability, "too_large");
	assert.equal(owner.bodyStore.get(record.bodyRef!)?.body, "abcd");
	assert.equal(owner.bodyOverflowCount, 1);
	const base64 = model.ensureNetworkEntry(owner, "request-base64");
	base64.request.url = "https://api.example.test/binary";
	base64.response = { status: 200, mimeType: "application/octet-stream" };
	model.storeNetworkBody(owner, base64, { body: btoa("abcdef"), base64Encoded: true });
	assert.equal(owner.bodyStore.get(base64.bodyRef!)?.body, btoa("abcd"));
	assert.equal(base64.bodyPreview, null);
	assert.deepEqual(notifications, ["body", "body"]);
	model.setNetworkWaitNotifier(null);
});

test("network model list, frame, summary, pruning, and diagnostics helpers stay bounded", () => {
	const { owner, record } = populatedRecord({ maxEntries: 1, maxAgeMs: 0 });
	const matching = { sinceSeq: Number(record.seq) - 1, requestId: record.requestId, urlContains: "/users", urlPattern: "api\\.example\\.test", method: "post", type: "fetch", mime: "json", status: 201, includeUrls: ["api.example.test"], excludeUrls: ["logout"] };
	assert.equal(model.networkRecordMatchesList(record, matching), true);
	for (const [key, value] of Object.entries({ sinceSeq: record.seq, requestId: "other", urlContains: "missing", urlPattern: "missing", method: "GET", type: "Document", mime: "text/html", status: 404, includeUrls: ["missing"], excludeUrls: ["api.example.test"] })) {
		assert.equal(model.networkRecordMatchesList(record, { ...matching, [key]: value }), false, key);
	}
	assert.equal(model.networkWsFrameMatches(record.wsFrames[0], { method: "received", opcode: 1, payloadContains: "socket" }), true);
	assert.equal(model.networkWsFrameMatches(record.wsFrames[0], { opcode: 2 }), false);
	assert.equal(model.networkSseEventMatches(record.sseEvents[0], { eventName: "update", eventId: "7", dataContains: "stream" }), true);
	assert.equal(model.networkSseEventMatches(record.sseEvents[0], { event_name: "missing" }), false);

	const summary = model.networkRecordSummary(record);
	assert.deepEqual({ status: summary.status, type: summary.type, postDataBytes: summary.postDataBytes, redirects: summary.redirects, wsFrameCount: summary.wsFrameCount, sseEventCount: summary.sseEventCount }, { status: 201, type: "Fetch", postDataBytes: 7, redirects: 0, wsFrameCount: 1, sseEventCount: 1 });
	assert.equal(model.networkRecordSummary(record, { includeDetails: true, includeBody: false }).body, undefined);
	model.rememberNetworkError(owner, "fixture", new Error("secret failure"));
	assert.equal((owner.lastErrors.at(-1) as JsonRecord | undefined)?.where, "fixture");
	assert.equal(model.networkRecorderSummary(owner)?.entries, 1);

	model.storeNetworkBody(owner, record, { body: "body", base64Encoded: false });
	const second = model.ensureNetworkEntry(owner, "request-2");
	assert.equal(owner.entries.length, 1);
	assert.equal(owner.entries[0], second);
	assert.equal(owner.byRequestId.has(record.requestId), false);
	assert.equal(owner.bodyStore.has(String(record.bodyRef)), false);
	assert.equal(owner.overflowCount, 1);
});
