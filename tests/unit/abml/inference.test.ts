// ABML R2 — inference layer unit tests. Covers all 11 PageIntent patterns plus
// dedup (filter-panel supersedes search), evidence (login submitRef), multi-choice
// container grouping confidence, and expandable threshold.
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

function emptyRelations(): RelationSummary { return { summary: {}, highlights: [] }; }
function relSummary(counts: Record<string, number>): RelationSummary { return { summary: counts, highlights: [] }; }
function intentKinds(result: InferenceSummary): string[] { return result.intents.map((i) => i.intent); }

// ── login ─────────────────────────────────────────────────────────────────────

test("login detected when password input + button present; evidence.submitRef set", () => {
	const btn = entity({ ref: "pi-ref://control/submit", role: "button" });
	const entities = [
		entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "email" } }),
		entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "password" } }),
		btn,
	];
	const result = buildInferenceSummary(entities, emptyRelations());
	assert.ok(intentKinds(result).includes("login"));
	const login = result.intents.find((i) => i.intent === "login");
	assert.equal(login?.confidence, "high");
	assert.equal(login?.evidence?.submitRef, "pi-ref://control/submit", "evidence.submitRef = first non-disabled button");
});

test("login medium confidence (no button) — evidence absent", () => {
	const entities = [entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "password" } })];
	const login = buildInferenceSummary(entities, emptyRelations()).intents.find((i) => i.intent === "login");
	assert.ok(login);
	assert.equal(login!.confidence, "medium");
	assert.equal(login!.evidence, undefined);
});

test("no login when no password input", () => {
	const entities = [
		entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "text" } }),
		entity({ role: "button" }),
	];
	assert.ok(!intentKinds(buildInferenceSummary(entities, emptyRelations())).includes("login"));
});

// ── search ────────────────────────────────────────────────────────────────────

test("search (high) from searchbox role", () => {
	const entities = [entity({ role: "searchbox", state: { editable: true } })];
	const s = buildInferenceSummary(entities, emptyRelations()).intents.find((i) => i.intent === "search");
	assert.ok(s);
	assert.equal(s!.confidence, "high");
});

test("search (medium) from search landmark + editable input", () => {
	const entities = [
		entity({ role: "region", kind: "region", structure: { landmark: "search" } }),
		entity({ role: "textbox", state: { editable: true } }),
	];
	const s = buildInferenceSummary(entities, emptyRelations()).intents.find((i) => i.intent === "search");
	assert.ok(s);
	assert.equal(s!.confidence, "medium");
});

// ── filter-panel supersedes search ───────────────────────────────────────────

test("filter-panel detected; search NOT emitted separately", () => {
	const entities = [
		entity({ role: "region", kind: "region", structure: { landmark: "search" } }),
		entity({ role: "textbox", state: { editable: true } }),
		entity({ role: "combobox", kind: "control", state: { editable: true }, ref: "pi-ref://control/combo" }),
	];
	const kinds = intentKinds(buildInferenceSummary(entities, emptyRelations()));
	assert.ok(kinds.includes("filter-panel"));
	assert.ok(!kinds.includes("search"), "search suppressed when filter-panel fires");
});

// ── single-choice ─────────────────────────────────────────────────────────────

test("single-choice (high) from radiogroup", () => {
	const s = buildInferenceSummary([entity({ role: "radiogroup", kind: "region" })], emptyRelations()).intents.find((i) => i.intent === "single-choice");
	assert.ok(s && s.confidence === "high");
});

test("single-choice (medium) from 2+ radios without radiogroup", () => {
	const s = buildInferenceSummary([entity({ role: "radio" }), entity({ role: "radio", ref: "pi-ref://control/r2" })], emptyRelations()).intents.find((i) => i.intent === "single-choice");
	assert.ok(s && s.confidence === "medium");
});

// ── multi-choice ──────────────────────────────────────────────────────────────

test("multi-choice (high) when 3+ checkboxes share a group container", () => {
	const groupHints = { containerRole: "group", containerName: "Sport" };
	const entities = [
		entity({ role: "checkbox", hints: groupHints }),
		entity({ role: "checkbox", hints: groupHints, ref: "pi-ref://control/cb2" }),
		entity({ role: "checkbox", hints: groupHints, ref: "pi-ref://control/cb3" }),
	];
	const mc = buildInferenceSummary(entities, emptyRelations()).intents.find((i) => i.intent === "multi-choice");
	assert.ok(mc);
	assert.equal(mc!.confidence, "high", "grouped checkboxes → high confidence");
});

test("multi-choice (medium) when 3+ checkboxes are scattered (no shared container)", () => {
	const entities = [
		entity({ role: "checkbox" }),
		entity({ role: "checkbox", ref: "pi-ref://control/cb2" }),
		entity({ role: "checkbox", ref: "pi-ref://control/cb3" }),
	];
	const mc = buildInferenceSummary(entities, emptyRelations()).intents.find((i) => i.intent === "multi-choice");
	assert.ok(mc);
	assert.equal(mc!.confidence, "medium", "scattered checkboxes → medium confidence");
});

test("no multi-choice from only 2 checkboxes", () => {
	const entities = [entity({ role: "checkbox" }), entity({ role: "checkbox", ref: "pi-ref://control/cb2" })];
	assert.ok(!intentKinds(buildInferenceSummary(entities, emptyRelations())).includes("multi-choice"));
});

// ── expandable ────────────────────────────────────────────────────────────────

test("expandable detected when expandedTarget >= 2", () => {
	const exp = buildInferenceSummary([], relSummary({ expandedTarget: 2 })).intents.find((i) => i.intent === "expandable");
	assert.ok(exp && exp.confidence === "high");
});

test("no expandable when expandedTarget = 1 (single nav toggle — noise in live validation)", () => {
	assert.ok(!intentKinds(buildInferenceSummary([], relSummary({ expandedTarget: 1 }))).includes("expandable"));
});

test("no expandable from controls alone", () => {
	assert.ok(!intentKinds(buildInferenceSummary([], relSummary({ controls: 5 }))).includes("expandable"));
});

// ── data-grid ─────────────────────────────────────────────────────────────────

test("data-grid from grid role (ARIA interactive grid)", () => {
	assert.ok(intentKinds(buildInferenceSummary([entity({ role: "grid", kind: "region" })], emptyRelations())).includes("data-grid"));
});

test("data-grid from treegrid role", () => {
	assert.ok(intentKinds(buildInferenceSummary([entity({ role: "treegrid", kind: "region" })], emptyRelations())).includes("data-grid"));
});

test("data-grid from tableCells >= 50", () => {
	assert.ok(intentKinds(buildInferenceSummary([], relSummary({ tableCells: 50 }))).includes("data-grid"));
});

test("no data-grid from tableCells < 50 (doc-table noise threshold)", () => {
	assert.ok(!intentKinds(buildInferenceSummary([], relSummary({ tableCells: 42 }))).includes("data-grid"));
});

// ── navigation ────────────────────────────────────────────────────────────────

test("navigation from currentIn relation", () => {
	const nav = buildInferenceSummary([], relSummary({ currentIn: 1 })).intents.find((i) => i.intent === "navigation");
	assert.ok(nav && nav.confidence === "high");
});

// ── dialog ────────────────────────────────────────────────────────────────────

test("dialog from dialog role", () => {
	assert.ok(intentKinds(buildInferenceSummary([entity({ role: "dialog", kind: "region" })], emptyRelations())).includes("dialog"));
});

test("dialog from alertdialog role", () => {
	assert.ok(intentKinds(buildInferenceSummary([entity({ role: "alertdialog", kind: "region" })], emptyRelations())).includes("dialog"));
});

// ── tabbed-interface ──────────────────────────────────────────────────────────

test("tabbed-interface (high) from tablist role", () => {
	const ti = buildInferenceSummary([entity({ role: "tablist", kind: "region" })], emptyRelations()).intents.find((i) => i.intent === "tabbed-interface");
	assert.ok(ti && ti.confidence === "high");
});

test("tabbed-interface (medium) from 2+ tab entities without tablist", () => {
	const entities = [entity({ role: "tab" }), entity({ role: "tab", ref: "pi-ref://control/tab2" })];
	const ti = buildInferenceSummary(entities, emptyRelations()).intents.find((i) => i.intent === "tabbed-interface");
	assert.ok(ti && ti.confidence === "medium");
});

test("no tabbed-interface from single tab entity", () => {
	assert.ok(!intentKinds(buildInferenceSummary([entity({ role: "tab" })], emptyRelations())).includes("tabbed-interface"));
});

// ── alert-region ──────────────────────────────────────────────────────────────

test("alert-region from alert role", () => {
	const ar = buildInferenceSummary([entity({ role: "alert", kind: "region" })], emptyRelations()).intents.find((i) => i.intent === "alert-region");
	assert.ok(ar && ar.confidence === "high");
});

test("alert-region from status role", () => {
	assert.ok(intentKinds(buildInferenceSummary([entity({ role: "status", kind: "region" })], emptyRelations())).includes("alert-region"));
});

// ── empty / multi-intent co-occurrence ───────────────────────────────────────

test("empty intents when no patterns match", () => {
	assert.deepEqual(buildInferenceSummary([entity({ role: "link" })], emptyRelations()).intents, []);
});

test("multiple intents co-occur on a complex page", () => {
	const groupHints = { containerRole: "group", containerName: "Options" };
	const entities = [
		entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "password" } }),
		entity({ ref: "pi-ref://control/submit", role: "button" }),
		entity({ role: "radiogroup", kind: "region" }),
		entity({ role: "grid", kind: "region" }),
		entity({ role: "tablist", kind: "region" }),
		entity({ role: "checkbox", hints: groupHints }),
		entity({ role: "checkbox", hints: groupHints, ref: "pi-ref://control/cb2" }),
		entity({ role: "checkbox", hints: groupHints, ref: "pi-ref://control/cb3" }),
	];
	const result = buildInferenceSummary(entities, relSummary({ currentIn: 1 }));
	const kinds = intentKinds(result);
	assert.ok(kinds.includes("login"), "login");
	assert.ok(kinds.includes("single-choice"), "single-choice");
	assert.ok(kinds.includes("multi-choice"), "multi-choice");
	assert.ok(kinds.includes("data-grid"), "data-grid via grid role");
	assert.ok(kinds.includes("navigation"), "navigation via currentIn");
	assert.ok(kinds.includes("tabbed-interface"), "tabbed-interface");
	const mc = result.intents.find((i) => i.intent === "multi-choice");
	assert.equal(mc?.confidence, "high", "grouped checkboxes → high");
	const login = result.intents.find((i) => i.intent === "login");
	assert.equal(login?.evidence?.submitRef, "pi-ref://control/submit");
});
