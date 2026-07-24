import { defaultRefPolicyForKind } from "../refs/refPolicy.js";
import { finiteNumber as numberValue, nonEmptyString as stringValue, recordValue as asRecord } from "../../utils/records.js";
import { memoizedUrlOrigin } from "../../utils/url.js";
import { dedupeLocators } from "./entity.js";
import type { BuiltEntity, Entity, EntityKind, EntityState, EntityStructure, RelationType } from "./entity.js";
import type { Locator } from "./types.js";
import { sanitizeSemanticText } from "./semanticText.js";
import { buildBoundedSpatialIndex, queryBoundedSpatialIndex, type BoundedSpatialIndex } from "./spatialIndex.js";
import { backendNodeKey, cleanTargetId } from "./nodeKey.js";

export type AxTreeNode = Record<string, unknown>;
export type AxContext = {
	browserSessionId?: string;
	tabId?: number;
	targetId?: string;
	targetGeneration?: number;
	pageEpoch?: string;
	url?: string;
	observationId: string;
	capturedAt: number;
	viewport?: { width: number; height: number };
};

type AxPropertyMap = Map<string, unknown>;
type EntityMatchInfo = {
	name?: string;
	role: string;
	point?: { x: number; y: number };
	box?: { x: number; y: number; w: number; h: number };
	targetId?: string;
};

type SemanticRoleCandidates = {
	all: Set<number>;
	unnamed: Set<number>;
	byName: Map<string, Set<number>>;
	withoutPoint: Set<number>;
	unnamedWithoutPoint: Set<number>;
	withoutPointByName: Map<string, Set<number>>;
};

type DomMatchIndex = {
	byBackendNodeId: Map<number, Set<number>>;
	byBackendNodeKey: Map<string, Set<number>>;
	boxes: BoundedSpatialIndex<number>;
	points: BoundedSpatialIndex<number>;
	byRole: Map<string, SemanticRoleCandidates>;
};

type ScoredMatch = { index: number; score: number; count: number };

export type AxFusionDiagnostics = {
	scanBacked: number;
	axEnriched: number;
	axOnly: number;
	matched: { backend: number; geometry: number; semantic: number };
	degraded: boolean;
	skipped: {
		ambiguousBackend: number;
		ambiguousGeometry: number;
		ambiguousSemantic: number;
		targetScopeMismatch: number;
		unsafeSemantic: number;
	};
};

export type AxFusionResult = {
	merged: Entity[];
	unmatchedAx: BuiltEntity[];
	diagnostics: AxFusionDiagnostics;
};

function emptyFusionDiagnostics(scanBacked: number): AxFusionDiagnostics {
	return {
		scanBacked,
		axEnriched: 0,
		axOnly: 0,
		matched: { backend: 0, geometry: 0, semantic: 0 },
		degraded: false,
		skipped: {
			ambiguousBackend: 0,
			ambiguousGeometry: 0,
			ambiguousSemantic: 0,
			targetScopeMismatch: 0,
			unsafeSemantic: 0,
		},
	};
}

const CONTROL_AX_ROLES = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "tab", "listbox", "menuitem", "option", "slider", "spinbutton"]);
const TEXT_AX_ROLES = new Set(["statictext", "text", "labeltext", "heading"]);
const MEDIA_AX_ROLES = new Set(["image", "img"]);
const FRAME_AX_ROLES = new Set(["iframe", "frame", "webarea", "rootwebarea"]);
const BORING_AX_ROLES = new Set(["rootwebarea", "none", "generic", "group", "pane", "section", "paragraph", "listitemmarker", "inlinetextbox"]);
const EDITABLE_AX_ROLES = new Set(["textbox", "searchbox", "combobox", "textarea", "spinbutton"]);
const LANDMARK_ROLES = new Set(["banner", "navigation", "main", "complementary", "contentinfo", "search", "form", "region"]);
const AX_AUTHORITATIVE_STATE = ["checked", "selected", "pressed", "expanded"] as const;
const GEOMETRY_MATCH_RADIUS_PX = 24;
const COINCIDENT_BOX_IOU = 0.8;
const AX_GEOMETRY_BUCKET_SIZE = 64;
const MAX_AX_GEOMETRY_BUCKETS_PER_RECT = 256;

function boolValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function axValueText(value: unknown): string | undefined {
	if (typeof value === "string") return stringValue(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	const record = asRecord(value);
	if (!record) return undefined;
	return axValueText(record.value) || axValueText(record.text) || axValueText(record.name);
}

function axPropertyMap(node: AxTreeNode): AxPropertyMap {
	const props = Array.isArray(node.properties) ? node.properties : [];
	const out = new Map<string, unknown>();
	for (const item of props) {
		const record = asRecord(item);
		const name = record && stringValue(record.name);
		if (name) out.set(name, record?.value);
	}
	return out;
}

function axPropertyFromMap(propertyMap: AxPropertyMap | undefined, propertyName: string): unknown {
	return propertyMap?.get(propertyName);
}

function axProperty(node: AxTreeNode, propertyName: string, propertyMap?: AxPropertyMap): unknown {
	if (propertyMap) return axPropertyFromMap(propertyMap, propertyName);
	const props = Array.isArray(node.properties) ? node.properties : [];
	const hit = props.find((item) => {
		const record = asRecord(item);
		return record && String(record.name || "") === propertyName;
	});
	const record = asRecord(hit);
	return record?.value;
}

function axPropertyBool(node: AxTreeNode, propertyName: string, propertyMap?: AxPropertyMap): boolean | undefined {
	const value = axProperty(node, propertyName, propertyMap);
	const text = axValueText(value);
	if (text === "true") return true;
	if (text === "false") return false;
	return boolValue(asRecord(value)?.value ?? value);
}

function safeAxSemanticText(value: unknown): string | undefined {
	return sanitizeSemanticText(value, 160);
}

export function axRole(node: AxTreeNode): string {
	return safeAxSemanticText(axValueText(node.role)) || "generic";
}

export function axName(node: AxTreeNode): string | undefined {
	return safeAxSemanticText(axValueText(node.name));
}

export function axValue(node: AxTreeNode, propertyMap?: AxPropertyMap): string | undefined {
	return safeAxSemanticText(
		axValueText(node.value)
		|| axValueText(axProperty(node, "value", propertyMap))
		|| axValueText(axProperty(node, "valuetext", propertyMap))
		|| axValueText(axProperty(node, "valuenow", propertyMap)),
	);
}

export function axNodeId(node: AxTreeNode): string | undefined {
	return stringValue(node.nodeId) || stringValue(node.axNodeId) || stringValue(node.id);
}

export function axBackendNodeId(node: AxTreeNode): number | undefined {
	return numberValue(node.backendDOMNodeId) ?? numberValue(node.backendNodeId);
}

function kindForAxRole(role: string): EntityKind {
	const normalized = role.toLowerCase();
	if (CONTROL_AX_ROLES.has(normalized)) return "control";
	if (TEXT_AX_ROLES.has(normalized)) return "text";
	if (MEDIA_AX_ROLES.has(normalized)) return "media";
	if (FRAME_AX_ROLES.has(normalized)) return "frame";
	return "element";
}

export function isInterestingAxNode(node: AxTreeNode): boolean {
	if (node.ignored === true) return false;
	const role = axRole(node).toLowerCase();
	const name = axName(node);
	if (BORING_AX_ROLES.has(role)) return Boolean(name || axValue(node));
	if (kindForAxRole(role) !== "element") return true;
	return Boolean(name || axValue(node) || axBackendNodeId(node));
}

export function buildAxLocators(node: AxTreeNode, propertyMap?: AxPropertyMap, targetId?: string): Locator[] {
	const locators: Locator[] = [];
	const nodeId = axNodeId(node);
	const backendNodeId = axBackendNodeId(node);
	const role = axRole(node);
	const name = axName(node) || axValue(node, propertyMap);
	if (backendNodeId !== undefined && backendNodeId > 0) locators.push({ by: "backendNodeId", value: backendNodeId, ...(targetId ? { targetId } : {}) });
	if (nodeId) locators.push({ by: "axNodeId", value: nodeId });
	if (name) locators.push({ by: "textAnchor", value: name, role, exact: false });
	return dedupeLocators(locators);
}

export function boxModelToGeometry(model: unknown): { box?: { x: number; y: number; w: number; h: number }; point?: { x: number; y: number } } | undefined {
	const record = asRecord(model);
	if (!record) return undefined;
	const border = Array.isArray(record.border) ? record.border.map((item) => Number(item)) : [];
	if (border.length < 8 || border.some((item) => !Number.isFinite(item))) return undefined;
	const xs = [border[0], border[2], border[4], border[6]];
	const ys = [border[1], border[3], border[5], border[7]];
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const w = Math.max(0, maxX - minX);
	const h = Math.max(0, maxY - minY);
	return {
		box: { x: Math.round(minX), y: Math.round(minY), w: Math.round(w), h: Math.round(h) },
		point: { x: Math.round(minX + w / 2), y: Math.round(minY + h / 2) },
	};
}

function axStructure(node: AxTreeNode, role: string, propertyMap?: AxPropertyMap): EntityStructure | undefined {
	const level = numberValue(axValueText(axProperty(node, "level", propertyMap)));
	const setSize = numberValue(axValueText(axProperty(node, "setsize", propertyMap)));
	const posInSet = numberValue(axValueText(axProperty(node, "posinset", propertyMap)));
	const sortText = axValueText(axProperty(node, "sort", propertyMap));
	const colIndex = numberValue(axValueText(axProperty(node, "colindex", propertyMap)));
	const rowIndex = numberValue(axValueText(axProperty(node, "rowindex", propertyMap)));
	const landmark = LANDMARK_ROLES.has(role.toLowerCase()) ? role.toLowerCase() : undefined;
	if (
		level === undefined
		&& setSize === undefined
		&& posInSet === undefined
		&& (!sortText || sortText === "none")
		&& colIndex === undefined
		&& rowIndex === undefined
		&& landmark === undefined
	) return undefined;
	return {
		...(level !== undefined ? { level } : {}),
		...(setSize !== undefined ? { setSize } : {}),
		...(posInSet !== undefined ? { posInSet } : {}),
		...(sortText && sortText !== "none" ? { sort: sortText } : {}),
		...(colIndex !== undefined ? { colIndex } : {}),
		...(rowIndex !== undefined ? { rowIndex } : {}),
		...(landmark ? { landmark } : {}),
	};
}

function geometryInViewport(geometry: Parameters<typeof buildAxEntityFromNode>[2], viewport: AxContext["viewport"]): boolean {
	if (!geometry || !viewport || viewport.width <= 0 || viewport.height <= 0) return false;
	if (geometry.box) {
		const box = geometry.box;
		return box.w > 0 && box.h > 0 && box.x + box.w > 0 && box.y + box.h > 0 && box.x < viewport.width && box.y < viewport.height;
	}
	const point = geometry.point;
	return Boolean(point && point.x >= 0 && point.y >= 0 && point.x < viewport.width && point.y < viewport.height);
}

function axRelatedBackendIds(node: AxTreeNode, propertyName: string, propertyMap?: AxPropertyMap): number[] {
	const value = axProperty(node, propertyName, propertyMap);
	const record = asRecord(value);
	const related = record && Array.isArray(record.relatedNodes) ? record.relatedNodes : Array.isArray(value) ? value : [];
	const ids: number[] = [];
	for (const item of related) {
		const rec = asRecord(item);
		const id = numberValue(rec?.backendDOMNodeId ?? rec?.backendNodeId);
		if (id !== undefined && id > 0) ids.push(id);
	}
	return ids;
}

export type AxRelationAnchor = { type: RelationType; targetKey: string };

export function extractAxPropertyRelationAnchors(node: AxTreeNode, propertyMap?: AxPropertyMap): AxRelationAnchor[] {
	const out: AxRelationAnchor[] = [];
	const propertyTypes: Array<[string, RelationType]> = [
		["labelledby", "labelledBy"],
		["describedby", "describedBy"],
		["controls", "controls"],
		["owns", "owns"],
	];
	for (const [property, type] of propertyTypes) {
		for (const id of axRelatedBackendIds(node, property, propertyMap)) out.push({ type, targetKey: `b:${id}` });
	}
	if (axPropertyBool(node, "expanded", propertyMap) !== undefined) {
		for (const id of axRelatedBackendIds(node, "controls", propertyMap)) out.push({ type: "expandedTarget", targetKey: `b:${id}` });
	}
	return out;
}

export function buildAxEntityFromNode(node: AxTreeNode, context: AxContext, geometry?: { box?: { x: number; y: number; w: number; h: number }; point?: { x: number; y: number } }, options: { redactValue?: boolean } = {}): BuiltEntity {
	const role = axRole(node);
	const roleLower = role.toLowerCase();
	const targetId = cleanTargetId(context.targetId);
	const backendNodeId = axBackendNodeId(node);
	const propertyMap = axPropertyMap(node);
	const origin = memoizedUrlOrigin(context.url);
	const structure = axStructure(node, role, propertyMap);
	const rawName = axValueText(node.name);
	const rawValue = axValueText(node.value)
		|| axValueText(axProperty(node, "value", propertyMap))
		|| axValueText(axProperty(node, "valuetext", propertyMap))
		|| axValueText(axProperty(node, "valuenow", propertyMap));
	const name = safeAxSemanticText(rawName);
	const value = options.redactValue ? undefined : safeAxSemanticText(rawValue);
	const kind = kindForAxRole(role);
	const locators = buildAxLocators(node, propertyMap, targetId);
	const capturedAt = context.capturedAt;
	const disabled = axPropertyBool(node, "disabled", propertyMap) === true || axPropertyBool(node, "aria-disabled", propertyMap) === true;
	const focused = axPropertyBool(node, "focused", propertyMap) === true;
	const expanded = axPropertyBool(node, "expanded", propertyMap);
	const checked = axPropertyBool(node, "checked", propertyMap);
	const selected = axPropertyBool(node, "selected", propertyMap);
	const pressed = axPropertyBool(node, "pressed", propertyMap);
	const currentText = axValueText(axProperty(node, "current", propertyMap));
	const current = currentText === undefined ? undefined : currentText === "false" ? false : currentText === "true" ? true : currentText;
	const inViewport = geometryInViewport(geometry, context.viewport);
	const state = {
		visible: node.hidden !== true && node.invisible !== true,
		occluded: false,
		disabled,
		focused,
		...(typeof checked === "boolean" ? { checked } : {}),
		...(typeof selected === "boolean" ? { selected } : {}),
		...(typeof pressed === "boolean" ? { pressed } : {}),
		...(typeof expanded === "boolean" ? { expanded } : {}),
		...(current !== undefined && current !== false ? { current } : {}),
		editable: EDITABLE_AX_ROLES.has(roleLower),
		inViewport,
	};
	const executable = backendNodeId !== undefined && backendNodeId > 0;
	const actions = [executable && CONTROL_AX_ROLES.has(roleLower) ? "click" as const : undefined, executable && EDITABLE_AX_ROLES.has(roleLower) ? "edit" as const : undefined]
		.filter((action): action is "click" | "edit" => action !== undefined);
	return {
		entity: {
			kind,
			role,
			...(name ? { name } : {}),
			...(value ? { value } : {}),
			state,
			...(actions.length ? { actionability: { actions, confidence: "medium" } } : {}),
			...(structure ? { structure } : {}),
			source: "ax",
			locators,
			...(geometry ? { geometry } : {}),
			hints: {
				axNodeId: axNodeId(node),
				backendNodeId,
				...(targetId ? { targetId } : {}),
				...(rawName && !name ? { unsafeNameSkipped: true } : {}),
				...(rawValue && options.redactValue ? { valueRedacted: true } : {}),
				...(rawValue && !options.redactValue && !value ? { unsafeValueSkipped: true } : {}),
				physicalStateConfidence: { visible: "medium", occluded: "low", inViewport: context.viewport ? "high" : "low" },
			},
		},
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
			semantic: { role, ...(name ? { name } : {}), ...(value ? { value } : {}) },
			...(geometry ? { geometry } : {}),
			observationId: context.observationId,
			documentEpoch: {
				...(context.targetGeneration ? { targetGeneration: context.targetGeneration } : {}),
				...(context.pageEpoch ? { pageEpoch: context.pageEpoch } : {}),
				url: context.url,
				capturedAt,
			},
			createdAt: capturedAt,
			ttlMs: 5 * 60 * 1000,
			stabilityScore: 0.65,
		},
	};
}

function entityName(entity: Entity | BuiltEntity["entity"]): string | undefined {
	return typeof entity.name === "string" && entity.name.trim() ? entity.name.trim().toLowerCase() : undefined;
}

function entityRole(entity: Entity | BuiltEntity["entity"]): string {
	return String(entity.role || "generic").trim().toLowerCase();
}

function entityPoint(entity: Entity | BuiltEntity["entity"]): { x: number; y: number } | undefined {
	return entity.geometry?.point;
}

function entityBox(entity: Entity | BuiltEntity["entity"]): { x: number; y: number; w: number; h: number } | undefined {
	return entity.geometry?.box;
}

function buildEntityMatchInfo(entity: Entity | BuiltEntity["entity"]): EntityMatchInfo {
	const identity = entityBackendNodeIdentity(entity);
	return {
		name: entityName(entity),
		role: entityRole(entity),
		point: entityPoint(entity),
		box: entityBox(entity),
		targetId: identity?.targetId ?? cleanTargetId(entity.hints?.targetId ?? entity.hints?.cdpTargetId),
	};
}

function entityBackendNodeIdentity(entity: Entity | BuiltEntity["entity"]): { backendNodeId: number; targetId?: string } | undefined {
	const hintedTargetId = cleanTargetId(entity.hints?.targetId ?? entity.hints?.cdpTargetId);
	const hinted = numberValue(entity.hints?.backendNodeId);
	const locator = entity.locators?.find((item) => item.by === "backendNodeId");
	if (locator?.by === "backendNodeId" && locator.value > 0) {
		return { backendNodeId: locator.value, targetId: cleanTargetId(locator.targetId) ?? hintedTargetId };
	}
	return hinted !== undefined && hinted > 0 ? { backendNodeId: hinted, ...(hintedTargetId ? { targetId: hintedTargetId } : {}) } : undefined;
}

function entityBackendNodeId(entity: Entity | BuiltEntity["entity"]): number | undefined {
	return entityBackendNodeIdentity(entity)?.backendNodeId;
}

export type AxFusionMatch = { tier: "backend" | "geometry" | "semantic"; confidence: "high" | "medium" };

function sameSemanticValue(left: unknown, right: unknown): boolean {
	return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
}

function pointDistance(a?: { x: number; y: number }, b?: { x: number; y: number }): number | undefined {
	if (!a || !b) return undefined;
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function mergeKnownDomAndAxEntity(base: Entity, ax: BuiltEntity["entity"], match: AxFusionMatch = { tier: "backend", confidence: "high" }): Entity {
	const mergedState: EntityState = { ...base.state };
	const stateSource: Record<string, "ax"> = {};
	const conflicts: string[] = [];
	const trustedIdentity = match.tier === "backend";
	const axActionability = trustedIdentity ? ax.actionability : undefined;
	const actions = [...new Set([...(base.actionability?.actions ?? []), ...(axActionability?.actions ?? [])])];
	const actionability = actions.length ? {
		actions,
		...(base.actionability?.hint || axActionability?.hint ? { hint: base.actionability?.hint ?? axActionability?.hint } : {}),
		confidence: base.actionability?.confidence === "high" || axActionability?.confidence === "high" ? "high" as const : "medium" as const,
	} : undefined;
	for (const key of AX_AUTHORITATIVE_STATE) {
		const axStateValue = (ax.state as Record<string, unknown>)[key];
		if (axStateValue !== undefined) {
			const baseStateValue = (base.state as Record<string, unknown>)[key];
			if (baseStateValue !== undefined && baseStateValue !== axStateValue) conflicts.push(`state.${key}`);
			(mergedState as Record<string, unknown>)[key] = axStateValue;
			stateSource[key] = "ax";
		}
	}
	const role = ax.role && ax.role !== "generic" ? ax.role : base.role;
	const name = ax.name || base.name;
	const password = base.hints?.inputKind === "password";
	const value = password ? base.value : ax.value ?? base.value;
	if (ax.role && ax.role !== "generic" && !sameSemanticValue(base.role, ax.role)) conflicts.push("role");
	if (base.name && ax.name && !sameSemanticValue(base.name, ax.name)) conflicts.push("name");
	if (!password && base.value !== undefined && ax.value !== undefined && !sameSemanticValue(base.value, ax.value)) conflicts.push("value");
	const backendNodeId = trustedIdentity ? entityBackendNodeId(ax) : undefined;
	const axIdentityLocators = trustedIdentity ? (ax.locators ?? []).filter((locator) => locator.by === "backendNodeId" || locator.by === "axNodeId") : [];
	const fieldSource = {
		...(role === ax.role && ax.role !== "generic" ? { role: "ax" as const } : {}),
		...(ax.name ? { name: "ax" as const } : {}),
		...(!password && ax.value !== undefined ? { value: "ax" as const } : {}),
		...(ax.structure ? { structure: "ax" as const } : {}),
	};
	return {
		...base,
		role,
		name,
		value,
		state: mergedState,
		...(actionability ? { actionability } : {}),
		...(ax.structure || base.structure ? { structure: { ...(base.structure || {}), ...(ax.structure || {}) } } : {}),
		locators: dedupeLocators([...axIdentityLocators, ...(base.locators ?? [])]),
		geometry: base.geometry || ax.geometry,
		hints: {
			...(base.hints || {}),
			...(trustedIdentity ? { axNodeId: ax.hints?.axNodeId, axBackendNodeId: ax.hints?.backendNodeId } : {}),
			...(backendNodeId !== undefined ? { backendNodeId } : {}),
			...(ax.hints?.containerRole ? { containerRole: ax.hints.containerRole } : {}),
			...(ax.hints?.containerName ? { containerName: ax.hints.containerName } : {}),
			...(trustedIdentity && ax.hints?.containerKey ? { containerKey: ax.hints.containerKey } : {}),
			...(trustedIdentity && ax.hints?.currentContainerKeys ? { currentContainerKeys: ax.hints.currentContainerKeys } : {}),
			mergedSources: ["dom", "ax"],
			fusionMatch: match,
			...(Object.keys(fieldSource).length ? { fieldSource } : {}),
			...(Object.keys(stateSource).length ? { stateSource } : {}),
			...(conflicts.length ? { fusionConflicts: conflicts } : {}),
		},
	};
}

function boxIoU(a?: { x: number; y: number; w: number; h: number }, b?: { x: number; y: number; w: number; h: number }): number | undefined {
	if (!a || !b) return undefined;
	const ix = Math.max(a.x, b.x);
	const iy = Math.max(a.y, b.y);
	const ix2 = Math.min(a.x + a.w, b.x + b.w);
	const iy2 = Math.min(a.y + a.h, b.y + b.h);
	const intersection = Math.max(0, ix2 - ix) * Math.max(0, iy2 - iy);
	const union = a.w * a.h + b.w * b.h - intersection;
	return union > 0 ? intersection / union : undefined;
}

function compatibleMatchRoles(left: string, right: string): boolean {
	if (left === right) return true;
	return (left === "img" && right === "image")
		|| (left === "image" && right === "img")
		|| (left === "label" && ["labeltext", "text", "statictext"].includes(right))
		|| (right === "label" && ["labeltext", "text", "statictext"].includes(left))
		|| (["text", "statictext", "labeltext"].includes(left) && ["text", "statictext", "labeltext"].includes(right))
		|| (["frame", "iframe"].includes(left) && ["frame", "iframe"].includes(right));
}

function axMatchScore(dom: EntityMatchInfo, ax: EntityMatchInfo): { score: number; geometryBacked: boolean } | undefined {
	if (dom.targetId !== ax.targetId) return undefined;
	if (!compatibleMatchRoles(dom.role, ax.role)) return undefined;
	if (dom.name !== undefined && ax.name !== undefined && dom.name !== ax.name) return undefined;
	const iou = boxIoU(dom.box, ax.box);
	if (iou !== undefined && iou >= COINCIDENT_BOX_IOU) return { score: 120 + iou * 10, geometryBacked: true };
	const nameMatch = dom.name !== undefined && dom.name === ax.name;
	const roleMatch = dom.role === ax.role;
	const dist = pointDistance(dom.point, ax.point);
	const geomKnown = dist !== undefined;
	const geomClose = dist !== undefined && dist <= GEOMETRY_MATCH_RADIUS_PX;
	if (nameMatch && geomClose) return { score: 100 - dist, geometryBacked: true };
	if (roleMatch && geomClose) return { score: 80 - dist, geometryBacked: true };
	// No shared geometry below this line: these matches rest on role (and maybe name) alone, so they
	// must not be trusted when more than one candidate ties (see mergeDomAndAxEntities pass 2).
	if (roleMatch && nameMatch && !geomKnown) return { score: 60, geometryBacked: false };
	if (roleMatch && !geomKnown) return { score: 40, geometryBacked: false };
	return undefined;
}

function appendSetIndexValue<K>(index: Map<K, Set<number>>, key: K, value: number): void {
	const values = index.get(key);
	if (values) values.add(value);
	else index.set(key, new Set([value]));
}

function emptySemanticRoleCandidates(): SemanticRoleCandidates {
	return {
		all: new Set(),
		unnamed: new Set(),
		byName: new Map(),
		withoutPoint: new Set(),
		unnamedWithoutPoint: new Set(),
		withoutPointByName: new Map(),
	};
}

function semanticRoleKey(info: Pick<EntityMatchInfo, "role" | "targetId">): string {
	return `${info.targetId ?? ""}\u0000${info.role}`;
}

function buildDomMatchIndex(entities: Entity[], prepared: EntityMatchInfo[]): DomMatchIndex {
	const byBackendNodeId = new Map<number, Set<number>>();
	const byBackendNodeKey = new Map<string, Set<number>>();
	const boxItems: Array<{ value: number; rect: { x: number; y: number; w: number; h: number } }> = [];
	const pointItems: Array<{ value: number; rect: { x: number; y: number; w: number; h: number } }> = [];
	const byRole = new Map<string, SemanticRoleCandidates>();
	for (let index = 0; index < entities.length; index += 1) {
		const backendIdentity = entityBackendNodeIdentity(entities[index]!);
		if (backendIdentity) {
			appendSetIndexValue(byBackendNodeId, backendIdentity.backendNodeId, index);
			appendSetIndexValue(byBackendNodeKey, backendNodeKey(backendIdentity), index);
		}
		const info = prepared[index]!;
		if (info.box) boxItems.push({ value: index, rect: info.box });
		if (info.point) pointItems.push({ value: index, rect: { ...info.point, w: 0, h: 0 } });
		const roleKey = semanticRoleKey(info);
		let semantic = byRole.get(roleKey);
		if (!semantic) {
			semantic = emptySemanticRoleCandidates();
			byRole.set(roleKey, semantic);
		}
		semantic.all.add(index);
		if (info.name === undefined) semantic.unnamed.add(index);
		else appendSetIndexValue(semantic.byName, info.name, index);
		if (info.point !== undefined) continue;
		semantic.withoutPoint.add(index);
		if (info.name === undefined) semantic.unnamedWithoutPoint.add(index);
		else appendSetIndexValue(semantic.withoutPointByName, info.name, index);
	}
	const spatialOptions = { bucketSize: AX_GEOMETRY_BUCKET_SIZE, maxBucketsPerRect: MAX_AX_GEOMETRY_BUCKETS_PER_RECT };
	return {
		byBackendNodeId,
		byBackendNodeKey,
		boxes: buildBoundedSpatialIndex(boxItems, spatialOptions),
		points: buildBoundedSpatialIndex(pointItems, spatialOptions),
		byRole,
	};
}

function retireDomMatchCandidate(index: DomMatchIndex, domIndex: number, entity: Entity, info: EntityMatchInfo): void {
	const backendIdentity = entityBackendNodeIdentity(entity);
	if (backendIdentity) {
		index.byBackendNodeId.get(backendIdentity.backendNodeId)?.delete(domIndex);
		index.byBackendNodeKey.get(backendNodeKey(backendIdentity))?.delete(domIndex);
	}
	const semantic = index.byRole.get(semanticRoleKey(info));
	if (!semantic) return;
	semantic.all.delete(domIndex);
	if (info.name === undefined) semantic.unnamed.delete(domIndex);
	else semantic.byName.get(info.name)?.delete(domIndex);
	if (info.point !== undefined) return;
	semantic.withoutPoint.delete(domIndex);
	if (info.name === undefined) semantic.unnamedWithoutPoint.delete(domIndex);
	else semantic.withoutPointByName.get(info.name)?.delete(domIndex);
}

function addCandidates(target: Set<number>, candidates: Iterable<number>): void {
	for (const candidate of candidates) target.add(candidate);
}

function geometryMatchCandidates(ax: EntityMatchInfo, index: DomMatchIndex): Set<number> {
	const candidates = new Set<number>();
	if (ax.box) addCandidates(candidates, queryBoundedSpatialIndex(index.boxes, ax.box));
	if (ax.point) {
		addCandidates(candidates, queryBoundedSpatialIndex(index.points, {
			x: ax.point.x - GEOMETRY_MATCH_RADIUS_PX,
			y: ax.point.y - GEOMETRY_MATCH_RADIUS_PX,
			w: GEOMETRY_MATCH_RADIUS_PX * 2,
			h: GEOMETRY_MATCH_RADIUS_PX * 2,
		}));
	}
	return candidates;
}

function bestMatch(candidates: Iterable<number>, usedDom: Uint8Array, domPrepared: EntityMatchInfo[], ax: EntityMatchInfo, geometryOnly: boolean): { index: number; ambiguous: boolean } {
	let bestIndex = -1;
	let bestScore = 0;
	let ambiguous = false;
	for (const domIndex of candidates) {
		if (usedDom[domIndex]) continue;
		const match = axMatchScore(domPrepared[domIndex]!, ax);
		if (match === undefined || (geometryOnly && !match.geometryBacked)) continue;
		if (match.score > bestScore) {
			bestScore = match.score;
			bestIndex = domIndex;
			ambiguous = false;
		} else if (match.score === bestScore && bestIndex >= 0) {
			ambiguous = true;
		}
	}
	return { index: bestIndex, ambiguous };
}

function considerScoredMatch(best: ScoredMatch, index: number, score: number, count = 1): void {
	if (count <= 0) return;
	if (score > best.score) {
		best.index = index;
		best.score = score;
		best.count = count;
	} else if (score === best.score) {
		best.count += count;
	}
}

function availableGroupExcluding(group: Set<number> | undefined, excluded: Set<number>): { index: number; count: number } {
	if (!group?.size) return { index: -1, count: 0 };
	let excludedCount = 0;
	for (const candidate of excluded) if (group.has(candidate)) excludedCount += 1;
	const count = group.size - excludedCount;
	if (count <= 0) return { index: -1, count: 0 };
	for (const candidate of group) {
		if (!excluded.has(candidate)) return { index: candidate, count };
	}
	return { index: -1, count: 0 };
}

function considerSemanticGroup(best: ScoredMatch, group: Set<number> | undefined, geometryCandidates: Set<number>, score: number): void {
	const available = availableGroupExcluding(group, geometryCandidates);
	if (available.index >= 0) considerScoredMatch(best, available.index, score, available.count);
}

function bestSemanticMatch(ax: EntityMatchInfo, index: DomMatchIndex, usedDom: Uint8Array, domPrepared: EntityMatchInfo[]): { index: number; ambiguous: boolean } {
	const geometryCandidates = geometryMatchCandidates(ax, index);
	const best: ScoredMatch = { index: -1, score: 0, count: 0 };
	for (const domIndex of geometryCandidates) {
		if (usedDom[domIndex]) continue;
		const match = axMatchScore(domPrepared[domIndex]!, ax);
		if (match) considerScoredMatch(best, domIndex, match.score);
	}
	const semantic = index.byRole.get(semanticRoleKey(ax));
	if (!semantic) return { index: best.index, ambiguous: best.count > 1 };
	const requireWithoutPoint = ax.point !== undefined;
	if (ax.name === undefined) {
		considerSemanticGroup(best, requireWithoutPoint ? semantic.withoutPoint : semantic.all, geometryCandidates, 40);
	} else {
		considerSemanticGroup(best, (requireWithoutPoint ? semantic.withoutPointByName : semantic.byName).get(ax.name), geometryCandidates, 60);
		considerSemanticGroup(best, requireWithoutPoint ? semantic.unnamedWithoutPoint : semantic.unnamed, geometryCandidates, 40);
	}
	return { index: best.index, ambiguous: best.count > 1 };
}

export function mergeDomAndAxEntities(domEntities: Entity[], axEntities: BuiltEntity[]): AxFusionResult {
	const merged: Entity[] = domEntities.map((entity) => ({ ...entity, ...(entity.hints ? { hints: { ...entity.hints } } : {}) }));
	const diagnostics = emptyFusionDiagnostics(domEntities.length);
	const domPrepared = merged.map((entity) => buildEntityMatchInfo(entity));
	const axPrepared = axEntities.map((ax) => buildEntityMatchInfo(ax.entity));
	const matchIndex = buildDomMatchIndex(merged, domPrepared);
	const usedAx = new Uint8Array(axEntities.length);
	const usedDom = new Uint8Array(merged.length);
	const unsafeAx = new Uint8Array(axEntities.length);
	for (let axIndex = 0; axIndex < axEntities.length; axIndex += 1) {
		const hints = axEntities[axIndex]!.entity.hints;
		if (hints?.unsafeNameSkipped === true || hints?.unsafeValueSkipped === true) {
			unsafeAx[axIndex] = 1;
			diagnostics.skipped.unsafeSemantic += 1;
		}
	}
	const commit = (axIndex: number, domIndex: number, tier: AxFusionMatch["tier"]): void => {
		retireDomMatchCandidate(matchIndex, domIndex, merged[domIndex]!, domPrepared[domIndex]!);
		merged[domIndex] = mergeKnownDomAndAxEntity(merged[domIndex]!, axEntities[axIndex]!.entity, { tier, confidence: tier === "semantic" ? "medium" : "high" });
		domPrepared[domIndex] = buildEntityMatchInfo(merged[domIndex]!);
		usedAx[axIndex] = 1;
		usedDom[domIndex] = 1;
		diagnostics.axEnriched += 1;
		diagnostics.matched[tier] += 1;
	};
	const commitUnique = (proposals: Array<{ axIndex: number; domIndex: number }>, tier: AxFusionMatch["tier"], ambiguity: "ambiguousBackend" | "ambiguousGeometry" | "ambiguousSemantic"): void => {
		const byDom = new Map<number, number[]>();
		for (const proposal of proposals) {
			const candidates = byDom.get(proposal.domIndex);
			if (candidates) candidates.push(proposal.axIndex);
			else byDom.set(proposal.domIndex, [proposal.axIndex]);
		}
		for (const [domIndex, axIndexes] of byDom) {
			if (axIndexes.length === 1) commit(axIndexes[0]!, domIndex, tier);
			else diagnostics.skipped[ambiguity] += axIndexes.length;
		}
	};
	const backendProposals: Array<{ axIndex: number; domIndex: number }> = [];
	for (let axIndex = 0; axIndex < axEntities.length; axIndex += 1) {
		const axBackendIdentity = entityBackendNodeIdentity(axEntities[axIndex]!.entity);
		if (!axBackendIdentity) continue;
		const backendCandidates = matchIndex.byBackendNodeKey.get(backendNodeKey(axBackendIdentity));
		if (backendCandidates?.size === 1) backendProposals.push({ axIndex, domIndex: backendCandidates.values().next().value! });
		else if (backendCandidates && backendCandidates.size > 1) diagnostics.skipped.ambiguousBackend += 1;
		else if (matchIndex.byBackendNodeId.get(axBackendIdentity.backendNodeId)?.size) diagnostics.skipped.targetScopeMismatch += 1;
	}
	commitUnique(backendProposals, "backend", "ambiguousBackend");
	const geometryProposals: Array<{ axIndex: number; domIndex: number }> = [];
	for (let axIndex = 0; axIndex < axEntities.length; axIndex += 1) {
		if (usedAx[axIndex] || unsafeAx[axIndex]) continue;
		const match = bestMatch(geometryMatchCandidates(axPrepared[axIndex]!, matchIndex), usedDom, domPrepared, axPrepared[axIndex]!, true);
		if (match.index >= 0 && !match.ambiguous) geometryProposals.push({ axIndex, domIndex: match.index });
		else if (match.index >= 0) diagnostics.skipped.ambiguousGeometry += 1;
	}
	commitUnique(geometryProposals, "geometry", "ambiguousGeometry");
	const semanticProposals: Array<{ axIndex: number; domIndex: number }> = [];
	for (let axIndex = 0; axIndex < axEntities.length; axIndex += 1) {
		if (usedAx[axIndex] || unsafeAx[axIndex]) continue;
		const match = bestSemanticMatch(axPrepared[axIndex]!, matchIndex, usedDom, domPrepared);
		if (match.index >= 0 && !match.ambiguous) semanticProposals.push({ axIndex, domIndex: match.index });
		else if (match.index >= 0) diagnostics.skipped.ambiguousSemantic += 1;
	}
	commitUnique(semanticProposals, "semantic", "ambiguousSemantic");
	const unmatchedAx = axEntities.filter((_, index) => !usedAx[index] && !unsafeAx[index]);
	diagnostics.axOnly = unmatchedAx.length;
	diagnostics.degraded = Object.values(diagnostics.skipped).some((count) => count > 0);
	return { merged, unmatchedAx, diagnostics };
}
