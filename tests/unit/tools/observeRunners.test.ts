import test from "node:test";
import assert from "node:assert/strict";
import {
	normalizeContentTimeoutMs,
	entitySalienceRank,
	sortEntitiesBySalience,
	buildEntityOutline,
	buildPageGist,
	DEFAULT_CONTENT_TIMEOUT_MS,
	MIN_CONTENT_TIMEOUT_MS,
} from "../../../src/tools/observeRunners.ts";
import type { Entity } from "../../../src/abml/entity.ts";

// ── normalizeContentTimeoutMs ─────────────────────────────────────────────────

test("normalizeContentTimeoutMs returns default when undefined", () => {
	assert.equal(normalizeContentTimeoutMs(undefined), DEFAULT_CONTENT_TIMEOUT_MS);
});

test("normalizeContentTimeoutMs returns default when null", () => {
	assert.equal(normalizeContentTimeoutMs(null), DEFAULT_CONTENT_TIMEOUT_MS);
});

test("normalizeContentTimeoutMs accepts positive number", () => {
	assert.equal(normalizeContentTimeoutMs(5000), 5000);
});

test("normalizeContentTimeoutMs ceils fractional values", () => {
	assert.equal(normalizeContentTimeoutMs(100.1), 101);
});

test("normalizeContentTimeoutMs throws for zero or negative", () => {
	assert.throws(() => normalizeContentTimeoutMs(0), /INVALID_TIMEOUT|positive number/);
	assert.throws(() => normalizeContentTimeoutMs(-100), /INVALID_TIMEOUT|positive number/);
});

test("normalizeContentTimeoutMs throws below minimum", () => {
	assert.throws(() => normalizeContentTimeoutMs(MIN_CONTENT_TIMEOUT_MS - 1), /INVALID_TIMEOUT|at least/);
});

test("normalizeContentTimeoutMs accepts exactly minimum", () => {
	assert.equal(normalizeContentTimeoutMs(MIN_CONTENT_TIMEOUT_MS), MIN_CONTENT_TIMEOUT_MS);
});

test("normalizeContentTimeoutMs throws for NaN and Infinity", () => {
	assert.throws(() => normalizeContentTimeoutMs(NaN), /positive number/);
	assert.throws(() => normalizeContentTimeoutMs(Infinity), /positive number/);
});

// ── entitySalienceRank ────────────────────────────────────────────────────────

function makeEntity(overrides: Partial<Entity> = {}): Entity {
	return {
		ref: "ref-1",
		kind: "control",
		role: "button",
		name: "Click me",
		state: {},
		source: "ax",
		structure: {},
		hints: {},
		...overrides,
	} as Entity;
}

test("entitySalienceRank gives rank 0 to checked=true entities", () => {
	const entity = makeEntity({ state: { checked: true } });
	assert.equal(entitySalienceRank(entity), 0);
});

test("entitySalienceRank gives rank 0 to selected=true entities", () => {
	const entity = makeEntity({ state: { selected: true } });
	assert.equal(entitySalienceRank(entity), 0);
});

test("entitySalienceRank gives rank 0 to pressed=true entities", () => {
	const entity = makeEntity({ state: { pressed: true } });
	assert.equal(entitySalienceRank(entity), 0);
});

test("entitySalienceRank gives rank 0 to current entity", () => {
	const entity = makeEntity({ state: { current: "page" } });
	assert.equal(entitySalienceRank(entity), 0);
});

test("entitySalienceRank gives rank 1 to entities with checked defined but false", () => {
	const entity = makeEntity({ state: { checked: false } });
	assert.equal(entitySalienceRank(entity), 1);
});

test("entitySalienceRank gives rank 2 to control entities", () => {
	const entity = makeEntity({ kind: "control", state: {} });
	assert.equal(entitySalienceRank(entity), 2);
});

test("entitySalienceRank gives rank 3 to inViewport entities", () => {
	const entity = makeEntity({ kind: "region", state: { inViewport: true } });
	assert.equal(entitySalienceRank(entity), 3);
});

test("entitySalienceRank gives rank 4 to plain region entities", () => {
	const entity = makeEntity({ kind: "region", state: {} });
	assert.equal(entitySalienceRank(entity), 4);
});

// ── sortEntitiesBySalience ────────────────────────────────────────────────────

test("sortEntitiesBySalience places active controls before inactive regions", () => {
	const active = makeEntity({ ref: "active", kind: "control", state: { checked: true } });
	const passive = makeEntity({ ref: "passive", kind: "region", state: {} });
	const sorted = sortEntitiesBySalience([passive, active]);
	assert.equal(sorted[0].ref, "active");
	assert.equal(sorted[1].ref, "passive");
});

test("sortEntitiesBySalience preserves stable order within same rank", () => {
	const a = makeEntity({ ref: "a", state: {} });
	const b = makeEntity({ ref: "b", state: {} });
	const c = makeEntity({ ref: "c", state: {} });
	const sorted = sortEntitiesBySalience([a, b, c]);
	assert.equal(sorted[0].ref, "a");
	assert.equal(sorted[1].ref, "b");
	assert.equal(sorted[2].ref, "c");
});

// ── buildEntityOutline ────────────────────────────────────────────────────────

test("buildEntityOutline returns empty array for entities with no containerRole hints", () => {
	const entities = [
		makeEntity({ ref: "e1", hints: {} }),
		makeEntity({ ref: "e2", hints: { containerRole: undefined } }),
	];
	assert.deepEqual(buildEntityOutline(entities), []);
});

test("buildEntityOutline groups entities by containerRole", () => {
	const entities = [
		makeEntity({ ref: "e1", kind: "control", hints: { containerRole: "navigation" } }),
		makeEntity({ ref: "e2", kind: "control", hints: { containerRole: "navigation" } }),
		makeEntity({ ref: "e3", kind: "region", hints: { containerRole: "main" } }),
	];
	const outline = buildEntityOutline(entities);
	assert.equal(outline.length, 2);
	const nav = outline.find((g) => g.container === "navigation");
	assert.ok(nav);
	assert.equal(nav!.memberCount, 2);
});

test("buildEntityOutline puts controls first in memberRefs", () => {
	const entities = [
		makeEntity({ ref: "region1", kind: "region", hints: { containerRole: "form" } }),
		makeEntity({ ref: "btn1", kind: "control", hints: { containerRole: "form" } }),
	];
	const outline = buildEntityOutline(entities);
	const form = outline[0];
	assert.equal(form.memberRefs[0], "btn1");
});

// ── buildPageGist ─────────────────────────────────────────────────────────────

test("buildPageGist returns zero counts for empty entities", () => {
	const gist = buildPageGist([]);
	assert.equal(gist.controlCount, 0);
	assert.equal(gist.containerCount, 0);
	assert.deepEqual(gist.landmarks, []);
});

test("buildPageGist collects landmarks from entities", () => {
	const entities = [
		makeEntity({ structure: { landmark: "navigation" } }),
		makeEntity({ structure: { landmark: "main" } }),
		makeEntity({ structure: { landmark: "navigation" } }), // duplicate
	];
	const gist = buildPageGist(entities);
	assert.equal(gist.landmarks.length, 2, "deduplicates landmarks");
	assert.ok((gist.landmarks as string[]).includes("navigation"));
	assert.ok((gist.landmarks as string[]).includes("main"));
});

test("buildPageGist counts controls correctly", () => {
	const entities = [
		makeEntity({ kind: "control", state: {} }),
		makeEntity({ kind: "control", state: {} }),
		makeEntity({ kind: "region", state: {} }),
	];
	const gist = buildPageGist(entities);
	assert.equal(gist.controlCount, 2);
});

test("buildPageGist reports stateful and active control counts", () => {
	const entities = [
		makeEntity({ kind: "control", state: { checked: true } }),   // active stateful
		makeEntity({ kind: "control", state: { checked: false } }),  // stateful not active
		makeEntity({ kind: "control", state: {} }),                  // plain
	];
	const gist = buildPageGist(entities);
	assert.equal(gist.controlCount, 3);
	assert.equal((gist as Record<string, unknown>).statefulControlCount, 2);
	assert.equal((gist as Record<string, unknown>).activeControlCount, 1);
});
