// ABML R2 — inference layer (pure core). Detects generic ARIA semantic patterns from the
// merged entity list + R1 relation summary. No per-site or per-type branches — every detector
// matches against the universal ARIA structure (roles, landmarks, relation counts). The result
// rides the envelope top-level alongside gist/outline/relations, budget-immune.
//
// Patterns detected:
//   login            — password-type input + submit control; evidence.submitRef = button ref
//   search           — searchbox role or search landmark with editable inputs
//   filter-panel     — search landmark + 2+ editable inputs (structured filter UI)
//   single-choice    — radiogroup container or 2+ radio entities
//   multi-choice     — 3+ checkbox entities; high when grouped in a container, medium when scattered
//   expandable       — expandedTarget >= 2 (accordion/combobox/disclosure; threshold filters
//                      single nav-toggle noise found in live validation)
//   data-grid        — grid/treegrid role entity, or tableCells >= 50
//   navigation       — nav with aria-current item (currentIn relation)
//   dialog           — dialog or alertdialog entity
//   tabbed-interface — tablist role or 2+ tab entities (switch tabs to see more content)
//   alert-region     — alert or status role (live feedback area after actions)
import type { Entity } from "./entity.js";
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
	| "alert-region";    // alert or status live region

export type DetectedIntent = {
	intent: PageIntent;
	confidence: "high" | "medium" | "low";
	// Optional relational facts about the detected pattern. Only present when the detector
	// has useful entity refs to surface (e.g. login includes submitRef so the agent knows
	// exactly which button to click without re-scanning).
	evidence?: Record<string, unknown>;
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

// login: password-type input (DOM-sourced inputKind) + at least one non-disabled button.
// evidence.submitRef points to the first non-disabled button so the agent knows which
// ref to click without a follow-up scan.
function detectLogin(entities: Entity[]): DetectedIntent | undefined {
	if (!hasInputKind(entities, "password")) return undefined;
	const submitButton = entities.find((e) => e.kind === "control" && (e.role === "button" || e.role === "link") && !e.state.disabled);
	if (!submitButton) return { intent: "login", confidence: "medium" };
	return { intent: "login", confidence: "high", evidence: { submitRef: submitButton.ref } };
}

// search: searchbox role (from <input type=search> via DOM roleOf) is a strong signal.
// search landmark alone (ARIA search role applied to a region) is medium.
function detectSearch(entities: Entity[]): DetectedIntent | undefined {
	if (hasRole(entities, "searchbox")) return { intent: "search", confidence: "high" };
	if (hasLandmark(entities, "search") && countEditable(entities) >= 1) return { intent: "search", confidence: "medium" };
	return undefined;
}

// filter-panel: a search-landmark region containing 2+ editable inputs signals a structured
// filter UI (date range, facets, dropdown filters) as opposed to a single search box.
function detectFilterPanel(entities: Entity[]): DetectedIntent | undefined {
	if (!hasLandmark(entities, "search")) return undefined;
	if (countEditable(entities) < 2) return undefined;
	return { intent: "filter-panel", confidence: "high" };
}

// single-choice: radiogroup container in the AX tree is the clean signal (high confidence).
// 2+ radio entities without an explicit radiogroup is medium.
function detectSingleChoice(entities: Entity[]): DetectedIntent | undefined {
	if (hasRole(entities, "radiogroup")) return { intent: "single-choice", confidence: "high" };
	if (countRole(entities, "radio") >= 2) return { intent: "single-choice", confidence: "medium" };
	return undefined;
}

// multi-choice: 3+ checkboxes suggests a multi-select list (options, features, tags).
// High confidence when 3+ share the same ARIA group container (intentional grouping by author).
// Medium for scattered checkboxes — could be unrelated form controls (terms + newsletter).
function detectMultiChoice(entities: Entity[]): DetectedIntent | undefined {
	const checkboxes = entities.filter((e) => e.role?.toLowerCase() === "checkbox");
	if (checkboxes.length < 3) return undefined;
	// Count checkboxes per container. A group with 3+ checkboxes = intentional multi-choice.
	const groupCounts = new Map<string, number>();
	for (const e of checkboxes) {
		const role = typeof e.hints?.containerRole === "string" ? e.hints.containerRole : null;
		if (!role) continue;
		const key = `${role}|${typeof e.hints?.containerName === "string" ? e.hints.containerName : ""}`;
		groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
	}
	const hasGrouped = Array.from(groupCounts.values()).some((count) => count >= 3);
	return { intent: "multi-choice", confidence: hasGrouped ? "high" : "medium" };
}

// expandable: expandedTarget >= 2 filters the single-nav-toggle case found in live validation
// (Bing/GitLab each had expandedTarget=1 from a single hamburger/dropdown menu but aren't
// really "expandable" pages). Two or more expand relations suggest the pattern is structural.
const EXPANDABLE_THRESHOLD = 2;
function detectExpandable(relSummary: RelationSummary): DetectedIntent | undefined {
	if ((relSummary.summary.expandedTarget ?? 0) >= EXPANDABLE_THRESHOLD) return { intent: "expandable", confidence: "high" };
	return undefined;
}

// data-grid: grid/treegrid role (ARIA interactive grid) or tableCells >= 50 (large table).
// Threshold of 50 filters documentation/attribute tables on reference pages (W3C APG, MDN
// have 12–42-cell attribute tables on almost every page — live validation confirmed this).
const DATA_GRID_CELL_THRESHOLD = 50;
function detectDataGrid(entities: Entity[], relSummary: RelationSummary): DetectedIntent | undefined {
	if (hasRole(entities, "grid") || hasRole(entities, "treegrid")) return { intent: "data-grid", confidence: "high" };
	if ((relSummary.summary.tableCells ?? 0) >= DATA_GRID_CELL_THRESHOLD) return { intent: "data-grid", confidence: "high" };
	return undefined;
}

// navigation: currentIn fires when an aria-current entity has a resolved nav/list container.
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

// tabbed-interface: tablist role is the authoritative ARIA container for a tab panel set.
// 2+ tab entities without an explicit tablist is medium — ungrouped tabs exist in the wild.
// Tells the agent: switch tabs to access content not visible in the current panel.
function detectTabbedInterface(entities: Entity[]): DetectedIntent | undefined {
	if (hasRole(entities, "tablist")) return { intent: "tabbed-interface", confidence: "high" };
	if (countRole(entities, "tab") >= 2) return { intent: "tabbed-interface", confidence: "medium" };
	return undefined;
}

// alert-region: role="alert" (assertive live region, e.g. validation errors) or role="status"
// (polite live region, e.g. save confirmations). Tells the agent where to look for feedback
// after an action — essential for form validation and async operation results.
function detectAlertRegion(entities: Entity[]): DetectedIntent | undefined {
	if (entities.some((e) => e.role === "alert" || e.role === "status")) {
		return { intent: "alert-region", confidence: "high" };
	}
	return undefined;
}

// ── Public builder ─────────────────────────────────────────────────────────────

// Detect generic ARIA semantic patterns over the merged entity list + R1 relation summary.
// Every detector is independent, generic (no per-site/per-type branches), and returns at
// most one DetectedIntent. Dedup rules:
//   - "filter-panel" supersedes "search" (the former implies the latter).
// Order is deterministic (definition order below).
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
	add(detectTabbedInterface(entities));
	add(detectAlertRegion(entities));
	return { intents };
}
