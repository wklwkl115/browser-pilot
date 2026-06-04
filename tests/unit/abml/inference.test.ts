// ABML R2 — inference layer unit tests. Each detector is independent; tests cover every
// PageIntent pattern (login/search/filter-panel/single-choice/multi-choice/expandable/
// data-grid/navigation/dialog) and dedup behaviour (filter-panel supersedes search).
import test from "node:test";
import assert from "node:assert/strict";
import { buildInferenceSummary, type InferenceSummary } from "../../../src/abml-core/inference.ts";
import type { Entity } from "../../../src/abml-core/entity.ts";
import type { RelationSummary } from "../../../src/abml-core/relations.ts";

function entity(opts: {
	ref?: string;
	kind?: Entity["kind"];
	role: string;
	state?: Partial<Entity["state"]>;
	structure?: Entity["structure"];
	hints?: Record<string, unknown>;
}): Entity {
	return {
		ref: opts.ref ?? `pi-ref://control/${opts.role}`,
		kind: opts.kind ?? "control",
		role: opts.role,
		state: {
			visible: true, occluded: false, disabled: false, focused: false,
			editable: false, inViewport: true,
			...(opts.state ?? {}),
		},
		source: "dom",
		...(opts.structure ? { structure: opts.structure } : {}),
		...(opts.hints ? { hints: opts.hints } : {}),
	};
}

function emptyRelations(): RelationSummary {
	return { summary: {}, highlights: [] };
}

function relSummary(counts: Record<string, number>): RelationSummary {
	return { summary: counts, highlights: [] };
}

function intentKinds(result: InferenceSummary): string[] {
	return result.intents.map((i) => i.intent);
}

// ── login ─────────────────────────────────────────────────────────────────────

test("login detected when password input + button present", () => {
	const entities = [
		entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "email" } }),
		entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "password" } }),
		entity({ role: "button" }),
	];
	const result = buildInferenceSummary(entities, emptyRelations());
	assert.ok(intentKinds(result).includes("login"), "login detected");
	const login = result.intents.find((i) => i.intent === "login");
	assert.equal(login?.confidence, "high", "high confidence when button present");
});

test("login medium confidence when password input but no button", () => {
	const entities = [
		entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "password" } }),
	];
	const result = buildInferenceSummary(entities, emptyRelations());
	const login = result.intents.find((i) => i.intent === "login");
	assert.ok(login, "login detected");
	assert.equal(login!.confidence, "medium");
});

test("no login when no password input", () => {
	const entities = [
		entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "text" } }),
		entity({ role: "button" }),
	];
	const result = buildInferenceSummary(entities, emptyRelations());
	assert.ok(!intentKinds(result).includes("login"), "no login without password");
});

// ── search ────────────────────────────────────────────────────────────────────

test("search (high) detected from searchbox role", () => {
	const entities = [entity({ role: "searchbox", state: { editable: true } })];
	const result = buildInferenceSummary(entities, emptyRelations());
	const search = result.intents.find((i) => i.intent === "search");
	assert.ok(search, "search detected");
	assert.equal(search!.confidence, "high");
});

test("search (medium) detected from search landmark + input", () => {
	const entities = [
		entity({ role: "region", kind: "region", structure: { landmark: "search" } }),
		entity({ role: "textbox", state: { editable: true } }),
	];
	const result = buildInferenceSummary(entities, emptyRelations());
	const search = result.intents.find((i) => i.intent === "search");
	assert.ok(search, "search detected from landmark");
	assert.equal(search!.confidence, "medium");
});

test("no search when search landmark present but no editable inputs", () => {
	const entities = [
		entity({ role: "region", kind: "region", structure: { landmark: "search" } }),
	];
	const result = buildInferenceSummary(entities, emptyRelations());
	assert.ok(!intentKinds(result).includes("search"), "no search without editable input");
});

// ── filter-panel (supersedes search) ─────────────────────────────────────────

test("filter-panel detected from search landmark + 2+ editable inputs; search not emitted separately", () => {
	const entities = [
		entity({ role: "region", kind: "region", structure: { landmark: "search" } }),
		entity({ role: "textbox", state: { editable: true } }),
		entity({ role: "combobox", kind: "control", state: { editable: true } }),
	];
	const result = buildInferenceSummary(entities, emptyRelations());
	assert.ok(intentKinds(result).includes("filter-panel"), "filter-panel detected");
	assert.ok(!intentKinds(result).includes("search"), "search not emitted when filter-panel fires");
});

test("filter-panel not detected with only 1 editable input in search landmark", () => {
	const entities = [
		entity({ role: "region", kind: "region", structure: { landmark: "search" } }),
		entity({ role: "textbox", state: { editable: true } }),
	];
	const result = buildInferenceSummary(entities, emptyRelations());
	assert.ok(!intentKinds(result).includes("filter-panel"), "filter-panel needs 2+ inputs");
});

// ── single-choice ─────────────────────────────────────────────────────────────

test("single-choice (high) detected from radiogroup role", () => {
	const entities = [entity({ role: "radiogroup", kind: "region" })];
	const result = buildInferenceSummary(entities, emptyRelations());
	const sc = result.intents.find((i) => i.intent === "single-choice");
	assert.ok(sc, "single-choice detected");
	assert.equal(sc!.confidence, "high");
});

test("single-choice (medium) detected from 2+ radio entities", () => {
	const entities = [entity({ role: "radio" }), entity({ role: "radio", ref: "pi-ref://control/radio2" })];
	const result = buildInferenceSummary(entities, emptyRelations());
	const sc = result.intents.find((i) => i.intent === "single-choice");
	assert.ok(sc, "single-choice detected from radios");
	assert.equal(sc!.confidence, "medium");
});

test("no single-choice from only 1 radio entity", () => {
	const entities = [entity({ role: "radio" })];
	const result = buildInferenceSummary(entities, emptyRelations());
	assert.ok(!intentKinds(result).includes("single-choice"), "single radio is not a choice group");
});

// ── multi-choice ──────────────────────────────────────────────────────────────

test("multi-choice detected from 3+ checkboxes", () => {
	const entities = [
		entity({ role: "checkbox" }),
		entity({ role: "checkbox", ref: "pi-ref://control/cb2" }),
		entity({ role: "checkbox", ref: "pi-ref://control/cb3" }),
	];
	const result = buildInferenceSummary(entities, emptyRelations());
	assert.ok(intentKinds(result).includes("multi-choice"), "3 checkboxes → multi-choice");
});

test("no multi-choice from 2 checkboxes", () => {
	const entities = [entity({ role: "checkbox" }), entity({ role: "checkbox", ref: "pi-ref://control/cb2" })];
	const result = buildInferenceSummary(entities, emptyRelations());
	assert.ok(!intentKinds(result).includes("multi-choice"), "2 checkboxes not enough");
});

// ── expandable ────────────────────────────────────────────────────────────────

test("expandable detected from expandedTarget in relation summary", () => {
	const result = buildInferenceSummary([], relSummary({ expandedTarget: 2 }));
	const exp = result.intents.find((i) => i.intent === "expandable");
	assert.ok(exp, "expandable detected");
	assert.equal(exp!.confidence, "high");
});

test("no expandable when only controls (not expandedTarget) in summary", () => {
	const result = buildInferenceSummary([], relSummary({ controls: 3 }));
	assert.ok(!intentKinds(result).includes("expandable"), "controls alone doesn't imply expandable");
});

// ── data-grid ─────────────────────────────────────────────────────────────────

test("data-grid detected from grid role entity (ARIA interactive grid)", () => {
	const entities = [entity({ role: "grid", kind: "region" })];
	const result = buildInferenceSummary(entities, emptyRelations());
	const dg = result.intents.find((i) => i.intent === "data-grid");
	assert.ok(dg, "grid role → data-grid");
	assert.equal(dg!.confidence, "high");
});

test("data-grid detected from treegrid role entity", () => {
	const entities = [entity({ role: "treegrid", kind: "region" })];
	const result = buildInferenceSummary(entities, emptyRelations());
	assert.ok(intentKinds(result).includes("data-grid"), "treegrid → data-grid");
});

test("data-grid detected from tableCells >= 50 (large data table)", () => {
	const result = buildInferenceSummary([], relSummary({ tableCells: 50 }));
	assert.ok(intentKinds(result).includes("data-grid"), "tableCells=50 → data-grid");
});

test("no data-grid from small tables (< 50 cells) — filters documentation/attribute tables", () => {
	const result = buildInferenceSummary([], relSummary({ tableCells: 42 }));
	assert.ok(!intentKinds(result).includes("data-grid"), "tableCells=42 does NOT trigger data-grid (doc table noise)");
});

test("no data-grid when tableCells is 0", () => {
	const result = buildInferenceSummary([], relSummary({ tableCells: 0 }));
	assert.ok(!intentKinds(result).includes("data-grid"), "tableCells:0 is not a data-grid");
});

// ── navigation ────────────────────────────────────────────────────────────────

test("navigation detected from currentIn in relation summary", () => {
	const result = buildInferenceSummary([], relSummary({ currentIn: 1 }));
	const nav = result.intents.find((i) => i.intent === "navigation");
	assert.ok(nav, "navigation detected");
	assert.equal(nav!.confidence, "high");
});

// ── dialog ────────────────────────────────────────────────────────────────────

test("dialog detected from dialog role entity", () => {
	const entities = [entity({ role: "dialog", kind: "region" })];
	const result = buildInferenceSummary(entities, emptyRelations());
	assert.ok(intentKinds(result).includes("dialog"), "dialog role → dialog intent");
});

test("dialog detected from alertdialog role", () => {
	const entities = [entity({ role: "alertdialog", kind: "region" })];
	const result = buildInferenceSummary(entities, emptyRelations());
	assert.ok(intentKinds(result).includes("dialog"), "alertdialog → dialog intent");
});

// ── empty / no-match ─────────────────────────────────────────────────────────

test("empty intents array when no patterns match", () => {
	const result = buildInferenceSummary([entity({ role: "link" })], emptyRelations());
	assert.deepEqual(result.intents, [], "no detections on a plain link");
});

test("multiple intents co-occur on a complex page", () => {
	const entities = [
		entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "password" } }),
		entity({ role: "button" }),
		entity({ role: "radiogroup", kind: "region" }),
		entity({ role: "grid", kind: "region" }),
	];
	const result = buildInferenceSummary(entities, relSummary({ tableCells: 0 }));
	const kinds = intentKinds(result);
	assert.ok(kinds.includes("login"), "login co-detected");
	assert.ok(kinds.includes("single-choice"), "single-choice co-detected");
	assert.ok(kinds.includes("data-grid"), "data-grid co-detected (via grid role)");
});
