import test from "node:test";
import assert from "node:assert/strict";
import { buildTreeDiff } from "../../../src/abml-core/treeDiff.ts";
import type { Entity, EntityState } from "../../../src/abml-core/entity.ts";

const state = (overrides: Partial<EntityState> = {}): EntityState => ({
	visible: true,
	occluded: false,
	disabled: false,
	focused: false,
	editable: false,
	inViewport: true,
	...overrides,
});

function item(ref: string, name: string, index: number, overrides: Partial<Entity> = {}): Entity {
	return {
		ref,
		kind: "control",
		role: "link",
		name,
		state: state(overrides.state),
		source: "ax",
		structure: { posInSet: index, setSize: 8, ...(overrides.structure || {}) },
		hints: { containerRole: "list", containerName: "Products", ...(overrides.hints || {}) },
		...overrides,
	};
}

function list(names: string[], prefix: string): Entity[] {
	return names.map((name, index) => item(`pi-ref://control/${prefix}${index}`, name, index + 1));
}

test("treeDiff: reorder with stable names reports only template-level reorder", () => {
	const before = list(["Alpha", "Bravo", "Charlie", "Delta", "Echo"], "b");
	const after = list(["Charlie", "Alpha", "Bravo", "Delta", "Echo"], "a");
	const diff = buildTreeDiff(before, after);
	assert.equal(diff.summary.changedTemplateCount, 1);
	assert.equal(diff.summary.appeared, 0);
	assert.equal(diff.summary.disappeared, 0);
	assert.equal(diff.summary.changed, 0);
	assert.equal(diff.summary.reordered, 1);
	assert.equal(diff.templates[0].container, "list");
	assert.equal(diff.templates[0].containerName, "Products");
	assert.equal(diff.templates[0].reordered?.commonCount, 5);
});

test("treeDiff: insertion in a templated list emits one appeared instance", () => {
	const before = list(["Alpha", "Bravo", "Charlie", "Delta"], "b");
	const after = list(["Alpha", "Bravo", "Charlie", "Delta", "Echo"], "a");
	const diff = buildTreeDiff(before, after);
	assert.equal(diff.summary.appeared, 1);
	assert.equal(diff.summary.disappeared, 0);
	assert.equal(diff.templates[0].appeared.instances[0].name, "Echo");
	assert.equal(diff.templates[0].appeared.instances[0].anchor, "name");
	assert.equal(diff.templates[0].appeared.instances[0].confidence, "high");
});

test("treeDiff: value/state changes stay attached to the semantic instance key", () => {
	const before = list(["Alpha", "Bravo", "Charlie", "Delta"], "b");
	const after = list(["Alpha", "Bravo", "Charlie", "Delta"], "a");
	after[2] = { ...after[2], value: "updated", state: state({ selected: true }) };
	const diff = buildTreeDiff(before, after);
	assert.equal(diff.summary.changed, 1);
	assert.equal(diff.templates[0].changed.instances[0].key, "name:charlie");
	assert.deepEqual(diff.templates[0].changed.instances[0].fields.map((field) => field.field), ["value", "selected"]);
});

test("treeDiff: duplicate names fall back to low-confidence positions", () => {
	const before = list(["Item", "Item", "Item", "Item"], "b");
	const after = list(["Item", "Item", "Item", "Item"], "a");
	after[1] = { ...after[1], value: "changed" };
	const diff = buildTreeDiff(before, after);
	assert.equal(diff.summary.changed, 1);
	assert.equal(diff.templates[0].changed.instances[0].anchor, "posInSet");
	assert.equal(diff.templates[0].changed.instances[0].confidence, "low");
});

test("treeDiff: partial baseline is explicit unavailable instead of pretending full structure", () => {
	const diff = buildTreeDiff(list(["Alpha", "Bravo", "Charlie", "Delta"], "b"), list(["Alpha", "Bravo", "Charlie", "Delta"], "a"), { partialBaseline: true });
	assert.equal(diff.summary.partialBaseline, true);
	assert.match(String(diff.summary.unavailable), /full baseline/);
	assert.equal(diff.templates.length, 0);
});
