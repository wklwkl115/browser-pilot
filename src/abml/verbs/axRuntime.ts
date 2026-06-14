import type { BrowserBridgeServer } from "../../driver/BrowserBridgeServer.js";
import { isRecord } from "../../utils/records.js";
import { assertBridgeCommandSucceeded } from "../../tools/bridgeResultValidation.js";
import { registerRefDescriptor } from "../../resources/resourceStore.js";
import type { Entity } from "../entity.js";
import { axBackendNodeId, axName, axNodeId, axRole, buildAxEntityFromNode, boxModelToGeometry, extractAxPropertyRelationAnchors, isInterestingAxNode, mergeDomAndAxEntities, type AxContext } from "../ax.js";
import type { BuiltEntity } from "../entity.js";
import type { SnapshotGeometryEntry } from "../identityBootstrap.js";
import type { PaintOrderEntry, RelationAnchor } from "../relations.js";

export type AbmlAxRuntimeServer = Pick<BrowserBridgeServer, "sendCommand">;

export type AxReadRuntimeOptions = {
	browserSessionId?: string;
	tabId: number;
	observationId: string;
	url?: string;
	capturedAt?: number;
	timeoutMs?: number;
	cacheKey?: string;
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

export type AxReadDiagnostics = {
	axMs: number;
	cdpCalls: number;
	geometryCdpCalls: number;
	snapshotGeometryCount?: number;
	snapshotGeometryUnavailable?: boolean;
	snapshotStartedAt?: string;
	snapshotEndedAt?: string;
	paintOrder?: { supported: boolean; entryCount: number; ownerBackendNodeIdCount: number; snapshotUnsupported?: boolean; geometryFallbackUsed?: boolean };
	nodeCount: number;
	interestingNodeCount: number;
	cacheHit: boolean;
};

export type AxReadResult = { entities: BuiltEntity[]; anchors: RelationAnchor[]; snapshotGeometryEntries?: SnapshotGeometryEntry[]; paintOrderEntries?: PaintOrderEntry[]; diagnostics?: AxReadDiagnostics };

type AxRawCacheEntry = {
	nodes: Array<Record<string, unknown>>;
	geometryByBackend: Map<number, ReturnType<typeof boxModelToGeometry> | undefined>;
	snapshotGeometryEntries?: SnapshotGeometryEntry[];
	paintOrderEntries?: PaintOrderEntry[];
	createdAt: number;
};

const AX_RAW_CACHE_MAX = 16;
const axRawCache = new Map<string, AxRawCacheEntry>();

function axRawCacheKey(options: AxReadRuntimeOptions): string | undefined {
	if (!options.cacheKey) return undefined;
	return [options.browserSessionId || "default", options.tabId, options.cacheKey].join("\u0000");
}

function rememberAxRawCache(key: string, entry: AxRawCacheEntry): void {
	axRawCache.set(key, entry);
	while (axRawCache.size > AX_RAW_CACHE_MAX) {
		const first = axRawCache.keys().next().value;
		if (first === undefined) break;
		axRawCache.delete(first);
	}
}

type AxGeometry = ReturnType<typeof boxModelToGeometry>;

function geometryFromSnapshotBounds(value: unknown): AxGeometry | undefined {
	const bounds = Array.isArray(value) ? value.map((item) => Number(item)) : [];
	const [x, y, width, height] = bounds;
	if (![x, y, width, height].every((item) => Number.isFinite(item))) return undefined;
	const w = Math.max(0, width);
	const h = Math.max(0, height);
	return {
		box: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) },
		point: { x: Math.round(x + w / 2), y: Math.round(y + h / 2) },
	};
}

function snapshotGeometryByBackend(value: unknown): Map<number, AxGeometry> {
	const root = isRecord(valueRecord(value).result) ? valueRecord(value).result as Record<string, unknown> : valueRecord(value);
	const documents = Array.isArray(root.documents) ? root.documents : [];
	const out = new Map<number, AxGeometry>();
	for (const documentSnapshot of documents) {
		const doc = valueRecord(documentSnapshot);
		const nodes = valueRecord(doc.nodes);
		const layout = valueRecord(doc.layout);
		const backendIds = Array.isArray(nodes.backendNodeId) ? nodes.backendNodeId : [];
		const nodeIndexes = Array.isArray(layout.nodeIndex) ? layout.nodeIndex : [];
		const bounds = Array.isArray(layout.bounds) ? layout.bounds : [];
		for (let i = 0; i < nodeIndexes.length; i += 1) {
			const nodeIndex = Number(nodeIndexes[i]);
			const backendNodeId = Number(backendIds[nodeIndex]);
			if (!Number.isFinite(backendNodeId) || backendNodeId <= 0) continue;
			const geometry = geometryFromSnapshotBounds(bounds[i]);
			if (geometry) out.set(backendNodeId, geometry);
		}
	}
	return out;
}

function snapshotString(strings: unknown[], index: unknown): string {
	const text = strings[Number(index)];
	return typeof text === "string" ? text : String(index ?? "");
}

function snapshotAttrs(nodes: Record<string, unknown>, strings: unknown[], nodeIndex: number): Record<string, string> | undefined {
	const raw = Array.isArray(nodes.attributes) && Array.isArray(nodes.attributes[nodeIndex]) ? nodes.attributes[nodeIndex] as unknown[] : [];
	const out: Record<string, string> = {};
	for (let i = 0; i + 1 < raw.length; i += 2) out[snapshotString(strings, raw[i])] = snapshotString(strings, raw[i + 1]);
	return Object.keys(out).length ? out : undefined;
}

function snapshotGeometryEntries(value: unknown): SnapshotGeometryEntry[] {
	const root = isRecord(valueRecord(value).result) ? valueRecord(value).result as Record<string, unknown> : valueRecord(value);
	const documents = Array.isArray(root.documents) ? root.documents : [];
	const strings = Array.isArray(root.strings) ? root.strings : [];
	const out: SnapshotGeometryEntry[] = [];
	const seen = new Set<number>();
	for (const documentSnapshot of documents) {
		const doc = valueRecord(documentSnapshot);
		const nodes = valueRecord(doc.nodes);
		const layout = valueRecord(doc.layout);
		const backendIds = Array.isArray(nodes.backendNodeId) ? nodes.backendNodeId : [];
		const nodeIndexes = Array.isArray(layout.nodeIndex) ? layout.nodeIndex : [];
		const bounds = Array.isArray(layout.bounds) ? layout.bounds : [];
		for (let i = 0; i < nodeIndexes.length; i += 1) {
			const nodeIndex = Number(nodeIndexes[i]);
			const backendNodeId = Number(backendIds[nodeIndex]);
			if (!Number.isFinite(backendNodeId) || backendNodeId <= 0 || seen.has(backendNodeId)) continue;
			const geometry = geometryFromSnapshotBounds(bounds[i]);
			if (!geometry?.box) continue;
			out.push({ backendNodeId, bounds: geometry.box, ...(snapshotAttrs(nodes, strings, nodeIndex) ? { attrs: snapshotAttrs(nodes, strings, nodeIndex) } : {}) });
			seen.add(backendNodeId);
		}
	}
	return out;
}

function snapshotPaintOrderEntries(value: unknown): PaintOrderEntry[] {
	const root = isRecord(valueRecord(value).result) ? valueRecord(value).result as Record<string, unknown> : valueRecord(value);
	const documents = Array.isArray(root.documents) ? root.documents : [];
	const out: PaintOrderEntry[] = [];
	const seen = new Set<number>();
	for (const documentSnapshot of documents) {
		const doc = valueRecord(documentSnapshot);
		const nodes = valueRecord(doc.nodes);
		const layout = valueRecord(doc.layout);
		const backendIds = Array.isArray(nodes.backendNodeId) ? nodes.backendNodeId : [];
		const nodeIndexes = Array.isArray(layout.nodeIndex) ? layout.nodeIndex : [];
		const bounds = Array.isArray(layout.bounds) ? layout.bounds : [];
		const paintOrders = Array.isArray(layout.paintOrders) ? layout.paintOrders : Array.isArray(layout.paintOrder) ? layout.paintOrder : [];
		for (let i = 0; i < nodeIndexes.length; i += 1) {
			const nodeIndex = Number(nodeIndexes[i]);
			const backendNodeId = Number(backendIds[nodeIndex]);
			const paintOrder = Number(paintOrders[i]);
			if (!Number.isFinite(backendNodeId) || backendNodeId <= 0 || !Number.isFinite(paintOrder) || seen.has(backendNodeId)) continue;
			const geometry = geometryFromSnapshotBounds(bounds[i]);
			if (!geometry?.box) continue;
			out.push({ backendNodeId, paintOrder, bounds: geometry.box });
			seen.add(backendNodeId);
		}
	}
	return out;
}

export async function readAxEntities(server: AbmlAxRuntimeServer, options: AxReadRuntimeOptions): Promise<AxReadResult> {
	const startedAt = Date.now();
	const timeoutMs = options.timeoutMs ?? 10_000;
	const rawCacheKey = axRawCacheKey(options);
	const cachedRaw = rawCacheKey ? axRawCache.get(rawCacheKey) : undefined;
	let cdpCalls = 0;
	let geometryCdpCalls = 0;
	const sendCdp = async (request: { browserSessionId?: string; tabId: number; timeoutMs: number; cdpMethod: string; params?: Record<string, unknown> }) => {
		cdpCalls += 1;
		if (request.cdpMethod === "DOM.getBoxModel") geometryCdpCalls += 1;
		return await sendPersistentCdp(server, request);
	};
	let nodes: Array<Record<string, unknown>>;
	const rawGeometryByBackend = cachedRaw ? new Map(cachedRaw.geometryByBackend) : new Map<number, ReturnType<typeof boxModelToGeometry> | undefined>();
	let snapshotEntries = cachedRaw?.snapshotGeometryEntries ? [...cachedRaw.snapshotGeometryEntries] : [];
	let paintOrderEntries = cachedRaw?.paintOrderEntries ? [...cachedRaw.paintOrderEntries] : [];
	if (cachedRaw) {
		nodes = cachedRaw.nodes;
	} else {
		const tree = await sendCdp({
			browserSessionId: options.browserSessionId,
			tabId: options.tabId,
			timeoutMs,
			cdpMethod: "Accessibility.getFullAXTree",
		});
		const root = valueRecord(tree.data);
		const rootResult = valueRecord(root.result);
		nodes = Array.isArray(root.nodes) ? root.nodes as Array<Record<string, unknown>> : Array.isArray(rootResult.nodes) ? rootResult.nodes as Array<Record<string, unknown>> : [];
	}
	const context: AxContext = {
		browserSessionId: options.browserSessionId,
		tabId: options.tabId,
		url: options.url,
		observationId: options.observationId,
		capturedAt: options.capturedAt ?? Date.now(),
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
	let snapshotGeometryCount = 0;
	let snapshotGeometryUnavailable = false;
	let snapshotStartedAt: string | undefined;
	let snapshotEndedAt: string | undefined;
	let paintOrderSnapshotUnsupported = false;
	let paintOrderGeometryFallbackUsed = false;
	if (!cachedRaw) {
		let snapshotData: unknown;
		try {
			snapshotStartedAt = new Date().toISOString();
			const snapshot = await sendCdp({
				browserSessionId: options.browserSessionId,
				tabId: options.tabId,
				timeoutMs,
				cdpMethod: "DOMSnapshot.captureSnapshot",
				params: { computedStyles: [], includeDOMRects: true, includePaintOrder: true },
			});
			snapshotData = snapshot.data;
			snapshotEndedAt = new Date().toISOString();
			paintOrderEntries = snapshotPaintOrderEntries(snapshotData);
		} catch {
			paintOrderSnapshotUnsupported = true;
			try {
				if (!snapshotStartedAt) snapshotStartedAt = new Date().toISOString();
				const snapshot = await sendCdp({
					browserSessionId: options.browserSessionId,
					tabId: options.tabId,
					timeoutMs,
					cdpMethod: "DOMSnapshot.captureSnapshot",
					params: { computedStyles: [], includeDOMRects: true },
				});
				snapshotData = snapshot.data;
				snapshotEndedAt = new Date().toISOString();
				paintOrderGeometryFallbackUsed = true;
			} catch {
				snapshotEndedAt = new Date().toISOString();
				snapshotGeometryUnavailable = true;
			}
		}
		if (snapshotData !== undefined) {
			snapshotEntries = snapshotGeometryEntries(snapshotData);
			for (const [backendNodeId, geometry] of snapshotGeometryByBackend(snapshotData)) {
				if (!rawGeometryByBackend.has(backendNodeId)) {
					rawGeometryByBackend.set(backendNodeId, geometry);
					snapshotGeometryCount += 1;
				}
			}
		}
	}
	await Promise.all(interestingNodes.map(async (node) => {
		const backendNodeId = Number(node.backendDOMNodeId ?? node.backendNodeId);
		if (Number.isFinite(backendNodeId) && backendNodeId > 0) {
			if (rawGeometryByBackend.has(backendNodeId)) {
				geometryByNode.set(node, rawGeometryByBackend.get(backendNodeId));
				return;
			}
			try {
				const box = await sendCdp({
					browserSessionId: options.browserSessionId,
					tabId: options.tabId,
					timeoutMs,
					cdpMethod: "DOM.getBoxModel",
					params: { backendNodeId },
				});
				const geometry = boxModelToGeometry(valueRecord(box.data).result ?? valueRecord(box.data));
				rawGeometryByBackend.set(backendNodeId, geometry);
				geometryByNode.set(node, geometry);
			} catch {
				rawGeometryByBackend.set(backendNodeId, undefined);
				geometryByNode.set(node, undefined);
			}
		}
	}));
	if (rawCacheKey && !cachedRaw) rememberAxRawCache(rawCacheKey, { nodes, geometryByBackend: rawGeometryByBackend, snapshotGeometryEntries: snapshotEntries, paintOrderEntries, createdAt: Date.now() });
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
	return {
		entities: out,
		anchors,
		...(snapshotEntries.length ? { snapshotGeometryEntries: snapshotEntries } : {}),
		...(paintOrderEntries.length ? { paintOrderEntries } : {}),
		diagnostics: {
			axMs: Date.now() - startedAt,
			cdpCalls,
			geometryCdpCalls,
			...(snapshotGeometryCount ? { snapshotGeometryCount } : {}),
			...(snapshotGeometryUnavailable ? { snapshotGeometryUnavailable: true } : {}),
			...(snapshotStartedAt ? { snapshotStartedAt } : {}),
			...(snapshotEndedAt ? { snapshotEndedAt } : {}),
			paintOrder: {
				supported: paintOrderEntries.length > 0,
				entryCount: paintOrderEntries.length,
				ownerBackendNodeIdCount: new Set(paintOrderEntries.map((entry) => entry.backendNodeId)).size,
				...(paintOrderSnapshotUnsupported ? { snapshotUnsupported: true } : {}),
				...(paintOrderGeometryFallbackUsed ? { geometryFallbackUsed: true } : {}),
			},
			nodeCount: nodes.length,
			interestingNodeCount: interestingNodes.length,
			cacheHit: !!cachedRaw,
		},
	};
}

export function mergeAxIntoDomEntities(domEntities: Entity[], axEntities: BuiltEntity[]): Entity[] {
	const merged = mergeDomAndAxEntities(domEntities, axEntities);
	const appended = merged.unmatchedAx.map((item) => {
		const refId = registerRefDescriptor({ descriptor: item.descriptor, name: item.entity.name || item.entity.role });
		return { ...item.entity, ref: refId };
	});
	return [...merged.merged, ...appended];
}
