// ABML R2 — inference layer (pure core). Detects generic ARIA semantic patterns from the
// merged entity list + R1 relation summary (+ optional R3 temporal diff). No per-site or
// per-type branches — every detector matches against the universal ARIA structure (roles,
// landmarks, relation counts). The result rides the envelope top-level alongside
// gist/outline/relations, budget-immune.
//
// Each intent is ANCHORED: beyond the bare label it carries `evidence` refs (the entity the
// agent should act on — submitRef/gridRef/dialogRef/…) and a short `reason` (the signal +
// confidence rationale). Detection logic is frozen; evidence/reason are best-effort additive
// (omitted when no ref resolves), so the anchoring change is zero-regression.
//
// Patterns detected:
//   login            — password-type input + submit control; evidence.submitRef
//   search           — searchbox role or search landmark with editable inputs
//   filter-panel     — search landmark + 2+ editable inputs (structured filter UI)
//   single-choice    — radiogroup container or 2+ radio entities
//   multi-choice     — 3+ checkbox entities; high when grouped in a container
//   expandable       — expandedTarget >= 2 (accordion/combobox/disclosure)
//   data-grid        — grid/treegrid role entity, or tableCells >= 50
//   navigation       — nav with aria-current item (currentIn relation)
//   dialog           — dialog or alertdialog entity
//   tabbed-interface — tablist role or 2+ tab entities
//   alert-region     — alert or status role (live feedback area after actions)
//   form-dependency  — R3 diff: editable/focused field enabled a previously disabled control
import type { Entity, RelationType } from "./entity.js";
import type { EntityDiff } from "./diff.js";
import type { RelationSummary } from "./relations.js";

export type PageIntent =
	| "login"            // password-type input + submit button
	| "search"           // searchbox role or search landmark
	| "filter-panel"     // search landmark + 2+ editable inputs
	| "single-choice"    // radiogroup or 2+ radio entities
	| "multi-choice"     // 3+ checkbox entities
	| "expandable"       // expandedTarget >= 2 relations
	| "data-grid"        // table/grid with cell relations
	| "navigation"       // nav with aria-current (currentIn) relation
	| "dialog"           // modal dialog or alertdialog
	| "tabbed-interface" // tablist or 2+ tab entities
	| "alert-region"     // alert or status live region
	| "form-dependency"; // disabled control enabled by an editable/focused field transition

export type DetectedIntent = {
	intent: PageIntent;
	confidence: "high" | "medium" | "low";
	// Short, agent-readable basis for the judgement (signal + confidence rationale), e.g.
	// "radiogroup role", "3 grouped checkboxes", "table with 162 cells". Role/landmark/count
	// only — never embeds user-entered text.
	reason?: string;
	// Actionable anchors for the pattern — the ref(s) the agent should act on, so it doesn't
	// re-scan entities to locate the target. Ref arrays are capped (MAX_EVIDENCE_REFS) with a
	// sibling count. Omitted entirely when no ref resolves (best-effort; never blocks detection).
	evidence?: Record<string, unknown>;
};

export type InferenceSummary = {
	// Detected page-level semantic patterns. Empty array when nothing is detected.
	// Always present when abmlIntegrated; lifted to envelope top-level.
	intents: DetectedIntent[];
};

// Per-array evidence ref cap — keeps the envelope compact + deterministic (like relations.highlights).
const MAX_EVIDENCE_REFS = 6;

// ── Detection helpers ─────────────────────────────────────────────────────────

function hasInputKind(entities: Entity[], kind: string): boolean {
	return entities.some((e) => typeof e.hints?.inputKind === "string" && (e.hints.inputKind as string).toLowerCase() === kind);
}

function hasLandmark(entities: Entity[], landmark: string): boolean {
	return entities.some((e) => typeof e.structure?.landmark === "string" && e.structure.landmark === landmark);
}

function countEditable(entities: Entity[]): number {
	return entities.filter((e) => e.kind === "control" && e.state.editable).length;
}

// ── Evidence resolution helpers (best-effort ref lookup over the merged entity list) ──────

function firstRefByRole(entities: Entity[], ...roles: string[]): string | undefined {
	const set = new Set(roles.map((r) => r.toLowerCase()));
	return entities.find((e) => e.role && set.has(e.role.toLowerCase()))?.ref;
}

function allRefsByRole(entities: Entity[], role: string): string[] {
	const lower = role.toLowerCase();
	return entities.filter((e) => e.role?.toLowerCase() === lower).map((e) => e.ref);
}

function refsWithRelation(entities: Entity[], type: RelationType): string[] {
	return entities.filter((e) => e.relations?.some((r) => r.type === type)).map((e) => e.ref);
}

function firstRelationTarget(entities: Entity[], type: RelationType): string | undefined {
	for (const e of entities) {
		const rel = e.relations?.find((r) => r.type === type);
		if (rel) return rel.targetRef;
	}
	return undefined;
}

function landmarkRef(entities: Entity[], landmark: string): string | undefined {
	return entities.find((e) => e.structure?.landmark === landmark)?.ref;
}

// Cap a ref list to MAX_EVIDENCE_REFS and emit it under `key`, with a sibling `<base>Count`
// when truncated (key "tabRefs" → count "tabCount"). Returns {} when the list is empty so
// the caller can spread it into evidence and naturally omit absent anchors.
function capRefs(all: string[], key: string): Record<string, unknown> {
	if (!all.length) return {};
	const refs = all.slice(0, MAX_EVIDENCE_REFS);
	const countKey = `${key.replace(/Refs$/, "")}Count`;
	return { [key]: refs, ...(all.length > refs.length ? { [countKey]: all.length } : {}) };
}

// Construct a DetectedIntent, dropping an empty evidence object so absent anchors don't
// surface as `evidence: {}`.
function mk(intent: PageIntent, confidence: DetectedIntent["confidence"], reason: string, evidence?: Record<string, unknown>): DetectedIntent {
	const hasEvidence = evidence && Object.keys(evidence).length > 0;
	return { intent, confidence, reason, ...(hasEvidence ? { evidence } : {}) };
}

// ── Detectors (detection logic frozen; evidence/reason additive) ────────────────

// login: password-type input (DOM-sourced inputKind) + at least one non-disabled button.
// evidence.submitRef points to the first actionable button so the agent can click without rescan.
function detectLogin(entities: Entity[]): DetectedIntent | undefined {
	if (!hasInputKind(entities, "password")) return undefined;
	const submitButton = entities.find((e) => e.kind === "control" && (e.role === "button" || e.role === "link") && !e.state.disabled);
	if (!submitButton) return mk("login", "medium", "password field, no actionable submit");
	return mk("login", "high", "password field + actionable submit", { submitRef: submitButton.ref });
}

// search: searchbox role (from <input type=search> via DOM roleOf) is a strong signal.
// search landmark alone (ARIA search role applied to a region) is medium.
function detectSearch(entities: Entity[]): DetectedIntent | undefined {
	const searchRef = firstRefByRole(entities, "searchbox");
	if (searchRef) return mk("search", "high", "searchbox role", { searchRef });
	if (hasLandmark(entities, "search") && countEditable(entities) >= 1) {
		const regionRef = landmarkRef(entities, "search");
		return mk("search", "medium", "search landmark with input", regionRef ? { regionRef } : undefined);
	}
	return undefined;
}

// filter-panel: a search-landmark region containing 2+ editable inputs signals a structured
// filter UI (date range, facets, dropdown filters) as opposed to a single search box.
function detectFilterPanel(entities: Entity[]): DetectedIntent | undefined {
	if (!hasLandmark(entities, "search")) return undefined;
	const inputCount = countEditable(entities);
	if (inputCount < 2) return undefined;
	const regionRef = landmarkRef(entities, "search");
	return mk("filter-panel", "high", `search landmark, ${inputCount} inputs`, { ...(regionRef ? { regionRef } : {}), inputCount });
}

// single-choice: radiogroup container in the AX tree is the clean signal (high confidence).
// 2+ radio entities without an explicit radiogroup is medium.
function detectSingleChoice(entities: Entity[]): DetectedIntent | undefined {
	const groupRef = firstRefByRole(entities, "radiogroup");
	if (groupRef) return mk("single-choice", "high", "radiogroup role", { groupRef });
	const radios = allRefsByRole(entities, "radio");
	if (radios.length >= 2) return mk("single-choice", "medium", `${radios.length} ungrouped radios`, capRefs(radios, "optionRefs"));
	return undefined;
}

// multi-choice: 3+ checkboxes suggests a multi-select list (options, features, tags).
// High confidence when 3+ share the same ARIA group container (intentional grouping by author).
// Medium for scattered checkboxes — could be unrelated form controls (terms + newsletter).
function detectMultiChoice(entities: Entity[]): DetectedIntent | undefined {
	const checkboxes = entities.filter((e) => e.role?.toLowerCase() === "checkbox");
	if (checkboxes.length < 3) return undefined;
	// Group checkboxes by their ARIA container. A group with 3+ = intentional multi-choice.
	const groups = new Map<string, { name: string; refs: string[] }>();
	for (const e of checkboxes) {
		const role = typeof e.hints?.containerRole === "string" ? e.hints.containerRole : null;
		if (!role) continue;
		const name = typeof e.hints?.containerName === "string" ? e.hints.containerName : "";
		const key = `${role}|${name}`;
		const group = groups.get(key) ?? { name, refs: [] };
		group.refs.push(e.ref);
		groups.set(key, group);
	}
	const dominant = Array.from(groups.values()).filter((g) => g.refs.length >= 3).sort((a, b) => b.refs.length - a.refs.length)[0];
	if (dominant) {
		return mk("multi-choice", "high", `${dominant.refs.length} grouped checkboxes`, { ...capRefs(dominant.refs, "optionRefs"), ...(dominant.name ? { groupName: dominant.name } : {}) });
	}
	return mk("multi-choice", "medium", `${checkboxes.length} scattered checkboxes`, capRefs(checkboxes.map((e) => e.ref), "optionRefs"));
}

// expandable: expandedTarget >= 2 filters the single-nav-toggle case found in live validation
// (Bing/GitLab each had expandedTarget=1 from a single hamburger/dropdown menu but aren't
// really "expandable" pages). Two or more expand relations suggest the pattern is structural.
// Detection stays on the relSummary count; evidence resolves trigger refs in a parallel walk.
const EXPANDABLE_THRESHOLD = 2;
function detectExpandable(entities: Entity[], relSummary: RelationSummary): DetectedIntent | undefined {
	const count = relSummary.summary.expandedTarget ?? 0;
	if (count < EXPANDABLE_THRESHOLD) return undefined;
	return mk("expandable", "high", `${count} expand triggers`, capRefs(refsWithRelation(entities, "expandedTarget"), "triggerRefs"));
}

// data-grid: grid/treegrid role (ARIA interactive grid) or tableCells >= 50 (large table).
// Threshold of 50 filters documentation/attribute tables on reference pages (W3C APG, MDN
// have 12–42-cell attribute tables on almost every page — live validation confirmed this).
const DATA_GRID_CELL_THRESHOLD = 50;
function detectDataGrid(entities: Entity[], relSummary: RelationSummary): DetectedIntent | undefined {
	const gridRef = firstRefByRole(entities, "grid", "treegrid");
	if (gridRef) return mk("data-grid", "high", "grid role", { gridRef });
	const cellCount = relSummary.summary.tableCells ?? 0;
	if (cellCount >= DATA_GRID_CELL_THRESHOLD) {
		const tableRef = firstRelationTarget(entities, "cellOf");
		return mk("data-grid", "high", `table with ${cellCount} cells`, { ...(tableRef ? { tableRef } : {}), cellCount });
	}
	return undefined;
}

// navigation: currentIn fires when an aria-current entity has a resolved nav/list container.
// Detection stays on the relSummary count; evidence resolves the current item + nav container.
function detectNavigation(entities: Entity[], relSummary: RelationSummary): DetectedIntent | undefined {
	if ((relSummary.summary.currentIn ?? 0) <= 0) return undefined;
	const currentEntity = entities.find((e) => e.state.current !== undefined && e.state.current !== false);
	const navRef = currentEntity?.relations?.find((r) => r.type === "currentIn")?.targetRef;
	return mk("navigation", "high", "aria-current item in nav", { ...(currentEntity ? { currentRef: currentEntity.ref } : {}), ...(navRef ? { navRef } : {}) });
}

// dialog: a dialog or alertdialog entity present in the merged entity list.
function detectDialog(entities: Entity[]): DetectedIntent | undefined {
	const dialog = entities.find((e) => e.role === "dialog" || e.role === "alertdialog");
	if (!dialog) return undefined;
	return mk("dialog", "high", `${dialog.role} role`, { dialogRef: dialog.ref });
}

// tabbed-interface: tablist role is the authoritative ARIA container for a tab panel set.
// 2+ tab entities without an explicit tablist is medium — ungrouped tabs exist in the wild.
// Tells the agent: switch tabs to access content not visible in the current panel.
function detectTabbedInterface(entities: Entity[]): DetectedIntent | undefined {
	const tablistRef = firstRefByRole(entities, "tablist");
	const tabRefs = allRefsByRole(entities, "tab");
	if (tablistRef) return mk("tabbed-interface", "high", `tablist with ${tabRefs.length} tabs`, { tablistRef, ...capRefs(tabRefs, "tabRefs") });
	if (tabRefs.length >= 2) return mk("tabbed-interface", "medium", `${tabRefs.length} ungrouped tabs`, capRefs(tabRefs, "tabRefs"));
	return undefined;
}

// alert-region: role="alert" (assertive live region, e.g. validation errors) or role="status"
// (polite live region, e.g. save confirmations). Tells the agent where to look for feedback
// after an action — essential for form validation and async operation results.
function detectAlertRegion(entities: Entity[]): DetectedIntent | undefined {
	const region = entities.find((e) => e.role === "alert" || e.role === "status");
	if (!region) return undefined;
	const live = region.role === "alert" ? "assertive" : "polite";
	return mk("alert-region", "high", `${region.role} live region`, { regionRef: region.ref, live });
}

function changedField(change: EntityDiff["changed"][number], side: "before" | "after", field: string): unknown {
	const value = change[side];
	return value && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}

// form-dependency: R3 temporal fact. A control that was disabled became enabled, while the
// after snapshot has focus on an editable control. Because editable values are intentionally
// redacted/suppressed, focused editable field is the privacy-safe proxy for "the field just filled".
function detectFormDependency(entities: Entity[], diff?: EntityDiff): DetectedIntent | undefined {
	if (!diff) return undefined;
	const enabled = diff.changed.find((change) => change.kind === "state-changed" && changedField(change, "before", "disabled") === true && changedField(change, "after", "disabled") === false);
	if (!enabled) return undefined;
	const focused = diff.focusedRef ? entities.find((entity) => entity.ref === diff.focusedRef && entity.kind === "control" && entity.state.editable === true) : undefined;
	const requiredRef = focused && focused.ref !== enabled.ref ? focused.ref : undefined;
	if (!requiredRef) return undefined;
	return mk("form-dependency", "high", "a field enabled a disabled control", { enabledRef: enabled.ref, requiredRef });
}

// ── Public builder ─────────────────────────────────────────────────────────────

// Detect generic ARIA semantic patterns over the merged entity list + R1 relation summary
// (+ optional R3 diff). Every detector is independent, generic (no per-site/per-type branches),
// returns at most one DetectedIntent, and anchors it to evidence refs + a reason. Dedup rules:
//   - "filter-panel" supersedes "search" (the former implies the latter).
// Order is deterministic (definition order below).
export function buildInferenceSummary(entities: Entity[], relSummary: RelationSummary, diff?: EntityDiff): InferenceSummary {
	const intents: DetectedIntent[] = [];
	const add = (d: DetectedIntent | undefined): void => { if (d) intents.push(d); };
	add(detectLogin(entities));
	// filter-panel implies search; skip "search" if filter-panel fires to avoid redundancy.
	const filterPanel = detectFilterPanel(entities);
	if (filterPanel) add(filterPanel);
	else add(detectSearch(entities));
	add(detectSingleChoice(entities));
	add(detectMultiChoice(entities));
	add(detectExpandable(entities, relSummary));
	add(detectDataGrid(entities, relSummary));
	add(detectNavigation(entities, relSummary));
	add(detectDialog(entities));
	add(detectTabbedInterface(entities));
	add(detectAlertRegion(entities));
	add(detectFormDependency(entities, diff));
	return { intents };
}
