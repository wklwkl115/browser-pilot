// ABML R2 — inference layer (pure core). Detects generic ARIA semantic patterns from the
// merged entity list + R1 relation summary. No per-site or per-type branches — every detector
// matches against the universal ARIA structure (roles, landmarks, relation counts). The result
// rides the envelope top-level alongside gist/outline/relations, budget-immune.
//
// Patterns detected:
//   login         — password-type input + at least one submit control
//   search        — searchbox role or search landmark with editable inputs
//   filter-panel  — search landmark + 2+ editable inputs (structured filter UI)
//   single-choice — radiogroup container or 2+ radio entities
//   multi-choice  — 3+ checkbox entities
//   expandable    — expandedTarget relations present (accordion/combobox/disclosure)
//   data-grid     — table/grid cells (tableCells in relation summary > 0)
//   navigation    — nav with aria-current item (currentIn relation)
//   dialog        — dialog or alertdialog entity
import type { Entity } from "./entity.js";
import type { RelationSummary } from "./relations.js";

export type PageIntent =
	| "login"         // password-type input + submit button
	| "search"        // searchbox role or search landmark
	| "filter-panel"  // search landmark + 2+ editable inputs
	| "single-choice" // radiogroup or 2+ radio entities
	| "multi-choice"  // 3+ checkbox entities
	| "expandable"    // expandedTarget relations present
	| "data-grid"     // table/grid with cell relations
	| "navigation"    // nav with aria-current (currentIn) relation
	| "dialog";       // modal dialog or alertdialog

export type DetectedIntent = {
	intent: PageIntent;
	confidence: "high" | "medium" | "low";
};

export type InferenceSummary = {
	// Detected page-level semantic patterns. Empty array when nothing is detected.
	// Always present when abmlIntegrated; lifted to envelope top-level.
	intents: DetectedIntent[];
};

// ── Detection helpers ─────────────────────────────────────────────────────────

function hasRole(entities: Entity[], role: string): boolean {
	const lower = role.toLowerCase();
	return entities.some((e) => e.role?.toLowerCase() === lower);
}

function hasInputKind(entities: Entity[], kind: string): boolean {
	return entities.some((e) => typeof e.hints?.inputKind === "string" && (e.hints.inputKind as string).toLowerCase() === kind);
}

function hasLandmark(entities: Entity[], landmark: string): boolean {
	return entities.some((e) => typeof e.structure?.landmark === "string" && e.structure.landmark === landmark);
}

function countRole(entities: Entity[], role: string): number {
	const lower = role.toLowerCase();
	return entities.filter((e) => e.role?.toLowerCase() === lower).length;
}

function countEditable(entities: Entity[]): number {
	return entities.filter((e) => e.kind === "control" && e.state.editable).length;
}

// login: password-type input exists (DOM-sourced inputKind from the scan) + at least one
// non-disabled button/submit. The form landmark need not be present — a passwordless login
// or a single-field API-key form still counts when those two signals co-occur.
function detectLogin(entities: Entity[]): DetectedIntent | undefined {
	if (!hasInputKind(entities, "password")) return undefined;
	const hasButton = entities.some((e) => e.kind === "control" && (e.role === "button" || e.role === "link") && !e.state.disabled);
	return { intent: "login", confidence: hasButton ? "high" : "medium" };
}

// search: searchbox role (from <input type=search> via DOM roleOf) is a strong signal.
// search landmark alone (ARIA search role applied to a region) is medium — it could be a
// search results page with no input box, or a sidebar filter.
function detectSearch(entities: Entity[]): DetectedIntent | undefined {
	if (hasRole(entities, "searchbox")) return { intent: "search", confidence: "high" };
	if (hasLandmark(entities, "search") && countEditable(entities) >= 1) return { intent: "search", confidence: "medium" };
	return undefined;
}

// filter-panel: a search-landmark region containing 2+ editable inputs signals a structured
// filter UI (date range, facets, dropdown filters) as opposed to a single search box.
// Requires both signals: the ARIA landmark (intentional by the author) AND multiple inputs.
function detectFilterPanel(entities: Entity[]): DetectedIntent | undefined {
	if (!hasLandmark(entities, "search")) return undefined;
	if (countEditable(entities) < 2) return undefined;
	return { intent: "filter-panel", confidence: "high" };
}

// single-choice: radiogroup container in the AX tree is the clean signal (high confidence).
// 2+ radio entities without an explicit radiogroup is medium — they may be ungrouped radios
// still representing a single-choice set (common in legacy HTML).
function detectSingleChoice(entities: Entity[]): DetectedIntent | undefined {
	if (hasRole(entities, "radiogroup")) return { intent: "single-choice", confidence: "high" };
	if (countRole(entities, "radio") >= 2) return { intent: "single-choice", confidence: "medium" };
	return undefined;
}

// multi-choice: 3+ checkboxes suggests a multi-select list (options, features, tags).
// Threshold at 3 rather than 2 because form-footer clusters (terms + newsletter) are common
// and don't represent a semantic multi-choice group.
function detectMultiChoice(entities: Entity[]): DetectedIntent | undefined {
	if (countRole(entities, "checkbox") >= 3) return { intent: "multi-choice", confidence: "medium" };
	return undefined;
}

// expandable: expandedTarget is the narrowest, highest-signal relation — it fires only when
// aria-expanded + aria-controls co-occur (accordion panels, combobox listboxes, disclosure
// widgets). controls alone is broader (any aria-controls reference) so we don't use it here.
function detectExpandable(relSummary: RelationSummary): DetectedIntent | undefined {
	if ((relSummary.summary.expandedTarget ?? 0) > 0) return { intent: "expandable", confidence: "high" };
	return undefined;
}

// data-grid: two signals, priority-ordered:
//   1. grid/treegrid role entity present — ARIA interactive grid (sortable/selectable rows),
//      high confidence regardless of cell count.
//   2. tableCells >= 50 — large static table likely representing structured data content.
//      Threshold filters documentation/attribute tables that appear on almost every reference
//      page (W3C APG, MDN) and would otherwise flood any agent reading the page with
//      false data-grid signals. tableCells > 0 was too broad in live validation (APG pages
//      all have 12–42-cell attribute tables; only the actual data page had 162+ cells).
const DATA_GRID_CELL_THRESHOLD = 50;
function detectDataGrid(entities: Entity[], relSummary: RelationSummary): DetectedIntent | undefined {
	if (hasRole(entities, "grid") || hasRole(entities, "treegrid")) return { intent: "data-grid", confidence: "high" };
	if ((relSummary.summary.tableCells ?? 0) >= DATA_GRID_CELL_THRESHOLD) return { intent: "data-grid", confidence: "high" };
	return undefined;
}

// navigation: currentIn fires when an aria-current entity has a resolved nav/list container
// — the page has an active navigation state (breadcrumb page, selected tab, current menu item).
function detectNavigation(relSummary: RelationSummary): DetectedIntent | undefined {
	if ((relSummary.summary.currentIn ?? 0) > 0) return { intent: "navigation", confidence: "high" };
	return undefined;
}

// dialog: a dialog or alertdialog entity present in the merged entity list.
function detectDialog(entities: Entity[]): DetectedIntent | undefined {
	if (entities.some((e) => e.role === "dialog" || e.role === "alertdialog")) {
		return { intent: "dialog", confidence: "high" };
	}
	return undefined;
}

// ── Public builder ─────────────────────────────────────────────────────────────

// Detect generic ARIA semantic patterns over the merged entity list + R1 relation summary.
// Every detector is independent, generic (no per-site/per-type branches), and returns at
// most one DetectedIntent. Dedup rule: "filter-panel" supersedes "search" (the former
// implies the latter). Order is deterministic (definition order).
export function buildInferenceSummary(entities: Entity[], relSummary: RelationSummary): InferenceSummary {
	const intents: DetectedIntent[] = [];
	const add = (d: DetectedIntent | undefined): void => { if (d) intents.push(d); };
	add(detectLogin(entities));
	// filter-panel implies search; skip "search" if filter-panel fires to avoid redundancy.
	const filterPanel = detectFilterPanel(entities);
	if (filterPanel) add(filterPanel);
	else add(detectSearch(entities));
	add(detectSingleChoice(entities));
	add(detectMultiChoice(entities));
	add(detectExpandable(relSummary));
	add(detectDataGrid(entities, relSummary));
	add(detectNavigation(relSummary));
	add(detectDialog(entities));
	return { intents };
}
