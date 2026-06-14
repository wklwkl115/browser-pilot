import test from "node:test";
import assert from "node:assert/strict";
import { buildCollectionModels, summarizeCollectionCompleteness, type CollectionModel } from "../../../src/abml-core/collections.ts";
import type { Entity, EntityState } from "../../../src/abml-core/entity.ts";
import type { StructureTemplate } from "../../../src/abml-core/templating.ts";

const state = (overrides: Partial<EntityState> = {}): EntityState => ({
	visible: true,
	occluded: false,
	disabled: false,
	focused: false,
	editable: false,
	inViewport: true,
	...overrides,
});

function item(index: number, overrides: Partial<Entity> = {}): Entity {
	return {
		ref: overrides.ref ?? `pi-ref://element/item-${index}`,
		kind: overrides.kind ?? "element",
		role: overrides.role ?? "listitem",
		name: overrides.name ?? `Item ${index}`,
		state: overrides.state ?? state(),
		source: overrides.source ?? "ax",
		structure: overrides.structure ?? { posInSet: index },
		hints: {
			containerRole: "list",
			containerName: "Results",
			...overrides.hints,
		},
		...overrides,
	};
}

function model(input: Parameters<typeof buildCollectionModels>[0]): CollectionModel {
	const models = buildCollectionModels(input);
	assert.equal(models.length, 1);
	return models[0]!;
}

test("collections: ARIA set coverage proves a complete collection", () => {
	const collection = model({
		entities: [1, 2, 3].map((index) => item(index, { structure: { posInSet: index, setSize: 3 } })),
	});
	assert.equal(collection.completeness, "complete");
	assert.equal(collection.confidence, "high");
	assert.equal(collection.declaredTotal, 3);
	assert.equal(collection.continuation, undefined);
	assert.match(summarizeCollectionCompleteness(collection).reason, /declared 3/);
});

test("collections: capped template refs become folded, not falsely complete inline data", () => {
	const template: StructureTemplate = {
		container: "list",
		containerName: "Results",
		role: "listitem",
		kind: "element",
		count: 30,
		setSize: 30,
		varies: ["name"],
		constant: { role: "listitem", kind: "element" },
		instanceRefs: Array.from({ length: 20 }, (_, index) => `pi-ref://element/folded-${index}`),
		sample: { ref: "pi-ref://element/folded-0", name: "Result 0" },
	};
	const collection = model({ entities: [], templates: [template] });
	assert.equal(collection.completeness, "folded");
	assert.equal(collection.itemRefCount, 30);
	assert.equal(collection.itemRefs.length, 20);
	assert.equal(collection.continuation?.kind, "artifact-window");
});

test("collections: visible list hints without a terminal boundary are viewport windows", () => {
	const collection = model({
		entities: [],
		scanEvidence: {
			listHints: [{ selector: "#feed > article", itemCount: 12, firstItemPreview: "Alpha" }],
		},
	});
	assert.equal(collection.completeness, "viewport-window");
	assert.equal(collection.confidence, "low");
	assert.equal(collection.observedCount, 12);
	assert.notEqual(collection.completeness, "complete");
});

test("collections: declared total larger than observed window is virtualized", () => {
	const collection = model({
		entities: [1, 2, 3, 4].map((index) => item(index, { structure: { posInSet: index, setSize: 20 } })),
	});
	assert.equal(collection.completeness, "virtualized");
	assert.equal(collection.declaredTotal, 20);
	assert.equal(collection.continuation?.kind, "virtual-window");
});

test("collections: rendered items plus skeleton placeholders mark lazy hydration", () => {
	const rendered = [1, 2, 3, 4, 5, 6].map((index) => item(index, {
		role: "article",
		hints: { containerRole: "feed", containerName: "Videos" },
	}));
	const skeleton = item(7, {
		role: "article",
		name: "loading placeholder",
		hints: { containerRole: "feed", containerName: "Videos", skeleton: true },
	});
	const collection = model({ entities: [...rendered, skeleton] });
	assert.equal(collection.completeness, "lazy");
	assert.equal(collection.continuation?.kind, "virtual-window");
	assert(collection.evidence.some((entry) => /placeholder/.test(entry.summary)));
});

test("collections: generic growth probe upgrades a window to virtualized", () => {
	const collection = model({
		entities: [1, 2, 3, 4, 5].map((index) => item(index)),
		scanEvidence: {
			growthProbe: { beforeCount: 5, afterCount: 9, beforeScrollHeight: 1200, afterScrollHeight: 2400 },
		},
	});
	assert.equal(collection.completeness, "virtualized");
	assert.equal(collection.confidence, "high");
	assert.equal(collection.continuation?.kind, "virtual-window");
	assert(collection.evidence.some((entry) => entry.source === "growthProbe"));
});

test("collections: growth probe treats a shifted fixed-size virtual window as virtualized", () => {
	const collection = model({
		entities: [1, 2, 3, 4, 5].map((index) => item(index)),
		scanEvidence: {
			growthProbe: { beforeCount: 5, afterCount: 5, beforeFirstText: "Result 1", afterFirstText: "Result 12", windowShifted: true },
		},
	});
	assert.equal(collection.completeness, "virtualized");
	assert.equal(collection.confidence, "high");
	assert.equal(collection.continuation?.kind, "virtual-window");
	assert(collection.evidence.some((entry) => /visible item window shifted/.test(entry.summary)));
});

test("collections: generic next/page controls produce a pagination continuation signal", () => {
	const collection = model({
		entities: [1, 2, 3, 4, 5].map((index) => item(index)),
		scanEvidence: {
			actionables: [{ index: 4, role: "button", action: "Next page", disabled: false }],
		},
	});
	assert.equal(collection.completeness, "paginated");
	assert.equal(collection.continuation?.kind, "pagination-edge");
	assert(collection.evidence.some((entry) => entry.jsonPath === "data.actionables[0]"));
});

test("collections: raw AX/outline member counts are not completeness or item-count oracles", () => {
	const collection = model({
		entities: [item(1, {
			kind: "region",
			role: "list",
			name: "Topic 1",
			structure: undefined,
			hints: { listContainer: true, itemCount: 30, memberCount: 925, jsonPath: "data.list_hints[0]" },
		})],
		scanEvidence: {
			listHints: [{ selector: "#topics", itemCount: 30, firstItemPreview: "Topic 1", memberCount: 925 }],
		},
	});
	assert.equal(collection.observedCount, 30);
	assert.notEqual(collection.observedCount, 925);
	assert.notEqual(collection.completeness, "complete");
});

test("collections: data.rows alone is not a semantic collection model", () => {
	const models = buildCollectionModels({
		entities: [],
		scanEvidence: {
			rows: Array.from({ length: 15 }, (_, index) => ({ text: `Sidebar link ${index}`, href: `/nav/${index}` })),
		},
	});
	assert.deepEqual(models, []);
});

test("collections: sparse positional evidence remains unknown", () => {
	const collection = model({
		entities: [item(1, {
			role: "item",
			hints: { containerRole: "group", containerName: "Loose group" },
			structure: { posInSet: 1 },
		})],
	});
	assert.equal(collection.completeness, "unknown");
	assert.equal(collection.confidence, "low");
	assert.equal(collection.continuation, undefined);
});
