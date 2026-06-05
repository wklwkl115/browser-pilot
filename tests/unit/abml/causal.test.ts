import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCausalSummary, buildCausalRequest, causalUnavailable, MAX_CAUSAL_REQUESTS, buildTriggeredRelations, resolveActionEntityRef, MAX_TRIGGERED_RELATIONS, buildCausalEvent, buildCausalEvents, MAX_CAUSAL_EVENTS, eventTriggeredByEntity, latestSeq } from "../../../src/abml-core/causal.ts";

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

test("causal: redacts free-text and PII-looking query values without over-redacting machine params", () => {
	const r = buildCausalRequest({ requestId: "q", request: { url: "https://x/search?query=playwright+browser+test+2&q=user%40example.test&qry=13800138000&id=123&id2=12345678&t=1717600000000&page=2&lang=en", method: "GET" } });
	assert.ok(r.url, "url present");
	assert.ok(!r.url!.includes("playwright"));
	assert.ok(!r.url!.includes("user%40example.test"));
	assert.ok(!r.url!.includes("13800138000"));
	assert.ok(r.url!.includes("id=123"));
	assert.ok(r.url!.includes("id2=12345678"));
	assert.ok(r.url!.includes("t=1717600000000"));
	assert.ok(r.url!.includes("page=2"));
	assert.ok(r.url!.includes("lang=en"));
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

// ── R3.x P2 — event causal entries ────────────────────────────────────────────

test("causal P2: buildCausalEvent shapes a hook event — ref/type/at/redacted summary/selector", () => {
	const e = buildCausalEvent({ seq: 9, type: "domSink", timestamp: 1710, data: { prop: "innerHTML", value: "token=SECRET123 hi", elementRef: { selector: "#out" } } });
	assert.equal(e.ref, "pi-ref://event/9");
	assert.equal(e.type, "domSink");
	assert.equal(e.at, 1710);
	assert.equal(e.selector, "#out", "DOM-sink event names its target element");
	assert.ok(e.summary && !e.summary.includes("SECRET123"), "summary redacted");
});

test("causal P2: buildCausalEvent never dumps a raw payload object (summary omitted when no text field)", () => {
	const e = buildCausalEvent({ seq: 3, type: "storage", data: { keys: 4, bytes: 200 } });
	assert.equal(e.summary, undefined, "no message/summary/... field → no summary, no object dump");
	assert.equal(e.selector, undefined);
});

test("causal P2: buildCausalEvents windows seq>sinceSeq, sorts, caps + true count", () => {
	const recs = [
		{ seq: 7, type: "console", data: { message: "b" } },
		{ seq: 5, type: "console", data: { message: "a" } },
		{ seq: 2, type: "console", data: { message: "old" } },
	];
	const r = buildCausalEvents(recs, 4);
	assert.deepEqual(r.events.map((e) => e.ref), ["pi-ref://event/5", "pi-ref://event/7"], "seq>4, sorted ascending");
	assert.equal(r.eventCount, undefined, "no count when not capped");
	const many = buildCausalEvents(Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, type: "console", data: { message: `m${i}` } })), 0);
	assert.equal(many.events.length, MAX_CAUSAL_EVENTS, "capped at MAX_CAUSAL_EVENTS");
	assert.equal(many.eventCount, 20, "true delta count reported when capped");
});

test("causal P2: console event summary comes from args[0] (the message), redacted", () => {
	const e = buildCausalEvent({ seq: 4, type: "console.error", data: { args: ["login failed token=SECRETXY"], stack: "…" } });
	assert.equal(e.type, "console.error");
	assert.ok(e.summary && e.summary.includes("login failed") && !e.summary.includes("SECRETXY"), "args[0] used as summary, sensitive value scrubbed");
});

test("causal P2: empty event delta → empty events, no eventCount", () => {
	const r = buildCausalEvents([], 10);
	assert.equal(r.events.length, 0);
	assert.ok(!("eventCount" in r));
});

// ── R3.x P2-B — event-sourced attribution ──────────────────────────────────────

const ctlSel = (ref: string, selector: string) => ({ ref, kind: "control" as const, role: "button", state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true }, source: "dom" as const, hints: { selector } });

test("causal P2-B: an event naming its element → triggered edge on that entity (source event/medium)", () => {
	const entities = [ctlSel("pi-ref://control/pay", "#pay"), ctlSel("pi-ref://control/other", "#other")];
	const events = [{ ref: "pi-ref://event/9", type: "domSink", selector: "#pay" }];
	const map = eventTriggeredByEntity(events, entities);
	const rels = map.get("pi-ref://control/pay");
	assert.ok(rels && rels.length === 1, "triggered edge attached to the named control");
	assert.equal(rels[0].type, "triggered");
	assert.equal(rels[0].targetRef, "pi-ref://event/9", "edge targets the event ref");
	assert.equal(rels[0].source, "event", "element-sourced (stronger than timing)");
	assert.equal(rels[0].confidence, "medium");
	assert.equal(map.get("pi-ref://control/other"), undefined, "unrelated control gets nothing");
});

test("causal P2-B: events without a selector, or selectors matching no entity, attribute nothing", () => {
	const entities = [ctlSel("pi-ref://control/pay", "#pay")];
	assert.equal(eventTriggeredByEntity([{ ref: "pi-ref://event/1", type: "console.error" }], entities).size, 0, "no selector → no attribution");
	assert.equal(eventTriggeredByEntity([{ ref: "pi-ref://event/2", type: "domSink", selector: "#nope" }], entities).size, 0, "unmatched selector → no attribution");
});

test("causal P2-B: a region/non-actionable entity is not an attribution target", () => {
	const region = { ref: "pi-ref://region/1", kind: "region" as const, role: "main", state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true }, source: "dom" as const, hints: { selector: "#main" } };
	assert.equal(eventTriggeredByEntity([{ ref: "pi-ref://event/3", type: "domSink", selector: "#main" }], [region]).size, 0, "region rejected (only control/element)");
});

// ── R3.x P2-C — seq cursor advance (stream-plane drain) ─────────────────────────

test("causal P2-C: latestSeq returns the max seq over a delta window", () => {
	assert.equal(latestSeq([{ seq: 5 }, { seq: 9 }, { seq: 7 }]), 9, "highest seq is the new cursor");
	assert.equal(latestSeq([{ seq: 0 }]), 0, "seq 0 is a valid cursor");
});

test("causal P2-C: latestSeq ignores records with no numeric seq, undefined when none", () => {
	assert.equal(latestSeq([]), undefined, "empty delta → keep prior cursor (undefined)");
	assert.equal(latestSeq([{ id: "x" }, { seq: "nope" }]), undefined, "non-numeric seq ignored");
	assert.equal(latestSeq([{ seq: 4 }, { id: "y" }, { seq: 11 }]), 11, "mixed: max over the numeric ones");
});
