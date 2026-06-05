// ABML R3.x causal plane (P0 + P1) contract.
//
// Verifies the network-delta causal plane end-to-end without a browser:
//   - P0 pure-core selector: seq>baseline window, sorted, pi-ref://network refs, URL redaction,
//     cap + true count, empty delta, recorder-unavailable shape;
//   - P0 budget immunity: a `causal` summary block survives to envelope.causal (incl. tight budget
//     and the unavailable variant), with envelope-level redaction as defense-in-depth;
//   - P1 attribution: buildTriggeredRelations (timing/low edges, capped), resolveActionEntityRef
//     (actionRef > focusedRef, focus robustness rejecting frame/region), triggered lifted to
//     envelope.relations.summary with its target resolvable inline in causal.requests;
//   - static wiring: observeRunners queries the recorder + builds/attributes causal, resultMiddleware
//     lifts it, the bridge exposes lastSeq, the snapshot carries networkSeq, and the check is registered.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCausalSummary, buildCausalRequest, causalUnavailable, MAX_CAUSAL_REQUESTS, buildTriggeredRelations, resolveActionEntityRef, MAX_TRIGGERED_RELATIONS, buildCausalEvent, buildCausalEvents, MAX_CAUSAL_EVENTS, eventTriggeredByEntity, latestSeq } from "../../../src/abml-core/causal.ts";
import { distilledTextResult } from "../../../src/tools/resultMiddleware.ts";
import { createBrowserAbmlRuntime } from "../../../src/abml/verbs/runtime.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");
const hasRequests = (c) => "requests" in c;

// ── Pure-core selector ─────────────────────────────────────────────────────────

// seq window + ordering + ref minting. Tolerant of the network.list summary shape (nested
// request/response) and the flattened shape (top-level url/status) — both read defensively.
const windowed = buildCausalSummary([
	{ seq: 7, requestId: "b", request: { url: "https://x/api/b", method: "POST" }, response: { status: 201 }, type: "Fetch", updatedAt: 200 },
	{ seq: 5, requestId: "a", request: { url: "https://x/api/a", method: "GET" }, response: { status: 200 }, type: "XHR", updatedAt: 100 },
	{ seq: 3, requestId: "old", url: "https://x/old", method: "GET", status: 200 },
], 4);
assert.ok(hasRequests(windowed));
assert.equal(windowed.sinceSeq, 4);
assert.deepEqual(windowed.requests.map((r) => r.ref), ["pi-ref://network/a", "pi-ref://network/b"], "seq>4, sorted ascending, refs minted");
assert.equal(windowed.requests[0].method, "GET");
assert.equal(windowed.requests[0].type, "XHR");
assert.equal(windowed.requests[1].status, 201);

// flattened record shape (top-level url/status) is also accepted
const flat = buildCausalRequest({ requestId: "f", url: "https://x/flat", method: "DELETE", status: 204, type: "XHR" });
assert.equal(flat.ref, "pi-ref://network/f");
assert.equal(flat.url, "https://x/flat");
assert.equal(flat.status, 204);

// URL redaction: sensitive query value scrubbed
const red = buildCausalRequest({ requestId: "t", request: { url: "https://x/api?token=SECRET123&q=1", method: "GET" } });
assert.ok(red.url && !red.url.includes("SECRET123"), "sensitive query value scrubbed in causal request url");
const queryRed = buildCausalRequest({ requestId: "q", request: { url: "https://x/search?query=playwright+browser+test+2&q=user%40example.test&qry=13800138000&id=123&id2=12345678&t=1717600000000&page=2&lang=en", method: "GET" } });
assert.ok(queryRed.url && !queryRed.url.includes("playwright") && !queryRed.url.includes("user%40example.test") && !queryRed.url.includes("13800138000"), "free-text query and PII-looking query values scrubbed");
assert.ok(queryRed.url?.includes("id=123") && queryRed.url?.includes("id2=12345678") && queryRed.url?.includes("t=1717600000000") && queryRed.url?.includes("page=2") && queryRed.url?.includes("lang=en"), "low-risk machine query params remain visible, including long ids/timestamps");

// cap + true count
const capped = buildCausalSummary(Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, requestId: `r${i}`, request: { url: `https://x/${i}`, method: "GET" } })), 0);
assert.ok(hasRequests(capped));
assert.equal(capped.requests.length, MAX_CAUSAL_REQUESTS, "capped at MAX_CAUSAL_REQUESTS");
assert.equal(capped.requestCount, 20, "true delta count reported when capped");

// empty delta → empty requests, no requestCount
const empty = buildCausalSummary([], 10);
assert.ok(hasRequests(empty) && empty.requests.length === 0 && !("requestCount" in empty), "empty delta carries no requestCount");

// recorder-unavailable shape
const unavail = causalUnavailable("network recorder not active — start via browser_network start");
assert.ok(!hasRequests(unavail) && "unavailable" in unavail && unavail.unavailable.includes("not active"), "unavailable block shape");

// ── Budget immunity: causal survives to envelope top-level ───────────────────────

const lifted = await distilledTextResult("body", {
	toolName: "browser_observe", command: "scan", detailLevel: "summary",
	maxChars: 4_000, fallbackName: "observe-scan",
	summary: {
		abmlIntegrated: true,
		causal: { sinceSeq: 5, requests: [{ ref: "pi-ref://network/req-a", method: "POST", url: "https://x/api/cart?token=SECRET123", status: 200, type: "XHR", at: 111 }] },
		focus: { gist: { landmarks: ["main"], controlCount: 1 }, primary_entities: [{ ref: "pi-ref://control/1", kind: "control", role: "button", name: "Pay" }] },
	},
});
const liftedEnvelope = JSON.parse(lifted.content[0].text);
assert.ok(typeof liftedEnvelope.causal === "object" && liftedEnvelope.causal !== null, "causal at envelope top-level");
assert.equal(liftedEnvelope.causal.sinceSeq, 5);
assert.equal(liftedEnvelope.causal.requests.length, 1);
assert.equal(liftedEnvelope.causal.requests[0].ref, "pi-ref://network/req-a");
assert.ok(!liftedEnvelope.causal.requests[0].url.includes("SECRET123"), "envelope-level redaction scrubs token (defense-in-depth)");

// unavailable variant lifts too
const unavailLifted = await distilledTextResult("body", {
	toolName: "browser_observe", command: "scan", detailLevel: "summary",
	maxChars: 4_000, fallbackName: "observe-scan",
	summary: { abmlIntegrated: true, causal: { unavailable: "network recorder not active — start via browser_network start" }, focus: {} },
});
const unavailEnvelope = JSON.parse(unavailLifted.content[0].text);
assert.ok(typeof unavailEnvelope.causal?.unavailable === "string" && unavailEnvelope.causal.unavailable.includes("not active"), "unavailable causal lifted to envelope");

// budget-squeeze survival
const tight = await distilledTextResult("body", {
	toolName: "browser_observe", command: "scan", detailLevel: "summary", maxChars: 3_000, fallbackName: "observe-scan",
	summary: {
		abmlIntegrated: true,
		causal: { sinceSeq: 9, requests: Array.from({ length: 12 }, (_, i) => ({ ref: `pi-ref://network/r${i}`, method: "GET", url: `https://x/${i}`, status: 200, type: "XHR", at: i })) },
		focus: {
			gist: { landmarks: ["main"], controlCount: 50 },
			relations: { summary: { tableCells: 200 }, highlights: [] },
			primary_entities: Array.from({ length: 30 }, (_, i) => ({ ref: `pi-ref://control/${i}`, kind: "control", role: "tab", name: `tab ${i} ${"pad ".repeat(60)}` })),
		},
	},
});
const tightEnvelope = JSON.parse(tight.content[0].text);
assert.ok(typeof tightEnvelope.causal === "object", "causal survives budget squeeze");
assert.equal(tightEnvelope.causal?.sinceSeq, 9, "causal sinceSeq intact under tight budget");

// ── R3.x P1 — attribution (triggered relation, focus robustness) ─────────────────

const ctl = (ref) => ({ ref, kind: "control", role: "button", state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true }, source: "dom" });

// buildTriggeredRelations: one timing/low edge per delta request, capped; empty for unavailable.
const trig = buildTriggeredRelations(buildCausalSummary([
	{ seq: 6, requestId: "a", request: { url: "https://x/a", method: "POST" }, response: { status: 200 } },
	{ seq: 7, requestId: "b", request: { url: "https://x/b", method: "GET" } },
], 5));
assert.deepEqual(trig.map((r) => r.type), ["triggered", "triggered"], "triggered edges built from delta");
assert.deepEqual(trig.map((r) => r.targetRef), ["pi-ref://network/a", "pi-ref://network/b"], "target the network refs");
assert.equal(trig[0].source, "timing", "timing-sourced (not initiator-stack proof)");
assert.equal(trig[0].confidence, "low", "low confidence — timing window only");
assert.equal(buildTriggeredRelations(causalUnavailable("off")).length, 0, "no triggered when unavailable");
assert.equal(buildTriggeredRelations(buildCausalSummary(Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, requestId: `r${i}`, request: { url: `https://x/${i}` } })), 0)).length, MAX_TRIGGERED_RELATIONS, "capped at MAX_TRIGGERED_RELATIONS");

// resolveActionEntityRef: actionRef > focusedRef; FOCUS ROBUSTNESS rejects a ref on a frame/region.
const attEntities = [ctl("pi-ref://control/a"), { ref: "pi-ref://frame/1", kind: "frame", role: "iframe", state: { focused: true }, source: "dom" }, { ref: "pi-ref://region/1", kind: "region", role: "main", state: {}, source: "dom" }];
assert.equal(resolveActionEntityRef("pi-ref://control/a", undefined, attEntities), "pi-ref://control/a", "explicit actionRef resolves to its control");
assert.equal(resolveActionEntityRef(undefined, "pi-ref://control/a", attEntities), "pi-ref://control/a", "focusedRef fallback resolves a control");
assert.equal(resolveActionEntityRef(undefined, "pi-ref://frame/1", attEntities), undefined, "focusedRef on a frame is rejected (no mis-attribution)");
assert.equal(resolveActionEntityRef("pi-ref://region/1", undefined, attEntities), undefined, "actionRef on a region is rejected");

// Budget immunity: a triggered edge in relations.summary survives to envelope.relations.
const p1Lift = await distilledTextResult("body", {
	toolName: "browser_observe", command: "scan", detailLevel: "summary", maxChars: 4_000, fallbackName: "observe-scan",
	summary: {
		abmlIntegrated: true,
		causal: { sinceSeq: 5, requests: [{ ref: "pi-ref://network/pay-1", method: "POST", url: "https://x/api/pay", status: 200, type: "XHR", at: 1 }] },
		focus: {
			relations: { summary: { triggered: 1 }, highlights: [{ type: "triggered", sourceRef: "pi-ref://control/pay", targetRef: "pi-ref://network/pay-1", source: "timing" }] },
			primary_entities: [{ ref: "pi-ref://control/pay", kind: "control", role: "button", name: "Pay", relations: [{ type: "triggered", targetRef: "pi-ref://network/pay-1", source: "timing", confidence: "low" }] }],
		},
	},
});
const p1Envelope = JSON.parse(p1Lift.content[0].text);
assert.equal(p1Envelope.relations?.summary?.triggered, 1, "triggered count lifted to envelope.relations.summary");
assert.equal(p1Envelope.causal?.requests?.[0]?.ref, "pi-ref://network/pay-1", "triggered targetRef resolvable inline in causal.requests");

// ── Static wiring guards ────────────────────────────────────────────────────────

const observeSrc = readRepo("src/tools/observeRunners.ts");
// ── R3.x P2 — event causal entries (pure + envelope) ─────────────────────────────

// buildCausalEvent: shape + redaction + selector; never dumps a raw payload object.
const ev0 = buildCausalEvent({ seq: 9, type: "domSink", timestamp: 5, data: { value: "token=SECRET99 x", elementRef: { selector: "#out" } } });
assert.equal(ev0.ref, "pi-ref://event/9");
assert.equal(ev0.type, "domSink");
assert.equal(ev0.selector, "#out", "DOM-sink event names its element");
assert.ok(ev0.summary && !ev0.summary.includes("SECRET99"), "event summary redacted");
assert.equal(buildCausalEvent({ seq: 2, type: "storage", data: { keys: 3 } }).summary, undefined, "no text field → no summary / no raw object dump");

// buildCausalEvents: seq>baseline window, sorted, cap + true count.
const evDelta = buildCausalEvents([
	{ seq: 7, type: "console", data: { message: "b" } },
	{ seq: 5, type: "console", data: { message: "a" } },
	{ seq: 2, type: "console", data: { message: "old" } },
], 4);
assert.deepEqual(evDelta.events.map((e) => e.ref), ["pi-ref://event/5", "pi-ref://event/7"], "seq>4, sorted ascending");
const evCapped = buildCausalEvents(Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, type: "console", data: { message: `m${i}` } })), 0);
assert.equal(evCapped.events.length, MAX_CAUSAL_EVENTS, "capped at MAX_CAUSAL_EVENTS");
assert.equal(evCapped.eventCount, 20, "true count when capped");

// Envelope: causal.events lifts to envelope.causal.events (budget-immune, redacted) alongside requests.
const evLift = await distilledTextResult("body", {
	toolName: "browser_observe", command: "scan", detailLevel: "summary", maxChars: 4_000, fallbackName: "observe-scan",
	summary: { abmlIntegrated: true, causal: { sinceSeq: 5, requests: [], events: [{ ref: "pi-ref://event/10", type: "domSink", at: 1, summary: "token=SECRET77 x", selector: "#out" }] }, focus: {} },
});
const evEnv = JSON.parse(evLift.content[0].text);
assert.equal(evEnv.causal?.events?.length, 1, "causal.events lifted to envelope.causal");
assert.equal(evEnv.causal.events[0].ref, "pi-ref://event/10");
assert.ok(!evEnv.causal.events[0].summary.includes("SECRET77"), "envelope-level redaction scrubs the event summary");

// ── R3.x P2-B — event-sourced attribution (pure) ─────────────────────────────────

const p2bEntities = [
	{ ref: "pi-ref://control/pay", kind: "control", role: "button", state: {}, source: "dom", hints: { selector: "#pay" } },
	{ ref: "pi-ref://region/main", kind: "region", role: "main", state: {}, source: "dom", hints: { selector: "#main" } },
];
const p2bMap = eventTriggeredByEntity([{ ref: "pi-ref://event/9", type: "domSink", selector: "#pay" }, { ref: "pi-ref://event/10", type: "domSink", selector: "#main" }, { ref: "pi-ref://event/11", type: "console.error" }], p2bEntities);
const payRels = p2bMap.get("pi-ref://control/pay");
assert.ok(payRels && payRels.length === 1, "event naming a control → triggered on it");
assert.equal(payRels[0].source, "event", "element-sourced (stronger than P1 timing)");
assert.equal(payRels[0].confidence, "medium");
assert.equal(payRels[0].targetRef, "pi-ref://event/9", "edge targets the event ref");
assert.equal(p2bMap.get("pi-ref://region/main"), undefined, "region is not an attribution target");
assert.equal(p2bMap.size, 1, "selectorless / unmatched events attribute nothing");

// ── R3.x P2-C — causal stream plane (cursor drain channel) ───────────────────────

// Pure cursor-advance: latestSeq = max seq over the delta (the new cursor); undefined keeps the prior.
assert.equal(latestSeq([{ seq: 5 }, { seq: 9 }, { seq: 7 }]), 9, "latestSeq returns the max seq");
assert.equal(latestSeq([{ seq: 0 }]), 0, "seq 0 is a valid cursor");
assert.equal(latestSeq([{ id: "x" }, { seq: "nan" }]), undefined, "no numeric seq → undefined (hold cursor)");

// Behavioral gate: arm pins the cursor at the recorder high-water (no history replay), drain returns
// redacted entities on the causal ref scheme + advances the cursor + refreshes the capture-ref. Run against
// a fake bridge + the real pi-ref store (the only browser-free way to guard the runtime, not just grep it).
const streamCalls = [];
const streamState = { items: [], lastSeq: 30 };
const streamServer = {
	snapshot: (o = {}) => ({ browserSessionId: o.browserSessionId || "default", defaultTabId: 7, selectionVersion: 1, tabs: [{ tabId: 7, url: "https://x/" }] }),
	createObservationSnapshot: (s) => ({ snapshotId: s.snapshotId || "snap-1", ttlMs: 60_000, expired: false, ...s }),
	async sendCommand(command) {
		streamCalls.push(command.cmd);
		if (command.cmd === "network.status") return { acknowledged: true, tabId: 7, data: { active: true, lastSeq: streamState.lastSeq } };
		if (command.cmd === "network.list") return { acknowledged: true, tabId: 7, data: { items: streamState.items.filter((r) => Number(r.seq) > Number(command.sinceSeq ?? 0)) } };
		return { acknowledged: true, tabId: 7, data: {} };
	},
};
const streamRuntime = createBrowserAbmlRuntime(streamServer, { tabId: 7, timeoutMs: 2000 });
const streamArm = await streamRuntime.read({ plane: "network" });
assert.ok(streamArm.ok && streamArm.data.armed === true && streamArm.data.cursor === 30, "arm pins cursor at high-water 30");
assert.match(String(streamArm.data.captureRef), /^pi-ref:\/\/signal\//, "arm mints a signal capture-ref cursor");
streamState.items = [{ seq: 31, requestId: "s31", request: { url: "https://x/api?token=SECRET314", method: "POST" }, response: { status: 200 }, type: "Fetch" }];
streamState.lastSeq = 31;
const streamDrain = await streamRuntime.read({ plane: "network", ref: String(streamArm.data.captureRef) });
assert.ok(streamDrain.ok, "drain succeeds");
assert.equal((streamDrain.entities || []).length, 1, "delta request became a stream entity");
assert.equal(streamDrain.entities[0].ref, "pi-ref://network/s31", "entity ref uses the causal scheme");
assert.ok(!JSON.stringify(streamDrain.entities).includes("SECRET314"), "raw secret never leaves redaction in the stream entity");
assert.equal(streamDrain.data.cursor, 31, "cursor advanced to the last consumed seq");
assert.notEqual(String(streamDrain.data.captureRef), String(streamArm.data.captureRef), "drain refreshes the cursor ref");
const streamInactive = await createBrowserAbmlRuntime({ ...streamServer, async sendCommand(c) { return { acknowledged: true, tabId: 7, data: c.cmd === "network.status" ? { active: false } : {} }; } }, { tabId: 7, timeoutMs: 2000 }).read({ plane: "network" });
assert.ok(streamInactive.ok && /not active/.test(String(streamInactive.data.unavailable)), "recorder inactive → unavailable (no throw)");

// ── Static wiring guards ────────────────────────────────────────────────────────

assert.ok(observeSrc.includes("buildCausalSummary") && observeSrc.includes("causal"), "observeRunners builds causal");
assert.ok(observeSrc.includes("network.status") && observeSrc.includes("network.list"), "observeRunners reads recorder high-water + delta");
assert.ok(observeSrc.includes("networkSeq"), "observeRunners records/resolves networkSeq baseline anchor");
assert.ok(observeSrc.includes("resolveActionEntityRef") && observeSrc.includes("buildTriggeredRelations") && observeSrc.includes("addEntityRelations"), "observeRunners wires P1 attribution");
assert.ok(observeSrc.includes("actionRef"), "observeRunners reads the actionRef attribution signal");

const entitySrc = readRepo("src/abml-core/entity.ts");
assert.ok(entitySrc.includes("\"triggered\"") && entitySrc.includes("\"timing\""), "entity RelationType has triggered + source timing");
const registerSrc = readRepo("src/tools/registerObserveTool.ts");
assert.ok(registerSrc.includes("actionRef"), "browser_observe exposes the scan-only actionRef param");

const middlewareSrc = readRepo("src/tools/resultMiddleware.ts");
assert.ok(middlewareSrc.includes("envelopeCausal") && middlewareSrc.includes("causal?"), "resultMiddleware lifts causal");

const causalSrc = readRepo("src/abml-core/causal.ts");
assert.ok(causalSrc.includes("MAX_CAUSAL_REQUESTS") && causalSrc.includes("redactSensitiveText") && causalSrc.includes("pi-ref://network/"), "pure-core causal constants/redaction/ref present");

const snapshotTypeSrc = readRepo("src/driver/types.ts");
assert.ok(snapshotTypeSrc.includes("networkSeq"), "observation snapshot type carries networkSeq");

const bridgeNetSrc = readRepo("bridge_src/service_worker/network_model.ts");
assert.ok(bridgeNetSrc.includes("lastSeq"), "bridge networkRecorderSummary exposes lastSeq high-water mark");
const bridgeTypesSrc = readRepo("bridge_src/service_worker/types.ts");
assert.ok(bridgeTypesSrc.includes("lastSeq"), "bridge NetworkRecorderSummary type declares lastSeq");

const barrelSrc = readRepo("src/abml-core/index.ts");
assert.ok(barrelSrc.includes("./causal.js"), "kernel barrel exports causal");

// P2 static wiring
assert.ok(observeSrc.includes("readHookRecorderSeq") && observeSrc.includes("queryHookDelta") && observeSrc.includes("buildCausalEvents") && observeSrc.includes("hookSeq"), "observeRunners wires the P2 hook event-delta");
assert.ok(observeSrc.includes("eventTriggeredByEntity"), "observeRunners wires P2-B event-sourced attribution");
assert.ok(causalSrc.includes("buildCausalEvents") && causalSrc.includes("pi-ref://event/") && causalSrc.includes("CausalEvent"), "pure-core event-causal selector present");
assert.ok(causalSrc.includes("eventTriggeredByEntity") && causalSrc.includes("\"event\""), "pure-core P2-B event-sourced attribution present");
assert.ok(entitySrc.includes("\"event\""), "entity relation source union includes event");
assert.ok(snapshotTypeSrc.includes("hookSeq"), "observation snapshot type carries hookSeq");
const hookDispSrc = readRepo("bridge_src/page_scripts/hook_dispatcher.ts");
assert.ok(hookDispSrc.includes("last_seq: seq"), "hook status() exposes last_seq event high-water mark");

// P2-C static wiring: the runtime implements the network/event stream planes (the BACKEND_UNAVAILABLE
// stub is gone for them) via the capture-ref scaffold + redacted causal shaping; integration exposes it.
const runtimeSrc = readRepo("src/abml/verbs/runtime.ts");
assert.ok(runtimeSrc.includes("readStreamPlane") && runtimeSrc.includes('input.plane === "network" || input.plane === "event"'), "runtime routes network/event planes to the stream drain (no longer BACKEND_UNAVAILABLE)");
assert.ok(runtimeSrc.includes("createCaptureRef") && runtimeSrc.includes("streamState") && runtimeSrc.includes("latestSeq"), "runtime uses the capture-ref cursor scaffold + latestSeq advance");
assert.ok(runtimeSrc.includes("buildNetworkEntryEntity") && runtimeSrc.includes("buildEventEntity"), "runtime activates the dead stream entity builders");
assert.ok(runtimeSrc.includes("buildCausalRequest") && runtimeSrc.includes("buildCausalEvent"), "runtime redacts stream entities via the causal selectors (no raw url/payload)");
assert.ok(causalSrc.includes("export function latestSeq"), "pure-core latestSeq cursor-advance present");
const integrationSrc = readRepo("src/abml/verbs/integration.ts");
assert.ok(integrationSrc.includes("readStream"), "createBrowserAbmlIntegration exposes the readStream drain entry");

const pkg = JSON.parse(readRepo("package.json"));
assert.ok(pkg.scripts?.["check:abml-causal"]?.includes("check-abml-causal.mjs"), "check:abml-causal script present");

console.log(`abml causal ok — P0 pure-core seq-window selector (sorted, pi-ref://network refs, URL redaction, cap=${MAX_CAUSAL_REQUESTS}+count, unavailable) + budget-immune envelope.causal (incl. unavailable + tight budget); P1 attribution (triggered timing/low edges cap=${MAX_TRIGGERED_RELATIONS}, focus robustness rejects frame/region, lifted to relations.summary); recorder lastSeq + snapshot networkSeq anchor; P2-A event causal (buildCausalEvents seq-window/cap=${MAX_CAUSAL_EVENTS}, redacted summary + selector, no raw payload, lifted to envelope.causal.events; hook last_seq + snapshot hookSeq anchor); P2-B event-sourced attribution (eventTriggeredByEntity: element-named event → triggered source:"event"/medium, region rejected); P2-C causal stream plane (latestSeq cursor advance; runtime read(plane:network|event) arm pins high-water + drain returns redacted causal-scheme entities + advances/refreshes the signal capture-ref + recorder-inactive unavailable; integration.readStream entry; capture-ref scaffold activated); all static wiring verified`);
