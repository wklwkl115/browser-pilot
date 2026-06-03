// ABML R2 inference layer contract.
//
// Verifies the full inference pipeline end-to-end without a browser: a hand-built entity +
// relation set flows through buildInferenceSummary, and the result surfaces at the envelope
// top-level via the real distiller (budget-immune like gist/outline/relations). Asserts:
// - All 9 PageIntent patterns are detected from their canonical triggers.
// - inference.intents survives to the envelope top-level.
// - filter-panel supersedes search (no duplicate).
// - Static wiring: observeRunners imports buildInferenceSummary; resultMiddleware has
//   envelopeInference; InferenceSummarySchema is exported from outputSchemas.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInferenceSummary } from "../../../src/abml-core/inference.ts";
import { distilledTextResult } from "../../../src/tools/resultMiddleware.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── All 9 pattern families ─────────────────────────────────────────────────────

// login
const loginEntities = [
	entity("textbox", { editable: true, hints: { inputKind: "password" } }),
	entity("button"),
];
const loginResult = buildInferenceSummary(loginEntities, emptyRel());
assert.ok(kinds(loginResult).includes("login"), "login pattern detected");
assert.equal(loginResult.intents.find((i) => i.intent === "login")?.confidence, "high");

// search (high — searchbox role)
const searchResult = buildInferenceSummary([entity("searchbox", { editable: true })], emptyRel());
assert.ok(kinds(searchResult).includes("search"), "search (searchbox role) detected");

// filter-panel (supersedes search)
const filterEntities = [
	entity("region", { kind: "region", structure: { landmark: "search" } }),
	entity("textbox", { editable: true }),
	entity("combobox", { editable: true, ref: "pi-ref://control/combo" }),
];
const filterResult = buildInferenceSummary(filterEntities, emptyRel());
assert.ok(kinds(filterResult).includes("filter-panel"), "filter-panel detected");
assert.ok(!kinds(filterResult).includes("search"), "search not emitted when filter-panel fires");

// single-choice (radiogroup)
const scResult = buildInferenceSummary([entity("radiogroup", { kind: "region" })], emptyRel());
assert.ok(kinds(scResult).includes("single-choice"), "single-choice (radiogroup) detected");

// multi-choice (3+ checkboxes)
const mcResult = buildInferenceSummary([
	entity("checkbox"),
	entity("checkbox", { ref: "pi-ref://control/cb2" }),
	entity("checkbox", { ref: "pi-ref://control/cb3" }),
], emptyRel());
assert.ok(kinds(mcResult).includes("multi-choice"), "multi-choice (3 checkboxes) detected");

// expandable (expandedTarget relation)
const expResult = buildInferenceSummary([], relWith({ expandedTarget: 1 }));
assert.ok(kinds(expResult).includes("expandable"), "expandable detected");

// data-grid (tableCells relation)
const gridResult = buildInferenceSummary([], relWith({ tableCells: 8 }));
assert.ok(kinds(gridResult).includes("data-grid"), "data-grid detected");

// navigation (currentIn relation)
const navResult = buildInferenceSummary([], relWith({ currentIn: 1 }));
assert.ok(kinds(navResult).includes("navigation"), "navigation detected");

// dialog
const dialogResult = buildInferenceSummary([entity("dialog", { kind: "region" })], emptyRel());
assert.ok(kinds(dialogResult).includes("dialog"), "dialog detected");

// ── Budget immunity: inference survives to envelope top-level ─────────────────

const envelopeSummary = {
	abmlIntegrated: true,
	focus: {
		gist: { landmarks: ["main"], controlCount: 2, containerCount: 1 },
		outline: [{ container: "radiogroup", name: "Options", memberCount: 2, controlCount: 2, memberRefs: ["a", "b"] }],
		relations: { summary: { tableCells: 8, currentIn: 1 }, highlights: [] },
		inference: { intents: [{ intent: "data-grid", confidence: "high" }, { intent: "navigation", confidence: "high" }] },
		primary_entities: [{ ref: "pi-ref://control/1", kind: "control", role: "radio", name: "A" }],
	},
};
const result = await distilledTextResult("body", {
	toolName: "browser_observe",
	command: "scan",
	detailLevel: "summary",
	maxChars: 4_000,
	fallbackName: "observe-scan",
	summary: envelopeSummary,
});
const envelope = JSON.parse(result.content[0].text);
assert.ok(typeof envelope.inference === "object" && envelope.inference !== null, "inference surfaced at envelope top-level");
assert.ok(Array.isArray(envelope.inference.intents) && envelope.inference.intents.length === 2, "inference.intents present and correct length");
assert.equal(envelope.inference.intents[0].intent, "data-grid", "first intent is data-grid");

// Budget-squeeze survival: big summary still keeps inference at top-level.
const tightSummary = {
	abmlIntegrated: true,
	focus: {
		gist: { landmarks: ["main"], controlCount: 50 },
		outline: [{ container: "radiogroup", name: "Big", memberCount: 50, memberRefs: [] }],
		relations: { summary: { tableCells: 100 }, highlights: [] },
		inference: { intents: [{ intent: "data-grid", confidence: "high" }] },
		primary_entities: Array.from({ length: 30 }, (_, i) => ({ ref: `pi-ref://control/${i}`, kind: "control", role: "radio", name: `option ${i} ${"pad ".repeat(60)}` })),
	},
};
const tightResult = await distilledTextResult("body", {
	toolName: "browser_observe", command: "scan", detailLevel: "summary", maxChars: 3_000, fallbackName: "observe-scan",
	summary: tightSummary,
});
const tightEnvelope = JSON.parse(tightResult.content[0].text);
assert.ok(typeof tightEnvelope.inference === "object", "inference survives budget squeeze");
assert.equal(tightEnvelope.inference?.intents?.[0]?.intent, "data-grid", "inference.intents intact under tight budget");

// ── Static wiring guards ──────────────────────────────────────────────────────

const observeSrc = readRepo("src/tools/observeRunners.ts");
assert.ok(observeSrc.includes("buildInferenceSummary"), "observeRunners must import + call buildInferenceSummary");
assert.ok(observeSrc.includes("inference:"), "observeRunners must surface focus.inference");

const middlewareSrc = readRepo("src/tools/resultMiddleware.ts");
assert.ok(middlewareSrc.includes("envelopeInference"), "resultMiddleware must define envelopeInference");
assert.ok(middlewareSrc.includes("inference?"), "resultMiddleware DistilledEnvelope must declare inference?");

const schemasSrc = readRepo("src/tools/summaries/outputSchemas.ts");
assert.ok(schemasSrc.includes("InferenceSummarySchema"), "outputSchemas must export InferenceSummarySchema");

const inferenceSrc = readRepo("src/abml-core/inference.ts");
assert.ok(inferenceSrc.includes("buildInferenceSummary") && inferenceSrc.includes("PageIntent"), "inference.ts must declare buildInferenceSummary + PageIntent");

const scanSrc = readRepo("src/scan/buildScanScript.ts");
assert.ok(scanSrc.includes("inputKind"), "scan script must capture inputKind for INPUT elements");

const entitySrc = readRepo("src/abml-core/entity.ts");
assert.ok(entitySrc.includes("inputKind"), "entity builder must pass inputKind to hints");

const pkg = JSON.parse(readRepo("package.json"));
assert.ok(pkg.scripts?.["check:abml-inference"]?.includes("check-abml-inference.mjs"), "package must expose check:abml-inference");

console.log(`abml inference ok — login/search/filter-panel/single-choice/multi-choice/expandable/data-grid/navigation/dialog all detected; inference.intents at envelope top-level (budget-immune); static wiring verified`);
