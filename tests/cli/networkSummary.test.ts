import assert from "node:assert/strict";
import test from "node:test";
import { summarizeNetworkData } from "../../src/commands/summaries/network.ts";

type Summary = Record<string, unknown>;

function preferredReads(summary: Summary): Array<Record<string, unknown>> {
	const hints = summary.artifact_hints as Record<string, unknown> | undefined;
	return (hints?.preferredReads as Array<Record<string, unknown>> | undefined) ?? [];
}

test("network summary characterizes nested entries, failures, counts, and artifact reads", () => {
	const summary = summarizeNetworkData({
		tabId: 7,
		sessionId: "session-1",
		active: true,
		total: 10,
		entries: [
			{ requestId: "r1", request: { url: "https://api.example.test/a?token=secret", method: "GET" }, response: { status: 200 }, _type: "Fetch", _bodyRef: "body-1", _bodyAvailability: "captured" },
			{ _requestId: "r2", request: { url: "https://cdn.example.test/b", method: "POST" }, response: { status: 503 }, type: "XHR", _error: "boom" },
			"malformed",
			{ id: "r3", url: "not a url", method: "PUT", status: "bad", failed: true },
		],
		condition: "idle",
		event: "network.response",
		wait_id: "wait-1",
		recorder: { tabId: 7, sessionId: "session-1", recorderId: "recorder-1", active: true, entries: 10, bodyCount: 1, activeWaitCount: 0 },
	});

	assert.deepEqual({ tabId: summary.tabId, sessionId: summary.sessionId, active: summary.active, total: summary.total, entryCount: summary.entryCount }, { tabId: 7, sessionId: "session-1", active: true, total: 10, entryCount: 4 });
	assert.deepEqual(summary.statusCounts, [{ key: "200", count: 1 }, { key: "503", count: 1 }, { key: "bad", count: 1 }]);
	assert.deepEqual(summary.methodCounts, [{ key: "GET", count: 1 }, { key: "POST", count: 1 }, { key: "PUT", count: 1 }]);
	assert.deepEqual(summary.typeCounts, [{ key: "Fetch", count: 1 }, { key: "XHR", count: 1 }, { key: "unknown", count: 1 }]);
	assert.deepEqual(summary.hostCounts, [{ key: "api.example.test", count: 1 }, { key: "cdn.example.test", count: 1 }, { key: "unknown", count: 1 }]);
	assert.equal((summary.samples as Summary).count, 3);
	assert.equal((summary.failed as Summary).count, 2);
	assert.deepEqual({ condition: summary.condition, event: summary.event, waitId: summary.waitId }, { condition: "idle", event: "network.response", waitId: "wait-1" });
	assert.deepEqual(summary.recorder, { tabId: 7, sessionId: "session-1", recorderId: "recorder-1", active: true, entries: 10, bodyCount: 1, activeWaitCount: 0 });
	assert.deepEqual(preferredReads(summary), [
		{ label: "all network entries", jsonPath: "data.entries", kind: "network-entry", count: 4 },
		{ label: "request r1", jsonPath: "data.entries[0].request", kind: "http-request", count: 1 },
		{ label: "request r2", jsonPath: "data.entries[1].request", kind: "http-request", count: 1 },
		{ label: "request r3", jsonPath: "data.entries[3]", kind: "http-request", count: 1 },
	]);
});

test("network summary characterizes collection precedence and single-request shapes", () => {
	const collectionCases: Array<{ data: Summary; path: string }> = [
		{ data: { items: [{ url: "https://items.test", method: "GET" }], entries: [{ url: "https://ignored.test" }] }, path: "data.items" },
		{ data: { entries: [{ url: "https://entries.test", method: "GET" }] }, path: "data.entries" },
		{ data: { requests: [{ url: "https://requests.test", method: "GET" }] }, path: "data.requests" },
		{ data: { log: { entries: [{ request: { url: "https://har.test", method: "GET" } }] } }, path: "data.log.entries" },
	];
	for (const { data, path } of collectionCases) {
		const summary = summarizeNetworkData(data);
		assert.equal(summary.entryCount, 1);
		assert.equal(preferredReads(summary)[0]?.jsonPath, path);
	}

	const requestOnly = summarizeNetworkData({ request: { url: "https://single.test/a", method: "PATCH" } });
	assert.equal(requestOnly.entryCount, 1);
	assert.deepEqual(requestOnly.hostCounts, [{ key: "single.test", count: 1 }]);
	assert.equal(requestOnly.artifact_hints, undefined);

	const wrapped = summarizeNetworkData({ _requestId: "wrapped-1", type: "Fetch", request: { url: "https://wrapped.test/a", method: "GET" }, response: { status: 204 } });
	assert.equal(wrapped.entryCount, 1);
	assert.deepEqual(wrapped.statusCounts, [{ key: "204", count: 1 }]);
	assert.equal((wrapped.samples as Summary).count, 1);

	const diagnosticsOnly = summarizeNetworkData({ entries: 3, diagnostics: { tabId: 9, sessionId: "session-9", active: false, entries: 3, bodyCount: 0 } });
	assert.deepEqual({ tabId: diagnosticsOnly.tabId, sessionId: diagnosticsOnly.sessionId, active: diagnosticsOnly.active, total: diagnosticsOnly.total, entryCount: diagnosticsOnly.entryCount }, { tabId: 9, sessionId: "session-9", active: false, total: 3, entryCount: 3 });
	assert.deepEqual(diagnosticsOnly.recorder, { tabId: 9, sessionId: "session-9", recorderId: undefined, active: false, entries: 3, bodyCount: 0, activeWaitCount: undefined });
});

test("network summary characterizes body metadata and malformed top-level values", () => {
	const body = summarizeNetworkData({ bodyRef: "body-1", bytes: 128, bodyTruncated: true, _bodyAvailability: "captured", _bodyUnavailableReason: "partial", url: "https://api.example.test/a", status: 206, mimeType: "application/json" });
	assert.deepEqual({ bodyRef: body.bodyRef, bodyBytes: body.bodyBytes, bodyTruncated: body.bodyTruncated, bodyAvailability: body.bodyAvailability, bodyUnavailableReason: body.bodyUnavailableReason, url: body.url, status: body.status, mimeType: body.mimeType }, {
		bodyRef: "body-1",
		bodyBytes: 128,
		bodyTruncated: true,
		bodyAvailability: "captured",
		bodyUnavailableReason: "partial",
		url: "https://api.example.test/a",
		status: 206,
		mimeType: "application/json",
	});
	assert.deepEqual(summarizeNetworkData(null), { type: "object" });
	assert.deepEqual(summarizeNetworkData("invalid"), { type: "string" });
});
