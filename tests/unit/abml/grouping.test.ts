import test from "node:test";
import assert from "node:assert/strict";
import { groupEntities, type TemplateGroup } from "../../../src/abml-core/grouping.ts";
import { buildTemplateSummary } from "../../../src/abml-core/templating.ts";
import { buildTreeDiff } from "../../../src/abml-core/treeDiff.ts";
import { buildSnapshotProjection } from "../../../src/abml-core/snapshotProjection.ts";
import { deriveSemanticRefAnchors } from "../../../src/abml-core/semanticRefAnchor.ts";
import { buildIdentityGraph } from "../../../src/abml-core/identityGraph.ts";
import type { Entity, EntityState } from "../../../src/abml-core/entity.ts";
import { compareMicroBench, microBenchSink } from "../helpers/microBench.ts";

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
		hints: { containerRole: "list", containerName: "Products", selector: `#${ref.split("/").pop()}`, ...(overrides.hints || {}) },
		...overrides,
	};
}

function list(names: string[], prefix: string): Entity[] {
	return names.map((name, index) => item(`pi-ref://control/${prefix}${index}`, name, index + 1));
}

function deepFreezeGroups(groups: TemplateGroup[]): void {
	for (const group of groups) {
		Object.freeze(group.descriptor);
		for (const member of group.members) Object.freeze(member);
		Object.freeze(group.members);
		Object.freeze(group);
	}
	Object.freeze(groups);
}

test("groupEntities memo hit returns a fresh top-level array with shared group objects", () => {
	const entities = list(["Alpha", "Bravo", "Charlie", "Delta"], "a");
	const first = groupEntities(entities);
	const second = groupEntities(entities);
	assert.notStrictEqual(first, second);
	assert.equal(first.length, 1);
	assert.strictEqual(first[0], second[0]);
	assert.strictEqual(first[0]?.members, second[0]?.members);
});

test("groupEntities misses on a fresh array reference even when the contents are identical", () => {
	const entities = list(["Alpha", "Bravo", "Charlie", "Delta"], "a");
	const freshArray = [...entities];
	const first = groupEntities(entities);
	const second = groupEntities(freshArray);
	assert.deepEqual(first, second);
	assert.notStrictEqual(first[0], second[0]);
	assert.notStrictEqual(first[0]?.members, second[0]?.members);
});

test("groupEntities top-level copy prevents consumer sort mutation from corrupting the cache", () => {
	const entities = [
		...list(["Alpha", "Bravo", "Charlie", "Delta"], "a"),
		...Array.from({ length: 4 }, (_, index) => item(`pi-ref://control/b${index}`, `Button ${index}`, index + 1, { role: "button", hints: { containerRole: "toolbar", containerName: "Actions" } })),
	];
	const groups = groupEntities(entities);
	const original = groups.map((group) => group.descriptor.key);
	groups.sort((a, b) => b.descriptor.key.localeCompare(a.descriptor.key));
	const reread = groupEntities(entities);
	assert.deepEqual(reread.map((group) => group.descriptor.key), original);
});

test("memoized groups stay immutable enough for all grouping consumers", () => {
	const before = list(["Alpha", "Bravo", "Charlie", "Delta"], "b");
	const after = list(["Alpha", "Bravo", "Charlie", "Delta", "Echo"], "a");
	const cached = groupEntities(after);
	deepFreezeGroups(cached);
	const treeDiff = buildTreeDiff(before, after);
	assert.doesNotThrow(() => buildTemplateSummary(after));
	assert.doesNotThrow(() => deriveSemanticRefAnchors(after));
	assert.doesNotThrow(() => buildSnapshotProjection(after, { treeDiff }));
	assert.doesNotThrow(() => buildIdentityGraph(after, undefined));
});

test("consumer outputs stay stable across same-array and fresh-array call sequences", () => {
	const before = list(["Alpha", "Bravo", "Charlie", "Delta"], "b");
	const after = list(["Alpha", "Bravo", "Charlie", "Delta", "Echo"], "a");
	const treeDiffA = buildTreeDiff(before, after);
	const treeDiffB = buildTreeDiff(before, after);
	assert.deepEqual(treeDiffA, treeDiffB);
	assert.deepEqual(buildTemplateSummary(after), buildTemplateSummary(after));
	assert.deepEqual(deriveSemanticRefAnchors(after), deriveSemanticRefAnchors(after));
	assert.deepEqual(buildSnapshotProjection(after, { treeDiff: treeDiffA }), buildSnapshotProjection(after, { treeDiff: treeDiffA }));
	assert.deepEqual(buildIdentityGraph(after, undefined), buildIdentityGraph(after, undefined));
	const freshAfter = [...after];
	assert.deepEqual(buildTemplateSummary(after), buildTemplateSummary(freshAfter));
	assert.deepEqual(deriveSemanticRefAnchors(after), deriveSemanticRefAnchors(freshAfter));
	assert.deepEqual(buildIdentityGraph(after, undefined), buildIdentityGraph(freshAfter, undefined));
});

test("groupEntities memo-hit bench stays on the shared helper", () => {
	const entities = Array.from({ length: 500 }, (_, index) => item(`pi-ref://control/m${index}`, `Item ${index}`, index + 1, {
		hints: { containerRole: "list", containerName: `Bucket ${Math.floor(index / 50)}` },
		structure: { posInSet: index + 1, setSize: 500 },
	}));
	groupEntities(entities);
	const bench = compareMicroBench({
		reference: () => groupEntities([...entities]),
		candidate: () => groupEntities(entities),
		iterations: 300,
		warmupSamples: 2,
		samples: 7,
	});
	assert.ok(Number.isFinite(bench.speedup));
	assert.ok(Number.isFinite(bench.referenceNsPerOp));
	assert.ok(Number.isFinite(bench.candidateNsPerOp));
	assert.ok(microBenchSink() >= 0);
	console.log(`groupEntities memo bench speedup=${bench.speedup.toFixed(2)}x candidate_ms=${bench.candidateMedianMs.toFixed(3)} reference_ms=${bench.referenceMedianMs.toFixed(3)}`);
});
