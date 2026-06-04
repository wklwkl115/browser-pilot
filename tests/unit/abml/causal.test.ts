import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCausalSummary, buildCausalRequest, causalUnavailable, MAX_CAUSAL_REQUESTS } from "../../../src/abml-core/causal.ts";

function hasRequests(c: ReturnType<typeof buildCausalSummary>): c is { sinceSeq: number; requests: ReturnType<typeof buildCausalRequest>[]; requestCount?: number } {
	return "requests" in c;
}

test("causal: keeps only records after the baseline seq, sorted by seq, mapped to refs", () => {
	const records = [
		{ seq: 7, requestId: "b", request: { url: "https://x/api/b", method: "POST" }, response: { status: 201 }, type: "Fetch", updatedAt: 200 },
		{ seq: 5, requestId: "a", request: { url: "https://x/api/a", method: "GET" }, response: { status: 200 }, type: "XHR", updatedAt: 100 },
		{ seq: 3, requestId: "old", request: { url: "https://x/old", method: "GET" } },
	];
	const c = buildCausalSummary(records, 4);
	assert.ok(hasRequests(c));
	assert.equal(c.sinceSeq, 4);
	assert.deepEqual(c.requests.map((r) => r.ref), ["pi-ref://network/a", "pi-ref://network/b"], "seq>4, sorted ascending");
	assert.equal(c.requests[0].method, "GET");
	assert.equal(c.requests[0].type, "XHR");
	assert.equal(c.requests[1].status, 201);
});

test("causal: redacts a sensitive URL query value", () => {
	const r = buildCausalRequest({ requestId: "t", request: { url: "https://x/api?token=SECRET123&q=1", method: "GET" } });
	assert.ok(r.url, "url present");
	assert.ok(!r.url!.includes("SECRET123"), "sensitive query value scrubbed");
});

test("causal: caps at MAX_CAUSAL_REQUESTS and reports the true count", () => {
	const records = Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, requestId: `r${i}`, request: { url: `https://x/${i}`, method: "GET" } }));
	const c = buildCausalSummary(records, 0);
	assert.ok(hasRequests(c));
	assert.equal(c.requests.length, MAX_CAUSAL_REQUESTS);
	assert.equal(c.requestCount, 20);
});

test("causal: empty delta → empty requests, no requestCount", () => {
	const c = buildCausalSummary([], 10);
	assert.ok(hasRequests(c));
	assert.equal(c.requests.length, 0);
	assert.ok(!("requestCount" in c));
});

test("causal: defensive seq filter (records at/below sinceSeq dropped even if passed in)", () => {
	const c = buildCausalSummary([{ seq: 2, requestId: "x", request: { url: "https://x/2" } }], 2);
	assert.ok(hasRequests(c) && c.requests.length === 0);
});

test("causal: unavailable block when no recorder is active", () => {
	const c = causalUnavailable("network recorder not active — start via browser_network start");
	assert.ok(!("requests" in c));
	assert.ok("unavailable" in c && c.unavailable.includes("not active"));
});
