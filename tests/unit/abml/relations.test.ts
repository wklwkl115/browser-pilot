// ABML R1 — relationship graph pure-core logic. materializeRelations turns node-id-keyed
// anchors into ref-keyed typed relations (dropping unresolved/self edges, deduping, capping),
// and buildRelationSummary produces the budget-immune envelope disclosure. No browser.
import test from "node:test";
import assert from "node:assert/strict";
import { materializeRelations, buildRelationSummary, entityRelationKeys, type RelationAnchor } from "../../../src/abml-core/relations.ts";
import type { Entity } from "../../../src/abml-core/entity.ts";

function entity(ref: string, opts: { backendNodeId?: number; axNodeId?: string; relations?: Entity["relations"] } = {}): Entity {
	return {
		ref,
		kind: "control",
		role: "button",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		source: "ax",
		...(opts.relations ? { relations: opts.relations } : {}),
		hints: {
			...(opts.backendNodeId !== undefined ? { backendNodeId: opts.backendNodeId } : {}),
			...(opts.axNodeId !== undefined ? { axNodeId: opts.axNodeId } : {}),
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

test("materialize resolves anchors to pi-ref targets", () => {
	const a = entity("pi-ref://control/combo", { backendNodeId: 10 });
	const b = entity("pi-ref://region/list", { backendNodeId: 20 });
	const [outA, outB] = materializeRelations([a, b], [anchor("b:10", "controls", "b:20")]);
	assert.deepEqual(outA.relations, [{ type: "controls", targetRef: "pi-ref://region/list", source: "ax", confidence: "high" }]);
	assert.equal(outB.relations, undefined, "target entity gets no inbound relation");
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

test("materialize preserves evidence and confidence", () => {
	const a = entity("pi-ref://cell/a", { backendNodeId: 10 });
	const b = entity("pi-ref://table/t", { backendNodeId: 20 });
	const [outA] = materializeRelations([a, b], [anchor("b:10", "cellOf", "b:20", { confidence: "medium", evidence: { rowIndex: 2, colIndex: 3 } })]);
	assert.deepEqual(outA.relations?.[0], { type: "cellOf", targetRef: "pi-ref://table/t", source: "ax", confidence: "medium", evidence: { rowIndex: 2, colIndex: 3 } });
});

test("buildRelationSummary counts by type, tableCells, and caps highlights", () => {
	const entities: Entity[] = [
		entity("pi-ref://control/c", { relations: [{ type: "controls", targetRef: "pi-ref://r/1", source: "ax", confidence: "high" }] }),
		entity("pi-ref://cell/1", { relations: [{ type: "cellOf", targetRef: "pi-ref://t/1", source: "ax", confidence: "high" }, { type: "rowOf", targetRef: "pi-ref://row/1", source: "ax", confidence: "high" }] }),
		entity("pi-ref://cell/2", { relations: [{ type: "cellOf", targetRef: "pi-ref://t/1", source: "ax", confidence: "high" }] }),
	];
	const { summary, highlights } = buildRelationSummary(entities);
	assert.equal(summary.controls, 1);
	assert.equal(summary.cellOf, 2);
	assert.equal(summary.rowOf, 1);
	assert.equal(summary.tableCells, 2, "two distinct cells with a cellOf relation");
	assert.equal(highlights[0]?.type, "controls", "interaction edge leads the deterministic highlight order");
	assert.ok(highlights.length <= 8);
});

test("buildRelationSummary returns an empty-but-present summary when no relations exist", () => {
	const { summary, highlights } = buildRelationSummary([entity("pi-ref://control/a")]);
	assert.deepEqual(summary, {});
	assert.deepEqual(highlights, []);
});
