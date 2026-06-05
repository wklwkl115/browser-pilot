import test from "node:test";
import assert from "node:assert/strict";
import { diffEntities, summarizeEntityDiff, type EntityDiff } from "../../../src/abml-core/diff.ts";
import type { Entity } from "../../../src/abml-core/entity.ts";

function entity(ref: string, opts: {
	name?: string;
	value?: string;
	role?: string;
	kind?: Entity["kind"];
	state?: Partial<Entity["state"]>;
} = {}): Entity {
	return {
		ref,
		kind: opts.kind ?? "control",
		role: opts.role ?? "button",
		...(opts.name !== undefined ? { name: opts.name } : {}),
		...(opts.value !== undefined ? { value: opts.value } : {}),
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

test("diffEntities partialBaseline suppresses unmatched after refs while keeping tracked changes", () => {
	const before = [entity("pi-ref://control/accordion", { state: { expanded: false } })];
	const after = [
		entity("pi-ref://control/accordion", { state: { expanded: true, focused: true } }),
		entity("pi-ref://element/noisy-inline-box", { kind: "element", role: "InlineTextBox" }),
	];
	assert.deepEqual(stripUndefined(diffEntities(before, after, { partialBaseline: true })), {
		appeared: [],
		disappeared: [],
		changed: [{
			ref: "pi-ref://control/accordion",
			kind: "state-changed",
			before: { focused: false, expanded: false },
			after: { focused: true, expanded: true },
		}],
		focusedRef: "pi-ref://control/accordion",
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

test("diffEntities detects value changes", () => {
	const before = [entity("pi-ref://control/search", { role: "searchbox", value: "A" })];
	const after = [entity("pi-ref://control/search", { role: "searchbox", value: "B" })];
	assert.deepEqual(stripUndefined(diffEntities(before, after)), {
		appeared: [],
		disappeared: [],
		changed: [{
			ref: "pi-ref://control/search",
			kind: "value-changed",
			before: { value: "A" },
			after: { value: "B" },
		}],
	});
});

test("summarizeEntityDiff ranks focused control value changes before churn", () => {
	const before = [entity("pi-ref://control/search", { role: "searchbox", value: "A" })];
	const after = [
		entity("pi-ref://control/search", { role: "searchbox", value: "B", state: { focused: true } }),
		...Array.from({ length: 8 }, (_, i) => entity(`pi-ref://text/suggest-${i}`, { kind: "text", role: "StaticText", name: `Suggestion ${i}` })),
	];
	const diff = diffEntities(before, after);
	const salience = summarizeEntityDiff(diff, before, after);
	assert.equal(salience.items[0].kind, "changed");
	assert.equal(salience.items[0].ref, "pi-ref://control/search");
	assert.equal(salience.items.at(-1)?.kind, "churn");
	assert.equal(salience.appeared, 8);
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
