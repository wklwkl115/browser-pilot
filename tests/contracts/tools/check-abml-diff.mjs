// ABML R3 runtime-events/diff contract.
//
// Locks the pull-model temporal layer without a browser:
// - pure diffEntities detects appeared/disappeared/state/name/focus
// - runAbmlRead threads baseline → diff
// - inference consumes diff for form-dependency facts
// - browser_observe/result middleware can lift diff to envelope top-level
// - stable pi-ref registration lets same-page snapshots match by ref
// - static wiring keeps observe baseline + envelope diff + schema/script in place
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { diffEntities, summarizeEntityDiff } from "../../../src/abml-core/diff.ts";
import { buildInferenceSummary } from "../../../src/abml-core/inference.ts";
import { runAbmlRead } from "../../../src/abml-core/verbs/read.ts";
import { registerRefDescriptor, resolveRefUriDetailed, clearResourceStore } from "../../../src/resources/resourceStore.ts";
import { distilledTextResult } from "../../../src/tools/resultMiddleware.ts";
import { EntityDiffSchema } from "../../../src/tools/summaries/outputSchemas.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

function entity(ref, opts = {}) {
	return {
		ref,
		kind: opts.kind ?? "control",
		role: opts.role ?? "button",
		...(opts.name !== undefined ? { name: opts.name } : {}),
		...(opts.value !== undefined ? { value: opts.value } : {}),
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true, ...(opts.state ?? {}) },
		source: opts.source ?? "dom",
		...(opts.hints ? { hints: opts.hints } : {}),
	};
}

const before = [
	entity("pi-ref://control/email", { role: "textbox", state: { editable: true, focused: false } }),
	entity("pi-ref://control/submit", { name: "Continue", state: { disabled: true } }),
	entity("pi-ref://control/old", { role: "button" }),
];
const after = [
	entity("pi-ref://control/email", { role: "textbox", state: { editable: true, focused: true } }),
	entity("pi-ref://control/submit", { name: "Submit", state: { disabled: false } }),
	entity("pi-ref://control/new", { role: "button" }),
];

const diff = diffEntities(before, after);
assert.deepEqual(diff.appeared, ["pi-ref://control/new"], "appeared refs detected");
const partialDiff = diffEntities([before[1]], after, { partialBaseline: true });
assert.deepEqual(partialDiff.appeared, [], "partial baseline suppresses unmatched appeared refs");
assert.ok(partialDiff.changed.some((c) => c.ref === "pi-ref://control/submit" && c.kind === "state-changed"), "partial baseline still reports tracked state changes");
assert.deepEqual(diff.disappeared, ["pi-ref://control/old"], "disappeared refs detected");
assert.equal(diff.focusedRef, "pi-ref://control/email", "focusedRef from after snapshot");
assert.ok(diff.changed.some((c) => c.ref === "pi-ref://control/submit" && c.kind === "state-changed" && c.before?.disabled === true && c.after?.disabled === false), "disabled true→false state delta detected");
assert.ok(diff.changed.some((c) => c.ref === "pi-ref://control/submit" && c.kind === "name-changed" && c.before?.name === "Continue" && c.after?.name === "Submit"), "name delta detected");
assert(Value.Check(EntityDiffSchema, diff), `EntityDiffSchema validates diff: ${JSON.stringify([...Value.Errors(EntityDiffSchema, diff)].slice(0, 5))}`);

const suggestionBefore = [entity("pi-ref://control/search", { role: "searchbox", value: "A" })];
const suggestionAfter = [
	entity("pi-ref://control/search", { role: "searchbox", value: "B", state: { focused: true } }),
	...Array.from({ length: 8 }, (_, i) => entity(`pi-ref://text/suggest-${i}`, { kind: "text", role: "StaticText", name: `Suggestion ${i}` })),
];
const suggestionDiff = diffEntities(suggestionBefore, suggestionAfter);
const suggestionSalience = summarizeEntityDiff(suggestionDiff, suggestionBefore, suggestionAfter);
assert.equal(suggestionSalience.items[0].kind, "changed", "salience leads with semantic value change");
assert.equal(suggestionSalience.items[0].ref, "pi-ref://control/search");
assert.equal(suggestionSalience.items.at(-1)?.kind, "churn", "appeared/disappeared churn summarized after changed items");
const tieSalience = summarizeEntityDiff(diffEntities([
	entity("pi-ref://control/b", { state: { disabled: true } }),
	entity("pi-ref://control/a", { state: { disabled: true } }),
], [
	entity("pi-ref://control/b", { state: { disabled: false } }),
	entity("pi-ref://control/a", { state: { disabled: false } }),
]));
assert.deepEqual(tieSalience.items.slice(0, 2).map((item) => item.ref), ["pi-ref://control/a", "pi-ref://control/b"], "equal-score diff salience uses deterministic codepoint order");

const read = await runAbmlRead({ plane: "structure", baseline: before }, async () => ({ entities: after }));
assert.equal(read.ok, true, "runAbmlRead with baseline succeeds");
assert.deepEqual(read.diff, diff, "runAbmlRead threads baseline through diffEntities");

const inference = buildInferenceSummary(after, { summary: {}, highlights: [] }, diff);
const dep = inference.intents.find((i) => i.intent === "form-dependency");
assert.equal(dep?.evidence?.enabledRef, "pi-ref://control/submit", "form-dependency evidence exposes enabledRef");
assert.equal(dep?.evidence?.requiredRef, "pi-ref://control/email", "form-dependency evidence exposes requiredRef");
assert.equal(dep?.evidence?.focusSignal, "focusedRef", "form-dependency evidence exposes focus signal");

const envelopeResult = await distilledTextResult("body", {
	toolName: "browser_observe",
	command: "scan",
	detailLevel: "summary",
	maxChars: 3_000,
	fallbackName: "observe-scan",
	summary: {
		abmlIntegrated: true,
		diff: { ...diff, summary: summarizeEntityDiff(diff, before, after) },
		focus: {
			gist: { landmarks: ["main"], controlCount: 2, containerCount: 1 },
			relations: { summary: {}, highlights: [] },
			inference,
			primary_entities: after,
		},
	},
});
const envelope = JSON.parse(envelopeResult.content[0].text);
assert.equal(envelope.diff.focusedRef, "pi-ref://control/email", "diff lifted to envelope top-level");
assert.equal(envelope.diff.summary.items[0].kind, "changed", "diff salience summary survives envelope lift");
assert.equal(inference.intents.find((i) => i.intent === "form-dependency")?.evidence?.enabledRef, "pi-ref://control/submit", "form-dependency detected by the inference engine");
assert.equal(envelope.inference, undefined, "inference is no longer lifted to the envelope (output field removed 2026-06-05)");

clearResourceStore();
const now = Date.now();
const descriptor = {
	kind: "control",
	locators: [{ by: "css", value: "#submit" }],
	owner: { browserSessionId: "s1", tabId: 7, topLevelOrigin: "https://example.test" },
	policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true },
	semantic: { role: "button", name: "Submit" },
	observationId: "snap-a",
	documentEpoch: { url: "https://example.test/form", capturedAt: now },
	createdAt: now,
	ttlMs: 60_000,
};
const stableA = registerRefDescriptor({ descriptor, name: "Submit" });
const stableB = registerRefDescriptor({ descriptor: { ...descriptor, observationId: "snap-b", createdAt: now + 1, documentEpoch: { url: "https://example.test/form", capturedAt: now + 1 } }, name: "Submit" });
assert.equal(stableA, stableB, "same-page same-locator descriptor gets stable pi-ref across snapshots");
assert(resolveRefUriDetailed(stableA).ok, "stable ref remains resolvable after re-registration");
clearResourceStore();

// Static wiring guards.
const coreBoundarySrc = readRepo("tests/contracts/drift/check-abml-core-boundary.mjs");
assert.ok(coreBoundarySrc.includes('"diff.ts"'), "diff.ts must be classified in ABML pure core boundary");
const barrelSrc = readRepo("src/abml-core/index.ts");
assert.ok(barrelSrc.includes('./diff.js'), "abml-core barrel must export diff");
const observeSrc = readRepo("src/tools/observe/scanRunner.ts");
assert.ok(observeSrc.includes("resolveBaselineEntities") && observeSrc.includes("partialBaseline") && observeSrc.includes("abmlRead.diff") && observeSrc.includes("summarizeEntityDiff") && /buildInferenceSummary\((abmlEntities|attributedEntities), relSummary, abmlDiff\)/.test(observeSrc), "observeRunners must thread baseline → readStructure → diff → inference with partial-baseline support and salience");
const observeToolSrc = readRepo("src/tools/registerObserveTool.ts");
assert.ok(observeToolSrc.includes("baseline") && observeToolSrc.includes("baseline diff is only valid for scan mode"), "browser_observe schema must expose scan-only baseline");
const middlewareSrc = readRepo("src/tools/resultMiddleware.ts");
assert.ok(middlewareSrc.includes("envelopeDiff") && middlewareSrc.includes("diff?"), "resultMiddleware must lift diff to top-level envelope");
const schemaSrc = readRepo("src/tools/summaries/outputSchemas.ts");
assert.ok(schemaSrc.includes("EntityDiffSchema"), "outputSchemas must export EntityDiffSchema");
const integrationSrc = readRepo("src/abml/verbs/integration.ts");
assert.ok(integrationSrc.includes("baseline") && integrationSrc.includes("diffOptions") && integrationSrc.includes("runtime.read"), "ABML integration helper must accept baseline + diffOptions");
const resourceSrc = readRepo("src/resources/resourceStore.ts");
const refIdSrc = readRepo("src/abml-core/refId.ts");
assert.ok(resourceSrc.includes("stableRefIdForDescriptor") && refIdSrc.includes("stableHash24"), "resourceStore must mint stable refs for snapshot diff matching");
const pkg = JSON.parse(readRepo("package.json"));
assert.ok(pkg.scripts?.["check:abml-diff"]?.includes("check-abml-diff.mjs"), "package must expose check:abml-diff");

console.log(`abml diff ok — appeared=${diff.appeared.length}, disappeared=${diff.disappeared.length}, changed=${diff.changed.length}, focusedRef=${diff.focusedRef}; envelope diff + form-dependency wired`);
