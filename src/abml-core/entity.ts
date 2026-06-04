import { defaultRefPolicyForKind } from "./refPolicy.js";
import type { Locator, RefDescriptor, RefKind } from "./types.js";
import { isRecord } from "../utils/records.js";

export type EntityKind = Extract<RefKind, "element" | "control" | "text" | "region" | "media" | "frame" | "network-entry" | "event" | "signal">;
export type EntitySource = "dom" | "ax" | "vision" | "network" | "hook" | "evidence";

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

// ABML R1 — relationship graph. A typed edge from this entity to another entity (by ref).
// Reuses AX relations/properties (labelledby/describedby/controls/owns), table hierarchy
// (cell→row→table), and aria-current. `targetRef` is always a materialized pi-ref://; the
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
	// ABML R3.x P1 — control → network request fired in the post-action delta window. Target is a
	// `pi-ref://network/<id>` (resolvable inline in envelope.causal.requests, not an entity). Causal
	// attribution is timing-only (source "timing", low confidence): the request fired after the
	// activated control, NOT a parsed initiator-stack proof. See abml-core/causal.ts.
	| "triggered";

export type EntityRelation = {
	type: RelationType;
	targetRef: string;
	source: "ax" | "dom" | "geometry" | "timing";
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
	structure?: EntityStructure;
	relations?: EntityRelation[];
	source: EntitySource;
	locators?: Locator[];
	geometry?: { box?: { x: number; y: number; w: number; h: number }; point?: { x: number; y: number } };
	stream?: { at: number; method?: string; url?: string; status?: number; eventType?: string; phase?: string; payloadHandle?: string };
	children?: Entity[] | { handle: string; count: number };
	hints?: { listContainer?: boolean; hiddenCount?: number; jsonPath?: string; selector?: string; [key: string]: unknown };
};

export type ScanEntityContext = {
	browserSessionId?: string;
	tabId?: number;
	url?: string;
	observationId: string;
	capturedAt?: number;
};

export type BuiltEntity = {
	entity: Omit<Entity, "ref">;
	descriptor: Omit<RefDescriptor, "refId">;
};

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text : undefined;
}

function numberValue(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
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

function topLevelOrigin(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

function dedupeLocators(locators: Locator[]): Locator[] {
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

function actionEntityKind(node: Record<string, unknown>): EntityKind {
	const tag = stringValue(node.tag)?.toLowerCase();
	const role = stringValue(node.role)?.toLowerCase();
	if (node.editable === true) return "control";
	if (["button", "link", "checkbox", "radio", "switch", "tab", "combobox", "option"].includes(role || "")) return "control";
	if (["button", "a", "input", "textarea", "select"].includes(tag || "")) return "control";
	return "element";
}

function actionEntityState(node: Record<string, unknown>): EntityState {
	const rect = geometryFromRect(node.rect)?.box;
	const point = geometryPoint(node.point)?.point;
	// aria-current (scan-sourced): Chrome's AX tree doesn't expose it, so the DOM scan is the
	// authoritative source. Normalize the token ("false" → not current, "true" → boolean, else
	// the token e.g. "page"/"step"). This also backfills the P1 state.current path on real pages.
	const currentRaw = typeof node.current === "string" ? node.current.trim() : undefined;
	const current = currentRaw === undefined || currentRaw === "" ? undefined : currentRaw === "false" ? false : currentRaw === "true" ? true : currentRaw;
	return {
		visible: node.visible !== false && Boolean(rect || point || node.hitOk !== undefined),
		occluded: node.hitOk === false,
		disabled: node.disabled === true,
		focused: node.focused === true,
		...(typeof node.checked === "boolean" ? { checked: node.checked } : {}),
		...(typeof node.expanded === "boolean" ? { expanded: node.expanded } : {}),
		...(current !== undefined && current !== false ? { current } : {}),
		editable: node.editable === true,
		inViewport: node.inViewport !== false && Boolean(point || rect),
	};
}

export function buildActionableLocators(node: Record<string, unknown>): Locator[] {
	const locators: Locator[] = [];
	const selector = stringValue(node.selector);
	const role = stringValue(node.role) || roleForTag(stringValue(node.tag));
	const name = stringValue(node.action) || stringValue(node.label) || stringValue(node.text);
	const point = geometryPoint(node.point)?.point;
	if (selector) locators.push({ by: "css", value: selector });
	if (name) locators.push({ by: "textAnchor", value: name, ...(role ? { role } : {}), exact: false });
	if (point) locators.push({ by: "point", x: point.x, y: point.y });
	return dedupeLocators(locators);
}

export function buildListHintLocators(node: Record<string, unknown>): Locator[] {
	const locators: Locator[] = [];
	const selector = stringValue(node.selector);
	const sample = stringValue(node.firstItemPreview);
	if (selector) locators.push({ by: "css", value: selector });
	if (sample) locators.push({ by: "textAnchor", value: sample, role: "list", exact: false });
	return dedupeLocators(locators);
}

export function buildDomEntityFromScanActionable(node: Record<string, unknown>, context: ScanEntityContext): BuiltEntity {
	const kind = actionEntityKind(node);
	const role = stringValue(node.role) || roleForTag(stringValue(node.tag));
	const locators = buildActionableLocators(node);
	const geometry = {
		...(geometryFromRect(node.rect) || {}),
		...(geometryPoint(node.point) || {}),
	};
	const name = stringValue(node.action) || stringValue(node.label) || stringValue(node.text);
	const value = node.editable === true ? undefined : stringValue(node.value);
	const entity: Omit<Entity, "ref"> = {
		kind,
		role,
		...(name ? { name } : {}),
		...(value ? { value } : {}),
		state: actionEntityState(node),
		source: "dom",
		locators,
		...(Object.keys(geometry).length ? { geometry } : {}),
		hints: {
			jsonPath: `data.actionables[${Number(node.index ?? 0)}]`,
			selector: stringValue(node.selector),
			...(Array.isArray(node.handlers) && node.handlers.length ? { handlers: node.handlers } : {}),
			// The element stacked on top at our center point when the hit-test failed — the occluder.
			// Resolved to an entity ref (coveredBy/occludes) in relation derivation; harmless if unresolved.
			...(node.hitOk === false && stringValue(node.occluderSelector) ? { occluderSelector: stringValue(node.occluderSelector) } : {}),
			// aria-controls / aria-owns / expanded target selectors (DOM-sourced so they resolve even when
			// the target is collapsed/hidden — the AX tree omits those). Materialized by selector.
			...(Array.isArray(node.controlsSelectors) && node.controlsSelectors.length ? { controlsSelectors: node.controlsSelectors } : {}),
			...(Array.isArray(node.ownsSelectors) && node.ownsSelectors.length ? { ownsSelectors: node.ownsSelectors } : {}),
			...(Array.isArray(node.expandedTargetSelectors) && node.expandedTargetSelectors.length ? { expandedTargetSelectors: node.expandedTargetSelectors } : {}),
			// HTML input type (e.g. "password", "search", "email") — DOM-sourced for R2 intent
			// detection. AX tree doesn't distinguish input types beyond role (textbox/searchbox).
			...(stringValue(node.inputKind) ? { inputKind: stringValue(node.inputKind) } : {}),
		},
	};
	const capturedAt = context.capturedAt ?? Date.now();
	return {
		entity,
		descriptor: {
			kind,
			locators,
			owner: {
				...(context.browserSessionId ? { browserSessionId: context.browserSessionId } : {}),
				...(context.tabId !== undefined ? { tabId: context.tabId } : {}),
				...(topLevelOrigin(context.url) ? { topLevelOrigin: topLevelOrigin(context.url) } : {}),
			},
			policy: defaultRefPolicyForKind(kind),
			semantic: {
				role,
				...(name ? { name } : {}),
			},
			...(Object.keys(geometry).length ? { geometry } : {}),
			observationId: context.observationId,
			documentEpoch: {
				url: context.url,
				capturedAt,
			},
			createdAt: capturedAt,
			ttlMs: 5 * 60 * 1000,
			stabilityScore: node.hitOk === true ? 0.9 : node.hitOk === false ? 0.4 : 0.6,
		},
	};
}

export function buildRegionEntityFromListHint(node: Record<string, unknown>, context: ScanEntityContext, index: number): BuiltEntity {
	const locators = buildListHintLocators(node);
	const name = stringValue(node.firstItemPreview) || stringValue(node.selector) || `list-${index}`;
	const hiddenCount = numberValue(node.hiddenCount);
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
			...(hiddenCount !== undefined ? { hiddenCount } : {}),
			jsonPath: `data.list_hints[${index}]`,
			selector: stringValue(node.selector),
		},
	};
	const capturedAt = context.capturedAt ?? Date.now();
	return {
		entity,
		descriptor: {
			kind: "region",
			locators,
			owner: {
				...(context.browserSessionId ? { browserSessionId: context.browserSessionId } : {}),
				...(context.tabId !== undefined ? { tabId: context.tabId } : {}),
				...(topLevelOrigin(context.url) ? { topLevelOrigin: topLevelOrigin(context.url) } : {}),
			},
			policy: defaultRefPolicyForKind("region"),
			semantic: { role: "list", name },
			observationId: context.observationId,
			documentEpoch: {
				url: context.url,
				capturedAt,
			},
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
// is not in the actionable list (e.g. scrolled off-screen). Built from the controls_pairs scan
// data; selector-keyed so it dedupes against an existing actionable if one is present.
export function buildControlsSourceEntity(node: Record<string, unknown>, context: ScanEntityContext): BuiltEntity {
	const selector = stringValue(node.sourceSelector);
	const role = stringValue(node.sourceRole) || "generic";
	const name = stringValue(node.sourceName);
	const locators: Locator[] = selector ? [{ by: "css", value: selector }] : [];
	const kind = referencedTargetKind(role);
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
			...(Array.isArray(node.controlsSelectors) && node.controlsSelectors.length ? { controlsSelectors: node.controlsSelectors } : {}),
			...(Array.isArray(node.ownsSelectors) && node.ownsSelectors.length ? { ownsSelectors: node.ownsSelectors } : {}),
			...(Array.isArray(node.expandedTargetSelectors) && node.expandedTargetSelectors.length ? { expandedTargetSelectors: node.expandedTargetSelectors } : {}),
		},
	};
	const capturedAt = context.capturedAt ?? Date.now();
	return {
		entity,
		descriptor: {
			kind,
			locators,
			owner: {
				...(context.browserSessionId ? { browserSessionId: context.browserSessionId } : {}),
				...(context.tabId !== undefined ? { tabId: context.tabId } : {}),
				...(topLevelOrigin(context.url) ? { topLevelOrigin: topLevelOrigin(context.url) } : {}),
			},
			policy: defaultRefPolicyForKind(kind),
			semantic: { role, ...(name ? { name } : {}) },
			observationId: context.observationId,
			documentEpoch: { url: context.url, capturedAt },
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
export function buildReferencedTargetEntity(node: Record<string, unknown>, context: ScanEntityContext): BuiltEntity {
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
	const capturedAt = context.capturedAt ?? Date.now();
	return {
		entity,
		descriptor: {
			kind,
			locators,
			owner: {
				...(context.browserSessionId ? { browserSessionId: context.browserSessionId } : {}),
				...(context.tabId !== undefined ? { tabId: context.tabId } : {}),
				...(topLevelOrigin(context.url) ? { topLevelOrigin: topLevelOrigin(context.url) } : {}),
			},
			policy: defaultRefPolicyForKind(kind),
			semantic: { role, ...(name ? { name } : {}) },
			observationId: context.observationId,
			documentEpoch: { url: context.url, capturedAt },
			createdAt: capturedAt,
			ttlMs: 5 * 60 * 1000,
			stabilityScore: 0.5,
		},
	};
}

export function buildVisionRegionFromCanvasActionable(node: Record<string, unknown>, context: ScanEntityContext): BuiltEntity {
	const geometry = {
		...(geometryFromRect(node.rect) || {}),
		...(geometryPoint(node.point) || {}),
	};
	const point = geometryCenter(geometry);
	const locators: Locator[] = point ? [{ by: "point", x: point.x, y: point.y }] : [];
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
			inViewport: Boolean(point || geometry.box),
		},
		source: "vision",
		locators,
		...(Object.keys(geometry).length ? { geometry } : {}),
		hints: {
			visualFloor: true,
			canvasRegion: true,
			jsonPath: `data.actionables[${Number(node.index ?? 0)}]`,
			selector: stringValue(node.selector),
		},
	};
	const capturedAt = context.capturedAt ?? Date.now();
	return {
		entity,
		descriptor: {
			kind: "region",
			locators,
			owner: {
				...(context.browserSessionId ? { browserSessionId: context.browserSessionId } : {}),
				...(context.tabId !== undefined ? { tabId: context.tabId } : {}),
				...(topLevelOrigin(context.url) ? { topLevelOrigin: topLevelOrigin(context.url) } : {}),
			},
			policy: defaultRefPolicyForKind("region"),
			semantic: { role: "region", name },
			...(Object.keys(geometry).length ? { geometry } : {}),
			observationId: context.observationId,
			documentEpoch: {
				url: context.url,
				capturedAt,
			},
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
