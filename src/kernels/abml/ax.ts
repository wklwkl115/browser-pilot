import { defaultRefPolicyForKind } from "../refs/refPolicy.js";
import { isRecord } from "../../utils/records.js";
import type { BuiltEntity, Entity, EntityKind, EntityState, EntityStructure, RelationType } from "./entity.js";
import type { Locator } from "./types.js";

export type AxTreeNode = Record<string, unknown>;
export type AxContext = {
	browserSessionId?: string;
	tabId?: number;
	url?: string;
	observationId: string;
	capturedAt: number;
};

type AxPropertyMap = Map<string, unknown>;
type EntityMatchInfo = {
	name?: string;
	role: string;
	point?: { x: number; y: number };
	box?: { x: number; y: number; w: number; h: number };
};

const CONTROL_AX_ROLES = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "tab", "listbox", "menuitem", "option", "slider", "spinbutton"]);
const TEXT_AX_ROLES = new Set(["statictext", "text", "labeltext", "heading"]);
const MEDIA_AX_ROLES = new Set(["image", "img"]);
const FRAME_AX_ROLES = new Set(["iframe", "frame", "webarea", "rootwebarea"]);
const BORING_AX_ROLES = new Set(["rootwebarea", "none", "generic", "group", "pane", "section", "paragraph", "listitemmarker", "inlinetextbox"]);
const EDITABLE_AX_ROLES = new Set(["textbox", "searchbox", "combobox", "textarea", "spinbutton"]);
const LANDMARK_ROLES = new Set(["banner", "navigation", "main", "complementary", "contentinfo", "search", "form", "region"]);
const AX_AUTHORITATIVE_STATE = ["checked", "selected", "pressed", "expanded", "current"] as const;
const GEOMETRY_MATCH_RADIUS_PX = 24;
const COINCIDENT_BOX_IOU = 0.8;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === "string") {
		const text = value.trim();
		return text ? text : undefined;
	}
	return undefined;
}

function numberValue(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function boolValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function topLevelOrigin(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

let cachedTopLevelOriginUrl: string | undefined;
let cachedTopLevelOriginValue: string | undefined;
let hasCachedTopLevelOrigin = false;

function memoizedTopLevelOrigin(url: string | undefined): string | undefined {
	if (hasCachedTopLevelOrigin && url === cachedTopLevelOriginUrl) return cachedTopLevelOriginValue;
	const origin = topLevelOrigin(url);
	cachedTopLevelOriginUrl = url;
	cachedTopLevelOriginValue = origin;
	hasCachedTopLevelOrigin = true;
	return origin;
}

function axValueText(value: unknown): string | undefined {
	if (typeof value === "string") return stringValue(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	const record = asRecord(value);
	if (!record) return undefined;
	return stringValue(record.value) || stringValue(record.text) || stringValue(record.name);
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

export function axRole(node: AxTreeNode): string {
	return axValueText(node.role) || "generic";
}

export function axName(node: AxTreeNode): string | undefined {
	return axValueText(node.name);
}

export function axValue(node: AxTreeNode, propertyMap?: AxPropertyMap): string | undefined {
	return axValueText(node.value)
		|| axValueText(axProperty(node, "value", propertyMap))
		|| axValueText(axProperty(node, "valuetext", propertyMap))
		|| axValueText(axProperty(node, "valuenow", propertyMap));
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

export function buildAxLocators(node: AxTreeNode, propertyMap?: AxPropertyMap): Locator[] {
	const locators: Locator[] = [];
	const nodeId = axNodeId(node);
	const backendNodeId = axBackendNodeId(node);
	const role = axRole(node);
	const name = axName(node) || axValue(node, propertyMap);
	if (backendNodeId !== undefined) locators.push({ by: "backendNodeId", value: backendNodeId });
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

export function buildAxEntityFromNode(node: AxTreeNode, context: AxContext, geometry?: { box?: { x: number; y: number; w: number; h: number }; point?: { x: number; y: number } }): BuiltEntity {
	const role = axRole(node);
	const roleLower = role.toLowerCase();
	const propertyMap = axPropertyMap(node);
	const origin = memoizedTopLevelOrigin(context.url);
	const structure = axStructure(node, role, propertyMap);
	const name = axName(node);
	const value = axValue(node, propertyMap);
	const kind = kindForAxRole(role);
	const locators = buildAxLocators(node, propertyMap);
	const capturedAt = context.capturedAt;
	const disabled = axPropertyBool(node, "disabled", propertyMap) === true || axPropertyBool(node, "aria-disabled", propertyMap) === true;
	const focused = axPropertyBool(node, "focused", propertyMap) === true;
	const expanded = axPropertyBool(node, "expanded", propertyMap);
	const checked = axPropertyBool(node, "checked", propertyMap);
	const selected = axPropertyBool(node, "selected", propertyMap);
	const pressed = axPropertyBool(node, "pressed", propertyMap);
	const currentText = axValueText(axProperty(node, "current", propertyMap));
	const current = currentText === undefined ? undefined : currentText === "false" ? false : currentText === "true" ? true : currentText;
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
		inViewport: Boolean(geometry?.point || geometry?.box),
	};
	return {
		entity: {
			kind,
			role,
			...(name ? { name } : {}),
			...(value ? { value } : {}),
			state,
			...(structure ? { structure } : {}),
			source: "ax",
			locators,
			...(geometry ? { geometry } : {}),
			hints: {
				axNodeId: axNodeId(node),
				backendNodeId: axBackendNodeId(node),
			},
		},
		descriptor: {
			kind,
			locators,
			owner: {
				...(context.browserSessionId ? { browserSessionId: context.browserSessionId } : {}),
				...(context.tabId !== undefined ? { tabId: context.tabId } : {}),
				...(origin ? { topLevelOrigin: origin } : {}),
			},
			policy: defaultRefPolicyForKind(kind),
			semantic: { role, ...(name ? { name } : {}), ...(value ? { value } : {}) },
			...(geometry ? { geometry } : {}),
			observationId: context.observationId,
			documentEpoch: { url: context.url, capturedAt },
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
	return {
		name: entityName(entity),
		role: entityRole(entity),
		point: entityPoint(entity),
		box: entityBox(entity),
	};
}

function entityBackendNodeId(entity: Entity | BuiltEntity["entity"]): number | undefined {
	const hinted = numberValue(entity.hints?.backendNodeId);
	if (hinted !== undefined && hinted > 0) return hinted;
	const locator = entity.locators?.find((item) => item.by === "backendNodeId");
	return locator?.by === "backendNodeId" && locator.value > 0 ? locator.value : undefined;
}

function pointDistance(a?: { x: number; y: number }, b?: { x: number; y: number }): number | undefined {
	if (!a || !b) return undefined;
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return Math.sqrt(dx * dx + dy * dy);
}

function mergedEntity(base: Entity, ax: BuiltEntity["entity"]): Entity {
	const mergedLocators = dedupeLocators([...(base.locators || []), ...(ax.locators || [])]);
	const mergedState: EntityState = { ...base.state };
	const stateSource: Record<string, "ax"> = {};
	for (const key of AX_AUTHORITATIVE_STATE) {
		const axStateValue = (ax.state as Record<string, unknown>)[key];
		if (axStateValue !== undefined) {
			(mergedState as Record<string, unknown>)[key] = axStateValue;
			stateSource[key] = "ax";
		}
	}
	return {
		...base,
		role: ax.role || base.role,
		name: ax.name || base.name,
		value: ax.value ?? base.value,
		state: mergedState,
		...(ax.structure || base.structure ? { structure: { ...(base.structure || {}), ...(ax.structure || {}) } } : {}),
		locators: mergedLocators,
		geometry: base.geometry || ax.geometry,
		hints: {
			...(base.hints || {}),
			...(ax.hints || {}),
			mergedSources: ["dom", "ax"],
			...(Object.keys(stateSource).length ? { stateSource } : {}),
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

function axMatchScore(dom: EntityMatchInfo, ax: EntityMatchInfo): { score: number; geometryBacked: boolean } | undefined {
	const iou = boxIoU(dom.box, ax.box);
	if (iou !== undefined && iou >= COINCIDENT_BOX_IOU) return { score: 120 + iou * 10, geometryBacked: true };
	if (dom.name !== undefined && ax.name !== undefined && dom.name !== ax.name) return undefined;
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

export function mergeDomAndAxEntities(domEntities: Entity[], axEntities: BuiltEntity[]): { merged: Entity[]; unmatchedAx: BuiltEntity[] } {
	const merged: Entity[] = domEntities.map((entity) => ({ ...entity, ...(entity.hints ? { hints: { ...entity.hints } } : {}) }));
	const domPrepared = merged.map((entity) => buildEntityMatchInfo(entity));
	const axPrepared = axEntities.map((ax) => buildEntityMatchInfo(ax.entity));
	const usedAx = new Set<number>();
	const usedDom = new Set<number>();
	// AX and DOM are two projections of the same node tree, so a DOM entity fuses with at most one
	// AX node. Consuming the DOM on commit enforces that 1:1 invariant — it stops several AX nodes
	// from piling their (distinct) authoritative state onto a single DOM entity.
	const commit = (axIndex: number, domIndex: number): void => {
		merged[domIndex] = mergedEntity(merged[domIndex]!, axEntities[axIndex]!.entity);
		domPrepared[domIndex] = buildEntityMatchInfo(merged[domIndex]!);
		usedAx.add(axIndex);
		usedDom.add(domIndex);
	};
	// Pass 0 — exact backendNodeId bootstrap. Once DOM scan entities are stamped from DOMSnapshot,
	// this is the identity join and should beat all geometry/name heuristics.
	for (let axIndex = 0; axIndex < axEntities.length; axIndex += 1) {
		const axBackendNodeId = entityBackendNodeId(axEntities[axIndex]!.entity);
		if (axBackendNodeId === undefined) continue;
		let matchIndex = -1;
		let ambiguous = false;
		for (let domIndex = 0; domIndex < merged.length; domIndex += 1) {
			if (usedDom.has(domIndex)) continue;
			if (entityBackendNodeId(merged[domIndex]!) !== axBackendNodeId) continue;
			if (matchIndex >= 0) ambiguous = true;
			else matchIndex = domIndex;
		}
		if (matchIndex >= 0 && !ambiguous) commit(axIndex, matchIndex);
	}
	// Pass 1 — geometry-backed matches (box IoU or coincident point). These are high-confidence, so
	// they claim their DOM first: a reliable spatial match must always win a DOM over a weaker
	// geometry-less one that merely shares a role.
	for (let axIndex = 0; axIndex < axEntities.length; axIndex += 1) {
		let bestIndex = -1;
		let bestScore = 0;
		for (let domIndex = 0; domIndex < merged.length; domIndex += 1) {
			if (usedDom.has(domIndex)) continue;
			const match = axMatchScore(domPrepared[domIndex]!, axPrepared[axIndex]!);
			if (match?.geometryBacked && match.score > bestScore) {
				bestScore = match.score;
				bestIndex = domIndex;
			}
		}
		if (bestIndex >= 0) commit(axIndex, bestIndex);
	}
	// Pass 2 — geometry-less matches (role, or role+name, with no shared point). With no geometry to
	// disambiguate, a tie among same-role candidates is a coin-flip that used to glue the AX node
	// onto whichever DOM entity came first in array order, mis-attributing its widget state to the
	// wrong sibling. Commit such a match ONLY when its best candidate is unambiguous; otherwise leave
	// the AX node unmatched so it is appended as its own entity (lossless) rather than corrupting a
	// sibling. This dissolves the whole geometry-less mis-association class, not one instance.
	for (let axIndex = 0; axIndex < axEntities.length; axIndex += 1) {
		if (usedAx.has(axIndex)) continue;
		let bestIndex = -1;
		let bestScore = 0;
		let ambiguous = false;
		for (let domIndex = 0; domIndex < merged.length; domIndex += 1) {
			if (usedDom.has(domIndex)) continue;
			const match = axMatchScore(domPrepared[domIndex]!, axPrepared[axIndex]!);
			if (match === undefined) continue;
			if (match.score > bestScore) {
				bestScore = match.score;
				bestIndex = domIndex;
				ambiguous = false;
			} else if (match.score === bestScore && bestIndex >= 0) {
				ambiguous = true;
			}
		}
		if (bestIndex >= 0 && !ambiguous) commit(axIndex, bestIndex);
	}
	return { merged, unmatchedAx: axEntities.filter((_, index) => !usedAx.has(index)) };
}
