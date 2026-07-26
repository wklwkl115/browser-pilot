import { defaultRefPolicyForKind } from "../refs/refPolicy.js";
import type { Locator, RefDescriptor, RefKind } from "./types.js";
import { finiteNumber as numberValue, isRecord, nonEmptyString as stringValue } from "../../utils/records.js";
import { memoizedUrlOrigin } from "../../utils/url.js";
import { firstSafeSemanticText, safeContainerLabelText, sanitizeSemanticText } from "./semanticText.js";
import type { ScanActionable, ScanCanvasRegion, ScanListHint } from "./pageWorldScan.js";

type ScanActionableInput = ScanActionable | Record<string, unknown>;
type ScanListHintInput = ScanListHint | Record<string, unknown>;
type ScanVisionInput = ScanActionable | ScanCanvasRegion | Record<string, unknown>;

export type EntityKind = Extract<RefKind, "element" | "control" | "text" | "region" | "media" | "frame">;
export type EntitySource = "dom" | "ax" | "vision";
// Public entity geometry is always viewport-relative CSS pixels. DOMSnapshot document coordinates
// are kept in SnapshotGeometryEntry and converted at the browser-runtime boundary.
export type EntityGeometry = { box?: { x: number; y: number; w: number; h: number }; point?: { x: number; y: number } };

export type EntityAction = "click" | "edit";
export type EntityActionability = {
	actions: EntityAction[];
	hint?: string;
	confidence: "high" | "medium";
};

export type EntityScope = {
	key: string;
	name?: string;
	position?: number;
	size?: number;
};

export type EntityState = {
	visible: boolean;
	occluded: boolean;
	disabled: boolean;
	focused: boolean;
	checked?: boolean;
	selected?: boolean;
	pressed?: boolean;
	expanded?: boolean;
	current?: boolean | string;
	editable: boolean;
	inViewport: boolean;
};

// Structural / document-outline metadata (ARIA structure + landmark spectrum). Distinct
// from EntityState (interaction state): these describe where an entity sits in the
// document, not whether it is checked/selected. Sourced from the AX tree.
export type EntityStructure = {
	level?: number; // aria-level — heading level / treeitem depth
	setSize?: number; // aria-setsize — size of the set this item belongs to
	posInSet?: number; // aria-posinset — 1-based position within that set
	sort?: string; // aria-sort on a column header (ascending/descending/other)
	landmark?: string; // landmark role (navigation/main/banner/contentinfo/complementary/search/form/region)
	rowIndex?: number; // table/grid cell — 1-based row position (aria-rowindex or computed)
	colIndex?: number; // table/grid cell — 1-based column position (aria-colindex or computed)
};

// Relationship graph: typed edges from this entity to other refs.
// Reuses AX relations/properties (labelledby/describedby/controls/owns), table hierarchy
// (cell→row→table), and aria-current. `targetRef` is always a materialized bp-ref://; the
// pre-ref backend/AX node ids used to extract anchors never leak here. Scalar facts
// (state.current, state.expanded, hints.containerRole) stay for old callers — relations
// are additive provenance, not a replacement.
export type RelationType =
	| "labelledBy"
	| "describedBy"
	| "controls"
	| "owns"
	| "expandedTarget"
	| "currentIn"
	| "cellOf"
	| "rowOf"
	| "columnOf"
	| "headerFor"
	| "occludes"
	| "coveredBy"
	// Control to network request fired in the post-action delta window. Target is a
	// `bp-ref://network/<id>` or `bp-ref://event/<id>` (resolvable inline in envelope.causal, not an
	// entity). Causal attribution source: "timing" (request fired after the activated control,
	// low confidence, no initiator-stack proof) or "event" (a hook event named this element as
	// its target, medium confidence). See abml-kernel/causal.ts.
	| "triggered";

export type EntityRelation = {
	type: RelationType;
	targetRef: string;
	source: "ax" | "dom" | "geometry" | "timing" | "event";
	confidence: "high" | "medium" | "low";
	evidence?: Record<string, unknown>;
};

export type Entity = {
	ref: string;
	kind: EntityKind;
	role: string;
	name?: string;
	value?: string;
	state: EntityState;
	actionability?: EntityActionability;
	scope?: EntityScope;
	structure?: EntityStructure;
	relations?: EntityRelation[];
	source: EntitySource;
	locators?: Locator[];
	geometry?: EntityGeometry;
	children?: Entity[] | { handle: string; count: number };
	hints?: { listContainer?: boolean; jsonPath?: string; selector?: string; [key: string]: unknown };
};

export function isAddressableEntity(entity: Entity): boolean {
	return entity.actionability !== undefined || entity.kind === "control" || entity.kind === "region" || entity.kind === "frame" || entity.kind === "media" || Boolean(entity.relations?.length);
}

export type ScanEntityContext = {
	browserSessionId?: string;
	tabId?: number;
	targetId?: string;
	targetGeneration?: number;
	pageEpoch?: string;
	documentId?: string;
	changeSeq?: number;
	url?: string;
	observationId: string;
	capturedAt: number;
};

function documentEpoch(context: ScanEntityContext): NonNullable<RefDescriptor["documentEpoch"]> {
	return {
		...(context.targetGeneration ? { targetGeneration: context.targetGeneration } : {}),
		...(context.pageEpoch ? { pageEpoch: context.pageEpoch } : {}),
		...(context.documentId ? { documentId: context.documentId } : {}),
		...(context.changeSeq !== undefined ? { changeSeq: context.changeSeq, mutationEpoch: context.changeSeq } : {}),
		url: context.url,
		capturedAt: context.capturedAt,
	};
}

export type BuiltEntity = {
	entity: Omit<Entity, "ref">;
	descriptor: Omit<RefDescriptor, "refId">;
};

function stringArray(value: unknown, limit = 8): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, limit);
	return out.length ? out : undefined;
}

function roleForTag(tag: string | undefined): string {
	switch ((tag || "").toLowerCase()) {
		case "a": return "link";
		case "button": return "button";
		case "input":
		case "textarea": return "textbox";
		case "select": return "combobox";
		case "img": return "img";
		case "iframe": return "frame";
		default: return tag || "generic";
	}
}

export function dedupeLocators(locators: Locator[]): Locator[] {
	const seen = new Set<string>();
	const out: Locator[] = [];
	for (const locator of locators) {
		const key = JSON.stringify(locator);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(locator);
	}
	return out;
}

function geometryFromRect(rect: unknown): { box?: { x: number; y: number; w: number; h: number } } | undefined {
	if (!isRecord(rect)) return undefined;
	const x = numberValue(rect.x);
	const y = numberValue(rect.y);
	const w = numberValue(rect.width ?? rect.w);
	const h = numberValue(rect.height ?? rect.h);
	if ([x, y, w, h].some((item) => item === undefined)) return undefined;
	return { box: { x: Math.round(x!), y: Math.round(y!), w: Math.round(w!), h: Math.round(h!) } };
}

function geometryPoint(point: unknown): { point?: { x: number; y: number } } | undefined {
	if (!isRecord(point)) return undefined;
	const x = numberValue(point.x);
	const y = numberValue(point.y);
	if (x === undefined || y === undefined) return undefined;
	return { point: { x: Math.round(x), y: Math.round(y) } };
}

function geometryCenter(geometry: { box?: { x: number; y: number; w: number; h: number }; point?: { x: number; y: number } }): { x: number; y: number } | undefined {
	if (geometry.point) return geometry.point;
	if (!geometry.box) return undefined;
	return {
		x: Math.round(geometry.box.x + geometry.box.w / 2),
		y: Math.round(geometry.box.y + geometry.box.h / 2),
	};
}

function actionEntityKind(node: ScanActionableInput): EntityKind {
	const tag = stringValue(node.tag)?.toLowerCase();
	const role = stringValue(node.role)?.toLowerCase();
	if (node.editable === true) return "control";
	if (["button", "link", "checkbox", "radio", "switch", "tab", "combobox", "option"].includes(role || "")) return "control";
	if (["button", "a", "input", "textarea", "select"].includes(tag || "")) return "control";
	return "element";
}

function actionEntityState(node: ScanActionableInput): EntityState {
	const rect = geometryFromRect(node.rect)?.box;
	const point = geometryPoint(node.point)?.point;
	// aria-current (scan-sourced): Chrome's AX tree doesn't expose it, so the DOM scan is the
	// authoritative source. Normalize the token ("false" → not current, "true" → boolean, else
	// the token e.g. "page"/"step"). This also backfills state.current on real pages.
	const currentRaw = typeof node.current === "string" ? node.current.trim() : undefined;
	const current = currentRaw === undefined || currentRaw === "" ? undefined : currentRaw === "false" ? false : currentRaw === "true" ? true : currentRaw;
	return {
		visible: node.visible !== false && Boolean(rect || point || node.hitOk !== undefined),
		occluded: node.hitOk === false,
		disabled: node.disabled === true,
		focused: node.focused === true,
		...(typeof node.checked === "boolean" ? { checked: node.checked } : {}),
		...(typeof node.selected === "boolean" ? { selected: node.selected } : {}),
		...(typeof node.pressed === "boolean" ? { pressed: node.pressed } : {}),
		...(typeof node.expanded === "boolean" ? { expanded: node.expanded } : {}),
		...(current !== undefined && current !== false ? { current } : {}),
		editable: node.editable === true,
		inViewport: node.inViewport !== false && Boolean(point || rect),
	};
}

export function buildActionableLocators(node: ScanActionableInput): Locator[] {
	const locators: Locator[] = [];
	const backendNodeId = numberValue(node.backendNodeId);
	const targetId = stringValue(node.targetId ?? node.cdpTargetId);
	const selector = stringValue(node.selector);
	const role = stringValue(node.role) || roleForTag(stringValue(node.tag));
	const name = firstSafeSemanticText([node.action, node.label, node.displayLabel, node.text], 160);
	const point = geometryPoint(node.point)?.point;
	if (backendNodeId !== undefined && backendNodeId > 0) locators.push({ by: "backendNodeId", value: backendNodeId, ...(targetId ? { targetId } : {}) });
	if (selector) locators.push({ by: "css", value: selector });
	if (name) locators.push({ by: "textAnchor", value: name, ...(role ? { role } : {}), exact: false });
	if (point) locators.push({ by: "point", x: point.x, y: point.y });
	return dedupeLocators(locators);
}

export function buildListHintLocators(node: ScanListHintInput): Locator[] {
	const locators: Locator[] = [];
	const selector = stringValue(node.selector);
	const sample = sanitizeSemanticText(node.firstItemPreview, 160);
	if (selector) locators.push({ by: "css", value: selector });
	if (sample) locators.push({ by: "textAnchor", value: sample, role: "list", exact: false });
	return dedupeLocators(locators);
}

export function buildDomEntityFromScanActionable(node: ScanActionableInput, context: ScanEntityContext): BuiltEntity {
	const kind = actionEntityKind(node);
	const role = stringValue(node.role) || roleForTag(stringValue(node.tag));
	const locators = buildActionableLocators(node);
	const geometry = {
		...(geometryFromRect(node.rect) || {}),
		...(geometryPoint(node.point) || {}),
	};
	const name = firstSafeSemanticText([node.action, node.label, node.displayLabel, node.text], 160);
	const value = node.editable === true ? undefined : sanitizeSemanticText(node.value, 160);
	const controlsSelectors = stringArray(node.controlsSelectors);
	const ownsSelectors = stringArray(node.ownsSelectors);
	const expandedTargetSelectors = stringArray(node.expandedTargetSelectors);
	const backendNodeId = numberValue(node.backendNodeId);
	const targetId = stringValue(node.targetId ?? node.cdpTargetId) || context.targetId;
	const backendNodeIdBootstrap = isRecord(node.backendNodeIdBootstrap) ? node.backendNodeIdBootstrap : undefined;
	const scope = isRecord(node.scope) ? node.scope : undefined;
	const scopeKey = stringValue(scope?.key);
	const scopeName = sanitizeSemanticText(scope?.name, 80);
	const scopePosition = numberValue(scope?.position);
	const scopeSize = numberValue(scope?.size);
	const actions = [node.clickable === true ? "click" as const : undefined, node.editable === true ? "edit" as const : undefined]
		.filter((action): action is "click" | "edit" => action !== undefined);
	const rawActionHint = stringValue(node.action);
	const actionHint = sanitizeSemanticText(rawActionHint, 80)
		?? (rawActionHint && /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,79}$/u.test(rawActionHint) ? rawActionHint : undefined);
	const entity: Omit<Entity, "ref"> = {
		kind,
		role,
		...(name ? { name } : {}),
		...(value ? { value } : {}),
		state: actionEntityState(node),
		...(actions.length ? { actionability: { actions, ...(actionHint ? { hint: actionHint } : {}), confidence: node.actionConfidence === "high" ? "high" : "medium" } } : {}),
		...(scopeKey ? { scope: { key: scopeKey, ...(scopeName ? { name: scopeName } : {}), ...(scopePosition !== undefined ? { position: scopePosition } : {}), ...(scopeSize !== undefined ? { size: scopeSize } : {}) } } : {}),
		source: "dom",
		locators,
		...(Object.keys(geometry).length ? { geometry } : {}),
		hints: {
			jsonPath: `data.structure.actionables[${Number(node.index ?? 0)}]`,
			selector: stringValue(node.selector),
			...(backendNodeId !== undefined && backendNodeId > 0 ? { backendNodeId } : {}),
			...(targetId ? { targetId } : {}),
			...(backendNodeIdBootstrap ? { backendNodeIdBootstrap } : {}),
			...(Array.isArray(node.handlers) && node.handlers.length ? { handlers: node.handlers } : {}),
			// The element stacked on top at our center point when the hit-test failed — the occluder.
			// Resolved to an entity ref (coveredBy/occludes) in relation derivation; harmless if unresolved.
			...(node.hitOk === false && stringValue(node.occluderSelector) ? { occluderSelector: stringValue(node.occluderSelector) } : {}),
			// aria-controls / aria-owns / expanded target selectors (DOM-sourced so they resolve even when
			// the target is collapsed/hidden — the AX tree omits those). Materialized by selector.
			...(controlsSelectors ? { controlsSelectors } : {}),
			...(ownsSelectors ? { ownsSelectors } : {}),
			...(expandedTargetSelectors ? { expandedTargetSelectors } : {}),
			// HTML input type (e.g. "password", "search", "email"). AX only exposes the role.
			...(stringValue(node.inputKind) ? { inputKind: stringValue(node.inputKind) } : {}),
		},
	};
	const capturedAt = context.capturedAt;
	const origin = memoizedUrlOrigin(context.url);
	return {
		entity,
		descriptor: {
			kind,
			locators,
			owner: {
				...(context.browserSessionId ? { browserSessionId: context.browserSessionId } : {}),
				...(context.tabId !== undefined ? { tabId: context.tabId } : {}),
				...(targetId ? { targetId } : {}),
				...(origin ? { topLevelOrigin: origin } : {}),
			},
			policy: defaultRefPolicyForKind(kind),
			semantic: {
				role,
				...(name ? { name } : {}),
			},
			...(Object.keys(geometry).length ? { geometry } : {}),
			observationId: context.observationId,
			documentEpoch: documentEpoch(context),
			createdAt: capturedAt,
			ttlMs: 5 * 60 * 1000,
			stabilityScore: node.hitOk === true ? 0.9 : node.hitOk === false ? 0.4 : 0.6,
		},
	};
}

function listHintNameParts(node: ScanListHintInput, index: number): { name: string; context?: string; source: "safe-label" | "safe-preview" | "fallback" } {
	const name = firstSafeSemanticText([node.containerLabel], 80);
	const preview = safeContainerLabelText(node.firstItemPreview, 80);
	const context = safeContainerLabelText(selectorContext(node.selector), 40);
	if (name) return { name, ...(context ? { context } : {}), source: "safe-label" };
	if (preview) return { name: preview, ...(context ? { context } : {}), source: "safe-preview" };
	return { name: `list-${index}`, ...(context ? { context } : {}), source: "fallback" };
}

function selectorContext(value: unknown): string | undefined {
	const selector = stringValue(value);
	if (!selector) return undefined;
	const match = selector.match(/(?:#([A-Za-z0-9_-]{2,})|\.([A-Za-z0-9_-]{2,}))/);
	return (match?.[1] ?? match?.[2])?.replace(/[-_]+/g, " ");
}

function normalizeNameKey(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function disambiguatedName(name: string, context: string | undefined): string {
	if (!context || normalizeNameKey(name) === normalizeNameKey(context)) return name;
	return `${name} (${context})`;
}

export function buildRegionEntityFromListHint(node: ScanListHintInput, context: ScanEntityContext, index: number, duplicateNames?: ReadonlySet<string>): BuiltEntity {
	const locators = buildListHintLocators(node);
	const nameParts = listHintNameParts(node, index);
	const name = duplicateNames?.has(normalizeNameKey(nameParts.name)) ? disambiguatedName(nameParts.name, nameParts.context) : nameParts.name;
	const entity: Omit<Entity, "ref"> = {
		kind: "region",
		role: "list",
		name,
		state: {
			visible: true,
			occluded: false,
			disabled: false,
			focused: false,
			editable: false,
			inViewport: true,
		},
		source: "dom",
		locators,
		hints: {
			listContainer: true,
			jsonPath: `data.structure.listHints[${index}]`,
			selector: stringValue(node.selector),
			...(nameParts.context && name === nameParts.name ? { containerNameContext: nameParts.context } : {}),
			containerNameSource: name !== nameParts.name ? "disambiguated" : nameParts.source,
		},
	};
	const capturedAt = context.capturedAt;
	const origin = memoizedUrlOrigin(context.url);
	return {
		entity,
		descriptor: {
			kind: "region",
			locators,
			owner: {
				...(context.browserSessionId ? { browserSessionId: context.browserSessionId } : {}),
				...(context.tabId !== undefined ? { tabId: context.tabId } : {}),
				...(origin ? { topLevelOrigin: origin } : {}),
			},
			policy: defaultRefPolicyForKind("region"),
			semantic: { role: "list", name },
			observationId: context.observationId,
			documentEpoch: documentEpoch(context),
			createdAt: capturedAt,
			ttlMs: 5 * 60 * 1000,
			stabilityScore: 0.7,
		},
	};
}

function referencedTargetKind(role: string): EntityKind {
	const normalized = role.toLowerCase();
	if (["button", "link", "checkbox", "radio", "switch", "tab", "combobox", "option", "textbox", "searchbox", "menuitem", "slider", "spinbutton"].includes(normalized)) return "control";
	if (["region", "listbox", "menu", "menubar", "dialog", "list", "grid", "table", "navigation", "tabpanel", "group", "tree", "form"].includes(normalized)) return "region";
	if (["heading", "text", "statictext"].includes(normalized)) return "text";
	return "element";
}

// A minimal entity for an element that declares aria-controls/aria-owns (the relation source) but
// is not in the actionable list (e.g. scrolled off-screen). Built from the scan control-pair
// data; selector-keyed so it dedupes against an existing actionable if one is present.
export function buildControlsSourceEntity(node: ScanActionableInput, context: ScanEntityContext): BuiltEntity {
	const selector = stringValue(node.sourceSelector);
	const role = stringValue(node.sourceRole) || "generic";
	const name = stringValue(node.sourceName);
	const locators: Locator[] = selector ? [{ by: "css", value: selector }] : [];
	const kind = referencedTargetKind(role);
	const controlsSelectors = stringArray(node.controlsSelectors);
	const ownsSelectors = stringArray(node.ownsSelectors);
	const expandedTargetSelectors = stringArray(node.expandedTargetSelectors);
	const entity: Omit<Entity, "ref"> = {
		kind,
		role,
		...(name ? { name } : {}),
		state: { visible: false, occluded: false, disabled: false, focused: false, editable: false, inViewport: false },
		source: "dom",
		locators,
		hints: {
			...(selector ? { selector } : {}),
			controlsSourceOnly: true,
			...(controlsSelectors ? { controlsSelectors } : {}),
			...(ownsSelectors ? { ownsSelectors } : {}),
			...(expandedTargetSelectors ? { expandedTargetSelectors } : {}),
		},
	};
	const capturedAt = context.capturedAt;
	const origin = memoizedUrlOrigin(context.url);
	return {
		entity,
		descriptor: {
			kind,
			locators,
			owner: {
				...(context.browserSessionId ? { browserSessionId: context.browserSessionId } : {}),
				...(context.tabId !== undefined ? { tabId: context.tabId } : {}),
				...(origin ? { topLevelOrigin: origin } : {}),
			},
			policy: defaultRefPolicyForKind(kind),
			semantic: { role, ...(name ? { name } : {}) },
			observationId: context.observationId,
			documentEpoch: documentEpoch(context),
			createdAt: capturedAt,
			ttlMs: 5 * 60 * 1000,
			stabilityScore: 0.4,
		},
	};
}

// A minimal entity for an element referenced by aria-controls/aria-owns (the relation target). It
// is emitted even when hidden/collapsed — that is exactly the case the AX tree drops — so the
// controls/owns/expandedTarget relation can resolve to a ref. Deduped by selector against scanned
// actionables, so a visible target that is also scanned collapses to one entity.
export function buildReferencedTargetEntity(node: ScanActionableInput, context: ScanEntityContext): BuiltEntity {
	const selector = stringValue(node.selector);
	const role = stringValue(node.role) || "generic";
	const name = stringValue(node.name);
	const kind = referencedTargetKind(role);
	const locators: Locator[] = selector ? [{ by: "css", value: selector }] : [];
	const hidden = node.hidden === true;
	const entity: Omit<Entity, "ref"> = {
		kind,
		role,
		...(name ? { name } : {}),
		state: { visible: !hidden, occluded: false, disabled: false, focused: false, editable: false, inViewport: !hidden },
		source: "dom",
		locators,
		hints: { ...(selector ? { selector } : {}), referencedTarget: true, ...(hidden ? { hidden: true } : {}) },
	};
	const capturedAt = context.capturedAt;
	const origin = memoizedUrlOrigin(context.url);
	return {
		entity,
		descriptor: {
			kind,
			locators,
			owner: {
				...(context.browserSessionId ? { browserSessionId: context.browserSessionId } : {}),
				...(context.tabId !== undefined ? { tabId: context.tabId } : {}),
				...(origin ? { topLevelOrigin: origin } : {}),
			},
			policy: defaultRefPolicyForKind(kind),
			semantic: { role, ...(name ? { name } : {}) },
			observationId: context.observationId,
			documentEpoch: documentEpoch(context),
			createdAt: capturedAt,
			ttlMs: 5 * 60 * 1000,
			stabilityScore: 0.5,
		},
	};
}

export function buildVisionRegionFromCanvasActionable(node: ScanVisionInput, context: ScanEntityContext): BuiltEntity {
	const geometry = {
		...(geometryFromRect(node.rect) || {}),
		...(geometryPoint(node.point) || {}),
	};
	const point = geometryCenter(geometry);
	const inViewport = node.inViewport !== false && Boolean(point || geometry.box);
	const locators: Locator[] = point && inViewport ? [{ by: "point", x: point.x, y: point.y }] : [];
	const name = stringValue(node.action) || stringValue(node.label) || stringValue(node.text) || stringValue(node.selector) || "canvas region";
	const entity: Omit<Entity, "ref"> = {
		kind: "region",
		role: "region",
		name,
		state: {
			visible: node.visible !== false && Boolean(geometry.box || point),
			occluded: node.hitOk === false,
			disabled: false,
			focused: false,
			editable: false,
			inViewport,
		},
		...(node.clickable === true ? { actionability: { actions: ["click"], hint: name, confidence: "medium" } } : {}),
		source: "dom",
		locators,
		...(Object.keys(geometry).length ? { geometry } : {}),
		hints: {
			visualFloor: true,
			visualSurface: true,
			canvasRegion: true,
			jsonPath: `data.structure.actionables[${Number(node.index ?? 0)}]`,
			selector: stringValue(node.selector),
		},
	};
	const capturedAt = context.capturedAt;
	const origin = memoizedUrlOrigin(context.url);
	return {
		entity,
		descriptor: {
			kind: "region",
			locators,
			owner: {
				...(context.browserSessionId ? { browserSessionId: context.browserSessionId } : {}),
				...(context.tabId !== undefined ? { tabId: context.tabId } : {}),
				...(origin ? { topLevelOrigin: origin } : {}),
			},
			policy: defaultRefPolicyForKind("region"),
			semantic: { role: "region", name },
			...(Object.keys(geometry).length ? { geometry } : {}),
			observationId: context.observationId,
			documentEpoch: documentEpoch(context),
			createdAt: capturedAt,
			ttlMs: 5 * 60 * 1000,
			stabilityScore: 0.25,
		},
	};
}

export function withRegisteredRef(entity: Omit<Entity, "ref">, refId: string): Entity {
	return { ...entity, ref: refId };
}

export function dedupeEntities<T extends { kind?: unknown; hints?: { selector?: unknown; jsonPath?: unknown; listContainer?: unknown }; locators?: Locator[] }>(entities: T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const entity of entities) {
		const selector = stringValue(entity.hints?.selector);
		const jsonPath = stringValue(entity.hints?.jsonPath);
		const locatorKey = Array.isArray(entity.locators) ? JSON.stringify(entity.locators) : "";
		const preferSelector = entity.kind === "region" || entity.hints?.listContainer === true;
		const key = preferSelector ? (selector || locatorKey || jsonPath) : (selector || jsonPath || locatorKey);
		if (key && seen.has(key)) continue;
		if (key) seen.add(key);
		out.push(entity);
	}
	return out;
}
