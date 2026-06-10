// ABML mechanism arm — M1 structure templating contract.
//
// Verifies the large-page token-compression layer without a browser:
//   - pure-core selector: AX-container + aria-setsize grouping, MIN threshold, varies/constant field
//     split, instanceRefs cap + true count, sort, distinct-name no-collision, no-signal → no template;
//   - ENGINE-only: envelope.templates output field removed (2026-06-05); templating still feeds
//     treeDiff + snapshotProjection;
//   - static wiring: observeRunners no longer builds focus.templates, resultMiddleware no longer
//     lifts it; treeDiff/snapshotProjection still import templating; barrel + shim.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTemplateSummary, MIN_TEMPLATE_INSTANCES, MAX_TEMPLATE_INSTANCE_REFS, MAX_TEMPLATES } from "../../../src/abml-core/templating.ts";
import { distilledTextResult } from "../../../src/tools/resultMiddleware.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");
const st = (o = {}) => ({ visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true, ...o });
const item = (ref, o = {}) => ({
	ref, kind: o.kind || "control", role: o.role || "link",
	...(o.name !== undefined ? { name: o.name } : {}), ...(o.value !== undefined ? { value: o.value } : {}),
	state: st(o.state), source: "dom",
	...(o.setSize !== undefined ? { structure: { setSize: o.setSize } } : {}),
	...(o.container || o.containerName ? { hints: { ...(o.container ? { containerRole: o.container } : {}), ...(o.containerName ? { containerName: o.containerName } : {}) } } : {}),
});

// ── Pure-core selector ─────────────────────────────────────────────────────────

// AX container group ≥ MIN → one template; varies/constant/sample/instanceRefs.
const containerEntities = Array.from({ length: 5 }, (_, i) => item(`pi-ref://control/l${i}`, { role: "link", container: "list", containerName: "Results", name: `Item ${i}` }));
const ct = buildTemplateSummary(containerEntities).templates;
assert.equal(ct.length, 1, "one template for a 5-member container group");
assert.equal(ct[0].count, 5);
assert.equal(ct[0].container, "list");
assert.equal(ct[0].containerName, "Results");
assert.equal(ct[0].role, "link");
assert.deepEqual(ct[0].varies, ["name"], "names differ → varies");
assert.deepEqual(ct[0].constant, { role: "link", kind: "control" }, "role/kind constant");
assert.equal(ct[0].sample.ref, "pi-ref://control/l0");
assert.equal(ct[0].instanceRefs.length, 5);

// aria-setsize group (no AX container) folds, carries setSize, no container.
const setEntities = Array.from({ length: 6 }, (_, i) => item(`pi-ref://control/o${i}`, { role: "option", name: `Opt ${i}`, setSize: 6 }));
const setT = buildTemplateSummary(setEntities).templates;
assert.equal(setT.length, 1);
assert.equal(setT[0].setSize, 6);
assert.equal(setT[0].container, undefined, "setSize grouping has no AX container");

// MIN threshold: a sub-MIN group is not a template.
assert.equal(buildTemplateSummary(Array.from({ length: MIN_TEMPLATE_INSTANCES - 1 }, (_, i) => item(`r${i}`, { container: "list", name: `x${i}` }))).templates.length, 0, "below MIN → no template");

// varies/constant: uniform value + uniform truthy state → constant; default state omitted.
const varEntities = Array.from({ length: 4 }, (_, i) => item(`pi-ref://control/c${i}`, { role: "checkbox", container: "group", containerName: "Opts", name: `C${i}`, value: "on", state: { checked: true } }));
const varT = buildTemplateSummary(varEntities).templates[0];
assert.deepEqual(varT.varies, ["name"]);
assert.equal(varT.constant.value, "on", "uniform value → constant");
assert.equal(varT.constant.checked, true, "uniform truthy state → constant");
assert.ok(!("disabled" in varT.constant), "uniform default state omitted");

// instanceRefs cap + true count.
const bigT = buildTemplateSummary(Array.from({ length: 30 }, (_, i) => item(`pi-ref://control/m${i}`, { container: "list", name: `n${i}` }))).templates[0];
assert.equal(bigT.count, 30, "count is the true size");
assert.equal(bigT.instanceRefs.length, MAX_TEMPLATE_INSTANCE_REFS, "instanceRefs capped");

// distinct containerNames (with spaces) do not collide.
const collA = Array.from({ length: 4 }, (_, i) => item(`pi-ref://control/a${i}`, { container: "list", containerName: "Search Results", name: `A${i}` }));
const collB = Array.from({ length: 4 }, (_, i) => item(`pi-ref://control/b${i}`, { container: "list", containerName: "Related", name: `B${i}` }));
assert.equal(buildTemplateSummary([...collA, ...collB]).templates.length, 2, "JSON key avoids spaced-name collision");

// no ARIA repetition signal → never templated (no DOM guessing).
assert.equal(buildTemplateSummary(Array.from({ length: 6 }, (_, i) => item(`r${i}`, { name: `x${i}` }))).templates.length, 0, "no container/setSize → not templated");

// different roles in the same container stay separate.
assert.equal(buildTemplateSummary([
	...Array.from({ length: 4 }, (_, i) => item(`pi-ref://control/lk${i}`, { role: "link", container: "navigation", containerName: "Main", name: `L${i}` })),
	...Array.from({ length: 4 }, (_, i) => item(`pi-ref://control/bn${i}`, { role: "button", container: "navigation", containerName: "Main", name: `B${i}` })),
]).templates.length, 2, "distinct roles → distinct templates");

const redundantText = buildTemplateSummary([
	...Array.from({ length: 12 }, (_, i) => item(`pi-ref://text/t${i}`, { role: "StaticText", kind: "text", container: "list", containerName: "Results", name: `Item ${i}` })),
	...Array.from({ length: 4 }, (_, i) => item(`pi-ref://control/l${i}`, { role: "link", kind: "control", container: "list", containerName: "Results", name: `Item ${i}` })),
]).templates;
assert.equal(redundantText.length, 1, "redundant text-leaf template suppressed when structural/actionable template shares the container");
assert.equal(redundantText[0].kind, "control");
const textOnly = buildTemplateSummary(Array.from({ length: 6 }, (_, i) => item(`pi-ref://text/cell${i}`, { role: "StaticText", kind: "text", container: "row", containerName: "Totals", name: `Cell ${i}` }))).templates;
assert.equal(textOnly.length, 1, "text-only accessible table-like repetition remains templated");
assert.equal(textOnly[0].kind, "text");

// ── templates is NO LONGER an agent-facing envelope field (removed 2026-06-05) ─────
// A real-agent eval showed envelope.templates was unread; the templating ENGINE stays (treeDiff +
// snapshotProjection consume it), but the budget-immune output field was cut to save tokens.

const tmpl = { container: "list", containerName: "Results", role: "link", kind: "control", count: 20, varies: ["name"], constant: { role: "link", kind: "control" }, instanceRefs: ["pi-ref://control/0", "pi-ref://control/1"], sample: { ref: "pi-ref://control/0", name: "Item 0" } };
const notLifted = await distilledTextResult("body", {
	toolName: "browser_observe", command: "scan", detailLevel: "summary", maxChars: 4_000, fallbackName: "observe-scan",
	summary: { abmlIntegrated: true, focus: { templates: [tmpl], primary_entities: [{ ref: "pi-ref://control/0", kind: "control", role: "link", name: "Item 0" }] } },
});
assert.equal(JSON.parse(notLifted.content[0].text).templates, undefined, "templates is no longer lifted to the envelope (output field removed)");

// ── Static wiring guards ────────────────────────────────────────────────────────

const observeSrc = readRepo("src/tools/observeRunners.ts");
assert.ok(!observeSrc.includes("buildTemplateSummary"), "observeRunners no longer builds focus.templates");
const middlewareSrc = readRepo("src/tools/resultMiddleware.ts");
assert.ok(!middlewareSrc.includes("envelopeTemplates"), "resultMiddleware no longer lifts templates");
const treeDiffSrc = readRepo("src/abml-core/treeDiff.ts");
assert.ok(treeDiffSrc.includes("./grouping.js") && treeDiffSrc.includes("templateFieldValue"), "treeDiff must consume shared grouping + templating helpers");
const snapshotSrc = readRepo("src/abml-core/snapshotProjection.ts");
assert.ok(snapshotSrc.includes("./grouping.js") && snapshotSrc.includes("buildTemplate("), "snapshotProjection must consume shared grouping + direct buildTemplate");
const templatingSrc = readRepo("src/abml-core/templating.ts");
assert.ok(templatingSrc.includes("buildTemplateSummary") && templatingSrc.includes("groupEntities") && templatingSrc.includes("buildTemplate("), "pure-core selector groups by AX container + setSize through shared grouping");
const groupingSrc = readRepo("src/abml-core/grouping.ts");
assert.ok(groupingSrc.includes("templateGroupDescriptorForEntity") && groupingSrc.includes("setSize"), "grouping kernel must own descriptor derivation and repetition signals");
const barrelSrc = readRepo("src/abml-core/index.ts");
assert.ok(barrelSrc.includes("./templating.js") && barrelSrc.includes("./grouping.js"), "kernel barrel exports templating and grouping");
const shimSrc = readRepo("src/abml/templating.ts");
assert.ok(shimSrc.includes("../abml-core/templating.js"), "src/abml/templating.ts is a re-export shim");
const groupingShimSrc = readRepo("src/abml/grouping.ts");
assert.ok(groupingShimSrc.includes("../abml-core/grouping.js"), "src/abml/grouping.ts is a re-export shim");
const pkg = JSON.parse(readRepo("package.json"));
assert.ok(pkg.scripts?.["check:abml-templating"]?.includes("check-abml-templating.mjs"), "check:abml-templating script present");

console.log(`abml templating ok — M1 pure-core selector (AX-container + aria-setsize grouping, MIN=${MIN_TEMPLATE_INSTANCES}, varies/constant split, instanceRefs cap=${MAX_TEMPLATE_INSTANCE_REFS}+count, MAX_TEMPLATES=${MAX_TEMPLATES}, distinct-name no-collision, no-signal→no-template) + ENGINE-only (treeDiff/snapshotProjection consume templating; envelope.templates output field removed 2026-06-05) + static wiring verified`);
