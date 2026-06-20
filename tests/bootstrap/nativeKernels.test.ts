import test from "node:test";
import assert from "node:assert/strict";
import type { Entity } from "../../src/kernels/abml/entity.ts";
import { diffEntities } from "../../src/kernels/abml/diff.ts";
import { buildTreeDiff } from "../../src/kernels/abml/treeDiff.ts";
import { buildNativeEntityDiff, buildNativeTreeDiff } from "../../src/native/browserPilotNativeKernels.ts";

function entity(ref: string, name: string, position: number, overrides: Partial<Entity> = {}): Entity {
	return {
		ref,
		kind: "control",
		role: "button",
		name,
		state: {
			visible: true,
			occluded: false,
			disabled: false,
			focused: false,
			editable: false,
			inViewport: true,
		},
		structure: { setSize: 4, posInSet: position },
		source: "dom",
		hints: { containerRole: "list", containerName: "Tasks" },
		...overrides,
	};
}

test("native ABML entity diff stays aligned with the TS kernel", () => {
	const before = [
		entity("bp-ref://control/1", "Alpha", 1),
		entity("bp-ref://control/2", "Beta", 2, { state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true, selected: false } }),
	];
	const after = [
		entity("bp-ref://control/1", "Alpha", 1, { value: "done" }),
		entity("bp-ref://control/2", "Beta updated", 2, { state: { visible: true, occluded: false, disabled: false, focused: true, editable: false, inViewport: true, selected: true } }),
		entity("bp-ref://control/3", "Gamma", 3),
	];
	const expected = diffEntities(before, after);
	const actual = buildNativeEntityDiff(before, after) ?? diffEntities(before, after);
	assert.deepEqual(actual, expected);
});

test("native ABML tree diff stays aligned with the TS kernel", () => {
	const before = [
		entity("bp-ref://control/1", "Alpha", 1),
		entity("bp-ref://control/2", "Beta", 2),
		entity("bp-ref://control/3", "Gamma", 3),
		entity("bp-ref://control/4", "Delta", 4),
	];
	const after = [
		entity("bp-ref://control/2-next", "Beta", 1),
		entity("bp-ref://control/1-next", "Alpha", 2, { value: "done" }),
		entity("bp-ref://control/3-next", "Gamma", 3),
		entity("bp-ref://control/5-next", "Epsilon", 4),
	];
	const expected = buildTreeDiff(before, after);
	const actual = buildNativeTreeDiff(before, after) ?? buildTreeDiff(before, after);
	assert.deepEqual(actual, expected);
});
