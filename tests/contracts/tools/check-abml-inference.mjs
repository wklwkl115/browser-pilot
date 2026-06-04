// ABML R2 inference layer contract.
//
// Verifies the full inference pipeline end-to-end without a browser: all 12 PageIntent
// patterns detected from their canonical triggers, plus P2/R3 improvements (evidence field,
// grouped multi-choice confidence, expandable threshold, tabbed-interface, alert-region,
// form-dependency from temporal diff).
// Also asserts budget immunity and static wiring.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInferenceSummary } from "../../../src/abml-core/inference.ts";
import { distilledTextResult } from "../../../src/tools/resultMiddleware.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

function entity(role, opts = {}) {
	return {
		ref: opts.ref ?? `pi-ref://control/${role}`,
		kind: opts.kind ?? "control",
		role,
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: opts.editable ?? false, inViewport: true, ...(opts.state ?? {}) },
		source: "dom",
		...(opts.structure ? { structure: opts.structure } : {}),
		...(opts.hints ? { hints: opts.hints } : {}),
	};
}
function emptyRel() { return { summary: {}, highlights: [] }; }
function relWith(counts) { return { summary: counts, highlights: [] }; }
const kinds = (result) => result.intents.map((i) => i.intent);

// ── All 12 pattern families ───────────────────────────────────────────────────

// login (P2: evidence.submitRef)
const loginEntities = [
	entity("textbox", { editable: true, hints: { inputKind: "password" } }),
	entity("button", { ref: "pi-ref://control/submit-btn" }),
];
const loginResult = buildInferenceSummary(loginEntities, emptyRel());
assert.ok(kinds(loginResult).includes("login"), "login detected");
assert.equal(loginResult.intents.find((i) => i.intent === "login")?.confidence, "high");
assert.equal(loginResult.intents.find((i) => i.intent === "login")?.evidence?.submitRef, "pi-ref://control/submit-btn", "login evidence.submitRef set");

// search (high — searchbox role)
assert.ok(kinds(buildInferenceSummary([entity("searchbox", { editable: true })], emptyRel())).includes("search"));

// filter-panel (supersedes search)
const filterEntities = [
	entity("region", { kind: "region", structure: { landmark: "search" } }),
	entity("textbox", { editable: true }),
	entity("combobox", { editable: true, ref: "pi-ref://control/combo" }),
];
const filterResult = buildInferenceSummary(filterEntities, emptyRel());
assert.ok(kinds(filterResult).includes("filter-panel"), "filter-panel detected");
assert.ok(!kinds(filterResult).includes("search"), "search suppressed");

// single-choice (radiogroup)
assert.ok(kinds(buildInferenceSummary([entity("radiogroup", { kind: "region" })], emptyRel())).includes("single-choice"));

// multi-choice (P1: high when grouped)
const groupHints = { containerRole: "group", containerName: "Sport" };
const mcResult = buildInferenceSummary([
	entity("checkbox", { hints: groupHints }),
	entity("checkbox", { hints: groupHints, ref: "pi-ref://control/cb2" }),
	entity("checkbox", { hints: groupHints, ref: "pi-ref://control/cb3" }),
], emptyRel());
assert.ok(kinds(mcResult).includes("multi-choice"), "multi-choice detected");
assert.equal(mcResult.intents.find((i) => i.intent === "multi-choice")?.confidence, "high", "grouped → high confidence");

// expandable (P1: threshold >= 2, not 1)
assert.ok(kinds(buildInferenceSummary([], relWith({ expandedTarget: 2 }))).includes("expandable"), "expandable at 2");
assert.ok(!kinds(buildInferenceSummary([], relWith({ expandedTarget: 1 }))).includes("expandable"), "expandedTarget=1 suppressed");

// data-grid (grid role OR tableCells >= 50)
assert.ok(kinds(buildInferenceSummary([entity("grid", { kind: "region" })], emptyRel())).includes("data-grid"), "data-grid from grid role");
assert.ok(kinds(buildInferenceSummary([], relWith({ tableCells: 50 }))).includes("data-grid"), "data-grid from tableCells=50");
assert.ok(!kinds(buildInferenceSummary([], relWith({ tableCells: 42 }))).includes("data-grid"), "tableCells=42 suppressed");

// navigation
assert.ok(kinds(buildInferenceSummary([], relWith({ currentIn: 1 }))).includes("navigation"));

// dialog
assert.ok(kinds(buildInferenceSummary([entity("dialog", { kind: "region" })], emptyRel())).includes("dialog"));

// tabbed-interface (P0: new)
const tiResult = buildInferenceSummary([entity("tablist", { kind: "region" })], emptyRel());
assert.ok(kinds(tiResult).includes("tabbed-interface"), "tabbed-interface detected");
assert.equal(tiResult.intents.find((i) => i.intent === "tabbed-interface")?.confidence, "high");

// alert-region (P0: new)
const arResult = buildInferenceSummary([entity("alert", { kind: "region" })], emptyRel());
assert.ok(kinds(arResult).includes("alert-region"), "alert-region detected");
assert.equal(arResult.intents.find((i) => i.intent === "alert-region")?.confidence, "high");

// status role also triggers alert-region
assert.ok(kinds(buildInferenceSummary([entity("status", { kind: "region" })], emptyRel())).includes("alert-region"), "status → alert-region");

// form-dependency (R3: disabled→enabled + focused editable field)
const depEntities = [
	entity("textbox", { ref: "pi-ref://control/email", editable: true, state: { focused: true } }),
	entity("button", { ref: "pi-ref://control/submit", state: { disabled: false } }),
];
const depResult = buildInferenceSummary(depEntities, emptyRel(), { appeared: [], disappeared: [], changed: [{ ref: "pi-ref://control/submit", kind: "state-changed", before: { disabled: true }, after: { disabled: false } }], focusedRef: "pi-ref://control/email" });
assert.equal(depResult.intents.find((i) => i.intent === "form-dependency")?.evidence?.enabledRef, "pi-ref://control/submit", "form-dependency detected from R3 diff");
assert.equal(depResult.intents.find((i) => i.intent === "form-dependency")?.evidence?.requiredRef, "pi-ref://control/email", "form-dependency requiredRef set");

// ── Evidence anchoring + reason (R2 optimization) ─────────────────────────────

// Every fired intent carries a reason string and (where resolvable) an evidence ref.
const anchorEntities = [
	entity("searchbox", { ref: "pi-ref://control/q", editable: true }),
	entity("grid", { kind: "region", ref: "pi-ref://region/grid" }),
	entity("tablist", { kind: "region", ref: "pi-ref://region/tablist" }),
	entity("tab", { ref: "pi-ref://control/tab1" }),
	entity("tab", { ref: "pi-ref://control/tab2" }),
	entity("dialog", { kind: "region", ref: "pi-ref://region/dlg" }),
	entity("alert", { kind: "region", ref: "pi-ref://region/alert" }),
];
const anchorResult = buildInferenceSummary(anchorEntities, emptyRel());
for (const i of anchorResult.intents) {
	assert.equal(typeof i.reason, "string", `${i.intent} carries a reason`);
	assert.ok(i.reason.length > 0, `${i.intent} reason non-empty`);
}
const anchorBy = (intent) => anchorResult.intents.find((i) => i.intent === intent);
assert.equal(anchorBy("search")?.evidence?.searchRef, "pi-ref://control/q", "search anchored to searchRef");
assert.equal(anchorBy("data-grid")?.evidence?.gridRef, "pi-ref://region/grid", "data-grid anchored to gridRef");
assert.equal(anchorBy("tabbed-interface")?.evidence?.tablistRef, "pi-ref://region/tablist", "tabbed-interface anchored to tablistRef");
assert.deepEqual(anchorBy("tabbed-interface")?.evidence?.tabRefs, ["pi-ref://control/tab1", "pi-ref://control/tab2"], "tab refs collected");
assert.equal(anchorBy("dialog")?.evidence?.dialogRef, "pi-ref://region/dlg", "dialog anchored to dialogRef");
assert.equal(anchorBy("alert-region")?.evidence?.regionRef, "pi-ref://region/alert", "alert-region anchored to regionRef");
assert.equal(anchorBy("alert-region")?.evidence?.live, "assertive", "alert → assertive live");

// Decoupling: count-only detection fires even when no entity resolves (evidence omitted).
const decoupled = buildInferenceSummary([], relWith({ tableCells: 60, expandedTarget: 2, currentIn: 1 }));
assert.ok(decoupled.intents.some((i) => i.intent === "data-grid"), "data-grid fires from count alone");
assert.ok(decoupled.intents.some((i) => i.intent === "expandable"), "expandable fires from count alone");
assert.ok(decoupled.intents.some((i) => i.intent === "navigation"), "navigation fires from count alone");

// ── Budget immunity: inference survives to envelope top-level ─────────────────

const envelopeSummary = {
	abmlIntegrated: true,
	focus: {
		gist: { landmarks: ["main"], controlCount: 3, containerCount: 1 },
		outline: [{ container: "tablist", name: "Settings", memberCount: 3, controlCount: 3, memberRefs: ["a", "b", "c"] }],
		relations: { summary: { tableCells: 50, currentIn: 1 }, highlights: [] },
		inference: { intents: [{ intent: "data-grid", confidence: "high" }, { intent: "tabbed-interface", confidence: "high" }, { intent: "alert-region", confidence: "high" }] },
		primary_entities: [{ ref: "pi-ref://control/1", kind: "control", role: "tab", name: "Settings" }],
	},
};
const result = await distilledTextResult("body", {
	toolName: "browser_observe", command: "scan", detailLevel: "summary",
	maxChars: 4_000, fallbackName: "observe-scan", summary: envelopeSummary,
});
const envelope = JSON.parse(result.content[0].text);
assert.ok(typeof envelope.inference === "object" && envelope.inference !== null, "inference at envelope top-level");
assert.ok(Array.isArray(envelope.inference.intents) && envelope.inference.intents.length === 3, "3 intents present");
assert.ok(envelope.inference.intents.some((i) => i.intent === "tabbed-interface"), "tabbed-interface in envelope");
assert.ok(envelope.inference.intents.some((i) => i.intent === "alert-region"), "alert-region in envelope");

// Budget-squeeze survival
const tightResult = await distilledTextResult("body", {
	toolName: "browser_observe", command: "scan", detailLevel: "summary", maxChars: 3_000, fallbackName: "observe-scan",
	summary: {
		abmlIntegrated: true,
		focus: {
			gist: { landmarks: ["main"], controlCount: 50 },
			outline: [{ container: "tablist", name: "Big", memberCount: 50, memberRefs: [] }],
			relations: { summary: { tableCells: 200 }, highlights: [] },
			inference: { intents: [{ intent: "data-grid", confidence: "high" }, { intent: "tabbed-interface", confidence: "high" }] },
			primary_entities: Array.from({ length: 30 }, (_, i) => ({ ref: `pi-ref://control/${i}`, kind: "control", role: "tab", name: `tab ${i} ${"pad ".repeat(60)}` })),
		},
	},
});
const tightEnvelope = JSON.parse(tightResult.content[0].text);
assert.ok(typeof tightEnvelope.inference === "object", "inference survives budget squeeze");
assert.ok(tightEnvelope.inference?.intents?.some((i) => i.intent === "tabbed-interface"), "tabbed-interface intact under tight budget");

// ── Static wiring guards ──────────────────────────────────────────────────────

const observeSrc = readRepo("src/tools/observeRunners.ts");
assert.ok(observeSrc.includes("buildInferenceSummary") && observeSrc.includes("inference:"), "observeRunners wires inference");

const middlewareSrc = readRepo("src/tools/resultMiddleware.ts");
assert.ok(middlewareSrc.includes("envelopeInference") && middlewareSrc.includes("inference?"), "resultMiddleware lifts inference");

const schemasSrc = readRepo("src/tools/summaries/outputSchemas.ts");
assert.ok(schemasSrc.includes("InferenceSummarySchema"), "InferenceSummarySchema exported");

const inferenceSrc = readRepo("src/abml-core/inference.ts");
assert.ok(inferenceSrc.includes("tabbed-interface") && inferenceSrc.includes("alert-region") && inferenceSrc.includes("form-dependency"), "new intents in inference.ts");
assert.ok(inferenceSrc.includes("evidence?") && inferenceSrc.includes("reason?"), "evidence + reason fields on DetectedIntent");
assert.ok(inferenceSrc.includes("EXPANDABLE_THRESHOLD") && inferenceSrc.includes("MAX_EVIDENCE_REFS"), "expandable threshold + evidence cap constants");

const schemaReasonSrc = readRepo("src/tools/summaries/outputSchemas.ts");
assert.ok(schemaReasonSrc.includes("reason: Type.Optional"), "InferenceSummarySchema exposes optional reason");

const scanSrc = readRepo("src/scan/buildScanScript.ts");
assert.ok(scanSrc.includes("inputKind"), "scan captures inputKind");

const pkg = JSON.parse(readRepo("package.json"));
assert.ok(pkg.scripts?.["check:abml-inference"]?.includes("check-abml-inference.mjs"), "check:abml-inference script present");

console.log(`abml inference ok — 12 patterns + evidence anchoring (every intent → reason + actionable refs: searchRef/gridRef/tablistRef/dialogRef/regionRef/triggerRefs/tableRef/...); count-only detection decoupled from evidence; grouped multi-choice high; expandable threshold=2; budget-immune; all static wiring verified`);
