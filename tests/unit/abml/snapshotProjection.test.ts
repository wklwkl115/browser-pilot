import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshotProjection } from "../../../src/abml-core/snapshotProjection.ts";
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

test("snapshotProjection: attaches treeDiff delta to the current template", () => {
	const before = list(["Alpha", "Bravo", "Charlie", "Delta"], "b");
	const after = list(["Alpha", "Bravo", "Charlie", "Delta", "Echo"], "a");
	const projection = buildSnapshotProjection(after, { treeDiff: buildTreeDiff(before, after) });
	assert.equal(projection.summary.templateCount, 1);
	assert.equal(projection.summary.appeared, 1);
	assert.equal(projection.templates[0]?.delta?.appeared.instances[0]?.name, "Echo");
	assert.equal(projection.templates[0]?.templateKey, buildTreeDiff(before, after).templates[0]?.templateKey);
});

test("snapshotProjection: partial baseline stays explicit unavailable", () => {
	const before = list(["Alpha", "Bravo", "Charlie", "Delta"], "b");
	const after = list(["Alpha", "Bravo", "Charlie", "Delta"], "a");
	const projection = buildSnapshotProjection(after, { treeDiff: buildTreeDiff(before, after, { partialBaseline: true }) });
	assert.equal(projection.summary.partialBaseline, true);
	assert.match(String(projection.summary.unavailable), /full baseline/);
	assert.equal(projection.templates.length, 1, "current template still projects even when baseline delta is unavailable");
});

test("snapshotProjection: emits delta-only templates when current members disappear below threshold", () => {
	const before = list(["Alpha", "Bravo", "Charlie", "Delta"], "b");
	const after = [before[0]!, before[1]!, before[2]!].map((entity, index) => ({ ...entity, ref: `pi-ref://control/a${index}` }));
	const projection = buildSnapshotProjection(after, { treeDiff: buildTreeDiff(before, after) });
	assert.equal(projection.templates[0]?.deltaOnly, true);
	assert.equal(projection.templates[0]?.delta?.disappeared.count, 4, "once the repeated structure drops below MIN, the prior template disappears as a whole");
	assert.equal(projection.templates[0]?.count, 0, "delta-only template has no current templated members");
});

test("snapshotProjection: caps and ranks templates with controls ahead of noisier text groups", () => {
	const controls = Array.from({ length: 4 }, (_, i) => item(`pi-ref://control/action${i}`, `Action ${i}`, i + 1, { role: "link", kind: "control", hints: { containerRole: "list", containerName: "Mixed" } }));
	const elements = Array.from({ length: 16 }, (_, i) => item(`pi-ref://element/li${i}`, `•`, i + 1, { role: "listitem", kind: "element", hints: { containerRole: "list", containerName: "Mixed" } }));
	const text = Array.from({ length: 12 }, (_, i) => item(`pi-ref://text/noise${i}`, `Noise ${i}`, i + 1, { role: "StaticText", kind: "text", hints: { containerRole: "list", containerName: "Mixed" } }));
	const projection = buildSnapshotProjection([...text, ...elements, ...controls]);
	assert.equal(projection.templates[0]?.kind, "control");
	assert.equal(projection.templates[1]?.kind, "element");
	assert.equal(projection.templates.some((template) => template.kind === "text" && template.containerName === "Mixed"), false);
});
