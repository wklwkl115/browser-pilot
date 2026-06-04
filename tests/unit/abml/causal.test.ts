import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCausalSummary, buildCausalRequest, causalUnavailable, MAX_CAUSAL_REQUESTS, buildTriggeredRelations, resolveActionEntityRef, MAX_TRIGGERED_RELATIONS } from "../../../src/abml-core/causal.ts";

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

// ── R3.x P1 — attribution ────────────────────────────────────────────────────

const control = (ref: string) => ({ ref, kind: "control" as const, role: "button", state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true }, source: "dom" as const });

test("causal P1: buildTriggeredRelations maps the delta to triggered edges (timing/low, capped)", () => {
	const causal = buildCausalSummary([
		{ seq: 6, requestId: "a", request: { url: "https://x/a", method: "POST" }, response: { status: 200 } },
		{ seq: 7, requestId: "b", request: { url: "https://x/b", method: "GET" } },
	], 5);
	const relations = buildTriggeredRelations(causal);
	assert.equal(relations.length, 2);
	assert.deepEqual(relations.map((r) => r.type), ["triggered", "triggered"]);
	assert.deepEqual(relations.map((r) => r.targetRef), ["pi-ref://network/a", "pi-ref://network/b"]);
	assert.equal(relations[0].source, "timing");
	assert.equal(relations[0].confidence, "low");
	assert.equal(relations[0].evidence?.method, "POST");
	assert.equal(relations[0].evidence?.since, 5);
});

test("causal P1: buildTriggeredRelations caps at MAX_TRIGGERED_RELATIONS and is empty for unavailable", () => {
	const many = buildCausalSummary(Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, requestId: `r${i}`, request: { url: `https://x/${i}` } })), 0);
	assert.equal(buildTriggeredRelations(many).length, MAX_TRIGGERED_RELATIONS);
	assert.deepEqual(buildTriggeredRelations(causalUnavailable("off")), []);
});

test("causal P1: resolveActionEntityRef prefers explicit actionRef, falls back to focusedRef", () => {
	const entities = [control("pi-ref://control/a"), control("pi-ref://control/b")];
	assert.equal(resolveActionEntityRef("pi-ref://control/a", "pi-ref://control/b", entities), "pi-ref://control/a", "explicit actionRef wins");
	assert.equal(resolveActionEntityRef(undefined, "pi-ref://control/b", entities), "pi-ref://control/b", "falls back to focusedRef");
	assert.equal(resolveActionEntityRef(undefined, undefined, entities), undefined, "no signal → no attribution");
	assert.equal(resolveActionEntityRef("pi-ref://control/missing", undefined, entities), undefined, "unknown ref → no attribution");
});

test("causal P1: focus robustness — a focusedRef landing on a frame/region is rejected", () => {
	const frame = { ref: "pi-ref://frame/1", kind: "frame" as const, role: "iframe", state: { visible: true, occluded: false, disabled: false, focused: true, editable: false, inViewport: true }, source: "dom" as const };
	const region = { ref: "pi-ref://region/1", kind: "region" as const, role: "main", state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true }, source: "dom" as const };
	const entities = [frame, region, control("pi-ref://control/ok")];
	assert.equal(resolveActionEntityRef(undefined, "pi-ref://frame/1", entities), undefined, "frame focusedRef rejected (no mis-attribution)");
	assert.equal(resolveActionEntityRef("pi-ref://region/1", undefined, entities), undefined, "region actionRef rejected");
	assert.equal(resolveActionEntityRef(undefined, "pi-ref://control/ok", entities), "pi-ref://control/ok", "a real control is accepted");
});
