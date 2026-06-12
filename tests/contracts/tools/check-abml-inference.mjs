// ABML R2 inference layer contract.
//
// Verifies the full inference pipeline end-to-end without a browser: all 12 PageIntent
// patterns detected from their canonical triggers, plus reliability hardening (evidence field,
// grouped multi-choice confidence, resolved expandable triggers, visibility gating,
// tabbed-interface, alert-region, form-dependency from temporal diff).
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
		...(opts.name !== undefined ? { name: opts.name } : {}),
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: opts.editable ?? false, inViewport: true, ...(opts.state ?? {}) },
		source: "dom",
		...(opts.structure ? { structure: opts.structure } : {}),
		...(opts.hints ? { hints: opts.hints } : {}),
		...(opts.relations ? { relations: opts.relations } : {}),
	};
}
function emptyRel() { return { summary: {}, highlights: [] }; }
function relWith(counts) { return { summary: counts, highlights: [] }; }
const kinds = (result) => result.intents.map((i) => i.intent);

// ── All 12 pattern families ───────────────────────────────────────────────────

// login (P2: evidence.submitRef)
const loginEntities = [
	entity("textbox", { editable: true, hints: { inputKind: "password" } }),
	entity("button", { ref: "pi-ref://control/passkey", name: "passkey-login-button" }),
	entity("button", { ref: "pi-ref://control/submit-btn", name: "Sign in" }),
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
	entity("link", { ref: "pi-ref://control/filter-hp", name: "Apply HP filter" }),
	entity("link", { ref: "pi-ref://control/filter-lenovo", name: "Apply Lenovo filter" }),
	entity("link", { ref: "pi-ref://control/filter-dell", name: "Apply Dell filter" }),
];
const filterResult = buildInferenceSummary(filterEntities, emptyRel());
assert.ok(kinds(filterResult).includes("filter-panel"), "filter-panel detected");
assert.ok(!kinds(filterResult).includes("search"), "search suppressed");
assert.deepEqual(filterResult.intents.find((i) => i.intent === "filter-panel")?.evidence?.controlRefs, ["pi-ref://control/filter-hp", "pi-ref://control/filter-lenovo", "pi-ref://control/filter-dell"], "filter-panel anchored to filter controls");

const plainSearchForm = buildInferenceSummary([
	entity("region", { kind: "region", structure: { landmark: "search" } }),
	entity("textbox", { editable: true }),
	entity("combobox", { editable: true, ref: "pi-ref://control/combo" }),
], emptyRel());
assert.ok(!kinds(plainSearchForm).includes("filter-panel"), "plain search form is not a filter-panel");
assert.ok(kinds(plainSearchForm).includes("search"), "plain search form remains search");

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

// expandable (P1: threshold >= 2, not 1; R2.1: requires resolved trigger refs)
const expandableTriggers = [
	entity("button", { ref: "pi-ref://control/acc1", relations: [{ type: "expandedTarget", targetRef: "pi-ref://region/p1", source: "dom", confidence: "high" }] }),
	entity("button", { ref: "pi-ref://control/acc2", relations: [{ type: "expandedTarget", targetRef: "pi-ref://region/p2", source: "dom", confidence: "high" }] }),
];
assert.ok(kinds(buildInferenceSummary(expandableTriggers, relWith({ expandedTarget: 2 }))).includes("expandable"), "expandable at 2 with resolved triggers");
assert.ok(!kinds(buildInferenceSummary([], relWith({ expandedTarget: 2 }))).includes("expandable"), "count-only expandable suppressed");
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

// alert-region post-action (R3 diff): a live region that appeared / whose name changed is fresh feedback
const arAppeared = buildInferenceSummary([entity("status", { kind: "region", ref: "pi-ref://region/toast" })], emptyRel(), { appeared: ["pi-ref://region/toast"], disappeared: [], changed: [] });
assert.equal(arAppeared.intents.find((i) => i.intent === "alert-region")?.evidence?.fresh, "appeared", "alert-region flags fresh=appeared from R3 diff appeared");
const arUpdated = buildInferenceSummary([entity("alert", { kind: "region", ref: "pi-ref://region/err" })], emptyRel(), { appeared: [], disappeared: [], changed: [{ ref: "pi-ref://region/err", kind: "name-changed", before: {}, after: { name: "Error" } }] });
assert.equal(arUpdated.intents.find((i) => i.intent === "alert-region")?.evidence?.fresh, "updated", "alert-region flags fresh=updated from R3 diff name-changed");

// form-dependency (R3: disabled→enabled + focused editable field)
const depEntities = [
	entity("textbox", { ref: "pi-ref://control/email", editable: true, state: { focused: true } }),
	entity("button", { ref: "pi-ref://control/submit", state: { disabled: false } }),
];
const depResult = buildInferenceSummary(depEntities, emptyRel(), { appeared: [], disappeared: [], changed: [{ ref: "pi-ref://control/submit", kind: "state-changed", before: { disabled: true }, after: { disabled: false } }], focusedRef: "pi-ref://control/email" });
assert.equal(depResult.intents.find((i) => i.intent === "form-dependency")?.evidence?.enabledRef, "pi-ref://control/submit", "form-dependency detected from R3 diff");
assert.equal(depResult.intents.find((i) => i.intent === "form-dependency")?.evidence?.requiredRef, "pi-ref://control/email", "form-dependency requiredRef set");
assert.equal(depResult.intents.find((i) => i.intent === "form-dependency")?.evidence?.focusSignal, "focusedRef", "focusedRef signal preferred");

const depGainedFocus = buildInferenceSummary(depEntities, emptyRel(), { appeared: [], disappeared: [], changed: [
	{ ref: "pi-ref://control/submit", kind: "state-changed", before: { disabled: true }, after: { disabled: false } },
	{ ref: "pi-ref://control/email", kind: "state-changed", before: { focused: false }, after: { focused: true } },
] });
assert.equal(depGainedFocus.intents.find((i) => i.intent === "form-dependency")?.evidence?.requiredRef, "pi-ref://control/email", "form-dependency falls back to editable gained-focus transition");
assert.equal(depGainedFocus.intents.find((i) => i.intent === "form-dependency")?.confidence, "high", "gained-focus fallback remains high confidence");
assert.equal(depGainedFocus.intents.find((i) => i.intent === "form-dependency")?.evidence?.focusSignal, "focus-gained", "gained-focus signal exposed");

const depLostFocus = buildInferenceSummary([
	entity("textbox", { ref: "pi-ref://control/email", editable: true, state: { focused: false } }),
	entity("button", { ref: "pi-ref://control/submit", state: { disabled: false } }),
], emptyRel(), { appeared: [], disappeared: [], changed: [
	{ ref: "pi-ref://control/submit", kind: "state-changed", before: { disabled: true }, after: { disabled: false } },
	{ ref: "pi-ref://control/email", kind: "state-changed", before: { focused: true }, after: { focused: false } },
] });
assert.equal(depLostFocus.intents.find((i) => i.intent === "form-dependency")?.evidence?.requiredRef, "pi-ref://control/email", "form-dependency falls back to editable lost-focus transition");
assert.equal(depLostFocus.intents.find((i) => i.intent === "form-dependency")?.confidence, "medium", "lost-focus fallback is medium confidence");
assert.equal(depLostFocus.intents.find((i) => i.intent === "form-dependency")?.evidence?.focusSignal, "focus-lost", "lost-focus signal exposed");

const depAmbiguous = buildInferenceSummary([
	entity("textbox", { ref: "pi-ref://control/email", editable: true, state: { focused: true } }),
	entity("textbox", { ref: "pi-ref://control/name", editable: true, state: { focused: true } }),
	entity("button", { ref: "pi-ref://control/submit", state: { disabled: false } }),
], emptyRel(), { appeared: [], disappeared: [], changed: [
	{ ref: "pi-ref://control/submit", kind: "state-changed", before: { disabled: true }, after: { disabled: false } },
	{ ref: "pi-ref://control/email", kind: "state-changed", before: { focused: false }, after: { focused: true } },
	{ ref: "pi-ref://control/name", kind: "state-changed", before: { focused: false }, after: { focused: true } },
] });
assert.ok(!depAmbiguous.intents.some((i) => i.intent === "form-dependency"), "ambiguous editable focus transitions are suppressed");

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

// Decoupling: table/navigation count-only detection still fires; expandable now needs anchors.
const decoupled = buildInferenceSummary([], relWith({ tableCells: 60, expandedTarget: 2, currentIn: 1 }));
assert.ok(decoupled.intents.some((i) => i.intent === "data-grid"), "data-grid fires from count alone");
assert.ok(!decoupled.intents.some((i) => i.intent === "expandable"), "expandable count-only suppressed");
assert.ok(decoupled.intents.some((i) => i.intent === "navigation"), "navigation fires from count alone");

// ── inference is NO LONGER an agent-facing envelope field (removed 2026-06-05) ────
// A real-agent eval showed envelope.inference (intent labels) was unread; the inference ENGINE stays
// (it still feeds referenced_entities + evidence-ref promotion below), but the budget-immune output
// field was cut to save tokens.

const envelopeSummary = {
	abmlIntegrated: true,
	focus: {
		gist: { landmarks: ["main"], controlCount: 3, containerCount: 1 },
		relations: { summary: { tableCells: 50, currentIn: 1 }, highlights: [] },
		inference: { intents: [{ intent: "data-grid", confidence: "high" }, { intent: "tabbed-interface", confidence: "high" }] },
		primary_entities: [{ ref: "pi-ref://control/1", kind: "control", role: "tab", name: "Settings" }],
	},
};
const result = await distilledTextResult("body", {
	toolName: "browser_observe", command: "scan", detailLevel: "summary",
	maxChars: 4_000, fallbackName: "observe-scan", summary: envelopeSummary,
});
const envelope = JSON.parse(result.content[0].text);
assert.equal(envelope.inference, undefined, "inference is no longer lifted to the envelope (output field removed)");

const evidenceEntityResult = await distilledTextResult("body", {
	toolName: "browser_observe", command: "scan", detailLevel: "summary", maxChars: 2_500, fallbackName: "observe-scan",
	summary: {
		abmlIntegrated: true,
		focus: {
			inference: { intents: [{ intent: "login", confidence: "high", evidence: { submitRef: "pi-ref://control/submit-hidden" } }] },
			primary_entities: Array.from({ length: 20 }, (_, i) => ({ ref: `pi-ref://control/noise-${i}`, kind: "control", role: "button", name: `noise ${i} ${"pad ".repeat(30)}`, state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true }, source: "dom" })),
			list_entities: [],
			visual_regions: [],
			referenced_entities: [{ ref: "pi-ref://control/submit-hidden", kind: "control", role: "button", name: "Sign in", state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true }, source: "dom" }],
		},
	},
});
const evidenceEntityEnvelope = JSON.parse(evidenceEntityResult.content[0].text);
assert.equal(evidenceEntityEnvelope.entities?.[0]?.ref, "pi-ref://control/submit-hidden", "inference evidence entity is promoted into envelope.entities before salience noise");

// ── Static wiring guards ──────────────────────────────────────────────────────

const observeSrc = readRepo("src/tools/observe/scanRunner.ts");
const baselineSrc = readRepo("src/tools/observe/baseline.ts");
assert.ok(observeSrc.includes("buildInferenceSummary") && observeSrc.includes("const inference"), "observeRunners wires inference");
assert.ok(observeSrc.includes("entitiesForInferenceEvidence") && observeSrc.includes("referenced_entities"), "observeRunners carries inference evidence entities into referenced_entities");
assert.ok(baselineSrc.includes("savedArtifactPathFromBaseline") && baselineSrc.includes("baseline saved artifact"), "observeRunners prefers full saved baseline artifacts over capped envelope entities");

const middlewareSrc = readRepo("src/tools/resultMiddleware.ts");
assert.ok(!middlewareSrc.includes("envelopeInference"), "resultMiddleware no longer lifts inference to the envelope");
assert.ok(middlewareSrc.includes("referenced_entities") && middlewareSrc.includes("inferenceEvidenceRefs"), "resultMiddleware promotes inference evidence entities");

const schemasSrc = readRepo("src/tools/summaries/outputSchemas.ts");
assert.ok(schemasSrc.includes("InferenceSummarySchema"), "InferenceSummarySchema exported");

const inferenceSrc = readRepo("src/abml-core/inference.ts");
assert.ok(inferenceSrc.includes("tabbed-interface") && inferenceSrc.includes("alert-region") && inferenceSrc.includes("form-dependency"), "new intents in inference.ts");
assert.ok(inferenceSrc.includes("evidence?") && inferenceSrc.includes("reason?"), "evidence + reason fields on DetectedIntent");
assert.ok(inferenceSrc.includes("editableFocusTransition") && inferenceSrc.includes("focusSignal"), "form-dependency has robust focus-transition fallback");
assert.ok(inferenceSrc.includes("EXPANDABLE_THRESHOLD") && inferenceSrc.includes("MAX_EVIDENCE_REFS"), "expandable threshold + evidence cap constants");
assert.ok(inferenceSrc.includes("inferenceEvidenceRefs") && inferenceSrc.includes("entitiesForInferenceEvidence"), "inference evidence ref helpers exported");

const schemaReasonSrc = readRepo("src/tools/summaries/outputSchemas.ts");
assert.ok(schemaReasonSrc.includes("reason: Type.Optional"), "InferenceSummarySchema exposes optional reason");

const scanSrc = readRepo("src/scan/buildScanScript.ts");
const scanCaptureSrc = readRepo("capture-src/entries/scanTemplate.ts");
const scanBundleSrc = readRepo("src/capture/generated/scanBundle.ts");
assert.ok(scanSrc.includes("SCAN_TEMPLATE") && scanSrc.includes("renderCaptureTemplate"), "scan builder must stay a thin capture-template injection wrapper");
assert.ok(scanCaptureSrc.includes("inputKind"), "capture scan source captures inputKind");
assert.ok(scanBundleSrc.includes("inputKind"), "generated scan bundle preserves inputKind capture");

const pkg = JSON.parse(readRepo("package.json"));
assert.ok(pkg.scripts?.["check:abml-inference"]?.includes("check-abml-inference.mjs"), "check:abml-inference script present");

console.log(`abml inference ok — 12 patterns + hardened evidence anchoring (login scorer, filter controls, visible dialog/tab/live regions, post-action live-region freshness, resolved expandable triggers); grouped multi-choice high; expandable threshold=2; ENGINE-only (feeds referenced_entities + evidence-ref promotion; envelope.inference output field removed 2026-06-05); all static wiring verified`);
