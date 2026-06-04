import test from "node:test";
import assert from "node:assert/strict";
import { diffEntities, type EntityDiff } from "../../../src/abml-core/diff.ts";
import type { Entity } from "../../../src/abml-core/entity.ts";

function entity(ref: string, opts: {
	name?: string;
	role?: string;
	kind?: Entity["kind"];
	state?: Partial<Entity["state"]>;
} = {}): Entity {
	return {
		ref,
		kind: opts.kind ?? "control",
		role: opts.role ?? "button",
		...(opts.name !== undefined ? { name: opts.name } : {}),
		state: {
			visible: true,
			occluded: false,
			disabled: false,
			focused: false,
			editable: false,
			inViewport: true,
			...(opts.state ?? {}),
		},
		source: "dom",
	};
}

function stripUndefined(diff: EntityDiff): EntityDiff {
	return JSON.parse(JSON.stringify(diff)) as EntityDiff;
}

test("diffEntities returns empty arrays when snapshots are equal", () => {
	const before = [entity("pi-ref://control/a", { name: "Save" })];
	const after = [entity("pi-ref://control/a", { name: "Save" })];
	assert.deepEqual(stripUndefined(diffEntities(before, after)), { appeared: [], disappeared: [], changed: [] });
});

test("diffEntities detects appeared and disappeared refs", () => {
	const before = [entity("pi-ref://control/a"), entity("pi-ref://control/old")];
	const after = [entity("pi-ref://control/a"), entity("pi-ref://control/new")];
	assert.deepEqual(stripUndefined(diffEntities(before, after)), {
		appeared: ["pi-ref://control/new"],
		disappeared: ["pi-ref://control/old"],
		changed: [],
	});
});

test("diffEntities detects state delta only for changed state fields", () => {
	const before = [entity("pi-ref://control/submit", { state: { disabled: true, focused: false, expanded: false } })];
	const after = [entity("pi-ref://control/submit", { state: { disabled: false, focused: true, expanded: false } })];
	assert.deepEqual(stripUndefined(diffEntities(before, after)), {
		appeared: [],
		disappeared: [],
		changed: [{
			ref: "pi-ref://control/submit",
			kind: "state-changed",
			before: { disabled: true, focused: false },
			after: { disabled: false, focused: true },
		}],
		focusedRef: "pi-ref://control/submit",
	});
});

test("diffEntities detects name changes", () => {
	const before = [entity("pi-ref://control/action", { name: "Continue" })];
	const after = [entity("pi-ref://control/action", { name: "Submit" })];
	assert.deepEqual(stripUndefined(diffEntities(before, after)), {
		appeared: [],
		disappeared: [],
		changed: [{
			ref: "pi-ref://control/action",
			kind: "name-changed",
			before: { name: "Continue" },
			after: { name: "Submit" },
		}],
	});
});

test("diffEntities reports focusedRef from after snapshot without requiring a change", () => {
	const before = [entity("pi-ref://control/a", { state: { focused: true } })];
	const after = [entity("pi-ref://control/a", { state: { focused: true } })];
	assert.deepEqual(stripUndefined(diffEntities(before, after)), {
		appeared: [],
		disappeared: [],
		changed: [],
		focusedRef: "pi-ref://control/a",
	});
});
