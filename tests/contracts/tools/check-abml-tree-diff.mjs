// ABML mechanism arm — M2a living tree-diff contract.
//
// Verifies template-level O(change) structure diff without changing pi-ref minting:
//   - pure-core semantic matching over ARIA-grounded template groups;
//   - reorder/insert/change behavior over a repeated list;
//   - budget-immune envelope.treeDiff lift;
//   - static wiring into browser_observe baseline path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTreeDiff } from "../../../src/abml-core/treeDiff.ts";
import { distilledTextResult } from "../../../src/tools/resultMiddleware.ts";
import { PURE_CORE } from "../drift/abml-core-manifest.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");
const st = (o = {}) => ({ visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true, ...o });
const item = (ref, name, index, o = {}) => ({
	ref,
	kind: o.kind || "control",
	role: o.role || "link",
	name,
	...(o.value !== undefined ? { value: o.value } : {}),
	state: st(o.state),
	source: "ax",
	structure: { posInSet: index, setSize: o.setSize || 8 },
	hints: { containerRole: o.container || "list", containerName: o.containerName || "Products" },
});
const list = (names, prefix) => names.map((name, i) => item(`pi-ref://control/${prefix}${i}`, name, i + 1));

// Reorder of a semantic-name stable list must be a reorder, not N disappear/appear pairs.
const reordered = buildTreeDiff(list(["Alpha", "Bravo", "Charlie", "Delta", "Echo"], "b"), list(["Charlie", "Alpha", "Bravo", "Delta", "Echo"], "a"));
assert.equal(reordered.summary.appeared, 0, "reorder must not look like appeared instances");
assert.equal(reordered.summary.disappeared, 0, "reorder must not look like disappeared instances");
assert.equal(reordered.summary.reordered, 1, "reorder is represented structurally");
assert.equal(reordered.templates[0].reordered.commonCount, 5);

// Insert is O(change): one appeared instance, not a re-emission of the whole list.
const inserted = buildTreeDiff(list(["Alpha", "Bravo", "Charlie", "Delta"], "b"), list(["Alpha", "Bravo", "Charlie", "Delta", "Echo"], "a"));
assert.equal(inserted.summary.appeared, 1);
assert.equal(inserted.templates[0].appeared.instances[0].name, "Echo");
assert.equal(inserted.templates[0].appeared.instances[0].confidence, "high");
assert.deepEqual(inserted.summary.sample?.appeared, ["Echo"], "summary.sample surfaces the appeared item name at the summary level (no drilling into templates[].instances)");

// Field changes are attached to the semantic instance key.
const before = list(["Alpha", "Bravo", "Charlie", "Delta"], "b");
const after = list(["Alpha", "Bravo", "Charlie", "Delta"], "a");
after[2] = { ...after[2], value: "updated", state: st({ selected: true }) };
const changed = buildTreeDiff(before, after);
assert.equal(changed.summary.changed, 1);
assert.equal(changed.templates[0].changed.instances[0].key, "name:charlie");
assert.deepEqual(changed.templates[0].changed.instances[0].fields.map((field) => field.field), ["value", "selected"]);
assert.equal(changed.templates[0].changed.instances[0].fieldCount, 2, "changed fieldCount exposes total changed fields");
assert.equal(changed.templates[0].changed.instances[0].fieldsTruncated, undefined, "fieldsTruncated omitted when fields are complete");
assert.ok(changed.summary.sample?.changed?.includes("Charlie"), "summary.sample surfaces the changed item name at the summary level");

// Partial baselines are explicit: treeDiff needs a full baseline.
const partial = buildTreeDiff(before, after, { partialBaseline: true });
assert.equal(partial.summary.partialBaseline, true);
assert.equal(partial.templates.length, 0);

// Budget immunity: treeDiff survives resultMiddleware's summary squeeze.
const lifted = await distilledTextResult("body", {
	toolName: "browser_observe",
	command: "scan",
	detailLevel: "summary",
	maxChars: 2_500,
	fallbackName: "observe-scan",
	summary: {
		abmlIntegrated: true,
		treeDiff: inserted,
		focus: { primary_entities: Array.from({ length: 25 }, (_, i) => ({ ref: `pi-ref://control/${i}`, kind: "control", role: "link", name: `item ${i} ${"pad ".repeat(80)}` })) },
	},
});
const liftedEnv = JSON.parse(lifted.content[0].text);
assert.equal(liftedEnv.treeDiff.summary.appeared, 1, "treeDiff lifted to envelope top-level under tight budget");
assert.equal(liftedEnv.treeDiff.templates[0].appeared.instances[0].name, "Echo");

// Static wiring guards.
const observeSrc = readRepo("src/tools/observe/scanRunner.ts");
assert.ok(observeSrc.includes("buildTreeDiff") && observeSrc.includes("treeDiff:"), "observeRunners computes and attaches treeDiff");
const middlewareSrc = readRepo("src/tools/resultMiddleware.ts");
assert.ok(middlewareSrc.includes("envelopeTreeDiff") && middlewareSrc.includes("treeDiff?"), "resultMiddleware lifts treeDiff");
const treeDiffSrc = readRepo("src/abml-core/treeDiff.ts");
// B1 (kernel-opt 2026-06-10) moved descriptor derivation into the shared grouping engine;
// treeDiff must consume grouping.js rather than re-deriving descriptors locally.
assert.ok(treeDiffSrc.includes('from "./grouping.js"') && treeDiffSrc.includes("partialBaseline"), "treeDiff pure core consumes the shared grouping engine and handles partial baselines");
const groupingSrc = readRepo("src/abml-core/grouping.ts");
assert.ok(groupingSrc.includes("templateGroupDescriptorForEntity"), "grouping engine owns template group descriptor derivation");
assert.ok(PURE_CORE.includes("treeDiff.ts"), "treeDiff classified as pure core");
const pkg = JSON.parse(readRepo("package.json"));
assert.ok(pkg.scripts?.["check:abml-tree-diff"]?.includes("check-abml-tree-diff.mjs"), "check:abml-tree-diff script present");

console.log("abml tree-diff ok — M2a pure-core semantic template diff + budget-immune envelope.treeDiff + observe wiring verified; ref minting untouched");
