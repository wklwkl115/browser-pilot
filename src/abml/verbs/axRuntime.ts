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

// Container roles that meaningfully "own" their members (item↔list, cell↔row↔table,
// radio↔radiogroup). Walking the AX childIds graph upward to the nearest one gives each
// member entity its structural container — the relationship arm of the ARIA spectrum.
const CONTAINER_ROLES = new Set(["radiogroup", "group", "list", "listbox", "menu", "menubar", "table", "grid", "treegrid", "tree", "tablist", "row", "rowgroup", "feed"]);

export function nearestContainer(node: Record<string, unknown>, parentByChildId: Map<string, Record<string, unknown>>): { role: string; name: string | undefined } | undefined {
	let current = node;
	for (let depth = 0; depth < 24; depth += 1) {
		const id = axNodeId(current);
		if (!id) return undefined;
		const parent = parentByChildId.get(id);
		if (!parent) return undefined;
		const role = axRole(parent).toLowerCase();
		if (CONTAINER_ROLES.has(role)) return { role, name: axName(parent) };
		current = parent;
	}
	return undefined;
}

// Relation key for a node: the same "b:<backendDOMNodeId>" | "a:<axNodeId>" space the entity
// hints register, so anchors resolve to refs in materializeRelations. Backend id preferred.
function nodeRelationKey(node: Record<string, unknown>): string | undefined {
	const backend = axBackendNodeId(node);
	if (backend !== undefined) return `b:${backend}`;
	const id = axNodeId(node);
	return id ? `a:${id}` : undefined;
}

const TABLE_ROLES = new Set(["table", "grid", "treegrid"]);
const CELL_ROLES = new Set(["cell", "gridcell", "columnheader", "rowheader"]);
// Containers whose aria-current item is a navigation/selection relation (currentIn target).
const CURRENT_CONTAINER_ROLES = new Set(["navigation", "menu", "menubar", "list", "listbox", "tablist", "tree", "radiogroup"]);

// Ordered rows of a table/grid, via childIds forward traversal (through rowgroup wrappers),
// not descending into nested tables. Order = document order ⇒ stable positional indices.
function collectTableRows(table: Record<string, unknown>, nodeById: Map<string, Record<string, unknown>>): Array<Record<string, unknown>> {
	const rows: Array<Record<string, unknown>> = [];
	const visit = (node: Record<string, unknown>, depth: number) => {
		if (depth > 24) return;
		const childIds = Array.isArray(node.childIds) ? node.childIds : [];
		for (const childId of childIds) {
			const child = nodeById.get(typeof childId === "string" ? childId : String(childId));
			if (!child) continue;
			const role = axRole(child).toLowerCase();
			if (TABLE_ROLES.has(role)) continue; // don't cross into a nested table
			if (role === "row") { rows.push(child); visit(child, depth + 1); }
			else visit(child, depth + 1);
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

// Table/grid relations: each cell → its table (cellOf), its row (rowOf), and its column header
// (columnOf); each column header → its table (headerFor). Row/column indices come from the AX
// structure when present (aria-row/colindex) else from document position — generic, no per-site
// logic. Mutates cell entities' structure so row/col context rides on the entity too.
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

// currentIn container: the nearest nav/list/menu ancestor's key. Stashed on every node's entity as
// hints.currentContainerKey; the DOM-sourced derive step (deriveStateRelationAnchors) turns it into a
// currentIn relation when the entity carries aria-current. We can't emit the relation here because
// Chrome's getFullAXTree omits aria-current — the current *state* arrives from the DOM scan, post-merge.
function nearestCurrentContainerKey(node: Record<string, unknown>, parentByChildId: Map<string, Record<string, unknown>>): string | undefined {
	let cursor = node;
	for (let depth = 0; depth < 24; depth += 1) {
		const id = axNodeId(cursor);
		if (!id) return undefined;
		const parent = parentByChildId.get(id);
		if (!parent) return undefined;
		if (CURRENT_CONTAINER_ROLES.has(axRole(parent).toLowerCase())) return nodeRelationKey(parent);
		cursor = parent;
	}
	return undefined;
}

// AX relation properties (aria-labelledby/describedby/controls) reference the target *element*,
// but that element's AX node is frequently a non-interesting `generic` wrapper whose visible text
// lives in a child StaticText with a different backend id (e.g. <span id=lbl>Email</span> → generic
// node + StaticText child). The wrapper isn't a built entity, so the relation target wouldn't
// resolve. Redirect such targets to the nearest built descendant so labelledBy/describedBy/controls
// reliably land on the entity that actually carries the name. Breadth-first, bounded.
function nearestBuiltDescendantKey(node: Record<string, unknown>, nodeById: Map<string, Record<string, unknown>>, builtByKey: Map<string, BuiltEntity>): string | undefined {
	const queue: unknown[] = Array.isArray(node.childIds) ? [...node.childIds] : [];
	let steps = 0;
	while (queue.length && steps < 200) {
		steps += 1;
		const child = nodeById.get(String(queue.shift()));
		if (!child) continue;
		const key = nodeRelationKey(child);
		if (key && builtByKey.has(key)) return key;
		if (Array.isArray(child.childIds)) for (const id of child.childIds) queue.push(id);
	}
	return undefined;
}

function resolveAnchorTargets(anchors: RelationAnchor[], builtByKey: Map<string, BuiltEntity>, nodeByBackend: Map<number, Record<string, unknown>>, nodeById: Map<string, Record<string, unknown>>): RelationAnchor[] {
	const out: RelationAnchor[] = [];
	for (const anchor of anchors) {
		if (builtByKey.has(anchor.targetKey)) { out.push(anchor); continue; }
		const match = /^b:(\d+)$/.exec(anchor.targetKey);
		const node = match ? nodeByBackend.get(Number(match[1])) : undefined;
		const redirect = node ? nearestBuiltDescendantKey(node, nodeById, builtByKey) : undefined;
		if (redirect) out.push({ ...anchor, targetKey: redirect });
		// else drop: an unresolved target would be discarded in materialization anyway.
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
	for (const node of nodes) {
		if (!isInterestingAxNode(node)) continue;
		const backendNodeId = Number(node.backendDOMNodeId ?? node.backendNodeId);
		let geometry: ReturnType<typeof boxModelToGeometry> | undefined;
		if (Number.isFinite(backendNodeId) && backendNodeId > 0) {
			try {
				const box = await sendPersistentCdp(server, {
					browserSessionId: options.browserSessionId,
					tabId: options.tabId,
					timeoutMs,
					cdpMethod: "DOM.getBoxModel",
					params: { backendNodeId },
				});
				geometry = boxModelToGeometry(valueRecord(box.data).result ?? valueRecord(box.data));
			} catch {
				geometry = undefined;
			}
		}
		const built = buildAxEntityFromNode(node, context, geometry);
		const container = nearestContainer(node, parentByChildId);
		if (container) built.entity.hints = { ...(built.entity.hints || {}), containerRole: container.role, ...(container.name ? { containerName: container.name } : {}) };
		const currentContainerKey = nearestCurrentContainerKey(node, parentByChildId);
		if (currentContainerKey) built.entity.hints = { ...(built.entity.hints || {}), currentContainerKey };
		out.push(built);
		const sourceKey = nodeRelationKey(node);
		if (sourceKey) {
			builtByKey.set(sourceKey, built);
			for (const anchor of extractAxPropertyRelationAnchors(node)) propertyAnchors.push({ sourceKey, type: anchor.type, targetKey: anchor.targetKey, source: "ax", confidence: "high" });
		}
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
