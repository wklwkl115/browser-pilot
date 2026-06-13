import test from "node:test";
import assert from "node:assert/strict";
import { buildInferenceSummary, type InferenceSummary } from "../../../src/abml-core/inference.ts";
import type { Entity, RelationType } from "../../../src/abml-core/entity.ts";
import type { EntityDiff } from "../../../src/abml-core/diff.ts";
import type { RelationSummary } from "../../../src/abml-core/relations.ts";
import { compareMicroBench, microBenchSink } from "../helpers/microBench.ts";

type EntityOptions = {
	ref?: string;
	kind?: Entity["kind"];
	role: string;
	name?: string;
	state?: Partial<Entity["state"]>;
	structure?: Entity["structure"];
	hints?: Record<string, unknown>;
	relations?: Entity["relations"];
};

function entity(opts: EntityOptions): Entity {
	return {
		ref: opts.ref ?? `pi-ref://control/${opts.role}`,
		kind: opts.kind ?? "control",
		role: opts.role,
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
		...(opts.structure ? { structure: opts.structure } : {}),
		...(opts.hints ? { hints: opts.hints } : {}),
		...(opts.relations ? { relations: opts.relations } : {}),
	};
}

function emptyRelations(): RelationSummary {
	return { summary: {}, highlights: [] };
}

function relSummary(counts: Record<string, number>): RelationSummary {
	return { summary: counts, highlights: [] };
}

type InferenceFixture = {
	name: string;
	entities: Entity[];
	relSummary: RelationSummary;
	diff?: EntityDiff;
};

const parityFixtures: InferenceFixture[] = [
	{
		name: "login strong submit",
		entities: [
			entity({ role: "textbox", ref: "pi-ref://control/email", state: { editable: true }, hints: { inputKind: "email", selector: "#email" } }),
			entity({ role: "textbox", ref: "pi-ref://control/password", state: { editable: true }, hints: { inputKind: "password", selector: "#password" } }),
			entity({ role: "button", ref: "pi-ref://control/submit", name: "Sign in", hints: { selector: "button[type='submit']" } }),
		],
		relSummary: emptyRelations(),
	},
	{
		name: "search landmark",
		entities: [
			entity({ role: "region", kind: "region", ref: "pi-ref://region/search", structure: { landmark: "search" } }),
			entity({ role: "textbox", ref: "pi-ref://control/query", state: { editable: true }, hints: { selector: "#query" } }),
		],
		relSummary: emptyRelations(),
	},
	{
		name: "filter panel grouped controls",
		entities: [
			entity({ role: "region", kind: "region", structure: { landmark: "search" } }),
			entity({ role: "link", ref: "pi-ref://control/filter-brand", name: "Filter by brand", hints: { selector: "[data-filter='brand']" } }),
			entity({ role: "checkbox", ref: "pi-ref://control/filter-price", name: "Filter by price", hints: { selector: "[data-filter='price']" } }),
			entity({ role: "button", ref: "pi-ref://control/filter-rating", name: "Sort by rating", hints: { selector: "[data-filter='rating']" } }),
		],
		relSummary: emptyRelations(),
	},
	{
		name: "single choice radiogroup",
		entities: [entity({ role: "radiogroup", kind: "region", ref: "pi-ref://region/radio-group" })],
		relSummary: emptyRelations(),
	},
	{
		name: "multi choice grouped",
		entities: [
			entity({ role: "checkbox", ref: "pi-ref://control/cb1", hints: { containerRole: "group", containerName: "Sizes" } }),
			entity({ role: "checkbox", ref: "pi-ref://control/cb2", hints: { containerRole: "group", containerName: "Sizes" } }),
			entity({ role: "checkbox", ref: "pi-ref://control/cb3", hints: { containerRole: "group", containerName: "Sizes" } }),
		],
		relSummary: emptyRelations(),
	},
	{
		name: "expandable triggers",
		entities: [
			entity({ role: "button", ref: "pi-ref://control/acc1", relations: [{ type: "expandedTarget", targetRef: "pi-ref://region/p1", source: "dom", confidence: "high" }] }),
			entity({ role: "button", ref: "pi-ref://control/acc2", relations: [{ type: "expandedTarget", targetRef: "pi-ref://region/p2", source: "dom", confidence: "high" }] }),
		],
		relSummary: relSummary({ expandedTarget: 2 }),
	},
	{
		name: "data grid role wins",
		entities: [entity({ role: "grid", kind: "region", ref: "pi-ref://region/grid", hints: { selector: "#orders-grid" } })],
		relSummary: relSummary({ tableCells: 120 }),
	},
	{
		name: "navigation current item",
		entities: [
			entity({ role: "link", ref: "pi-ref://control/current", state: { current: "page" }, relations: [{ type: "currentIn", targetRef: "pi-ref://region/nav", source: "ax", confidence: "high" }] }),
		],
		relSummary: relSummary({ currentIn: 1 }),
	},
	{
		name: "dialog visible",
		entities: [entity({ role: "dialog", kind: "region", ref: "pi-ref://region/dialog", name: "Edit profile" })],
		relSummary: emptyRelations(),
	},
	{
		name: "tabbed interface high",
		entities: [
			entity({ role: "tablist", kind: "region", ref: "pi-ref://region/tablist" }),
			entity({ role: "tab", ref: "pi-ref://control/tab1" }),
			entity({ role: "tab", ref: "pi-ref://control/tab2" }),
		],
		relSummary: emptyRelations(),
	},
	{
		name: "alert region fresh appeared",
		entities: [entity({ role: "alert", kind: "region", ref: "pi-ref://region/alert" })],
		relSummary: emptyRelations(),
		diff: { appeared: ["pi-ref://region/alert"], disappeared: [], changed: [] },
	},
	{
		name: "form dependency focus transition",
		entities: [
			entity({ role: "textbox", ref: "pi-ref://control/email", state: { editable: true, focused: true } }),
			entity({ role: "button", ref: "pi-ref://control/submit" }),
		],
		relSummary: emptyRelations(),
		diff: {
			appeared: [],
			disappeared: [],
			changed: [
				{ ref: "pi-ref://control/submit", kind: "state-changed", before: { disabled: true }, after: { disabled: false } },
				{ ref: "pi-ref://control/email", kind: "state-changed", before: { focused: false }, after: { focused: true } },
			],
		},
	},
	{
		name: "complex co-occurrence",
		entities: [
			entity({ role: "textbox", ref: "pi-ref://control/password", state: { editable: true }, hints: { inputKind: "password", selector: "#password" } }),
			entity({ role: "button", ref: "pi-ref://control/submit", name: "Sign in" }),
			entity({ role: "grid", kind: "region", ref: "pi-ref://region/grid" }),
			entity({ role: "tablist", kind: "region", ref: "pi-ref://region/tablist" }),
			entity({ role: "tab", ref: "pi-ref://control/tab1" }),
			entity({ role: "tab", ref: "pi-ref://control/tab2" }),
			entity({ role: "status", kind: "region", ref: "pi-ref://region/status" }),
			entity({ role: "checkbox", ref: "pi-ref://control/cb1", hints: { containerRole: "group", containerName: "Options" } }),
			entity({ role: "checkbox", ref: "pi-ref://control/cb2", hints: { containerRole: "group", containerName: "Options" } }),
			entity({ role: "checkbox", ref: "pi-ref://control/cb3", hints: { containerRole: "group", containerName: "Options" } }),
		],
		relSummary: relSummary({ currentIn: 1 }),
	},
];

test("buildInferenceSummary feature-view refactor stays output-identical to the pre-pass reference", () => {
	for (const fixture of parityFixtures) {
		assert.deepEqual(
			buildInferenceSummary(fixture.entities, fixture.relSummary, fixture.diff),
			buildInferenceSummaryReference(fixture.entities, fixture.relSummary, fixture.diff),
			fixture.name,
		);
	}
});

test("equal-score login candidates keep first-match stable sort order", () => {
	const fixture: InferenceFixture = {
		name: "equal-score login tie",
		entities: [
			entity({ role: "textbox", ref: "pi-ref://control/password", state: { editable: true }, hints: { inputKind: "password" } }),
			entity({ role: "button", ref: "pi-ref://control/primary", name: "Sign in" }),
			entity({ role: "button", ref: "pi-ref://control/secondary", name: "Sign in" }),
		],
		relSummary: emptyRelations(),
	};
	const reference = buildInferenceSummaryReference(fixture.entities, fixture.relSummary, fixture.diff);
	const perturbed = structuredClone(reference);
	const login = perturbed.intents.find((intent) => intent.intent === "login");
	assert.ok(login?.evidence && typeof login.evidence === "object");
	login!.evidence!.submitRef = "pi-ref://control/secondary";
	assert.notDeepEqual(perturbed, reference);
	assert.deepEqual(buildInferenceSummary(fixture.entities, fixture.relSummary, fixture.diff), reference);
	assert.equal(reference.intents.find((intent) => intent.intent === "login")?.evidence?.submitRef, "pi-ref://control/primary");
});

test("buildInferenceSummary mixed-entity micro-bench stays on the shared helper", () => {
	const fixture = makeMixedInferenceFixture(500);
	const bench = compareMicroBench({
		reference: () => buildInferenceSummaryReference(fixture.entities, fixture.relSummary, fixture.diff),
		candidate: () => buildInferenceSummary(fixture.entities, fixture.relSummary, fixture.diff),
		iterations: 300,
		warmupSamples: 2,
		samples: 7,
	});
	assert.ok(Number.isFinite(bench.speedup));
	assert.ok(Number.isFinite(bench.referenceNsPerOp));
	assert.ok(Number.isFinite(bench.candidateNsPerOp));
	assert.ok(microBenchSink() >= 0);
	console.log(`buildInferenceSummary microbench speedup=${bench.speedup.toFixed(2)}x candidate_ms=${bench.candidateMedianMs.toFixed(3)} reference_ms=${bench.referenceMedianMs.toFixed(3)}`);
});

function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	};
}

function makeMixedInferenceFixture(count: number): InferenceFixture {
	const next = lcg(0x1AB1C0DE);
	const entities: Entity[] = [];
	const relationTypes: RelationType[] = ["expandedTarget", "currentIn", "cellOf"];
	for (let i = 0; i < count; i += 1) {
		const roleIndex = next() % 12;
		const role = ["button", "link", "checkbox", "textbox", "radio", "tab", "gridcell", "status", "dialog", "combobox", "option", "slider"][roleIndex];
		const kind = ["status", "dialog"].includes(role) ? "region" : "control";
		const selector = `#node-${i}`;
		const inputKind = role === "textbox" ? ((next() & 1) === 0 ? "password" : "email") : undefined;
		const containerBucket = i % 6;
		const relations = (i % 9 === 0)
			? [{ type: relationTypes[i % relationTypes.length], targetRef: `pi-ref://region/target-${i}`, source: "dom", confidence: "high" as const }]
			: undefined;
		const structure = role === "status" && i % 20 === 0 ? { landmark: "search" as const } : undefined;
		entities.push(entity({
			ref: `pi-ref://control/mixed-${i}`,
			role,
			kind,
			name: `${role} ${containerBucket} ${i % 5 === 0 ? "Sign in" : i % 7 === 0 ? "Filter by brand" : "Node"}`,
			state: {
				editable: role === "textbox" || role === "combobox",
				disabled: i % 17 === 0,
				inViewport: i % 13 !== 0,
				visible: i % 19 !== 0,
				occluded: i % 23 === 0,
				current: role === "link" && i % 29 === 0 ? "page" : false,
				focused: role === "textbox" && i % 31 === 0,
			},
			structure,
			hints: {
				...(inputKind ? { inputKind } : {}),
				selector,
				...(role === "checkbox" ? { containerRole: "group", containerName: `bucket-${containerBucket}` } : {}),
			},
			relations,
		}));
	}
	entities.unshift(
		entity({ role: "textbox", ref: "pi-ref://control/password-root", state: { editable: true }, hints: { inputKind: "password", selector: "#password-root" } }),
		entity({ role: "button", ref: "pi-ref://control/login-root", name: "Sign in", hints: { selector: "#login-root" } }),
		entity({ role: "tablist", kind: "region", ref: "pi-ref://region/tablist-root" }),
		entity({ role: "tab", ref: "pi-ref://control/tab-root-1" }),
		entity({ role: "tab", ref: "pi-ref://control/tab-root-2" }),
		entity({ role: "grid", kind: "region", ref: "pi-ref://region/grid-root", hints: { selector: "#grid-root" } }),
	);
	return {
		name: `mixed-${count}`,
		entities,
		relSummary: relSummary({ tableCells: 120, currentIn: 3, expandedTarget: 4 }),
		diff: {
			appeared: ["pi-ref://control/mixed-7"],
			disappeared: [],
			changed: [
				{ ref: "pi-ref://control/login-root", kind: "state-changed", before: { disabled: true }, after: { disabled: false } },
				{ ref: "pi-ref://control/password-root", kind: "state-changed", before: { focused: false }, after: { focused: true } },
				{ ref: "pi-ref://control/mixed-7", kind: "name-changed", before: { name: "Old" }, after: { name: "New" } },
			],
			focusedRef: "pi-ref://control/password-root",
		},
	};
}

const MAX_EVIDENCE_REFS = 6;
type ReferenceDetectedIntent = InferenceSummary["intents"][number];

function hasInputKind(entities: Entity[], kind: string): boolean {
	return entities.some((candidate) => typeof candidate.hints?.inputKind === "string" && (candidate.hints.inputKind as string).toLowerCase() === kind);
}

function hasLandmark(entities: Entity[], landmark: string): boolean {
	return entities.some((candidate) => typeof candidate.structure?.landmark === "string" && candidate.structure.landmark === landmark);
}

function countEditable(entities: Entity[]): number {
	return entities.filter((candidate) => candidate.kind === "control" && candidate.state.editable).length;
}

function roleOf(candidate: Entity): string {
	return (candidate.role || "").toLowerCase();
}

function textOf(candidate: Entity): string {
	const selector = typeof candidate.hints?.selector === "string" ? candidate.hints.selector : "";
	return `${candidate.name ?? ""} ${candidate.role ?? ""} ${selector}`.toLowerCase();
}

function isPerceptible(candidate: Entity): boolean {
	return candidate.state.visible === true && candidate.state.occluded !== true;
}

function uniqueRefs(refs: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const ref of refs) {
		if (!ref || seen.has(ref)) continue;
		seen.add(ref);
		out.push(ref);
	}
	return out;
}

function firstEntityByRole(entities: Entity[], ...roles: string[]): Entity | undefined {
	const set = new Set(roles.map((role) => role.toLowerCase()));
	return entities.find((candidate) => candidate.role && set.has(roleOf(candidate)));
}

function firstRefByRole(entities: Entity[], ...roles: string[]): string | undefined {
	return firstEntityByRole(entities, ...roles)?.ref;
}

function allRefsByRole(entities: Entity[], role: string): string[] {
	const lower = role.toLowerCase();
	return uniqueRefs(entities.filter((candidate) => roleOf(candidate) === lower).map((candidate) => candidate.ref));
}

function refsWithRelation(entities: Entity[], type: RelationType, predicate: (candidate: Entity) => boolean = () => true): string[] {
	return uniqueRefs(entities.filter((candidate) => predicate(candidate) && candidate.relations?.some((relation) => relation.type === type)).map((candidate) => candidate.ref));
}

function firstRelationTarget(entities: Entity[], type: RelationType): string | undefined {
	for (const candidate of entities) {
		const relation = candidate.relations?.find((value) => value.type === type);
		if (relation) return relation.targetRef;
	}
	return undefined;
}

function landmarkRef(entities: Entity[], landmark: string): string | undefined {
	return entities.find((candidate) => candidate.structure?.landmark === landmark)?.ref;
}

function capRefs(all: string[], key: string): Record<string, unknown> {
	if (!all.length) return {};
	const unique = uniqueRefs(all);
	const refs = unique.slice(0, MAX_EVIDENCE_REFS);
	const countKey = `${key.replace(/Refs$/, "")}Count`;
	return { [key]: refs, ...(unique.length > refs.length ? { [countKey]: unique.length } : {}) };
}

function mk(intent: ReferenceDetectedIntent["intent"], confidence: ReferenceDetectedIntent["confidence"], reason: string, evidence?: Record<string, unknown>): ReferenceDetectedIntent {
	const hasEvidence = evidence && Object.keys(evidence).length > 0;
	return { intent, confidence, reason, ...(hasEvidence ? { evidence } : {}) };
}

const LOGIN_POSITIVE_RE = /\b(sign[-\s]*in|log[-\s]*in|login|submit|continue|next)\b|登入|登录|登陆|提交|继续|下一步/i;
const LOGIN_NEGATIVE_RE = /passkey|oauth|omniauth|saml|sso|forgot|register|sign\s*up|show\s*password|cookie|privacy|help|explore|万能钥匙|忘记|注册/i;
const LOGIN_THIRD_PARTY_RE = /\b(?:sign[-\s]*in|log[-\s]*in|signin|login|continue|connect)\s+with\b/i;
const FILTER_TEXT_RE = /\b(filter|facet|refine|narrow|brand|price|rating|stars|department|category|condition|delivery|seller|sort)\b|筛选|缩小|品牌|价格|评分|类别|部门|配送|卖家/i;
const EXPANDABLE_THRESHOLD = 2;
const DATA_GRID_CELL_THRESHOLD = 50;

function loginCandidateScore(entity: Entity): number {
	if (entity.kind !== "control" || !["button", "link"].includes(roleOf(entity)) || entity.state.disabled) return Number.NEGATIVE_INFINITY;
	let score = 0;
	if (isPerceptible(entity)) score += 10;
	if (entity.state.inViewport) score += 2;
	const text = textOf(entity);
	const name = (entity.name ?? "").toLowerCase();
	if (roleOf(entity) === "button") score += 4;
	if (LOGIN_POSITIVE_RE.test(name)) score += 14;
	else if (LOGIN_POSITIVE_RE.test(text)) score += 8;
	if (/type=['"]?submit|sign-?in|login|submit/.test(text)) score += 6;
	if (/\bbtn\b/.test(name)) score -= 8;
	if (LOGIN_NEGATIVE_RE.test(text) || LOGIN_THIRD_PARTY_RE.test(text)) score -= 20;
	if (!entity.state.inViewport) score -= 8;
	return score;
}

function detectLogin(entities: Entity[]): ReferenceDetectedIntent | undefined {
	if (!hasInputKind(entities, "password")) return undefined;
	const submitButton = entities.filter((candidate) => loginCandidateScore(candidate) > 0).sort((a, b) => loginCandidateScore(b) - loginCandidateScore(a))[0];
	if (!submitButton) return mk("login", "medium", "password field, no strong submit");
	return mk("login", "high", "password field + strong submit", { submitRef: submitButton.ref });
}

function detectSearch(entities: Entity[]): ReferenceDetectedIntent | undefined {
	const searchRef = firstRefByRole(entities, "searchbox");
	if (searchRef) return mk("search", "high", "searchbox role", { searchRef });
	if (hasLandmark(entities, "search") && countEditable(entities) >= 1) {
		const regionRef = landmarkRef(entities, "search");
		return mk("search", "medium", "search landmark with input", regionRef ? { regionRef } : undefined);
	}
	return undefined;
}

function filterControls(entities: Entity[]): Entity[] {
	return entities.filter((candidate) => {
		if (candidate.kind !== "control" || candidate.state.disabled || !isPerceptible(candidate)) return false;
		const role = roleOf(candidate);
		return ["button", "link", "combobox", "option", "checkbox", "radio", "slider", "spinbutton"].includes(role) && FILTER_TEXT_RE.test(textOf(candidate));
	});
}

function detectFilterPanel(entities: Entity[]): ReferenceDetectedIntent | undefined {
	const controls = filterControls(entities);
	if (controls.length >= 3) {
		return mk("filter-panel", "high", `${controls.length} filter controls`, { ...capRefs(controls.map((candidate) => candidate.ref), "controlRefs"), inputCount: controls.length });
	}
	if (!hasLandmark(entities, "search")) return undefined;
	const editableInputs = entities.filter((candidate) => candidate.kind === "control" && candidate.state.editable && isPerceptible(candidate));
	const region = entities.find((candidate) => candidate.structure?.landmark === "search" && FILTER_TEXT_RE.test(textOf(candidate)));
	if (editableInputs.length < 2 || !region) return undefined;
	return mk("filter-panel", "medium", `search filter landmark, ${editableInputs.length} inputs`, { regionRef: region.ref, inputCount: editableInputs.length });
}

function detectSingleChoice(entities: Entity[]): ReferenceDetectedIntent | undefined {
	const groupRef = firstRefByRole(entities, "radiogroup");
	if (groupRef) return mk("single-choice", "high", "radiogroup role", { groupRef });
	const radios = allRefsByRole(entities, "radio");
	if (radios.length >= 2) return mk("single-choice", "medium", `${radios.length} ungrouped radios`, capRefs(radios, "optionRefs"));
	return undefined;
}

function detectMultiChoice(entities: Entity[]): ReferenceDetectedIntent | undefined {
	const checkboxes = entities.filter((candidate) => candidate.role?.toLowerCase() === "checkbox");
	if (checkboxes.length < 3) return undefined;
	const groups = new Map<string, { name: string; refs: string[] }>();
	for (const candidate of checkboxes) {
		const role = typeof candidate.hints?.containerRole === "string" ? candidate.hints.containerRole : null;
		if (!role) continue;
		const name = typeof candidate.hints?.containerName === "string" ? candidate.hints.containerName : "";
		const key = `${role}|${name}`;
		const group = groups.get(key) ?? { name, refs: [] };
		group.refs.push(candidate.ref);
		groups.set(key, group);
	}
	const dominant = Array.from(groups.values()).filter((group) => group.refs.length >= 3).sort((a, b) => b.refs.length - a.refs.length)[0];
	if (dominant) {
		return mk("multi-choice", "high", `${dominant.refs.length} grouped checkboxes`, { ...capRefs(dominant.refs, "optionRefs"), ...(dominant.name ? { groupName: dominant.name } : {}) });
	}
	return mk("multi-choice", "medium", `${checkboxes.length} scattered checkboxes`, capRefs(checkboxes.map((candidate) => candidate.ref), "optionRefs"));
}

function detectExpandable(entities: Entity[], relationSummary: RelationSummary): ReferenceDetectedIntent | undefined {
	const triggerRefs = refsWithRelation(entities, "expandedTarget", (candidate) => isPerceptible(candidate) || candidate.state.expanded !== undefined);
	const count = Math.max(triggerRefs.length, relationSummary.summary.expandedTarget ?? 0);
	if (triggerRefs.length < EXPANDABLE_THRESHOLD) return undefined;
	return mk("expandable", "high", `${count} expand triggers`, capRefs(triggerRefs, "triggerRefs"));
}

function detectDataGrid(entities: Entity[], relationSummary: RelationSummary): ReferenceDetectedIntent | undefined {
	const grid = entities.find((candidate) => ["grid", "treegrid"].includes(roleOf(candidate)) && isPerceptible(candidate) && !/autocomplete|suggest/i.test(textOf(candidate)));
	if (grid) return mk("data-grid", "high", "visible grid role", { gridRef: grid.ref });
	const cellCount = relationSummary.summary.tableCells ?? 0;
	if (cellCount >= DATA_GRID_CELL_THRESHOLD) {
		const tableRef = firstRelationTarget(entities, "cellOf");
		return mk("data-grid", "high", `table with ${cellCount} cells`, { ...(tableRef ? { tableRef } : {}), cellCount });
	}
	return undefined;
}

function detectNavigation(entities: Entity[], relationSummary: RelationSummary): ReferenceDetectedIntent | undefined {
	if ((relationSummary.summary.currentIn ?? 0) <= 0) return undefined;
	const currentEntity = entities.find((candidate) => candidate.state.current !== undefined && candidate.state.current !== false);
	const navRef = currentEntity?.relations?.find((relation) => relation.type === "currentIn")?.targetRef;
	return mk("navigation", "high", "aria-current item in nav", { ...(currentEntity ? { currentRef: currentEntity.ref } : {}), ...(navRef ? { navRef } : {}) });
}

function detectDialog(entities: Entity[]): ReferenceDetectedIntent | undefined {
	const dialog = entities.find((candidate) => (roleOf(candidate) === "dialog" || roleOf(candidate) === "alertdialog") && isPerceptible(candidate));
	if (!dialog) return undefined;
	return mk("dialog", "high", `visible ${dialog.role} role`, { dialogRef: dialog.ref });
}

function detectTabbedInterface(entities: Entity[]): ReferenceDetectedIntent | undefined {
	const tablist = entities.find((candidate) => roleOf(candidate) === "tablist" && isPerceptible(candidate));
	const tabRefs = uniqueRefs(entities.filter((candidate) => roleOf(candidate) === "tab" && isPerceptible(candidate)).map((candidate) => candidate.ref));
	if (tablist) return mk("tabbed-interface", "high", `visible tablist with ${tabRefs.length} tabs`, { tablistRef: tablist.ref, ...capRefs(tabRefs, "tabRefs") });
	if (tabRefs.length >= 2) return mk("tabbed-interface", "medium", `${tabRefs.length} visible ungrouped tabs`, capRefs(tabRefs, "tabRefs"));
	return undefined;
}

function detectAlertRegion(entities: Entity[], diff?: EntityDiff): ReferenceDetectedIntent | undefined {
	const regions = entities.filter((candidate) => (roleOf(candidate) === "alert" || roleOf(candidate) === "status") && isPerceptible(candidate));
	if (!regions.length) return undefined;
	const nameChanged = (ref: string): boolean => !!diff && diff.changed.some((candidate) => candidate.kind === "name-changed" && candidate.ref === ref);
	const isFresh = (ref: string): boolean => !!diff && (diff.appeared.includes(ref) || nameChanged(ref));
	const region = (diff ? regions.find((candidate) => isFresh(candidate.ref)) : undefined) ?? regions[0];
	const live = roleOf(region) === "alert" ? "assertive" : "polite";
	const fresh = !diff ? undefined : diff.appeared.includes(region.ref) ? "appeared" : nameChanged(region.ref) ? "updated" : undefined;
	const reason = fresh === "appeared"
		? `${region.role} live region appeared after action`
		: fresh === "updated"
			? `${region.role} live region updated after action`
			: `visible ${region.role} live region`;
	return mk("alert-region", "high", reason, { regionRef: region.ref, live, ...(fresh ? { fresh } : {}) });
}

function changedField(change: EntityDiff["changed"][number], side: "before" | "after", field: string): unknown {
	const value = change[side];
	return value && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}

function editableControlByRef(entities: Entity[], ref: string | undefined, enabledRef: string): Entity | undefined {
	if (!ref || ref === enabledRef) return undefined;
	return entities.find((candidate) => candidate.ref === ref && candidate.kind === "control" && candidate.state.editable === true);
}

function editableFocusTransition(entities: Entity[], diff: EntityDiff, enabledRef: string): { ref: string; confidence: ReferenceDetectedIntent["confidence"]; reason: string; signal: string } | undefined {
	const candidates = diff.changed
		.filter((change) => change.kind === "state-changed" && changedField(change, "before", "focused") !== changedField(change, "after", "focused"))
		.map((change) => ({ change, entity: editableControlByRef(entities, change.ref, enabledRef) }))
		.filter((item): item is { change: EntityDiff["changed"][number]; entity: Entity } => !!item.entity);
	const gained = candidates.filter((item) => changedField(item.change, "after", "focused") === true);
	if (gained.length === 1) return { ref: gained[0].entity.ref, confidence: "high", reason: "a field gained focus while enabling a disabled control", signal: "focus-gained" };
	if (gained.length > 1 || candidates.length !== 1) return undefined;
	const candidate = candidates[0];
	if (changedField(candidate.change, "before", "focused") === true && changedField(candidate.change, "after", "focused") === false) {
		return { ref: candidate.entity.ref, confidence: "medium", reason: "an editable field lost focus while a disabled control became enabled", signal: "focus-lost" };
	}
	return undefined;
}

function detectFormDependency(entities: Entity[], diff?: EntityDiff): ReferenceDetectedIntent | undefined {
	if (!diff) return undefined;
	const enabled = diff.changed.find((change) => change.kind === "state-changed" && changedField(change, "before", "disabled") === true && changedField(change, "after", "disabled") === false);
	if (!enabled) return undefined;
	const focused = editableControlByRef(entities, diff.focusedRef, enabled.ref);
	if (focused) return mk("form-dependency", "high", "a focused editable field enabled a disabled control", { enabledRef: enabled.ref, requiredRef: focused.ref, focusSignal: "focusedRef" });
	const transition = editableFocusTransition(entities, diff, enabled.ref);
	if (!transition) return undefined;
	return mk("form-dependency", transition.confidence, transition.reason, { enabledRef: enabled.ref, requiredRef: transition.ref, focusSignal: transition.signal });
}

function buildInferenceSummaryReference(entities: Entity[], relationSummary: RelationSummary, diff?: EntityDiff): InferenceSummary {
	const intents: InferenceSummary["intents"] = [];
	const add = (intent: ReferenceDetectedIntent | undefined): void => {
		if (intent) intents.push(intent);
	};
	add(detectLogin(entities));
	const filterPanel = detectFilterPanel(entities);
	if (filterPanel) add(filterPanel);
	else add(detectSearch(entities));
	add(detectSingleChoice(entities));
	add(detectMultiChoice(entities));
	add(detectExpandable(entities, relationSummary));
	add(detectDataGrid(entities, relationSummary));
	add(detectNavigation(entities, relationSummary));
	add(detectDialog(entities));
	add(detectTabbedInterface(entities));
	add(detectAlertRegion(entities, diff));
	add(detectFormDependency(entities, diff));
	return { intents };
}
