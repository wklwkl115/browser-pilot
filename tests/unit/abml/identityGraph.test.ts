import test from "node:test";
import assert from "node:assert/strict";
import { buildIdentityGraph, identityGraphSummary } from "../../../src/abml-core/identityGraph.ts";
import type { Entity, EntityState } from "../../../src/abml-core/entity.ts";

const state = (overrides: Partial<EntityState> = {}): EntityState => ({
	visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true,
	...overrides,
});

function entity(ref: string, name: string, overrides: Partial<Entity> = {}): Entity {
	return {
		ref, kind: "control", role: "link", name, state: state(), source: "ax",
		structure: { posInSet: 1, setSize: 8, ...(overrides.structure || {}) },
		hints: { containerRole: "list", containerName: "Items", selector: `#${ref.split("/").pop()}`, ...(overrides.hints || {}) },
		...overrides,
	};
}

test("identityGraph: entities with anchors get anchorKey and anchorConfidence", () => {
	const entities = [
		entity("pi-ref://control/a", "Alpha"),
		entity("pi-ref://control/b", "Bravo"),
		entity("pi-ref://control/c", "Charlie"),
		entity("pi-ref://control/d", "Delta"),
	];
	const graph = buildIdentityGraph(entities, undefined);
	assert.equal(graph.anchorCount, 4);
	assert.equal(graph.triggeredCount, 0);
	const alpha = graph.byRef["pi-ref://control/a"];
	assert.ok(alpha);
	assert.ok(alpha.anchorKey?.includes("alpha"), "anchorKey contains normalizedName");
	assert.equal(alpha.anchorConfidence, "high");
	assert.deepEqual(alpha.triggeredRequests, []);
});

test("identityGraph: entities with triggered relations get triggeredRequests", () => {
	const entities = [
		{ ...entity("pi-ref://control/btn", "Submit"), relations: [
			{ type: "triggered" as const, targetRef: "pi-ref://network/r1", source: "timing" as const, confidence: "low" as const },
			{ type: "triggered" as const, targetRef: "pi-ref://network/r2", source: "timing" as const, confidence: "medium" as const },
		] },
	];
	const graph = buildIdentityGraph(entities, undefined);
	assert.equal(graph.triggeredCount, 2);
	const btn = graph.byRef["pi-ref://control/btn"];
	assert.ok(btn);
	assert.deepEqual(btn.triggeredRequests, ["pi-ref://network/r1", "pi-ref://network/r2"]);
});

test("identityGraph: entities with neither anchor nor triggered are excluded", () => {
	const singleton = { ref: "pi-ref://control/solo", kind: "control" as const, role: "button", name: "Lonely", state: state(), source: "ax" as const };
	const graph = buildIdentityGraph([singleton], undefined);
	assert.equal(Object.keys(graph.byRef).length, 0);
	assert.equal(graph.anchorCount, 0);
});

test("identityGraph: empty input produces empty graph", () => {
	const graph = buildIdentityGraph([], undefined);
	assert.deepEqual(graph.byRef, {});
	assert.equal(graph.anchorCount, 0);
	assert.equal(graph.triggeredCount, 0);
});

test("identityGraph: summary produces compact counts", () => {
	const entities = [
		entity("pi-ref://control/a", "Alpha"),
		entity("pi-ref://control/b", "Bravo"),
		entity("pi-ref://control/c", "Charlie"),
		entity("pi-ref://control/d", "Delta"),
	];
	const summary = identityGraphSummary(buildIdentityGraph(entities, undefined));
	assert.equal(summary.anchorCount, 4);
	assert.equal(summary.triggeredCount, 0);
});
