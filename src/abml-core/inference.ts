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
//   filter-panel     — multiple filter/facet controls or structured search filters
//   single-choice    — radiogroup container or 2+ radio entities
//   multi-choice     — 3+ checkbox entities; high when grouped in a container
//   expandable       — 2+ unique expand triggers with visible/perceptible evidence
//   data-grid        — grid/treegrid role entity, or tableCells >= 50; autocomplete grids suppressed
//   navigation       — nav with aria-current item (currentIn relation)
//   dialog           — visible dialog or alertdialog entity
//   tabbed-interface — visible tablist or 2+ visible ungrouped tab entities
//   alert-region     — alert or status role (live feedback area after actions)
//   form-dependency  — R3 diff: editable/focused field enabled a previously disabled control
import type { Entity, RelationType } from "./entity.js";
import type { EntityDiff } from "./diff.js";
import type { RelationSummary } from "./relations.js";

export type PageIntent =
	| "login"            // password-type input + submit button
	| "search"           // searchbox role or search landmark
	| "filter-panel"     // filter/facet controls or structured search filters
	| "single-choice"    // radiogroup or 2+ radio entities
	| "multi-choice"     // 3+ checkbox entities
	| "expandable"       // 2+ unique expand-trigger relations
	| "data-grid"        // table/grid with cell relations
	| "navigation"       // nav with aria-current (currentIn) relation
	| "dialog"           // visible modal dialog or alertdialog
	| "tabbed-interface" // visible tablist or 2+ visible tab entities
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

function roleOf(entity: Entity): string {
	return (entity.role || "").toLowerCase();
}

function textOf(entity: Entity): string {
	const selector = typeof entity.hints?.selector === "string" ? entity.hints.selector : "";
	return `${entity.name ?? ""} ${entity.role ?? ""} ${selector}`.toLowerCase();
}

function isPerceptible(entity: Entity): boolean {
	return entity.state.visible === true && entity.state.occluded !== true;
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

// ── Evidence resolution helpers (best-effort ref lookup over the merged entity list) ──────

function firstEntityByRole(entities: Entity[], ...roles: string[]): Entity | undefined {
	const set = new Set(roles.map((r) => r.toLowerCase()));
	return entities.find((e) => e.role && set.has(roleOf(e)));
}

function firstRefByRole(entities: Entity[], ...roles: string[]): string | undefined {
	return firstEntityByRole(entities, ...roles)?.ref;
}

function allRefsByRole(entities: Entity[], role: string): string[] {
	const lower = role.toLowerCase();
	return uniqueRefs(entities.filter((e) => roleOf(e) === lower).map((e) => e.ref));
}

function refsWithRelation(entities: Entity[], type: RelationType, predicate: (entity: Entity) => boolean = () => true): string[] {
	return uniqueRefs(entities.filter((e) => predicate(e) && e.relations?.some((r) => r.type === type)).map((e) => e.ref));
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
	const unique = uniqueRefs(all);
	const refs = unique.slice(0, MAX_EVIDENCE_REFS);
	const countKey = `${key.replace(/Refs$/, "")}Count`;
	return { [key]: refs, ...(unique.length > refs.length ? { [countKey]: unique.length } : {}) };
}

function collectEvidenceRefs(value: unknown, refs: string[]): void {
	if (typeof value === "string") {
		if (value.startsWith("pi-ref://")) refs.push(value);
		return;
	}
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) collectEvidenceRefs(item, refs);
		return;
	}
	for (const item of Object.values(value as Record<string, unknown>)) collectEvidenceRefs(item, refs);
}

export function inferenceEvidenceRefs(summary: InferenceSummary | undefined): string[] {
	const refs: string[] = [];
	for (const intent of summary?.intents ?? []) collectEvidenceRefs(intent.evidence, refs);
	return uniqueRefs(refs);
}

export function entitiesForInferenceEvidence(entities: Entity[], summary: InferenceSummary | undefined, cap = MAX_EVIDENCE_REFS * 4): Entity[] {
	const refs = new Set(inferenceEvidenceRefs(summary).slice(0, cap));
	if (!refs.size) return [];
	return entities.filter((entity) => refs.has(entity.ref)).slice(0, cap);
}

// Construct a DetectedIntent, dropping an empty evidence object so absent anchors don't
// surface as `evidence: {}`.
function mk(intent: PageIntent, confidence: DetectedIntent["confidence"], reason: string, evidence?: Record<string, unknown>): DetectedIntent {
	const hasEvidence = evidence && Object.keys(evidence).length > 0;
	return { intent, confidence, reason, ...(hasEvidence ? { evidence } : {}) };
}

// ── Detectors (generic ARIA/text patterns only — no per-site allowlists; evidence additive) ──

// login: password-type input (DOM-sourced inputKind) + a visible, same-flow submit-like control.
// Demotion of non-submit controls uses GENERIC signals only — never a per-site/provider allowlist
// (Non-goal: no overfitting). Third-party identity buttons are recognized by the cross-site
// "<verb> with <provider>" language shape, not by enumerating Google/GitHub/GitLab/etc.
const LOGIN_POSITIVE_RE = /\b(sign[-\s]*in|log[-\s]*in|login|submit|continue|next)\b|登入|登录|登陆|提交|继续|下一步/i;
const LOGIN_NEGATIVE_RE = /passkey|oauth|omniauth|saml|sso|forgot|register|sign\s*up|show\s*password|cookie|privacy|help|explore|万能钥匙|忘记|注册/i;
// Generic social/federated-login shape: "Sign in with Google", "Continue with Acme SSO", "Connect
// with …". Matches the language pattern, so it generalizes to any provider without a name list.
const LOGIN_THIRD_PARTY_RE = /\b(?:sign[-\s]*in|log[-\s]*in|signin|login|continue|connect)\s+with\b/i;

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

function detectLogin(entities: Entity[]): DetectedIntent | undefined {
	if (!hasInputKind(entities, "password")) return undefined;
	const submitButton = entities
		.filter((e) => loginCandidateScore(e) > 0)
		.sort((a, b) => loginCandidateScore(b) - loginCandidateScore(a))[0];
	if (!submitButton) return mk("login", "medium", "password field, no strong submit");
	return mk("login", "high", "password field + strong submit", { submitRef: submitButton.ref });
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

// filter-panel: real filter/facet controls are usually links/buttons whose labels mention
// applying filters, or grouped checkbox/radio/range controls. A plain search landmark with
// multiple editable fields is only medium and must expose filter/facet semantics; this avoids
// anchoring Amazon-style search forms as filter panels.
const FILTER_TEXT_RE = /\b(filter|facet|refine|narrow|brand|price|rating|stars|department|category|condition|delivery|seller|sort)\b|筛选|缩小|品牌|价格|评分|类别|部门|配送|卖家/i;

function filterControls(entities: Entity[]): Entity[] {
	return entities.filter((entity) => {
		if (entity.kind !== "control" || entity.state.disabled || !isPerceptible(entity)) return false;
		const role = roleOf(entity);
		return ["button", "link", "combobox", "option", "checkbox", "radio", "slider", "spinbutton"].includes(role) && FILTER_TEXT_RE.test(textOf(entity));
	});
}

function detectFilterPanel(entities: Entity[]): DetectedIntent | undefined {
	const controls = filterControls(entities);
	if (controls.length >= 3) {
		return mk("filter-panel", "high", `${controls.length} filter controls`, { ...capRefs(controls.map((entity) => entity.ref), "controlRefs"), inputCount: controls.length });
	}
	if (!hasLandmark(entities, "search")) return undefined;
	const editableInputs = entities.filter((e) => e.kind === "control" && e.state.editable && isPerceptible(e));
	const region = entities.find((e) => e.structure?.landmark === "search" && FILTER_TEXT_RE.test(textOf(e)));
	if (editableInputs.length < 2 || !region) return undefined;
	return mk("filter-panel", "medium", `search filter landmark, ${editableInputs.length} inputs`, { regionRef: region.ref, inputCount: editableInputs.length });
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
	const triggerRefs = refsWithRelation(entities, "expandedTarget", (entity) => isPerceptible(entity) || entity.state.expanded !== undefined);
	const count = Math.max(triggerRefs.length, relSummary.summary.expandedTarget ?? 0);
	if (triggerRefs.length < EXPANDABLE_THRESHOLD) return undefined;
	return mk("expandable", "high", `${count} expand triggers`, capRefs(triggerRefs, "triggerRefs"));
}

// data-grid: grid/treegrid role (ARIA interactive grid) or tableCells >= 50 (large table).
// Threshold of 50 filters documentation/attribute tables on reference pages (W3C APG, MDN
// have 12–42-cell attribute tables on almost every page — live validation confirmed this).
const DATA_GRID_CELL_THRESHOLD = 50;
function detectDataGrid(entities: Entity[], relSummary: RelationSummary): DetectedIntent | undefined {
	const grid = entities.find((entity) => ["grid", "treegrid"].includes(roleOf(entity)) && isPerceptible(entity) && !/autocomplete|suggest/i.test(textOf(entity)));
	if (grid) return mk("data-grid", "high", "visible grid role", { gridRef: grid.ref });
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
	const dialog = entities.find((e) => (roleOf(e) === "dialog" || roleOf(e) === "alertdialog") && isPerceptible(e));
	if (!dialog) return undefined;
	return mk("dialog", "high", `visible ${dialog.role} role`, { dialogRef: dialog.ref });
}

// tabbed-interface: tablist role is the authoritative ARIA container for a tab panel set.
// 2+ tab entities without an explicit tablist is medium — ungrouped tabs exist in the wild.
// Tells the agent: switch tabs to access content not visible in the current panel.
function detectTabbedInterface(entities: Entity[]): DetectedIntent | undefined {
	const tablist = entities.find((entity) => roleOf(entity) === "tablist" && isPerceptible(entity));
	const tabRefs = uniqueRefs(entities.filter((entity) => roleOf(entity) === "tab" && isPerceptible(entity)).map((entity) => entity.ref));
	if (tablist) return mk("tabbed-interface", "high", `visible tablist with ${tabRefs.length} tabs`, { tablistRef: tablist.ref, ...capRefs(tabRefs, "tabRefs") });
	if (tabRefs.length >= 2) return mk("tabbed-interface", "medium", `${tabRefs.length} visible ungrouped tabs`, capRefs(tabRefs, "tabRefs"));
	return undefined;
}

// alert-region: role="alert" (assertive live region, e.g. validation errors) or role="status"
// (polite live region, e.g. save confirmations). Tells the agent where to look for feedback
// after an action — essential for form validation and async operation results.
// With an R3 diff, a live region that just appeared (dynamically inserted toast/alert) or whose
// accessible name changed (a persistent container that just received text) is fresh post-action
// feedback — the strongest signal. It is flagged via an evidence token (appeared|updated) + reason;
// the region's text is never embedded (generic + privacy-safe, same contract as form-dependency).
// Among multiple live regions the fresh one is preferred (it answers the last action).
function detectAlertRegion(entities: Entity[], diff?: EntityDiff): DetectedIntent | undefined {
	const regions = entities.filter((e) => (roleOf(e) === "alert" || roleOf(e) === "status") && isPerceptible(e));
	if (!regions.length) return undefined;
	const nameChanged = (ref: string): boolean => !!diff && diff.changed.some((c) => c.kind === "name-changed" && c.ref === ref);
	const isFresh = (ref: string): boolean => !!diff && (diff.appeared.includes(ref) || nameChanged(ref));
	const region = (diff ? regions.find((r) => isFresh(r.ref)) : undefined) ?? regions[0];
	const live = roleOf(region) === "alert" ? "assertive" : "polite";
	const fresh = !diff ? undefined : diff.appeared.includes(region.ref) ? "appeared" : nameChanged(region.ref) ? "updated" : undefined;
	const reason = fresh === "appeared" ? `${region.role} live region appeared after action`
		: fresh === "updated" ? `${region.role} live region updated after action`
		: `visible ${region.role} live region`;
	return mk("alert-region", "high", reason, { regionRef: region.ref, live, ...(fresh ? { fresh } : {}) });
}

function changedField(change: EntityDiff["changed"][number], side: "before" | "after", field: string): unknown {
	const value = change[side];
	return value && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}

function editableControlByRef(entities: Entity[], ref: string | undefined, enabledRef: string): Entity | undefined {
	if (!ref || ref === enabledRef) return undefined;
	return entities.find((entity) => entity.ref === ref && entity.kind === "control" && entity.state.editable === true);
}

function editableFocusTransition(entities: Entity[], diff: EntityDiff, enabledRef: string): { ref: string; confidence: DetectedIntent["confidence"]; reason: string; signal: string } | undefined {
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

// form-dependency: R3 temporal fact. A control that was disabled became enabled, while an
// editable control was the live focus or had a unique focus transition in the same diff. Because
// editable values are intentionally redacted/suppressed, focus is the privacy-safe proxy for
// "the field just filled". The transition fallback covers real pages where focus moves before rescan.
function detectFormDependency(entities: Entity[], diff?: EntityDiff): DetectedIntent | undefined {
	if (!diff) return undefined;
	const enabled = diff.changed.find((change) => change.kind === "state-changed" && changedField(change, "before", "disabled") === true && changedField(change, "after", "disabled") === false);
	if (!enabled) return undefined;
	const focused = editableControlByRef(entities, diff.focusedRef, enabled.ref);
	if (focused) return mk("form-dependency", "high", "a focused editable field enabled a disabled control", { enabledRef: enabled.ref, requiredRef: focused.ref, focusSignal: "focusedRef" });
	const transition = editableFocusTransition(entities, diff, enabled.ref);
	if (!transition) return undefined;
	return mk("form-dependency", transition.confidence, transition.reason, { enabledRef: enabled.ref, requiredRef: transition.ref, focusSignal: transition.signal });
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
	add(detectAlertRegion(entities, diff));
	add(detectFormDependency(entities, diff));
	return { intents };
}
