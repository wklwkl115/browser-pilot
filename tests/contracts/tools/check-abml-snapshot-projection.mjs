// ABML mechanism arm — M2c living snapshot projection contract.
//
// Verifies pure projection + budget-immune envelope lift + observe/artifact wiring. Projection must
// reuse ARIA-grounded templates/treeDiff; no public tool/protocol/action/ref behavior changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshotProjection } from "../../../src/abml-core/snapshotProjection.ts";
import { buildTreeDiff } from "../../../src/abml-core/treeDiff.ts";
import { distilledTextResult } from "../../../src/tools/resultMiddleware.ts";

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

const before = list(["Alpha", "Bravo", "Charlie", "Delta"], "b");
const after = list(["Alpha", "Bravo", "Charlie", "Delta", "Echo"], "a");
const treeDiff = buildTreeDiff(before, after);
const projection = buildSnapshotProjection(after, { treeDiff });

assert.equal(projection.summary.templateCount, 1, "one current template projected");
assert.equal(projection.summary.instanceCount, 5, "summary carries current instance count");
assert.equal(projection.summary.projectedInstanceRefCount, 5, "projection keeps capped handles");
assert.equal(projection.summary.appeared, 1, "summary carries treeDiff appeared count");
assert.equal(projection.templates[0].templateKey, treeDiff.templates[0].templateKey, "projection uses treeDiff-compatible template key");
assert.equal(projection.templates[0].container, "list");
assert.equal(projection.templates[0].containerName, "Products");
assert.equal(projection.templates[0].instanceRefCount, 5);
assert.deepEqual(projection.templates[0].varies, ["name"]);
assert.equal(projection.templates[0].delta?.appeared.instances[0].name, "Echo", "delta attached to affected template");
assert.equal(projection.templates[0].delta?.afterCount, 5);

const partialProjection = buildSnapshotProjection(after, { treeDiff: buildTreeDiff(before, after, { partialBaseline: true }) });
assert.equal(partialProjection.summary.partialBaseline, true, "partial baseline hint survives projection");
assert.equal(typeof partialProjection.summary.unavailable, "string", "partial baseline unavailable reason survives projection");

const big = Array.from({ length: 30 }, (_, i) => item(`pi-ref://control/x${i}`, `Item ${i}`, i + 1, { setSize: 30 }));
const bigProjection = buildSnapshotProjection(big);
assert.equal(bigProjection.templates[0].count, 30, "true count survives cap");
assert.ok(bigProjection.templates[0].instanceRefs.length < 30, "instanceRefs are capped");
assert.equal(bigProjection.templates[0].instanceRefCount, bigProjection.templates[0].instanceRefs.length, "capped handle count is explicit");

const noisyProjection = buildSnapshotProjection([
	...Array.from({ length: 12 }, (_, i) => item(`pi-ref://text/noise${i}`, `Noise ${i}`, i + 1, { role: "StaticText", kind: "text", container: "list", containerName: "Mixed" })),
	...Array.from({ length: 16 }, (_, i) => item(`pi-ref://element/li${i}`, `•`, i + 1, { role: "listitem", kind: "element", container: "list", containerName: "Mixed" })),
	...Array.from({ length: 4 }, (_, i) => item(`pi-ref://control/action${i}`, `Action ${i}`, i + 1, { role: "link", kind: "control", container: "list", containerName: "Mixed" })),
]);
assert.equal(noisyProjection.templates[0].kind, "control", "snapshotProjection must rank controls ahead of larger structural/text groups");
assert.equal(noisyProjection.templates[0].role, "link");
assert.equal(noisyProjection.templates[1].kind, "element", "non-text structural projection remains after controls");
assert.equal(noisyProjection.templates.some((template) => template.kind === "text" && template.containerName === "Mixed"), false, "redundant text-only projection is suppressed when a structural template shares the scope");

const lifted = await distilledTextResult("body", {
	toolName: "browser_observe",
	command: "scan",
	detailLevel: "summary",
	maxChars: 2_500,
	fallbackName: "observe-scan",
	summary: {
		abmlIntegrated: true,
		snapshotProjection: projection,
		focus: { primary_entities: Array.from({ length: 25 }, (_, i) => ({ ref: `pi-ref://control/${i}`, kind: "control", role: "link", name: `item ${i} ${"pad ".repeat(80)}` })) },
	},
});
const liftedEnv = JSON.parse(lifted.content[0].text);
assert.equal(liftedEnv.snapshotProjection.summary.appeared, 1, "snapshotProjection lifts to envelope under tight budget");
assert.equal(liftedEnv.snapshotProjection.templates[0].delta.appeared.instances[0].name, "Echo");

const observeSrc = readRepo("src/tools/observeRunners.ts");
assert.ok(observeSrc.includes("buildSnapshotProjection") && observeSrc.includes("snapshotProjection"), "observeRunners builds and persists snapshotProjection");
const middlewareSrc = readRepo("src/tools/resultMiddleware.ts");
assert.ok(middlewareSrc.includes("envelopeSnapshotProjection") && middlewareSrc.includes("snapshotProjection?"), "resultMiddleware lifts snapshotProjection");
const boundarySrc = readRepo("tests/contracts/drift/check-abml-core-boundary.mjs");
assert.ok(boundarySrc.includes('"snapshotProjection.ts"'), "snapshotProjection classified as pure core");
const pkg = JSON.parse(readRepo("package.json"));
assert.ok(pkg.scripts?.["check:abml-snapshot-projection"]?.includes("check-abml-snapshot-projection.mjs"), "check:abml-snapshot-projection script present");

console.log("abml snapshot projection ok — M2c pure projection + budget-immune envelope lift + observe/artifact wiring verified");
