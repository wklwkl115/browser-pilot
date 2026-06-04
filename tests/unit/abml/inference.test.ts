// ABML R2 — inference layer unit tests. Covers all PageIntent patterns plus
// dedup (filter-panel supersedes search), evidence (login submitRef), multi-choice
// container grouping confidence, expandable threshold, and boundary conditions
// (disabled-only buttons, partial/split grouping, co-occurring intents, evidence
// cleanliness, optional-diff-arg call site).
import test from "node:test";
import assert from "node:assert/strict";
import { buildInferenceSummary, type InferenceSummary } from "../../../src/abml-core/inference.ts";
import type { Entity } from "../../../src/abml-core/entity.ts";
import type { RelationSummary } from "../../../src/abml-core/relations.ts";

function entity(opts: {
	ref?: string;
	kind?: Entity["kind"];
	role: string;
	name?: string;
	state?: Partial<Entity["state"]>;
	structure?: Entity["structure"];
	hints?: Record<string, unknown>;
	relations?: Entity["relations"];
}): Entity {
	return {
		ref: opts.ref ?? `pi-ref://control/${opts.role}`,
		kind: opts.kind ?? "control",
		role: opts.role,
		...(opts.name !== undefined ? { name: opts.name } : {}),
		state: {
			visible: true, occluded: false, disabled: false, focused: false,
			editable: false, inViewport: true,
			...(opts.state ?? {}),
		},
		source: "dom",
		...(opts.structure ? { structure: opts.structure } : {}),
		...(opts.hints ? { hints: opts.hints } : {}),
		...(opts.relations ? { relations: opts.relations } : {}),
	};
}

function emptyRelations(): RelationSummary { return { summary: {}, highlights: [] }; }
function relSummary(counts: Record<string, number>): RelationSummary { return { summary: counts, highlights: [] }; }
function intentKinds(result: InferenceSummary): string[] { return result.intents.map((i) => i.intent); }

// ── login ─────────────────────────────────────────────────────────────────────

test("login detected when password input + submit-like button present; evidence.submitRef set", () => {
	const btn = entity({ ref: "pi-ref://control/submit", role: "button", name: "Sign in" });
	const entities = [
		entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "email" } }),
		entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "password" } }),
		btn,
	];
	const result = buildInferenceSummary(entities, emptyRelations());
	assert.ok(intentKinds(result).includes("login"));
	const login = result.intents.find((i) => i.intent === "login");
	assert.equal(login?.confidence, "high");
	assert.equal(login?.evidence?.submitRef, "pi-ref://control/submit", "evidence.submitRef = strong submit button");
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

test("filter-panel detected from explicit filter controls; search NOT emitted separately", () => {
	const entities = [
		entity({ role: "region", kind: "region", structure: { landmark: "search" } }),
		entity({ role: "link", name: "Apply HP filter", ref: "pi-ref://control/filter-hp" }),
		entity({ role: "link", name: "Apply Lenovo filter", ref: "pi-ref://control/filter-lenovo" }),
		entity({ role: "link", name: "Apply Dell filter", ref: "pi-ref://control/filter-dell" }),
	];
	const result = buildInferenceSummary(entities, emptyRelations());
	const kinds = intentKinds(result);
	assert.ok(kinds.includes("filter-panel"));
	assert.ok(!kinds.includes("search"), "search suppressed when filter-panel fires");
	assert.deepEqual(result.intents.find((i) => i.intent === "filter-panel")?.evidence?.controlRefs, ["pi-ref://control/filter-hp", "pi-ref://control/filter-lenovo", "pi-ref://control/filter-dell"]);
});

test("filter-panel does not fire for a plain search landmark with multiple non-filter inputs", () => {
	const entities = [
		entity({ role: "region", kind: "region", structure: { landmark: "search" } }),
		entity({ role: "textbox", state: { editable: true } }),
		entity({ role: "combobox", kind: "control", state: { editable: true }, ref: "pi-ref://control/combo" }),
	];
	const kinds = intentKinds(buildInferenceSummary(entities, emptyRelations()));
	assert.ok(!kinds.includes("filter-panel"));
	assert.ok(kinds.includes("search"));
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

test("expandable detected when 2 unique perceptible expandedTarget triggers resolve", () => {
	const triggers = [
		entity({ role: "button", ref: "pi-ref://control/acc1", relations: [{ type: "expandedTarget", targetRef: "pi-ref://region/p1", source: "dom", confidence: "high" }] }),
		entity({ role: "button", ref: "pi-ref://control/acc2", relations: [{ type: "expandedTarget", targetRef: "pi-ref://region/p2", source: "dom", confidence: "high" }] }),
	];
	const exp = buildInferenceSummary(triggers, relSummary({ expandedTarget: 2 })).intents.find((i) => i.intent === "expandable");
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

test("alert-region: a live region that appeared after an action is flagged fresh=appeared", () => {
	const entities = [entity({ role: "status", kind: "region", ref: "pi-ref://region/toast" })];
	const ar = buildInferenceSummary(entities, emptyRelations(), { appeared: ["pi-ref://region/toast"], disappeared: [], changed: [] }).intents.find((i) => i.intent === "alert-region");
	assert.equal(ar?.confidence, "high");
	assert.equal(ar?.evidence?.fresh, "appeared");
	assert.equal(ar?.evidence?.regionRef, "pi-ref://region/toast");
	assert.match(ar!.reason!, /appeared after action/);
});

test("alert-region: a persistent live region whose accessible name changed is flagged fresh=updated", () => {
	const entities = [entity({ role: "alert", kind: "region", ref: "pi-ref://region/err" })];
	const ar = buildInferenceSummary(entities, emptyRelations(), { appeared: [], disappeared: [], changed: [{ ref: "pi-ref://region/err", kind: "name-changed", before: {}, after: { name: "Error" } }] }).intents.find((i) => i.intent === "alert-region");
	assert.equal(ar?.evidence?.fresh, "updated");
	assert.equal(ar?.evidence?.live, "assertive");
	assert.match(ar!.reason!, /updated after action/);
});

test("alert-region: static scan (no diff) carries no fresh flag — behavior unchanged", () => {
	const ar = buildInferenceSummary([entity({ role: "status", kind: "region" })], emptyRelations()).intents.find((i) => i.intent === "alert-region");
	assert.ok(ar);
	assert.equal(ar!.evidence?.fresh, undefined);
});

test("alert-region: prefers the freshly-appeared region over a static one", () => {
	const entities = [
		entity({ role: "status", kind: "region", ref: "pi-ref://region/static" }),
		entity({ role: "alert", kind: "region", ref: "pi-ref://region/new" }),
	];
	const ar = buildInferenceSummary(entities, emptyRelations(), { appeared: ["pi-ref://region/new"], disappeared: [], changed: [] }).intents.find((i) => i.intent === "alert-region");
	assert.equal(ar?.evidence?.regionRef, "pi-ref://region/new", "the appeared region answers the last action; static one is secondary");
	assert.equal(ar?.evidence?.fresh, "appeared");
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

// ── boundary conditions (regression guards) ─────────────────────────────────────

test("login: all buttons disabled → medium, no submitRef", () => {
	const entities = [
		entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "password" } }),
		entity({ role: "button", ref: "pi-ref://control/disabled-btn", state: { disabled: true } }),
	];
	const login = buildInferenceSummary(entities, emptyRelations()).intents.find((i) => i.intent === "login");
	assert.ok(login, "login still detected (password present) even when button disabled");
	assert.equal(login!.confidence, "medium", "disabled-only buttons → medium");
	assert.equal(login!.evidence, undefined, "no submitRef when no actionable button");
});

test("login: submitRef skips disabled/noisy buttons and points to the strong enabled submit", () => {
	const entities = [
		entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "password" } }),
		entity({ role: "button", ref: "pi-ref://control/disabled-btn", name: "Sign in", state: { disabled: true } }),
		entity({ role: "button", ref: "pi-ref://control/passkey", name: "passkey-login-button" }),
		entity({ role: "button", ref: "pi-ref://control/active-btn", name: "sign-in-button" }),
	];
	const login = buildInferenceSummary(entities, emptyRelations()).intents.find((i) => i.intent === "login");
	assert.ok(login);
	assert.equal(login!.confidence, "high");
	assert.equal(login!.evidence?.submitRef, "pi-ref://control/active-btn", "submitRef = strongest non-disabled submit button");
});

test("login: federated '<verb> with X' buttons lose to the real submit — generic, no provider allowlist", () => {
	const entities = [
		entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "password" } }),
		entity({ role: "button", ref: "pi-ref://control/oauth-google", name: "Sign in with Google" }),
		// fictional provider — proves demotion is by the "X with Y" language shape, not a name list
		entity({ role: "button", ref: "pi-ref://control/oauth-acme", name: "Continue with Acme SSO" }),
		entity({ role: "button", ref: "pi-ref://control/submit", name: "Sign in" }),
	];
	const login = buildInferenceSummary(entities, emptyRelations()).intents.find((i) => i.intent === "login");
	assert.equal(login?.confidence, "high");
	assert.equal(login?.evidence?.submitRef, "pi-ref://control/submit", "real submit beats federated 'X with Y' buttons via a generic language pattern");
});

test("multi-choice: partial grouping (3 in a group + 1 scattered) → high", () => {
	const groupHints = { containerRole: "group", containerName: "Toppings" };
	const entities = [
		entity({ role: "checkbox", hints: groupHints }),
		entity({ role: "checkbox", hints: groupHints, ref: "pi-ref://control/cb2" }),
		entity({ role: "checkbox", hints: groupHints, ref: "pi-ref://control/cb3" }),
		entity({ role: "checkbox", ref: "pi-ref://control/cb-loose" }), // ungrouped newsletter checkbox
	];
	const mc = buildInferenceSummary(entities, emptyRelations()).intents.find((i) => i.intent === "multi-choice");
	assert.ok(mc);
	assert.equal(mc!.confidence, "high", "a group of 3 drives high even with an extra scattered checkbox");
});

test("multi-choice: 4 checkboxes spread across two groups of 2 each → medium (no single group reaches 3)", () => {
	const groupA = { containerRole: "group", containerName: "A" };
	const groupB = { containerRole: "group", containerName: "B" };
	const entities = [
		entity({ role: "checkbox", hints: groupA }),
		entity({ role: "checkbox", hints: groupA, ref: "pi-ref://control/a2" }),
		entity({ role: "checkbox", hints: groupB, ref: "pi-ref://control/b1" }),
		entity({ role: "checkbox", hints: groupB, ref: "pi-ref://control/b2" }),
	];
	const mc = buildInferenceSummary(entities, emptyRelations()).intents.find((i) => i.intent === "multi-choice");
	assert.ok(mc, "4 checkboxes total → multi-choice fires");
	assert.equal(mc!.confidence, "medium", "no single group reaches 3 → medium");
});

test("tabbed-interface + navigation co-occur (tab panel with a breadcrumb — common SPA shape)", () => {
	const entities = [entity({ role: "tablist", kind: "region" })];
	const kinds = intentKinds(buildInferenceSummary(entities, relSummary({ currentIn: 1 })));
	assert.ok(kinds.includes("tabbed-interface"), "tabbed-interface from tablist");
	assert.ok(kinds.includes("navigation"), "navigation from currentIn — independent detectors co-fire");
});

test("alert-region + dialog co-occur (validation error inside a modal)", () => {
	const entities = [
		entity({ role: "dialog", kind: "region" }),
		entity({ role: "alert", kind: "region", ref: "pi-ref://region/err" }),
	];
	const kinds = intentKinds(buildInferenceSummary(entities, emptyRelations()));
	assert.ok(kinds.includes("dialog"), "dialog detected");
	assert.ok(kinds.includes("alert-region"), "alert-region detected alongside dialog");
});

test("form-dependency detected from R3 diff disabled→enabled + focused editable field", () => {
	const entities = [
		entity({ role: "textbox", ref: "pi-ref://control/email", state: { editable: true, focused: true } }),
		entity({ role: "button", ref: "pi-ref://control/submit", state: { disabled: false } }),
	];
	const result = buildInferenceSummary(entities, emptyRelations(), {
		appeared: [],
		disappeared: [],
		changed: [{ ref: "pi-ref://control/submit", kind: "state-changed", before: { disabled: true }, after: { disabled: false } }],
		focusedRef: "pi-ref://control/email",
	});
	const dep = result.intents.find((i) => i.intent === "form-dependency");
	assert.ok(dep, "form-dependency fires");
	assert.equal(dep!.confidence, "high");
	assert.deepEqual(dep!.evidence, { enabledRef: "pi-ref://control/submit", requiredRef: "pi-ref://control/email" });
});

test("form-dependency does not fire without focused editable required field", () => {
	const entities = [entity({ role: "button", ref: "pi-ref://control/submit", state: { disabled: false } })];
	const result = buildInferenceSummary(entities, emptyRelations(), {
		appeared: [],
		disappeared: [],
		changed: [{ ref: "pi-ref://control/submit", kind: "state-changed", before: { disabled: true }, after: { disabled: false } }],
	});
	assert.ok(!intentKinds(result).includes("form-dependency"));
});

// ── evidence anchoring + reason (R2 optimization) ───────────────────────────────

test("every fired intent carries a reason string", () => {
	const groupHints = { containerRole: "group", containerName: "Sizes" };
	const entities = [
		entity({ role: "textbox", state: { editable: true }, hints: { inputKind: "password" } }),
		entity({ role: "button", ref: "pi-ref://control/submit" }),
		entity({ role: "grid", kind: "region" }),
		entity({ role: "tablist", kind: "region" }),
		entity({ role: "status", kind: "region" }),
		entity({ role: "checkbox", hints: groupHints }),
		entity({ role: "checkbox", hints: groupHints, ref: "pi-ref://control/cb2" }),
		entity({ role: "checkbox", hints: groupHints, ref: "pi-ref://control/cb3" }),
	];
	const result = buildInferenceSummary(entities, relSummary({ currentIn: 1 }));
	assert.ok(result.intents.length > 0);
	for (const i of result.intents) {
		assert.equal(typeof i.reason, "string", `${i.intent} must carry a reason`);
		assert.ok(i.reason!.length > 0, `${i.intent} reason non-empty`);
	}
});

test("evidence values are refs/counts/metadata only — never user-entered text", () => {
	// All evidence values must be pi-ref:// strings, numbers (counts), short metadata tokens
	// (live: assertive/polite), or arrays thereof — never arbitrary user input.
	const groupHints = { containerRole: "group", containerName: "Sport" };
	const entities = [
		entity({ role: "grid", kind: "region" }),
		entity({ role: "tablist", kind: "region" }),
		entity({ role: "alert", kind: "region" }),
		entity({ role: "checkbox", hints: groupHints }),
		entity({ role: "checkbox", hints: groupHints, ref: "pi-ref://control/cb2" }),
		entity({ role: "checkbox", hints: groupHints, ref: "pi-ref://control/cb3" }),
	];
	const result = buildInferenceSummary(entities, relSummary({ currentIn: 1 }));
	const okValue = (v: unknown): boolean =>
		(typeof v === "string" && (v.startsWith("pi-ref://") || v === "assertive" || v === "polite" || /^[\w' -]{1,40}$/.test(v)))
		|| typeof v === "number"
		|| (Array.isArray(v) && v.every((x) => typeof x === "string" && x.startsWith("pi-ref://")));
	for (const i of result.intents) {
		for (const [key, val] of Object.entries(i.evidence ?? {})) {
			assert.ok(okValue(val), `${i.intent}.evidence.${key} must be a ref/count/metadata token, got ${JSON.stringify(val)}`);
		}
	}
});

test("evidence anchors each intent to the right ref", () => {
	const groupHints = { containerRole: "group", containerName: "Toppings" };
	const entities = [
		entity({ role: "searchbox", ref: "pi-ref://control/q", state: { editable: true } }),
		entity({ role: "grid", kind: "region", ref: "pi-ref://region/grid" }),
		entity({ role: "tablist", kind: "region", ref: "pi-ref://region/tablist" }),
		entity({ role: "tab", ref: "pi-ref://control/tab1" }),
		entity({ role: "tab", ref: "pi-ref://control/tab2" }),
		entity({ role: "dialog", kind: "region", ref: "pi-ref://region/dlg" }),
		entity({ role: "alert", kind: "region", ref: "pi-ref://region/alert" }),
		entity({ role: "checkbox", hints: groupHints, ref: "pi-ref://control/t1" }),
		entity({ role: "checkbox", hints: groupHints, ref: "pi-ref://control/t2" }),
		entity({ role: "checkbox", hints: groupHints, ref: "pi-ref://control/t3" }),
	];
	const by = (intent: string) => buildInferenceSummary(entities, emptyRelations()).intents.find((i) => i.intent === intent);
	assert.equal(by("search")?.evidence?.searchRef, "pi-ref://control/q");
	assert.equal(by("data-grid")?.evidence?.gridRef, "pi-ref://region/grid");
	assert.equal(by("tabbed-interface")?.evidence?.tablistRef, "pi-ref://region/tablist");
	assert.deepEqual(by("tabbed-interface")?.evidence?.tabRefs, ["pi-ref://control/tab1", "pi-ref://control/tab2"]);
	assert.equal(by("dialog")?.evidence?.dialogRef, "pi-ref://region/dlg");
	assert.equal(by("alert-region")?.evidence?.regionRef, "pi-ref://region/alert");
	assert.equal(by("alert-region")?.evidence?.live, "assertive");
	assert.deepEqual(by("multi-choice")?.evidence?.optionRefs, ["pi-ref://control/t1", "pi-ref://control/t2", "pi-ref://control/t3"]);
	assert.equal(by("multi-choice")?.evidence?.groupName, "Toppings");
});

test("data-grid via tableCells resolves tableRef from a cellOf relation; fires even without one", () => {
	// With a cellOf relation present → tableRef resolves.
	const withTable = [
		entity({ role: "gridcell", ref: "pi-ref://cell/1", hints: {}, }),
	];
	withTable[0]!.relations = [{ type: "cellOf", targetRef: "pi-ref://region/table", source: "ax", confidence: "high" }];
	const r1 = buildInferenceSummary(withTable, relSummary({ tableCells: 60 })).intents.find((i) => i.intent === "data-grid");
	assert.ok(r1, "data-grid fires from tableCells>=50");
	assert.equal(r1!.evidence?.tableRef, "pi-ref://region/table");
	assert.equal(r1!.evidence?.cellCount, 60);
	// Count comes from a table whose entities aren't in the list → tableRef omitted, intent still fires.
	const r2 = buildInferenceSummary([], relSummary({ tableCells: 60 })).intents.find((i) => i.intent === "data-grid");
	assert.ok(r2, "data-grid still fires when no cell entity is present (decoupled detection)");
	assert.equal(r2!.evidence?.tableRef, undefined, "tableRef omitted when unresolvable");
	assert.equal(r2!.evidence?.cellCount, 60, "cellCount still surfaced");
});

test("expandable resolves trigger refs from expandedTarget relations; fires on count even without them", () => {
	const triggers = [
		entity({ role: "button", ref: "pi-ref://control/acc1" }),
		entity({ role: "button", ref: "pi-ref://control/acc2" }),
	];
	triggers[0]!.relations = [{ type: "expandedTarget", targetRef: "pi-ref://region/p1", source: "ax", confidence: "high" }];
	triggers[1]!.relations = [{ type: "expandedTarget", targetRef: "pi-ref://region/p2", source: "ax", confidence: "high" }];
	const r = buildInferenceSummary(triggers, relSummary({ expandedTarget: 2 })).intents.find((i) => i.intent === "expandable");
	assert.ok(r);
	assert.deepEqual(r!.evidence?.triggerRefs, ["pi-ref://control/acc1", "pi-ref://control/acc2"]);
	// Count without matching entities no longer fires: live validation showed count-only
	// expandable creates hidden/dropdown false positives without actionable anchors.
	const r2 = buildInferenceSummary([], relSummary({ expandedTarget: 2 })).intents.find((i) => i.intent === "expandable");
	assert.equal(r2, undefined, "expandable requires resolved trigger evidence");
});

test("ref arrays are capped at MAX_EVIDENCE_REFS with a sibling count", () => {
	const entities = Array.from({ length: 9 }, (_, i) => entity({ role: "tab", ref: `pi-ref://control/tab${i}` }));
	const ti = buildInferenceSummary(entities, emptyRelations()).intents.find((i) => i.intent === "tabbed-interface");
	assert.ok(ti);
	assert.equal((ti!.evidence?.tabRefs as string[]).length, 6, "tabRefs capped at 6");
	assert.equal(ti!.evidence?.tabCount, 9, "tabCount = untruncated total");
});

test("buildInferenceSummary is callable without the optional diff arg (R2-only call site)", () => {
	// observeRunners may call with two args (no R3 diff baseline); must not throw.
	const result = buildInferenceSummary([entity({ role: "tablist", kind: "region" })], emptyRelations());
	assert.ok(intentKinds(result).includes("tabbed-interface"));
});
