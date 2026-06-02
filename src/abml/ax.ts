import { defaultRefPolicyForKind } from "./refPolicy.js";
import { isRecord } from "../utils/records.js";
import type { BuiltEntity, Entity, EntityKind, EntityState } from "./entity.js";
import type { Locator } from "./types.js";

export type AxTreeNode = Record<string, unknown>;
export type AxContext = {
	browserSessionId?: string;
	tabId?: number;
	url?: string;
	observationId: string;
	capturedAt?: number;
};

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

function axValueText(value: unknown): string | undefined {
	if (typeof value === "string") return stringValue(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	const record = asRecord(value);
	if (!record) return undefined;
	return stringValue(record.value) || stringValue(record.text) || stringValue(record.name);
}

function axProperty(node: AxTreeNode, propertyName: string): unknown {
	const props = Array.isArray(node.properties) ? node.properties : [];
	const hit = props.find((item) => {
		const record = asRecord(item);
		return record && String(record.name || "") === propertyName;
	});
	const record = asRecord(hit);
	return record?.value;
}

function axPropertyBool(node: AxTreeNode, propertyName: string): boolean | undefined {
	const value = axProperty(node, propertyName);
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

export function axValue(node: AxTreeNode): string | undefined {
	return axValueText(node.value) || axValueText(axProperty(node, "value")) || axValueText(axProperty(node, "valuetext")) || axValueText(axProperty(node, "valuenow"));
}

export function axNodeId(node: AxTreeNode): string | undefined {
	return stringValue(node.nodeId) || stringValue(node.axNodeId) || stringValue(node.id);
}

export function axBackendNodeId(node: AxTreeNode): number | undefined {
	return numberValue(node.backendDOMNodeId) ?? numberValue(node.backendNodeId);
}

function kindForAxRole(role: string): EntityKind {
	const normalized = role.toLowerCase();
	if (["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "tab", "listbox", "menuitem", "option", "slider", "spinbutton"].includes(normalized)) return "control";
	if (["statictext", "text", "labeltext", "heading"].includes(normalized)) return "text";
	if (["image", "img"] .includes(normalized)) return "media";
	if (["iframe", "frame", "webarea", "rootwebarea"] .includes(normalized)) return "frame";
	return "element";
}

export function isInterestingAxNode(node: AxTreeNode): boolean {
	if (node.ignored === true) return false;
	const role = axRole(node).toLowerCase();
	const name = axName(node);
	const value = axValue(node);
	if (["rootwebarea", "none", "generic", "group", "pane", "section", "paragraph", "listitemmarker", "inlinetextbox"] .includes(role)) return Boolean(name || value);
	if (kindForAxRole(role) !== "element") return true;
	return Boolean(name || value || axBackendNodeId(node));
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

export function buildAxLocators(node: AxTreeNode): Locator[] {
	const locators: Locator[] = [];
	const nodeId = axNodeId(node);
	const backendNodeId = axBackendNodeId(node);
	const role = axRole(node);
	const name = axName(node) || axValue(node);
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

export function buildAxEntityFromNode(node: AxTreeNode, context: AxContext, geometry?: { box?: { x: number; y: number; w: number; h: number }; point?: { x: number; y: number } }): BuiltEntity {
	const role = axRole(node);
	const name = axName(node);
	const value = axValue(node);
	const kind = kindForAxRole(role);
	const locators = buildAxLocators(node);
	const capturedAt = context.capturedAt ?? Date.now();
	const disabled = axPropertyBool(node, "disabled") === true || axPropertyBool(node, "aria-disabled") === true;
	const focused = axPropertyBool(node, "focused") === true;
	const expanded = axPropertyBool(node, "expanded");
	const checked = axPropertyBool(node, "checked");
	const selected = axPropertyBool(node, "selected");
	const pressed = axPropertyBool(node, "pressed");
	const currentText = axValueText(axProperty(node, "current"));
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
		editable: ["textbox", "searchbox", "combobox", "textarea", "spinbutton"].includes(role.toLowerCase()),
		inViewport: Boolean(geometry?.point || geometry?.box),
	};
	return {
		entity: {
			kind,
			role,
			...(name ? { name } : {}),
			...(value ? { value } : {}),
			state,
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
				...(topLevelOrigin(context.url) ? { topLevelOrigin: topLevelOrigin(context.url) } : {}),
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

function pointDistance(a?: { x: number; y: number }, b?: { x: number; y: number }): number | undefined {
	if (!a || !b) return undefined;
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return Math.sqrt(dx * dx + dy * dy);
}

// AX is authoritative for control state (DOM input.checked lies under component
// frameworks) and for role (DOM heuristics mis-label, e.g. radio/checkbox as
// textbox). Propagating AX state onto the aligned DOM entity is the fix for
// "aligned but the lying DOM state survived".
const AX_AUTHORITATIVE_STATE = ["checked", "selected", "pressed", "expanded", "current"] as const;

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
		value: ax.value ?? base.value,
		state: mergedState,
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

const GEOMETRY_MATCH_RADIUS_PX = 24;

// Score how strongly an AX entity aligns to a DOM entity. AX role is authoritative,
// so DOM role is NOT required to agree: when name + geometry strongly agree, a role
// mismatch is exactly the DOM-mislabel case we want to correct (e.g. a Vue radio the
// DOM heuristic scanned as a textbox). Conflicting names veto the match; geometry
// breaks ties (closer = higher). Returns undefined when there is no defensible match.
function axMatchScore(dom: Entity, ax: BuiltEntity["entity"]): number | undefined {
	const domName = entityName(dom);
	const axName = entityName(ax);
	if (domName !== undefined && axName !== undefined && domName !== axName) return undefined;
	const nameMatch = domName !== undefined && domName === axName;
	const roleMatch = entityRole(dom) === entityRole(ax);
	const dist = pointDistance(entityPoint(dom), entityPoint(ax));
	const geomKnown = dist !== undefined;
	const geomClose = dist !== undefined && dist <= GEOMETRY_MATCH_RADIUS_PX;
	if (nameMatch && geomClose) return 100 - dist; // name + position: role-agnostic (corrects DOM mislabel)
	if (roleMatch && geomClose) return 80 - dist; // role + position
	if (roleMatch && nameMatch && !geomKnown) return 60; // role + name, geometry unknown
	if (roleMatch && !geomKnown) return 40; // role only, geometry unknown
	return undefined;
}

export function mergeDomAndAxEntities(domEntities: Entity[], axEntities: BuiltEntity[]): { merged: Entity[]; unmatchedAx: BuiltEntity[] } {
	const merged: Entity[] = domEntities.map((entity) => ({ ...entity, ...(entity.hints ? { hints: { ...entity.hints } } : {}) }));
	const used = new Set<number>();
	for (let axIndex = 0; axIndex < axEntities.length; axIndex += 1) {
		const ax = axEntities[axIndex];
		let bestIndex = -1;
		let bestScore = 0;
		for (let domIndex = 0; domIndex < merged.length; domIndex += 1) {
			const score = axMatchScore(merged[domIndex]!, ax.entity);
			if (score !== undefined && score > bestScore) {
				bestScore = score;
				bestIndex = domIndex;
			}
		}
		if (bestIndex >= 0) {
			merged[bestIndex] = mergedEntity(merged[bestIndex]!, ax.entity);
			used.add(axIndex);
		}
	}
	return { merged, unmatchedAx: axEntities.filter((_, index) => !used.has(index)) };
}
