import assert from "node:assert/strict";
import test from "node:test";
import { diffEntities } from "../../src/kernels/abml/diff.ts";
import type { Entity } from "../../src/kernels/abml/entity.ts";
import { reconcileEntityIdentities } from "../../src/kernels/abml/identityReconciliation.ts";

function entity(ref: string, overrides: Partial<Entity> = {}): Entity {
	return {
		ref,
		kind: "control",
		role: "button",
		name: "Send",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		source: "dom",
		geometry: { box: { x: 10, y: 10, w: 100, h: 40 } },
		...overrides,
	};
}

test("identity reconciliation keeps global semantic controls stable across node and selector replacement", () => {
	const before = entity("bp-ref://control/old", { locators: [{ by: "backendNodeId", value: 1 }, { by: "css", value: "#old" }] });
	const after = entity("bp-ref://control/new", { locators: [{ by: "backendNodeId", value: 2 }, { by: "css", value: "#new" }], state: { ...before.state, focused: true } });
	const result = reconcileEntityIdentities([before], [after]);
	assert.equal(result.entities[0]?.ref, before.ref);
	assert.deepEqual(result.diagnostics, { exact: 0, template: 0, semantic: 1, geometry: 0, created: 0, ambiguous: 0 });
	assert.deepEqual(diffEntities([before], result.entities), {
		appeared: [],
		disappeared: [],
		changed: [{ ref: before.ref, kind: "state-changed", before: { focused: false }, after: { focused: true } }],
		focusedRef: before.ref,
	});
});

test("identity reconciliation follows unique names instead of repeated-item order", () => {
	const before = [
		entity("bp-ref://control/alice", { name: "Alice", scope: { key: "old-list", name: "Recipients", position: 1, size: 2 } }),
		entity("bp-ref://control/bob", { name: "Bob", scope: { key: "old-list", name: "Recipients", position: 2, size: 2 } }),
	];
	const after = [
		entity("bp-ref://control/new-bob", { name: "Bob", scope: { key: "new-list", name: "Recipients", position: 1, size: 2 } }),
		entity("bp-ref://control/new-alice", { name: "Alice", scope: { key: "new-list", name: "Recipients", position: 2, size: 2 } }),
	];
	const result = reconcileEntityIdentities(before, after);
	assert.deepEqual(result.entities.map((item) => item.ref), [before[1]!.ref, before[0]!.ref]);
	assert.equal(result.diagnostics.semantic, 2);
});

test("identity reconciliation preserves refs through high-confidence template anchors", () => {
	const hints = { containerRole: "list", containerName: "Recipients" };
	const names = ["Alice", "Bob", "Carol", "Dora"];
	const before = names.map((name, index) => entity(`bp-ref://control/old-${index}`, { name, hints }));
	const after = names.map((name, index) => entity(`bp-ref://control/new-${index}`, { name, hints, structure: { landmark: "main" } }));
	const result = reconcileEntityIdentities(before, after);
	assert.deepEqual(result.entities.map((item) => item.ref), before.map((item) => item.ref));
	assert.equal(result.diagnostics.template, names.length);
});

test("identity reconciliation distinguishes duplicate names by semantic container", () => {
	const before = [
		entity("bp-ref://control/old-inbox", { hints: { containerRole: "list", containerName: "Inbox" } }),
		entity("bp-ref://control/old-outbox", { hints: { containerRole: "list", containerName: "Outbox" } }),
	];
	const after = [
		entity("bp-ref://control/new-inbox", { hints: { containerRole: "list", containerName: "Inbox" } }),
		entity("bp-ref://control/new-outbox", { hints: { containerRole: "list", containerName: "Outbox" } }),
	];
	const result = reconcileEntityIdentities(before, after);
	assert.deepEqual(result.entities.map((item) => item.ref), before.map((item) => item.ref));
	assert.equal(result.diagnostics.semantic, 2);
});

test("identity reconciliation tolerates missing scope evidence when page semantics stay unique", () => {
	const before = entity("bp-ref://control/old", { name: "Search", role: "searchbox", structure: { landmark: "search" } });
	const after = entity("bp-ref://control/new", { name: "Search", role: "searchbox", structure: undefined });
	const result = reconcileEntityIdentities([before], [after]);
	assert.equal(result.entities[0]?.ref, before.ref);
	assert.equal(result.diagnostics.semantic, 1);
});

test("identity reconciliation fails closed for duplicate semantic candidates", () => {
	const before = [entity("bp-ref://control/old-1"), entity("bp-ref://control/old-2")];
	const after = [entity("bp-ref://control/new-1"), entity("bp-ref://control/new-2")];
	const result = reconcileEntityIdentities(before, after);
	assert.deepEqual(result.entities.map((item) => item.ref), after.map((item) => item.ref));
	assert.deepEqual(result.diagnostics, { exact: 0, template: 0, semantic: 0, geometry: 0, created: 2, ambiguous: 2 });
});

test("identity reconciliation uses geometry only for one unnamed non-conflicting candidate", () => {
	const before = entity("bp-ref://control/old", { name: undefined });
	const nearby = entity("bp-ref://control/nearby", { name: undefined, geometry: { box: { x: 40, y: 20, w: 100, h: 40 } } });
	const far = entity("bp-ref://control/far", { name: undefined, geometry: { box: { x: 1_000, y: 1_000, w: 100, h: 40 } } });
	assert.equal(reconcileEntityIdentities([before], [nearby]).entities[0]?.ref, before.ref);
	assert.equal(reconcileEntityIdentities([before], [far]).entities[0]?.ref, far.ref);
});

test("identity reconciliation never geometrically hides a semantic name change", () => {
	const before = entity("bp-ref://control/send", { name: "Send" });
	const after = entity("bp-ref://control/danger", { name: "Delete", geometry: before.geometry });
	const result = reconcileEntityIdentities([before], [after]);
	assert.equal(result.entities[0]?.ref, after.ref);
	assert.equal(result.diagnostics.created, 1);
});

test("identity reconciliation stays bounded across 8k semantic entities", () => {
	const count = 8_000;
	const before = Array.from({ length: count }, (_, index) => entity(`bp-ref://control/old-${index}`, { name: `Action ${index}` }));
	const after = Array.from({ length: count }, (_, index) => entity(`bp-ref://control/new-${index}`, { name: `Action ${index}` }));
	reconcileEntityIdentities(before.slice(0, 20), after.slice(0, 20));
	const startedAt = performance.now();
	const result = reconcileEntityIdentities(before, after);
	const elapsedMs = performance.now() - startedAt;
	assert.equal(result.diagnostics.semantic, count);
	assert.equal(result.diagnostics.created, 0);
	const maxElapsedMs = process.env.BROWSER_PILOT_COVERAGE === "1" ? 2_000 : process.env.CI ? 1_000 : 400;
	assert.ok(elapsedMs < maxElapsedMs, `expected identity reconciliation < ${maxElapsedMs}ms, got ${elapsedMs.toFixed(2)}ms`);
});
