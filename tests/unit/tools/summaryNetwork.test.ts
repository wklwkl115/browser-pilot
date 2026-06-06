import test from "node:test";
import assert from "node:assert/strict";
import { summarizeNetworkData } from "../../../src/tools/summaries/network.ts";

test("summarizeNetworkData returns type for non-record input", () => {
	const result = summarizeNetworkData(null);
	assert.ok("type" in result);
});

test("summarizeNetworkData computes statusCounts from entries", () => {
	const data = {
		entries: [
			{ method: "GET", status: 200, url: "https://api.example.com/data", type: "xhr" },
			{ method: "POST", status: 404, url: "https://api.example.com/missing", type: "fetch" },
			{ method: "GET", status: 200, url: "https://api.example.com/more", type: "xhr" },
		],
	};
	const result = summarizeNetworkData(data);
	const statusCounts = result.statusCounts as Array<{ key: string; count: number }>;
	const ok = statusCounts.find((item) => item.key === "200");
	assert.ok(ok);
	assert.equal(ok!.count, 2);
});

test("summarizeNetworkData computes methodCounts", () => {
	const data = {
		entries: [
			{ method: "GET", status: 200 },
			{ method: "GET", status: 304 },
			{ method: "POST", status: 201 },
		],
	};
	const result = summarizeNetworkData(data);
	const methodCounts = result.methodCounts as Array<{ key: string; count: number }>;
	const getCount = methodCounts.find((item) => item.key === "GET");
	assert.ok(getCount);
	assert.equal(getCount!.count, 2);
});

test("summarizeNetworkData identifies failed requests", () => {
	const data = {
		entries: [
			{ method: "GET", status: 200 },
			{ method: "GET", status: 500, errorText: "net::ERR_FAILED" },
		],
	};
	const result = summarizeNetworkData(data);
	const failed = result.failed as { count: number };
	assert.ok(failed.count >= 1);
});

test("summarizeNetworkData handles data with requests array", () => {
	const data = { requests: [{ method: "GET", status: 200 }] };
	const result = summarizeNetworkData(data);
	assert.ok(typeof result.entryCount === "number");
	assert.ok((result.entryCount as number) >= 1);
});

test("summarizeNetworkData handles HAR-style log.entries", () => {
	const data = {
		log: { entries: [{ request: { method: "GET", url: "https://api.example.com" }, response: { status: 200 } }] },
	};
	const result = summarizeNetworkData(data);
	assert.ok((result.entryCount as number) >= 1);
});

test("summarizeNetworkData passes tabId, active, sessionId through", () => {
	const data = { tabId: 7, active: true, sessionId: "sess-1", entries: [] };
	const result = summarizeNetworkData(data);
	assert.equal(result.tabId, 7);
	assert.equal(result.active, true);
	assert.equal(result.sessionId, "sess-1");
});
