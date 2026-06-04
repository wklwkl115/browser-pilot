// ABML R3.x causal plane (P0) contract.
//
// Verifies the network-delta causal plane end-to-end without a browser:
//   - pure-core selector: seq>baseline window, sorted, pi-ref://network refs, URL redaction,
//     cap + true count, empty delta, recorder-unavailable shape;
//   - budget immunity: a `causal` summary block survives to envelope.causal (incl. tight budget
//     and the unavailable variant), with envelope-level redaction as defense-in-depth;
//   - static wiring: observeRunners queries the recorder + builds causal, resultMiddleware lifts
//     it, the bridge exposes lastSeq, the snapshot carries networkSeq, and the check is registered.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCausalSummary, buildCausalRequest, causalUnavailable, MAX_CAUSAL_REQUESTS } from "../../../src/abml-core/causal.ts";
import { distilledTextResult } from "../../../src/tools/resultMiddleware.ts";

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

// ── Static wiring guards ────────────────────────────────────────────────────────

const observeSrc = readRepo("src/tools/observeRunners.ts");
assert.ok(observeSrc.includes("buildCausalSummary") && observeSrc.includes("causal"), "observeRunners builds causal");
assert.ok(observeSrc.includes("network.status") && observeSrc.includes("network.list"), "observeRunners reads recorder high-water + delta");
assert.ok(observeSrc.includes("networkSeq"), "observeRunners records/resolves networkSeq baseline anchor");

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

const pkg = JSON.parse(readRepo("package.json"));
assert.ok(pkg.scripts?.["check:abml-causal"]?.includes("check-abml-causal.mjs"), "check:abml-causal script present");

console.log(`abml causal ok — pure-core seq-window selector (sorted, pi-ref://network refs, URL redaction, cap=${MAX_CAUSAL_REQUESTS}+count, unavailable); causal budget-immune to envelope top-level (incl. unavailable + tight budget); recorder lastSeq high-water + snapshot networkSeq anchor; all static wiring verified`);
