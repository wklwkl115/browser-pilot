import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { isRecord } from "../../utils/records.js";
import { assertBridgeCommandSucceeded } from "../../utils/bridgeResultValidation.js";
import { registerRefDescriptor } from "../../resources/resourceRefs.js";
import type { Entity } from "../../kernels/abml/entity.js";
import { axBackendNodeId, axName, axNodeId, axRole, buildAxEntityFromNode, boxModelToGeometry, extractAxPropertyRelationAnchors, isInterestingAxNode, mergeDomAndAxEntities, type AxContext, type AxFusionDiagnostics } from "../../kernels/abml/ax.js";
import type { BuiltEntity } from "../../kernels/abml/entity.js";
import type { SnapshotGeometryEntry } from "../../kernels/abml/identityBootstrap.js";
import type { PaintOrderEntry, RelationAnchor } from "../../kernels/abml/relations.js";

export type AbmlAxRuntimeServer = Pick<BrowserCommandRuntimePort, "sendCommand">;

export type AxReadRuntimeOptions = {
	browserSessionId?: string;
	tabId: number;
	targetGeneration?: number;
	pageEpoch?: string;
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
	bounded: { maxGeometryCdpCalls: number; geometryFallbackTruncated: boolean };
};

export type AxReadResult = { entities: BuiltEntity[]; anchors: RelationAnchor[]; snapshotGeometryEntries?: SnapshotGeometryEntry[]; paintOrderEntries?: PaintOrderEntry[]; diagnostics?: AxReadDiagnostics };

export type PartialAxStatus = "ok" | "skipped" | "failed" | "degraded";

export type PartialAxDiagnostics = {
	provider: "partial-ax";
	status: PartialAxStatus;
	backendNodeId?: number;
	fetchRelatives: boolean;
	timeoutMs: number;
	maxNodes: number;
	cdpCalls: number;
	nodeCount: number;
	elapsedMs: number;
	reason?: "missing-backendNodeId" | "empty" | "over-budget" | "unsupported" | "error";
	error?: { code?: string; message: string };
};

export type PartialAxResult = { nodes: Array<Record<string, unknown>>; diagnostics: PartialAxDiagnostics };

type AxRawCacheEntry = {
	nodes: Array<Record<string, unknown>>;
	geometryByBackend: Map<number, ReturnType<typeof boxModelToGeometry> | undefined>;
	snapshotGeometryEntries?: SnapshotGeometryEntry[];
	paintOrderEntries?: PaintOrderEntry[];
	createdAt: number;
};

const AX_RAW_CACHE_MAX = 16;
const AX_GEOMETRY_FALLBACK_MAX_CALLS = 64;
const axRawCache = new Map<string, AxRawCacheEntry>();

function axRawCacheKey(options: AxReadRuntimeOptions): string | undefined {
	if (!options.cacheKey) return undefined;
	return [options.browserSessionId || "default", options.tabId, options.cacheKey].join("\u0000");
}

function cdpErrorDetails(error: unknown): { code?: string; message: string } {
	if (isRecord(error)) {
		const code = typeof error.code === "string" ? error.code : undefined;
		const message = typeof error.message === "string" ? error.message : String(error);
		return { ...(code ? { code } : {}), message };
	}
	if (error instanceof Error) return { message: error.message };
	return { message: String(error) };
}

function partialAxDiagnostics(input: Omit<PartialAxDiagnostics, "provider">): PartialAxDiagnostics {
	return { provider: "partial-ax", ...input };
}

export async function readPartialAxTree(server: AbmlAxRuntimeServer, options: { browserSessionId?: string; tabId: number; backendNodeId?: number; timeoutMs?: number; maxNodes?: number; fetchRelatives?: boolean }): Promise<PartialAxResult> {
	const startedAt = Date.now();
	const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? 1_500, 5_000));
	const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 12, 100));
	const fetchRelatives = options.fetchRelatives === true;
	const backendNodeId = Number(options.backendNodeId);
	const base = { backendNodeId: Number.isFinite(backendNodeId) && backendNodeId > 0 ? backendNodeId : undefined, fetchRelatives, timeoutMs, maxNodes, cdpCalls: 0, nodeCount: 0, elapsedMs: 0 };
	if (base.backendNodeId === undefined) {
		return { nodes: [], diagnostics: partialAxDiagnostics({ ...base, status: "skipped", reason: "missing-backendNodeId", elapsedMs: Date.now() - startedAt }) };
	}
	try {
		const partial = await sendPersistentCdp(server, {
			browserSessionId: options.browserSessionId,
			tabId: options.tabId,
			timeoutMs,
			cdpMethod: "Accessibility.getPartialAXTree",
			params: { backendNodeId: base.backendNodeId, fetchRelatives },
		});
		const root = valueRecord(partial.data);
		const rootResult = valueRecord(root.result);
		const rawNodes = Array.isArray(root.nodes) ? root.nodes : Array.isArray(rootResult.nodes) ? rootResult.nodes : [];
		const nodeCount = rawNodes.length;
		if (!nodeCount) {
			return { nodes: [], diagnostics: partialAxDiagnostics({ ...base, cdpCalls: 1, status: "degraded", reason: "empty", elapsedMs: Date.now() - startedAt }) };
		}
		const nodes = rawNodes.filter(isRecord).slice(0, maxNodes).map((node) => ({ ...node }));
		const overBudget = nodeCount > maxNodes;
		return {
			nodes,
			diagnostics: partialAxDiagnostics({ ...base, cdpCalls: 1, nodeCount, status: overBudget ? "degraded" : "ok", ...(overBudget ? { reason: "over-budget" } : {}), elapsedMs: Date.now() - startedAt }),
		};
	} catch (error) {
		const details = cdpErrorDetails(error);
		const lowered = details.message.toLowerCase();
		const unsupported = lowered.includes("wasn't found") || lowered.includes("not found") || lowered.includes("unknown method") || lowered.includes("not supported");
		return { nodes: [], diagnostics: partialAxDiagnostics({ ...base, cdpCalls: 1, status: "failed", reason: unsupported ? "unsupported" : "error", error: details, elapsedMs: Date.now() - startedAt }) };
	}
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

type SnapshotLayoutEntry = { backendNodeId: number; geometry: NonNullable<AxGeometry>; attrs?: Record<string, string>; paintOrder?: number };

function snapshotLayoutEntries(value: unknown): SnapshotLayoutEntry[] {
	const root = isRecord(valueRecord(value).result) ? valueRecord(value).result as Record<string, unknown> : valueRecord(value);
	const documents = Array.isArray(root.documents) ? root.documents : [];
	const strings = Array.isArray(root.strings) ? root.strings : [];
	const out: SnapshotLayoutEntry[] = [];
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
			if (!Number.isFinite(backendNodeId) || backendNodeId <= 0) continue;
			const geometry = geometryFromSnapshotBounds(bounds[i]);
			if (!geometry) continue;
			const paintOrder = Number(paintOrders[i]);
			out.push({ backendNodeId, geometry, ...(snapshotAttrs(nodes, strings, nodeIndex) ? { attrs: snapshotAttrs(nodes, strings, nodeIndex) } : {}), ...(Number.isFinite(paintOrder) ? { paintOrder } : {}) });
		}
	}
	return out;
}

function snapshotGeometryByBackend(value: unknown): Map<number, AxGeometry> {
	return new Map(snapshotLayoutEntries(value).map((entry) => [entry.backendNodeId, entry.geometry]));
}

function uniqueSnapshotLayoutEntries(entries: SnapshotLayoutEntry[]): SnapshotLayoutEntry[] {
	const seen = new Set<number>();
	return entries.filter((entry) => {
		if (seen.has(entry.backendNodeId)) return false;
		seen.add(entry.backendNodeId);
		return true;
	});
}

function snapshotGeometryEntries(value: unknown): SnapshotGeometryEntry[] {
	return uniqueSnapshotLayoutEntries(snapshotLayoutEntries(value)).map((entry) => ({ backendNodeId: entry.backendNodeId, bounds: entry.geometry.box!, ...(entry.attrs ? { attrs: entry.attrs } : {}) }));
}

function snapshotPaintOrderEntries(value: unknown): PaintOrderEntry[] {
	return uniqueSnapshotLayoutEntries(snapshotLayoutEntries(value).filter((entry) => entry.paintOrder !== undefined)).map((entry) => ({ backendNodeId: entry.backendNodeId, paintOrder: entry.paintOrder!, bounds: entry.geometry.box! }));
}

type AxCdpRequest = Parameters<typeof sendPersistentCdp>[1];
type AxCdpSender = (request: AxCdpRequest) => ReturnType<typeof sendPersistentCdp>;
type AxNodeIndexes = {
	parentByChildId: Map<string, Record<string, unknown>>;
	nodeById: Map<string, Record<string, unknown>>;
	nodeByBackend: Map<number, Record<string, unknown>>;
};
type AxSnapshotRead = {
	rawGeometryByBackend: Map<number, AxGeometry | undefined>;
	snapshotEntries: SnapshotGeometryEntry[];
	paintOrderEntries: PaintOrderEntry[];
	snapshotGeometryCount: number;
	snapshotGeometryUnavailable: boolean;
	snapshotStartedAt?: string;
	snapshotEndedAt?: string;
	paintOrderSnapshotUnsupported: boolean;
	paintOrderGeometryFallbackUsed: boolean;
};
type AxGeometryRead = { geometryByNode: Map<Record<string, unknown>, AxGeometry | undefined>; geometryFallbackTruncated: boolean };

async function loadAxNodes(sendCdp: AxCdpSender, options: AxReadRuntimeOptions, timeoutMs: number, cached: AxRawCacheEntry | undefined): Promise<Array<Record<string, unknown>>> {
	if (cached) return cached.nodes;
	const tree = await sendCdp({ browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs, cdpMethod: "Accessibility.getFullAXTree" });
	const root = valueRecord(tree.data);
	const rootResult = valueRecord(root.result);
	return Array.isArray(root.nodes) ? root.nodes as Array<Record<string, unknown>> : Array.isArray(rootResult.nodes) ? rootResult.nodes as Array<Record<string, unknown>> : [];
}

function indexAxNodes(nodes: Array<Record<string, unknown>>): AxNodeIndexes {
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
	return { parentByChildId, nodeById, nodeByBackend };
}

async function requestDomSnapshot(sendCdp: AxCdpSender, options: AxReadRuntimeOptions, timeoutMs: number, includePaintOrder: boolean): Promise<unknown> {
	const params = { computedStyles: [], includeDOMRects: true, ...(includePaintOrder ? { includePaintOrder: true } : {}) };
	return (await sendCdp({ browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs, cdpMethod: "DOMSnapshot.captureSnapshot", params })).data;
}

async function readAxSnapshot(sendCdp: AxCdpSender, options: AxReadRuntimeOptions, timeoutMs: number, cached: AxRawCacheEntry | undefined): Promise<AxSnapshotRead> {
	const rawGeometryByBackend = cached ? new Map(cached.geometryByBackend) : new Map<number, AxGeometry | undefined>();
	let snapshotEntries = cached?.snapshotGeometryEntries ? [...cached.snapshotGeometryEntries] : [];
	let paintOrderEntries = cached?.paintOrderEntries ? [...cached.paintOrderEntries] : [];
	let snapshotGeometryCount = cached?.snapshotGeometryEntries?.length ?? 0;
	let snapshotGeometryUnavailable = false;
	let snapshotStartedAt: string | undefined;
	let snapshotEndedAt: string | undefined;
	let paintOrderSnapshotUnsupported = false;
	let paintOrderGeometryFallbackUsed = false;
	if (!cached) {
		let snapshotData: unknown;
		snapshotStartedAt = new Date().toISOString();
		try {
			snapshotData = await requestDomSnapshot(sendCdp, options, timeoutMs, true);
			paintOrderEntries = snapshotPaintOrderEntries(snapshotData);
		} catch {
			paintOrderSnapshotUnsupported = true;
			try {
				snapshotData = await requestDomSnapshot(sendCdp, options, timeoutMs, false);
				paintOrderGeometryFallbackUsed = true;
			} catch {
				snapshotGeometryUnavailable = true;
			}
		}
		snapshotEndedAt = new Date().toISOString();
		if (snapshotData !== undefined) {
			snapshotEntries = snapshotGeometryEntries(snapshotData);
			for (const [backendNodeId, geometry] of snapshotGeometryByBackend(snapshotData)) {
				if (rawGeometryByBackend.has(backendNodeId)) continue;
				rawGeometryByBackend.set(backendNodeId, geometry);
				snapshotGeometryCount += 1;
			}
		}
	}
	return { rawGeometryByBackend, snapshotEntries, paintOrderEntries, snapshotGeometryCount, snapshotGeometryUnavailable, snapshotStartedAt, snapshotEndedAt, paintOrderSnapshotUnsupported, paintOrderGeometryFallbackUsed };
}

async function readAxGeometry(sendCdp: AxCdpSender, options: AxReadRuntimeOptions, timeoutMs: number, nodes: Array<Record<string, unknown>>, rawGeometryByBackend: Map<number, AxGeometry | undefined>): Promise<AxGeometryRead> {
	const geometryByNode = new Map<Record<string, unknown>, AxGeometry | undefined>();
	let geometryFallbackAttempts = 0;
	let geometryFallbackTruncated = false;
	await Promise.all(nodes.map(async (node) => {
		const backendNodeId = Number(node.backendDOMNodeId ?? node.backendNodeId);
		if (!Number.isFinite(backendNodeId) || backendNodeId <= 0) return;
		if (rawGeometryByBackend.has(backendNodeId)) {
			geometryByNode.set(node, rawGeometryByBackend.get(backendNodeId));
			return;
		}
		if (geometryFallbackAttempts >= AX_GEOMETRY_FALLBACK_MAX_CALLS) {
			geometryFallbackTruncated = true;
			geometryByNode.set(node, undefined);
			return;
		}
		geometryFallbackAttempts += 1;
		try {
			const box = await sendCdp({ browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs, cdpMethod: "DOM.getBoxModel", params: { backendNodeId } });
			const geometry = boxModelToGeometry(valueRecord(box.data).result ?? valueRecord(box.data));
			rawGeometryByBackend.set(backendNodeId, geometry);
			geometryByNode.set(node, geometry);
		} catch {
			rawGeometryByBackend.set(backendNodeId, undefined);
			geometryByNode.set(node, undefined);
		}
	}));
	return { geometryByNode, geometryFallbackTruncated };
}

function assembleAxEntities(nodes: Array<Record<string, unknown>>, interestingNodes: Array<Record<string, unknown>>, context: AxContext, indexes: AxNodeIndexes, geometryByNode: Map<Record<string, unknown>, AxGeometry | undefined>): Pick<AxReadResult, "entities" | "anchors"> {
	const entities: BuiltEntity[] = [];
	const builtByKey = new Map<string, BuiltEntity>();
	const propertyAnchors: RelationAnchor[] = [];
	const currentContainerCandidatesByKey = new Map<string, string[]>();
	for (const node of interestingNodes) {
		const built = buildAxEntityFromNode(node, context, geometryByNode.get(node));
		const ancestors = ancestorContainerContext(node, indexes.parentByChildId);
		if (ancestors.nearest) built.entity.hints = { ...(built.entity.hints || {}), containerRole: ancestors.nearest.role, ...(ancestors.nearest.name ? { containerName: ancestors.nearest.name } : {}) };
		entities.push(built);
		const sourceKey = nodeRelationKey(node);
		if (!sourceKey) continue;
		builtByKey.set(sourceKey, built);
		if (ancestors.currentContainerKeys.length) currentContainerCandidatesByKey.set(sourceKey, ancestors.currentContainerKeys);
		for (const anchor of extractAxPropertyRelationAnchors(node)) propertyAnchors.push({ sourceKey, type: anchor.type, targetKey: anchor.targetKey, source: "ax", confidence: "high" });
	}
	for (const [key, candidates] of currentContainerCandidatesByKey) {
		const containerKeys = candidates.filter((candidate) => candidate !== key && builtByKey.has(candidate));
		if (containerKeys.length) builtByKey.get(key)!.entity.hints = { ...(builtByKey.get(key)!.entity.hints || {}), currentContainerKeys: containerKeys };
	}
	const anchors = resolveAnchorTargets([...propertyAnchors, ...tableRelationAnchors(nodes, indexes.nodeById, builtByKey)], builtByKey, indexes.nodeByBackend, indexes.nodeById);
	return { entities, anchors };
}

function projectAxReadResult(input: { startedAt: number; cdpCalls: number; geometryCdpCalls: number; nodes: Array<Record<string, unknown>>; interestingNodes: Array<Record<string, unknown>>; cached: boolean; snapshot: AxSnapshotRead; geometry: AxGeometryRead; assembled: Pick<AxReadResult, "entities" | "anchors"> }): AxReadResult {
	const { snapshot, geometry } = input;
	return {
		...input.assembled,
		...(snapshot.snapshotEntries.length ? { snapshotGeometryEntries: snapshot.snapshotEntries } : {}),
		...(snapshot.paintOrderEntries.length ? { paintOrderEntries: snapshot.paintOrderEntries } : {}),
		diagnostics: {
			axMs: Date.now() - input.startedAt,
			cdpCalls: input.cdpCalls,
			geometryCdpCalls: input.geometryCdpCalls,
			...(snapshot.snapshotGeometryCount ? { snapshotGeometryCount: snapshot.snapshotGeometryCount } : {}),
			...(snapshot.snapshotGeometryUnavailable ? { snapshotGeometryUnavailable: true } : {}),
			...(snapshot.snapshotStartedAt ? { snapshotStartedAt: snapshot.snapshotStartedAt } : {}),
			...(snapshot.snapshotEndedAt ? { snapshotEndedAt: snapshot.snapshotEndedAt } : {}),
			paintOrder: {
				supported: snapshot.paintOrderEntries.length > 0,
				entryCount: snapshot.paintOrderEntries.length,
				ownerBackendNodeIdCount: new Set(snapshot.paintOrderEntries.map((entry) => entry.backendNodeId)).size,
				...(snapshot.paintOrderSnapshotUnsupported ? { snapshotUnsupported: true } : {}),
				...(snapshot.paintOrderGeometryFallbackUsed ? { geometryFallbackUsed: true } : {}),
			},
			nodeCount: input.nodes.length,
			interestingNodeCount: input.interestingNodes.length,
			cacheHit: input.cached,
			bounded: { maxGeometryCdpCalls: AX_GEOMETRY_FALLBACK_MAX_CALLS, geometryFallbackTruncated: geometry.geometryFallbackTruncated },
		},
	};
}

export async function readAxEntities(server: AbmlAxRuntimeServer, options: AxReadRuntimeOptions): Promise<AxReadResult> {
	const startedAt = Date.now();
	const timeoutMs = options.timeoutMs ?? 10_000;
	const rawCacheKey = axRawCacheKey(options);
	const cachedRaw = rawCacheKey ? axRawCache.get(rawCacheKey) : undefined;
	let cdpCalls = 0;
	let geometryCdpCalls = 0;
	const sendCdp: AxCdpSender = async (request) => {
		cdpCalls += 1;
		if (request.cdpMethod === "DOM.getBoxModel") geometryCdpCalls += 1;
		return await sendPersistentCdp(server, request);
	};
	const nodes = await loadAxNodes(sendCdp, options, timeoutMs, cachedRaw);
	const interestingNodes = nodes.filter(isInterestingAxNode);
	const indexes = indexAxNodes(nodes);
	const context: AxContext = {
		browserSessionId: options.browserSessionId,
		tabId: options.tabId,
		targetGeneration: options.targetGeneration,
		pageEpoch: options.pageEpoch,
		url: options.url,
		observationId: options.observationId,
		capturedAt: options.capturedAt ?? Date.now(),
	};
	const snapshot = await readAxSnapshot(sendCdp, options, timeoutMs, cachedRaw);
	const geometry = await readAxGeometry(sendCdp, options, timeoutMs, interestingNodes, snapshot.rawGeometryByBackend);
	if (rawCacheKey && !cachedRaw) rememberAxRawCache(rawCacheKey, { nodes, geometryByBackend: snapshot.rawGeometryByBackend, snapshotGeometryEntries: snapshot.snapshotEntries, paintOrderEntries: snapshot.paintOrderEntries, createdAt: Date.now() });
	const assembled = assembleAxEntities(nodes, interestingNodes, context, indexes, geometry.geometryByNode);
	return projectAxReadResult({ startedAt, cdpCalls, geometryCdpCalls, nodes, interestingNodes, cached: !!cachedRaw, snapshot, geometry, assembled });
}

export function mergeAxIntoDomEntities(domEntities: Entity[], axEntities: BuiltEntity[]): { entities: Entity[]; diagnostics: AxFusionDiagnostics } {
	const merged = mergeDomAndAxEntities(domEntities, axEntities);
	const appended = merged.unmatchedAx.map((item) => {
		const refId = registerRefDescriptor({ descriptor: item.descriptor });
		return { ...item.entity, ref: refId };
	});
	return { entities: [...merged.merged, ...appended], diagnostics: merged.diagnostics };
}
