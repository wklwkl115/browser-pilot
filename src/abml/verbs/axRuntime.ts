import type { BrowserBridgeServer } from "../../driver/BrowserBridgeServer.js";
import { isRecord } from "../../utils/records.js";
import { assertBridgeCommandSucceeded } from "../../tools/bridgeResultValidation.js";
import { registerRefDescriptor } from "../../resources/resourceStore.js";
import type { Entity } from "../entity.js";
import { axBackendNodeId, axName, axNodeId, axRole, buildAxEntityFromNode, boxModelToGeometry, extractAxPropertyRelationAnchors, isInterestingAxNode, mergeDomAndAxEntities, type AxContext } from "../ax.js";
import type { BuiltEntity } from "../entity.js";
import type { RelationAnchor } from "../relations.js";

export type AbmlAxRuntimeServer = Pick<BrowserBridgeServer, "sendCommand">;

export type AxReadRuntimeOptions = {
	browserSessionId?: string;
	tabId: number;
	observationId: string;
	url?: string;
	capturedAt?: number;
	timeoutMs?: number;
};

async function sendPersistentCdp(server: AbmlAxRuntimeServer, options: { browserSessionId?: string; tabId: number; timeoutMs: number; cdpMethod: string; params?: Record<string, unknown> }) {
	const result = await server.sendCommand({
		cmd: "persistent_cdp",
		action: "send",
		tabId: options.tabId,
		cdpMethod: options.cdpMethod,
		params: options.params || {},
		persistent: true,
		timeoutMs: options.timeoutMs,
	}, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs });
	assertBridgeCommandSucceeded(result, `persistent_cdp:${options.cdpMethod}`);
	return result;
}

function valueRecord(result: unknown): Record<string, unknown> {
	if (isRecord(result)) return result;
	return {};
}

const CONTAINER_ROLES = new Set(["radiogroup", "group", "list", "listbox", "menu", "menubar", "table", "grid", "treegrid", "tree", "tablist", "row", "rowgroup", "feed"]);
const TABLE_ROLES = new Set(["table", "grid", "treegrid"]);
const CELL_ROLES = new Set(["cell", "gridcell", "columnheader", "rowheader"]);
const CURRENT_CONTAINER_ROLES = new Set(["navigation", "menu", "menubar", "list", "listbox", "tablist", "tree", "radiogroup"]);

type AncestorContainerContext = {
	nearest?: { role: string; name: string | undefined };
	currentContainerKeys: string[];
};

function nodeRelationKey(node: Record<string, unknown>): string | undefined {
	const backend = axBackendNodeId(node);
	if (backend !== undefined) return `b:${backend}`;
	const id = axNodeId(node);
	return id ? `a:${id}` : undefined;
}

function ancestorContainerContext(node: Record<string, unknown>, parentByChildId: Map<string, Record<string, unknown>>): AncestorContainerContext {
	let current = node;
	let nearest: AncestorContainerContext["nearest"];
	const currentContainerKeys: string[] = [];
	for (let depth = 0; depth < 24; depth += 1) {
		const id = axNodeId(current);
		if (!id) break;
		const parent = parentByChildId.get(id);
		if (!parent) break;
		const role = axRole(parent).toLowerCase();
		if (!nearest && CONTAINER_ROLES.has(role)) nearest = { role, name: axName(parent) };
		if (CURRENT_CONTAINER_ROLES.has(role)) {
			const key = nodeRelationKey(parent);
			if (key && !currentContainerKeys.includes(key)) currentContainerKeys.push(key);
		}
		current = parent;
	}
	return { ...(nearest ? { nearest } : {}), currentContainerKeys };
}

export function nearestContainer(node: Record<string, unknown>, parentByChildId: Map<string, Record<string, unknown>>): { role: string; name: string | undefined } | undefined {
	return ancestorContainerContext(node, parentByChildId).nearest;
}

function collectTableRows(table: Record<string, unknown>, nodeById: Map<string, Record<string, unknown>>): Array<Record<string, unknown>> {
	const rows: Array<Record<string, unknown>> = [];
	const visit = (node: Record<string, unknown>, depth: number) => {
		if (depth > 24) return;
		const childIds = Array.isArray(node.childIds) ? node.childIds : [];
		for (const childId of childIds) {
			const child = nodeById.get(typeof childId === "string" ? childId : String(childId));
			if (!child) continue;
			const role = axRole(child).toLowerCase();
			if (TABLE_ROLES.has(role)) continue;
			if (role === "row") {
				rows.push(child);
				visit(child, depth + 1);
			} else {
				visit(child, depth + 1);
			}
		}
	};
	visit(table, 0);
	return rows;
}

function collectRowCells(row: Record<string, unknown>, nodeById: Map<string, Record<string, unknown>>): Array<Record<string, unknown>> {
	const cells: Array<Record<string, unknown>> = [];
	const childIds = Array.isArray(row.childIds) ? row.childIds : [];
	for (const childId of childIds) {
		const child = nodeById.get(typeof childId === "string" ? childId : String(childId));
		if (child && CELL_ROLES.has(axRole(child).toLowerCase())) cells.push(child);
	}
	return cells;
}

function tableRelationAnchors(nodes: Array<Record<string, unknown>>, nodeById: Map<string, Record<string, unknown>>, builtByKey: Map<string, BuiltEntity>): RelationAnchor[] {
	const anchors: RelationAnchor[] = [];
	for (const table of nodes) {
		if (!TABLE_ROLES.has(axRole(table).toLowerCase())) continue;
		const tableKey = nodeRelationKey(table);
		if (!tableKey) continue;
		const rows = collectTableRows(table, nodeById);
		const headersByCol = new Map<number, string>();
		const dataCells: Array<{ cellKey: string; colIndex: number }> = [];
		rows.forEach((row, rowPos) => {
			const rowKey = nodeRelationKey(row);
			collectRowCells(row, nodeById).forEach((cell, colPos) => {
				const cellKey = nodeRelationKey(cell);
				if (!cellKey) return;
				const built = builtByKey.get(cellKey);
				const colIndex = built?.entity.structure?.colIndex ?? colPos + 1;
				const rowIndex = built?.entity.structure?.rowIndex ?? rowPos + 1;
				if (built) built.entity.structure = { ...(built.entity.structure || {}), rowIndex, colIndex };
				anchors.push({ sourceKey: cellKey, type: "cellOf", targetKey: tableKey, source: "ax", confidence: "high", evidence: { rowIndex, colIndex } });
				if (rowKey) anchors.push({ sourceKey: cellKey, type: "rowOf", targetKey: rowKey, source: "ax", confidence: "high" });
				if (axRole(cell).toLowerCase() === "columnheader") {
					headersByCol.set(colIndex, cellKey);
					anchors.push({ sourceKey: cellKey, type: "headerFor", targetKey: tableKey, source: "ax", confidence: "medium", evidence: { colIndex } });
				} else {
					dataCells.push({ cellKey, colIndex });
				}
			});
		});
		for (const { cellKey, colIndex } of dataCells) {
			const headerKey = headersByCol.get(colIndex);
			if (headerKey && headerKey !== cellKey) anchors.push({ sourceKey: cellKey, type: "columnOf", targetKey: headerKey, source: "ax", confidence: "medium", evidence: { colIndex } });
		}
	}
	return anchors;
}

function nearestBuiltDescendantKey(node: Record<string, unknown>, nodeById: Map<string, Record<string, unknown>>, builtByKey: Map<string, BuiltEntity>): string | undefined {
	const queue: unknown[] = Array.isArray(node.childIds) ? [...node.childIds] : [];
	let firstMatch: string | undefined;
	let steps = 0;
	while (queue.length && steps < 200) {
		steps += 1;
		const child = nodeById.get(String(queue.shift()));
		if (!child) continue;
		const key = nodeRelationKey(child);
		if (key && builtByKey.has(key)) {
			const name = axName(child);
			if (name) return key;
			if (!firstMatch) firstMatch = key;
		}
		if (Array.isArray(child.childIds)) for (const id of child.childIds) queue.push(id);
	}
	return firstMatch;
}

function resolveAnchorTargets(anchors: RelationAnchor[], builtByKey: Map<string, BuiltEntity>, nodeByBackend: Map<number, Record<string, unknown>>, nodeById: Map<string, Record<string, unknown>>): RelationAnchor[] {
	const out: RelationAnchor[] = [];
	for (const anchor of anchors) {
		const match = /^b:(\d+)$/.exec(anchor.targetKey);
		const node = match ? nodeByBackend.get(Number(match[1])) : undefined;
		if (builtByKey.has(anchor.targetKey)) {
			const isLabelRelation = anchor.type === "labelledBy" || anchor.type === "describedBy";
			if (isLabelRelation && node && !axName(node)) {
				const namedDescendant = nearestBuiltDescendantKey(node, nodeById, builtByKey);
				if (namedDescendant) {
					out.push({ ...anchor, targetKey: namedDescendant });
					continue;
				}
			}
			out.push(anchor);
			continue;
		}
		const redirect = node ? nearestBuiltDescendantKey(node, nodeById, builtByKey) : undefined;
		if (redirect) out.push({ ...anchor, targetKey: redirect });
	}
	return out;
}

export type AxReadResult = { entities: BuiltEntity[]; anchors: RelationAnchor[] };

export async function readAxEntities(server: AbmlAxRuntimeServer, options: AxReadRuntimeOptions): Promise<AxReadResult> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const tree = await sendPersistentCdp(server, {
		browserSessionId: options.browserSessionId,
		tabId: options.tabId,
		timeoutMs,
		cdpMethod: "Accessibility.getFullAXTree",
	});
	const root = valueRecord(tree.data);
	const rootResult = valueRecord(root.result);
	const nodes = Array.isArray(root.nodes) ? root.nodes as Array<Record<string, unknown>> : Array.isArray(rootResult.nodes) ? rootResult.nodes as Array<Record<string, unknown>> : [];
	const context: AxContext = {
		browserSessionId: options.browserSessionId,
		tabId: options.tabId,
		url: options.url,
		observationId: options.observationId,
		capturedAt: options.capturedAt,
	};
	const parentByChildId = new Map<string, Record<string, unknown>>();
	const nodeById = new Map<string, Record<string, unknown>>();
	const nodeByBackend = new Map<number, Record<string, unknown>>();
	for (const node of nodes) {
		const nodeKey = axNodeId(node);
		if (nodeKey) nodeById.set(nodeKey, node);
		const backend = axBackendNodeId(node);
		if (backend !== undefined) nodeByBackend.set(backend, node);
		const childIds = Array.isArray(node.childIds) ? node.childIds : [];
		for (const childId of childIds) {
			const key = typeof childId === "string" ? childId : String(childId);
			if (key) parentByChildId.set(key, node);
		}
	}
	const out: BuiltEntity[] = [];
	const builtByKey = new Map<string, BuiltEntity>();
	const propertyAnchors: RelationAnchor[] = [];
	const currentContainerCandidatesByKey = new Map<string, string[]>();
	const interestingNodes = nodes.filter(isInterestingAxNode);
	const geometryByNode = new Map<Record<string, unknown>, ReturnType<typeof boxModelToGeometry> | undefined>();
	await Promise.all(interestingNodes.map(async (node) => {
		const backendNodeId = Number(node.backendDOMNodeId ?? node.backendNodeId);
		if (Number.isFinite(backendNodeId) && backendNodeId > 0) {
			try {
				const box = await sendPersistentCdp(server, {
					browserSessionId: options.browserSessionId,
					tabId: options.tabId,
					timeoutMs,
					cdpMethod: "DOM.getBoxModel",
					params: { backendNodeId },
				});
				geometryByNode.set(node, boxModelToGeometry(valueRecord(box.data).result ?? valueRecord(box.data)));
			} catch {
				geometryByNode.set(node, undefined);
			}
		}
	}));
	for (const node of interestingNodes) {
		const built = buildAxEntityFromNode(node, context, geometryByNode.get(node));
		const ancestors = ancestorContainerContext(node, parentByChildId);
		if (ancestors.nearest) built.entity.hints = { ...(built.entity.hints || {}), containerRole: ancestors.nearest.role, ...(ancestors.nearest.name ? { containerName: ancestors.nearest.name } : {}) };
		out.push(built);
		const sourceKey = nodeRelationKey(node);
		if (sourceKey) {
			builtByKey.set(sourceKey, built);
			if (ancestors.currentContainerKeys.length) currentContainerCandidatesByKey.set(sourceKey, ancestors.currentContainerKeys);
			for (const anchor of extractAxPropertyRelationAnchors(node)) propertyAnchors.push({ sourceKey, type: anchor.type, targetKey: anchor.targetKey, source: "ax", confidence: "high" });
		}
	}
	for (const [key, candidates] of currentContainerCandidatesByKey) {
		const containerKeys = candidates.filter((candidate) => candidate !== key && builtByKey.has(candidate));
		if (containerKeys.length) builtByKey.get(key)!.entity.hints = { ...(builtByKey.get(key)!.entity.hints || {}), currentContainerKeys: containerKeys };
	}
	const rawAnchors = [
		...propertyAnchors,
		...tableRelationAnchors(nodes, nodeById, builtByKey),
	];
	const anchors = resolveAnchorTargets(rawAnchors, builtByKey, nodeByBackend, nodeById);
	return { entities: out, anchors };
}

export function mergeAxIntoDomEntities(domEntities: Entity[], axEntities: BuiltEntity[]): Entity[] {
	const merged = mergeDomAndAxEntities(domEntities, axEntities);
	const appended = merged.unmatchedAx.map((item) => {
		const refId = registerRefDescriptor({ descriptor: item.descriptor, name: item.entity.name || item.entity.role });
		return { ...item.entity, ref: refId };
	});
	return [...merged.merged, ...appended];
}
