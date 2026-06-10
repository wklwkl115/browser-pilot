// ABML R1 relationship-graph contract.
//
// Locks the two-pass relation pipeline end-to-end without a browser: a fake AX tree (covering
// every batch-1 relation family — labelledBy, controls/expandedTarget, table cellOf/rowOf/
// columnOf/headerFor, currentIn) flows through readAxEntities → mergeAxIntoDomEntities (mints
// refs) → materializeRelations → buildRelationSummary, and the relation summary surfaces at the
// envelope top-level via the real distiller. Asserts: every relation family materializes, every
// target is a pi-ref:// (no backend/AX node id leaks), relations.summary survives to the envelope.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAxEntities, mergeAxIntoDomEntities } from "../../../src/abml/verbs/axRuntime.ts";
import { materializeRelations, buildRelationSummary, deriveStateRelationAnchors } from "../../../src/abml/relations.ts";
import { distilledTextResult } from "../../../src/tools/resultMiddleware.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

// A representative AX tree. childIds wire the table/nav hierarchy by axNodeId; relation
// properties (controls/labelledby/current) carry backendDOMNodeId related nodes.
const nodes = [
	{ nodeId: "n1", backendDOMNodeId: 1, role: { value: "combobox" }, name: { value: "Country" }, properties: [
		{ name: "controls", value: { relatedNodes: [{ backendDOMNodeId: 2 }] } },
		{ name: "expanded", value: { value: "true" } },
	] },
	{ nodeId: "n2", backendDOMNodeId: 2, role: { value: "listbox" }, name: { value: "Country options" } },
	{ nodeId: "n3", backendDOMNodeId: 3, role: { value: "textbox" }, name: { value: "Email" }, properties: [
		{ name: "labelledby", value: { relatedNodes: [{ backendDOMNodeId: 4 }] } },
	] },
	{ nodeId: "n4", backendDOMNodeId: 4, role: { value: "LabelText" }, name: { value: "Email" } },
	{ nodeId: "n5", backendDOMNodeId: 5, role: { value: "table" }, name: { value: "People" }, childIds: ["n6", "n8"] },
	{ nodeId: "n6", backendDOMNodeId: 6, role: { value: "row" }, childIds: ["n7"] },
	{ nodeId: "n7", backendDOMNodeId: 7, role: { value: "columnheader" }, name: { value: "Name" } },
	{ nodeId: "n8", backendDOMNodeId: 8, role: { value: "row" }, childIds: ["n9"] },
	{ nodeId: "n9", backendDOMNodeId: 9, role: { value: "cell" }, name: { value: "Alice" } },
	{ nodeId: "n10", backendDOMNodeId: 10, role: { value: "navigation" }, name: { value: "Breadcrumb" }, childIds: ["n11"] },
	{ nodeId: "n11", backendDOMNodeId: 11, role: { value: "link" }, name: { value: "Products" }, properties: [{ name: "current", value: { value: "page" } }] },
];

const fakeServer = {
	async sendCommand(command) {
		if (command.cdpMethod === "Accessibility.getFullAXTree") return { id: "ax", acknowledged: true, tabId: 1, data: { result: { nodes } } };
		if (command.cdpMethod === "DOM.getBoxModel") return { id: "box", acknowledged: true, tabId: 1, data: { result: {} } };
		throw new Error(`unexpected ${command.cdpMethod}`);
	},
};

const { entities: axEntities, anchors } = await readAxEntities(fakeServer, { tabId: 1, observationId: "snap", url: "https://example.test/relations", timeoutMs: 5_000 });
assert.ok(anchors.length > 0, "AX runtime must extract relation anchors");

// DOM-less: every AX node becomes an appended entity with a minted pi-ref. AX anchors (property/
// table) + DOM-sourced derived anchors (currentIn from the synthetic aria-current + stashed
// container; occlusion would come from scan state). Then materialize.
const merged = mergeAxIntoDomEntities([], axEntities);
const stateAnchors = deriveStateRelationAnchors(merged);
const related = materializeRelations(merged, [...anchors, ...stateAnchors]);

function relationsOf(role, name) {
	const entity = related.find((e) => e.role?.toLowerCase() === role && e.name === name);
	assert.ok(entity, `entity ${role} "${name}" present`);
	return entity.relations ?? [];
}
const typesOf = (role, name) => relationsOf(role, name).map((r) => r.type).sort();

// Every batch-1 relation family materializes.
assert.ok(typesOf("combobox", "Country").includes("controls"), "combobox → controls (aria-controls)");
assert.ok(typesOf("combobox", "Country").includes("expandedTarget"), "expanded combobox → expandedTarget");
assert.ok(typesOf("textbox", "Email").includes("labelledBy"), "textbox → labelledBy (aria-labelledby)");
assert.deepEqual(typesOf("cell", "Alice"), ["cellOf", "columnOf", "rowOf"], "data cell exposes table + row + column header context");
assert.ok(typesOf("columnheader", "Name").includes("headerFor"), "column header → headerFor table");
assert.ok(typesOf("link", "Products").includes("currentIn"), "aria-current link → currentIn nav (DOM-sourced derive)");

// Occlusion (R1.6): occluded entity ↔ the element stacked on top, matched by selector via the
// page hit-test. Hand-built (AX tree carries no occlusion); proves the geometry-relation derive.
const occluded = { ref: "pi-ref://control/under", kind: "control", role: "button", name: "Under", state: { visible: true, occluded: true, disabled: false, focused: false, editable: false, inViewport: true }, source: "dom", hints: { selector: "#under", occluderSelector: "#overlay" } };
const overlay = { ref: "pi-ref://control/overlay", kind: "control", role: "button", name: "Overlay", state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true }, source: "dom", hints: { selector: "#overlay" } };
const occRelated = materializeRelations([occluded, overlay], deriveStateRelationAnchors([occluded, overlay]));
assert.deepEqual(occRelated.find((e) => e.ref === "pi-ref://control/under")?.relations?.map((r) => r.type), ["coveredBy"], "occluded entity → coveredBy occluder");
assert.deepEqual(occRelated.find((e) => e.ref === "pi-ref://control/overlay")?.relations?.map((r) => r.type), ["occludes"], "occluder → occludes (inverse)");

// No backend/AX node id leaks: every relation target is a materialized pi-ref://.
for (const entity of related) {
	for (const relation of entity.relations ?? []) {
		assert.match(relation.targetRef, /^pi-ref:\/\//, `relation target must be a pi-ref (got ${relation.targetRef})`);
	}
}

// Relation summary: counts by type + tableCells.
const summary = buildRelationSummary(related);
assert.equal(summary.summary.controls, 1, "summary counts controls");
assert.equal(summary.summary.labelledBy, 1, "summary counts labelledBy");
assert.equal(summary.summary.cellOf, undefined, "cellOf omitted from summary — encoded as tableCells");
assert.equal(summary.summary.tableCells, 2, "tableCells = distinct cells with table context");
assert.equal(summary.summary.currentIn, 1, "summary counts currentIn");
assert.ok(Array.isArray(summary.highlights) && summary.highlights.length > 0, "highlights present");
assert.ok(summary.highlights.length <= 8, "highlights capped");

// End-to-end surfacing: relations.summary reaches the envelope top-level (budget-immune), and is
// always present when abmlIntegrated, sibling to gist/outline.
const result = await distilledTextResult("body", {
	toolName: "browser_observe",
	command: "scan",
	detailLevel: "summary",
	maxChars: 4_000,
	fallbackName: "observe-scan",
	summary: { abmlIntegrated: true, focus: { relations: summary, primary_entities: related.slice(0, 10) } },
});
const envelope = JSON.parse(result.content[0].text);
assert.equal(typeof envelope.relations, "object", "relations surfaced at envelope top-level");
assert.equal(envelope.relations.summary.cellOf, undefined, "cellOf omitted from envelope summary — encoded as tableCells");
assert.equal(envelope.relations.summary.tableCells, 2, "relations.summary.tableCells survives to the envelope");

// --- Static wiring: the runtime pipeline + live smoke + fixture + scripts stay in place --------
const runtimeSrc = readRepo("src/abml/verbs/runtime.ts");
assert.ok(runtimeSrc.includes("materializeRelations") && runtimeSrc.includes("relationCount"), "ABML read runtime must materialize relations after the merge and surface a relationCount");
assert.ok(runtimeSrc.includes("deriveStateRelationAnchors"), "ABML read runtime must derive DOM-sourced (currentIn/occlusion) anchors post-merge");
const axRuntimeSrc = readRepo("src/abml/verbs/axRuntime.ts");
assert.ok(axRuntimeSrc.includes("currentContainerKey"), "axRuntime must stash currentContainerKey for DOM-sourced currentIn");
const scanSrc = readRepo("src/scan/buildScanScript.ts");
const scanCaptureSrc = readRepo("capture-src/entries/scanTemplate.ts");
const scanBundleSrc = readRepo("src/capture/generated/scanBundle.ts");
assert.ok(scanSrc.includes("SCAN_TEMPLATE") && scanSrc.includes("renderCaptureTemplate"), "scan builder must stay a thin capture-template injection wrapper");
assert.ok(scanCaptureSrc.includes("aria-current") && scanCaptureSrc.includes("occluderSelector"), "capture scan source must capture aria-current + the occluder selector");
assert.ok(scanBundleSrc.includes("aria-current") && scanBundleSrc.includes("occluderSelector"), "generated scan bundle must preserve aria-current + occluder selector capture");
const observeSrc = readRepo("src/tools/observeRunners.ts");
assert.ok(observeSrc.includes("buildRelationSummary") && observeSrc.includes("relations:"), "observe runner must surface focus.relations via buildRelationSummary");
const middlewareSrc = readRepo("src/tools/resultMiddleware.ts");
assert.ok(middlewareSrc.includes("envelopeRelations") && middlewareSrc.includes("relations?"), "resultMiddleware must lift relations to the envelope top-level");
const entitySrc = readRepo("src/abml-core/entity.ts");
assert.ok(entitySrc.includes("EntityRelation") && entitySrc.includes("relations?: EntityRelation[]"), "entity model must declare EntityRelation + relations field");

const pkg = JSON.parse(readRepo("package.json"));
assert.ok(pkg.scripts?.["check:abml-relation-graph"]?.includes("check-abml-relation-graph.mjs"), "package must expose check:abml-relation-graph");
assert.ok(pkg.scripts?.["smoke:browser:abml-relations"]?.includes("smoke-abml-relations.mjs"), "package must expose smoke:browser:abml-relations");

const smokeSrc = readRepo("tests/smoke/smoke-abml-relations.mjs");
assert.ok(smokeSrc.includes("abml-relations.html") && smokeSrc.includes("registerBrowserTools") && smokeSrc.includes('getTool("browser_observe")') && smokeSrc.includes("envelope.relations"), "relations smoke must drive the real browser_observe tool end-to-end and assert the envelope relations");
const fixture = readRepo("evals/browser-workflows/fixtures/abml-relations.html");
for (const marker of ["aria-labelledby", "aria-controls", "aria-expanded", "<th", "aria-current"]) {
	assert.ok(fixture.includes(marker), `relations fixture must exercise ${marker}`);
}

console.log(`abml relation graph ok — ${anchors.length} anchors, families: controls/expandedTarget/labelledBy/cellOf/rowOf/columnOf/headerFor/currentIn; summary + highlights at envelope top-level; all targets pi-ref://; runtime/observe/middleware wired; smoke + fixture present`);
