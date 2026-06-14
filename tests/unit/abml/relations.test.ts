// ABML R1 — relationship graph pure-core logic. materializeRelations turns node-id-keyed
// anchors into ref-keyed typed relations (dropping unresolved/self edges, deduping, capping),
// and buildRelationSummary produces the budget-immune envelope disclosure. No browser.
import test from "node:test";
import assert from "node:assert/strict";
import { materializeRelations, materializeRelationGraph, buildRelationGraph, buildRelationSummary, derivePaintOrderRelationAnchors, deriveStateRelationAnchors, entityRelationKeys, type RelationAnchor } from "../../../src/abml-core/relations.ts";
import type { Entity } from "../../../src/abml-core/entity.ts";

function entity(ref: string, opts: { backendNodeId?: number; axNodeId?: string; selector?: string; relations?: Entity["relations"]; state?: Partial<Entity["state"]>; hints?: Record<string, unknown> } = {}): Entity {
	return {
		ref,
		kind: "control",
		role: "button",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true, ...(opts.state ?? {}) },
		source: "ax",
		...(opts.relations ? { relations: opts.relations } : {}),
		hints: {
			...(opts.backendNodeId !== undefined ? { backendNodeId: opts.backendNodeId } : {}),
			...(opts.axNodeId !== undefined ? { axNodeId: opts.axNodeId } : {}),
			...(opts.selector !== undefined ? { selector: opts.selector } : {}),
			...(opts.hints ?? {}),
		},
	};
}

function anchor(sourceKey: string, type: RelationAnchor["type"], targetKey: string, extra: Partial<RelationAnchor> = {}): RelationAnchor {
	return { sourceKey, type, targetKey, source: "ax", confidence: "high", ...extra };
}

test("entityRelationKeys registers both backend and ax-node keys", () => {
	assert.deepEqual(entityRelationKeys(entity("pi-ref://control/a", { backendNodeId: 10, axNodeId: "n5" })), ["b:10", "a:n5"]);
	assert.deepEqual(entityRelationKeys(entity("pi-ref://control/b")), []);
});

test("entityRelationKeys registers target-scoped backend key before legacy backend key", () => {
	const scoped = entity("pi-ref://control/a", { backendNodeId: 10, hints: { targetId: "target-child" } });
	assert.deepEqual(entityRelationKeys(scoped), ["t:target-child:b:10", "b:10"]);
});

test("materialize resolves anchors to pi-ref targets", () => {
	const a = entity("pi-ref://control/combo", { backendNodeId: 10 });
	const b = entity("pi-ref://region/list", { backendNodeId: 20 });
	const [outA, outB] = materializeRelations([a, b], [anchor("b:10", "controls", "b:20")]);
	assert.deepEqual(outA.relations, [{ type: "controls", targetRef: "pi-ref://region/list", source: "ax", confidence: "high" }]);
	assert.equal(outB.relations, undefined, "target entity gets no inbound relation");
});

test("materialize resolves composite backend keys and keeps legacy fallback", () => {
	const a = entity("pi-ref://control/combo", { backendNodeId: 10, hints: { targetId: "target-child" } });
	const b = entity("pi-ref://region/list", { backendNodeId: 20, hints: { targetId: "target-child" } });
	const [scopedOut] = materializeRelations([a, b], [anchor("t:target-child:b:10", "controls", "t:target-child:b:20")]);
	assert.equal(scopedOut.relations?.[0]?.targetRef, "pi-ref://region/list", "composite key resolves first");
	const [legacyOut] = materializeRelations([a, b], [anchor("b:10", "owns", "b:20")]);
	assert.equal(legacyOut.relations?.[0]?.targetRef, "pi-ref://region/list", "legacy bare backend key remains readable");
});

test("materialize resolves via ax-node-id key too", () => {
	const a = entity("pi-ref://control/x", { axNodeId: "n1" });
	const b = entity("pi-ref://text/y", { axNodeId: "n2" });
	const [outA] = materializeRelations([a, b], [anchor("a:n1", "labelledBy", "a:n2")]);
	assert.equal(outA.relations?.[0]?.targetRef, "pi-ref://text/y");
});

test("materialize drops unresolved targets and self edges", () => {
	const a = entity("pi-ref://control/a", { backendNodeId: 10 });
	const [outA] = materializeRelations([a], [
		anchor("b:10", "controls", "b:999"), // target has no entity
		anchor("b:10", "owns", "b:10"), // self edge
	]);
	assert.equal(outA.relations, undefined, "no resolvable relations");
});

test("materialize dedupes identical edges", () => {
	const a = entity("pi-ref://control/a", { backendNodeId: 10 });
	const b = entity("pi-ref://region/b", { backendNodeId: 20 });
	const [outA] = materializeRelations([a, b], [anchor("b:10", "controls", "b:20"), anchor("b:10", "controls", "b:20")]);
	assert.equal(outA.relations?.length, 1, "duplicate (type,target) collapses to one");
});

test("materialize merges evidence for duplicate relation edges", () => {
	const covered = entity("pi-ref://control/covered", { backendNodeId: 10 });
	const covering = entity("pi-ref://region/covering", { backendNodeId: 20 });
	const [outCovered] = materializeRelations([covered, covering], [
		anchor("b:10", "coveredBy", "b:20", { source: "geometry", confidence: "medium", evidence: { hitTest: true } }),
		anchor("b:10", "coveredBy", "b:20", { source: "geometry", confidence: "medium", evidence: { paintOrder: true, sourcePaintOrder: 2, targetPaintOrder: 3 } }),
	]);
	assert.equal(outCovered.relations?.length, 1, "duplicate edge remains collapsed");
	assert.deepEqual(outCovered.relations?.[0]?.evidence, { hitTest: true, paintOrder: true, sourcePaintOrder: 2, targetPaintOrder: 3 });
});

test("materialize caps per-entity relations deterministically (interaction edges win)", () => {
	const source = entity("pi-ref://control/owner", { backendNodeId: 1 });
	const targets: Entity[] = [];
	const anchors: RelationAnchor[] = [];
	// 6 owns + 6 describedBy = 12 candidate edges; cap is 8, owns ranks above describedBy.
	for (let i = 0; i < 6; i += 1) {
		const t = entity(`pi-ref://opt/${i}`, { backendNodeId: 100 + i });
		targets.push(t);
		anchors.push(anchor("b:1", "owns", `b:${100 + i}`));
	}
	for (let i = 0; i < 6; i += 1) {
		const t = entity(`pi-ref://lbl/${i}`, { backendNodeId: 200 + i });
		targets.push(t);
		anchors.push(anchor("b:1", "describedBy", `b:${200 + i}`));
	}
	const [outSource] = materializeRelations([source, ...targets], anchors);
	assert.equal(outSource.relations?.length, 8, "capped at MAX_RELATIONS_PER_ENTITY");
	assert.equal(outSource.relations?.filter((r) => r.type === "owns").length, 6, "all 6 owns kept (higher rank)");
	assert.equal(outSource.relations?.filter((r) => r.type === "describedBy").length, 2, "describedBy truncated to fill the cap");
});

test("materializeRelationGraph keeps full edges artifact-side while entity relations stay capped", () => {
	const source = entity("pi-ref://control/owner", { backendNodeId: 1 });
	const targets: Entity[] = [];
	const anchors: RelationAnchor[] = [];
	for (let i = 0; i < 10; i += 1) {
		targets.push(entity(`pi-ref://option/${i}`, { backendNodeId: 300 + i }));
		anchors.push(anchor("b:1", "owns", `b:${300 + i}`));
	}
	const { entities, graph } = materializeRelationGraph([source, ...targets], anchors);
	const owner = entities.find((item) => item.ref === "pi-ref://control/owner");
	assert.equal(graph.schemaVersion, 1);
	assert.equal(graph.edgeCount, 10, "central graph retains all resolvable edges");
	assert.equal(graph.edges.length, 10, "full graph edges are artifact-ready");
	assert.equal(graph.bySource["pi-ref://control/owner"]?.length, 10, "outbound index is full, not capped");
	assert.equal(graph.byType.owns?.length, 10, "type index is full, not capped");
	assert.equal(graph.entityRelationTruncated?.["pi-ref://control/owner"], 2, "graph records entity-field truncation");
	assert.equal(owner?.relations?.length, 8, "entity-derived field remains capped for envelope compatibility");
	const reconstructed = [];
	for (let i = 0; i < 8; i += 1) {
		const edge = graph.edges[i]!;
		reconstructed.push({
			type: edge.type,
			targetRef: edge.targetRef,
			source: edge.source,
			confidence: edge.confidence,
			...(edge.evidence ? { evidence: edge.evidence } : {}),
		});
	}
	assert.deepEqual(owner?.relations, reconstructed, "entity relations are reconstructable from the central graph prefix");
});

test("buildRelationGraph reconstructs a central graph from existing entity relations", () => {
	const entities: Entity[] = [
		entity("pi-ref://control/a", { relations: [{ type: "controls", targetRef: "pi-ref://region/b", source: "ax", confidence: "high" }] }),
		entity("pi-ref://region/b", { relations: [{ type: "labelledBy", targetRef: "pi-ref://text/c", source: "dom", confidence: "medium", evidence: { selector: "#c" } }] }),
	];
	const graph = buildRelationGraph(entities);
	assert.equal(graph.edgeCount, 2);
	assert.deepEqual(graph.bySource["pi-ref://control/a"], ["rel:1"]);
	assert.deepEqual(graph.byTarget["pi-ref://text/c"], ["rel:2"]);
	assert.equal(graph.edges[1]?.evidence?.selector, "#c");
});

test("materialize preserves evidence and confidence", () => {
	const a = entity("pi-ref://cell/a", { backendNodeId: 10 });
	const b = entity("pi-ref://table/t", { backendNodeId: 20 });
	const [outA] = materializeRelations([a, b], [anchor("b:10", "cellOf", "b:20", { confidence: "medium", evidence: { rowIndex: 2, colIndex: 3 } })]);
	assert.deepEqual(outA.relations?.[0], { type: "cellOf", targetRef: "pi-ref://table/t", source: "ax", confidence: "medium", evidence: { rowIndex: 2, colIndex: 3 } });
});

test("buildRelationSummary counts semantic types + tableCells; omits per-type table-structural noise", () => {
	const entities: Entity[] = [
		entity("pi-ref://control/c", { relations: [{ type: "controls", targetRef: "pi-ref://r/1", source: "ax", confidence: "high" }] }),
		entity("pi-ref://cell/1", { relations: [{ type: "cellOf", targetRef: "pi-ref://t/1", source: "ax", confidence: "high" }, { type: "rowOf", targetRef: "pi-ref://row/1", source: "ax", confidence: "high" }] }),
		entity("pi-ref://cell/2", { relations: [{ type: "cellOf", targetRef: "pi-ref://t/1", source: "ax", confidence: "high" }] }),
	];
	const { summary, highlights } = buildRelationSummary(entities);
	assert.equal(summary.controls, 1);
	// cellOf/rowOf/columnOf/headerFor are table-structural noise; omitted from per-type counts
	assert.equal(summary.cellOf, undefined, "cellOf omitted from summary (encoded as tableCells)");
	assert.equal(summary.rowOf, undefined, "rowOf omitted from summary");
	assert.equal(summary.tableCells, 2, "two distinct cells with a cellOf relation");
	// highlights only show semantic edges — table-structural excluded
	assert.equal(highlights[0]?.type, "controls", "interaction edge leads the deterministic highlight order");
	assert.equal(highlights.some((h) => h.type === "cellOf" || h.type === "rowOf"), false, "table-structural types excluded from highlights");
	assert.ok(highlights.length <= 8);
});

test("buildRelationSummary returns an empty-but-present summary when no relations exist", () => {
	const { summary, highlights } = buildRelationSummary([entity("pi-ref://control/a")]);
	assert.deepEqual(summary, {});
	assert.deepEqual(highlights, []);
});

test("deriveStateRelationAnchors builds currentIn from aria-current + stashed container chain", () => {
	const link = entity("pi-ref://control/products", { backendNodeId: 102, state: { current: "page" }, hints: { currentContainerKeys: ["b:100"] } });
	const nav = entity("pi-ref://element/nav", { backendNodeId: 100 });
	const anchors = deriveStateRelationAnchors([link, nav]);
	const currentIn = anchors.filter((a) => a.type === "currentIn");
	assert.equal(currentIn.length, 1);
	assert.equal(currentIn[0]?.sourceKey, "b:102");
	assert.equal(currentIn[0]?.targetKey, "b:100");
	const [out] = materializeRelations([link, nav], anchors);
	assert.deepEqual(out.relations, [{ type: "currentIn", targetRef: "pi-ref://element/nav", source: "ax", confidence: "high", evidence: { current: "page" } }]);
});

test("currentIn falls back to a surviving container when the nearest one didn't materialize", () => {
	// nearest container b:90 has no entity (folded away by the merge); fallback b:100 survives.
	const link = entity("pi-ref://control/products", { backendNodeId: 102, state: { current: "page" }, hints: { currentContainerKeys: ["b:90", "b:100"] } });
	const nav = entity("pi-ref://element/nav", { backendNodeId: 100 });
	const [out] = materializeRelations([link, nav], deriveStateRelationAnchors([link, nav]));
	assert.equal(out.relations?.[0]?.targetRef, "pi-ref://element/nav", "resolves to the surviving fallback container");
});

test("deriveStateRelationAnchors skips currentIn when not current or container unknown", () => {
	const noCurrent = entity("pi-ref://control/a", { backendNodeId: 1, hints: { currentContainerKeys: ["b:2"] } });
	const noContainer = entity("pi-ref://control/b", { backendNodeId: 3, state: { current: "page" } });
	const falseCurrent = entity("pi-ref://control/c", { backendNodeId: 4, state: { current: false }, hints: { currentContainerKeys: ["b:5"] } });
	assert.equal(deriveStateRelationAnchors([noCurrent, noContainer, falseCurrent]).filter((a) => a.type === "currentIn").length, 0);
});

test("deriveStateRelationAnchors builds coveredBy/occludes from occlusion + selector match", () => {
	const covered = entity("pi-ref://control/under", { selector: "#under", state: { occluded: true }, hints: { occluderSelector: "#overlay" } });
	const overlay = entity("pi-ref://control/overlay", { selector: "#overlay" });
	const anchors = deriveStateRelationAnchors([covered, overlay]);
	assert.equal(anchors.filter((a) => a.type === "coveredBy").length, 1, "covered → coveredBy");
	assert.equal(anchors.filter((a) => a.type === "occludes").length, 1, "overlay → occludes (inverse)");
	const out = materializeRelations([covered, overlay], anchors);
	const coveredOut = out.find((e) => e.ref === "pi-ref://control/under");
	const overlayOut = out.find((e) => e.ref === "pi-ref://control/overlay");
	assert.deepEqual(coveredOut?.relations, [{ type: "coveredBy", targetRef: "pi-ref://control/overlay", source: "geometry", confidence: "medium", evidence: { hitTest: true } }]);
	assert.deepEqual(overlayOut?.relations, [{ type: "occludes", targetRef: "pi-ref://control/under", source: "geometry", confidence: "medium" }]);
});

test("occlusion relation drops when the occluder is not a scanned entity", () => {
	const covered = entity("pi-ref://control/under", { selector: "#under", state: { occluded: true }, hints: { occluderSelector: "#unknown-overlay" } });
	const anchors = deriveStateRelationAnchors([covered]);
	const [out] = materializeRelations([covered], anchors);
	assert.equal(out.relations, undefined, "no relation when the occluder selector matches no entity");
});

test("derivePaintOrderRelationAnchors builds capped backendNodeId occlusion pairs from overlapping paint order", () => {
	const covered = entity("pi-ref://control/covered", { backendNodeId: 12 });
	const covering = entity("pi-ref://control/covering", { backendNodeId: 13 });
	const unrelated = entity("pi-ref://control/far", { backendNodeId: 14 });
	const anchors = derivePaintOrderRelationAnchors([covered, covering, unrelated], [
		{ backendNodeId: 12, paintOrder: 2, bounds: { x: 80, y: 100, w: 220, h: 90 } },
		{ backendNodeId: 13, paintOrder: 3, bounds: { x: 130, y: 120, w: 220, h: 90 } },
		{ backendNodeId: 14, paintOrder: 4, bounds: { x: 900, y: 900, w: 50, h: 50 } },
	]);
	const out = materializeRelations([covered, covering, unrelated], anchors);
	assert.deepEqual(out.find((item) => item.ref === "pi-ref://control/covered")?.relations, [{
		type: "coveredBy",
		targetRef: "pi-ref://control/covering",
		source: "geometry",
		confidence: "medium",
		evidence: { paintOrder: true, sourcePaintOrder: 2, targetPaintOrder: 3, overlapArea: 11900, overlapRatio: 0.601 },
	}]);
	assert.deepEqual(out.find((item) => item.ref === "pi-ref://control/covering")?.relations, [{
		type: "occludes",
		targetRef: "pi-ref://control/covered",
		source: "geometry",
		confidence: "medium",
		evidence: { paintOrder: true, sourcePaintOrder: 2, targetPaintOrder: 3, overlapArea: 11900, overlapRatio: 0.601 },
	}]);
	assert.equal(out.find((item) => item.ref === "pi-ref://control/far")?.relations, undefined, "non-overlap does not create a relation");
});
