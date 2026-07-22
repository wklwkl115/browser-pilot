// ABML relationship graph (pure core). Turns relation *anchors* (typed edges keyed by
// pre-ref backend/AX node ids, extracted from the AX tree by the runtime layer) into typed
// EntityRelation edges on entities (keyed by materialized bp-ref:// targets), plus a relation
// summary for the envelope top-level.
//
// The two-pass split keeps unstable backend ids out of public output: the runtime extracts
// anchors and mints refs (DOM↔AX merge), then this pure module materializes anchors→refs and
// summarizes. No browser, Node, or tools imports — stays inside the abml-kernel boundary.
import type { Entity, EntityRelation, RelationType } from "./entity.js";
import { backendNodeKey, bareBackendNodeKey, cleanTargetId } from "./nodeKey.js";

// A relation edge before ref materialization. sourceKey/targetKey are node-id keys in the
// shared key space "b:<backendDOMNodeId>" | "a:<axNodeId>" — never leaked to callers.
export type RelationAnchor = {
	sourceKey: string;
	type: RelationType;
	targetKey: string;
	// Ordered alternative target keys tried when targetKey doesn't resolve — used by currentIn, whose
	// nearest container node can be folded away by the merge; the first surviving container ref wins.
	targetKeyFallbacks?: string[];
	source: "ax" | "dom" | "geometry" | "timing" | "event";
	confidence: "high" | "medium" | "low";
	evidence?: Record<string, unknown>;
};

export type PaintOrderEntry = {
	backendNodeId: number;
	paintOrder: number;
	bounds: { x: number; y: number; w: number; h: number };
};

// Deterministic ordering for per-entity caps and envelope highlights — interaction edges
// (controls/owns/expanded) lead, then labels, then table structure. Keeps output stable
// across runs (no clock or random reads) so contract snapshots don't flake.
const TYPE_ORDER: RelationType[] = [
	"controls",
	"owns",
	"expandedTarget",
	"triggered",
	"currentIn",
	"labelledBy",
	"describedBy",
	"cellOf",
	"rowOf",
	"columnOf",
	"headerFor",
	"occludes",
	"coveredBy",
];

const PAINT_ORDER_BUCKET_SIZE = 256;
const MIN_OCCLUSION_OVERLAP_AREA = 9;
const MIN_OCCLUSION_OVERLAP_RATIO = 0.02;

function typeRank(type: RelationType): number {
	const idx = TYPE_ORDER.indexOf(type);
	return idx === -1 ? TYPE_ORDER.length : idx;
}

// The keys an entity answers to, across the shared anchor key space:
//   t:<targetId>:b:<backendDOMNodeId> · b:<backendDOMNodeId> · a:<axNodeId> — AX-derived endpoints (property/table/currentIn relations)
//   s:<selector>          — DOM endpoints (occlusion relations match by CSS selector)
// All of an entity's keys register so an anchor keyed by any of them resolves to its ref. When an
// OOPIF target id is known, the composite key is registered first and the bare backend key remains
// available for providers that do not report a target id.
export function entityRelationKeys(entity: Entity): string[] {
	const keys: string[] = [];
	const locator = entity.locators?.find((item) => item.by === "backendNodeId");
	const locatorBackend = locator?.by === "backendNodeId" ? Number(locator.value) : NaN;
	const hintBackend = Number(entity.hints?.backendNodeId);
	const backend = Number.isFinite(hintBackend) ? hintBackend : locator?.by === "backendNodeId" && Number.isFinite(locatorBackend) ? locatorBackend : undefined;
	if (backend !== undefined) {
		const targetId = cleanTargetId(entity.hints?.targetId ?? entity.hints?.cdpTargetId) ?? (locator?.by === "backendNodeId" ? cleanTargetId(locator.targetId) : undefined);
		const bareKey = bareBackendNodeKey(backend);
		const compositeKey = backendNodeKey({ backendNodeId: backend, targetId });
		keys.push(compositeKey);
		if (compositeKey !== bareKey) keys.push(bareKey);
	}
	const axNodeId = entity.hints?.axNodeId;
	if (typeof axNodeId === "string" && axNodeId.trim()) keys.push(`a:${axNodeId.trim()}`);
	const selector = entity.hints?.selector;
	if (typeof selector === "string" && selector.trim()) keys.push(`s:${selector.trim()}`);
	return keys;
}

function dedupeRelations(relations: EntityRelation[]): EntityRelation[] {
	const seen = new Set<string>();
	const out: EntityRelation[] = [];
	for (const relation of relations) {
		const key = `${relation.type}|${relation.targetRef}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(relation);
	}
	return out;
}

function sortRelations(relations: EntityRelation[]): EntityRelation[] {
	return [...relations].sort((a, b) => {
		const rank = typeRank(a.type) - typeRank(b.type);
		if (rank !== 0) return rank;
		return a.targetRef < b.targetRef ? -1 : a.targetRef > b.targetRef ? 1 : 0;
	});
}

// Relations derived from a merged entity's own scalar state + stashed keys — the DOM-sourced arm of
// R1 (batch 2). currentIn: an aria-current entity → its owning nav/list container (key stashed from
// the AX walk, since Chrome's getFullAXTree doesn't expose aria-current). coveredBy/occludes: an
// occluded entity ↔ the element stacked on top (matched by selector via the page hit-test). These
// feed the same materializeRelations pass; unresolved targets (occluder isn't a scanned entity) drop.
export function deriveStateRelationAnchors(entities: Entity[]): RelationAnchor[] {
	const out: RelationAnchor[] = [];
	for (const entity of entities) {
		const sourceKey = entityRelationKeys(entity)[0];
		if (!sourceKey) continue;
		const containerKeys = Array.isArray(entity.hints?.currentContainerKeys) ? (entity.hints!.currentContainerKeys as unknown[]).filter((k): k is string => typeof k === "string" && k.length > 0) : [];
		if (entity.state.current !== undefined && entity.state.current !== false && containerKeys.length) {
			out.push({ sourceKey, type: "currentIn", targetKey: containerKeys[0]!, ...(containerKeys.length > 1 ? { targetKeyFallbacks: containerKeys.slice(1) } : {}), source: "ax", confidence: "high", evidence: { current: entity.state.current } });
		}
		const occluder = entity.hints?.occluderSelector;
		if (entity.state.occluded === true && typeof occluder === "string" && occluder) {
			out.push({ sourceKey, type: "coveredBy", targetKey: `s:${occluder}`, source: "geometry", confidence: "medium", evidence: { hitTest: true } });
			out.push({ sourceKey: `s:${occluder}`, type: "occludes", targetKey: sourceKey, source: "geometry", confidence: "medium" });
		}
		// aria-controls/owns/expandedTarget by selector — resolves even when the target is collapsed/
		// hidden (the AX-property path drops those). Deduped against the AX-sourced controls/owns when
		// the target is also visible (same target ref).
		for (const [hintKey, type] of [["controlsSelectors", "controls"], ["ownsSelectors", "owns"], ["expandedTargetSelectors", "expandedTarget"]] as const) {
			const selectors = entity.hints?.[hintKey];
			if (!Array.isArray(selectors)) continue;
			for (const selector of selectors) {
				if (typeof selector === "string" && selector) out.push({ sourceKey, type, targetKey: `s:${selector}`, source: "dom", confidence: "high" });
			}
		}
	}
	return out;
}

type IndexedPaintEntity = PaintOrderEntry & { key: string; entityIndex: number; area: number };

function isPaintOrderRelationCandidate(entity: Entity): boolean {
	return entity.kind !== "text" && entity.kind !== "frame";
}

function rectArea(rect: PaintOrderEntry["bounds"]): number {
	return Math.max(0, rect.w) * Math.max(0, rect.h);
}

function rectIntersectionArea(a: PaintOrderEntry["bounds"], b: PaintOrderEntry["bounds"]): number {
	const left = Math.max(a.x, b.x);
	const top = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.w, b.x + b.w);
	const bottom = Math.min(a.y + a.h, b.y + b.h);
	return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function bucketRange(rect: PaintOrderEntry["bounds"]): { minX: number; maxX: number; minY: number; maxY: number } {
	return {
		minX: Math.floor(rect.x / PAINT_ORDER_BUCKET_SIZE),
		maxX: Math.floor((rect.x + rect.w) / PAINT_ORDER_BUCKET_SIZE),
		minY: Math.floor(rect.y / PAINT_ORDER_BUCKET_SIZE),
		maxY: Math.floor((rect.y + rect.h) / PAINT_ORDER_BUCKET_SIZE),
	};
}

function bucketKeys(rect: PaintOrderEntry["bounds"]): string[] {
	const range = bucketRange(rect);
	const out: string[] = [];
	for (let x = range.minX; x <= range.maxX; x += 1) {
		for (let y = range.minY; y <= range.maxY; y += 1) out.push(`${x}:${y}`);
	}
	return out;
}

// DOMSnapshot paint order is the lower-level occlusion spine: layout entries carry
// backendNodeId + bounds + paintOrder in one sample. Convert that into relation anchors
// without building an O(n²) matrix. Each lower painted entity keeps only the nearest higher painted
// overlapping candidate; full paint-order entries remain artifact-side diagnostics.
export function derivePaintOrderRelationAnchors(entities: Entity[], entries: PaintOrderEntry[]): RelationAnchor[] {
	if (!entries.length || !entities.length) return [];
	const entityBackendKeys = new Map<number, { key: string; entityIndex: number }>();
	for (let i = 0; i < entities.length; i += 1) {
		if (!isPaintOrderRelationCandidate(entities[i]!)) continue;
		for (const key of entityRelationKeys(entities[i]!)) {
			const match = /^b:(\d+)$/.exec(key);
			if (!match) continue;
			const backendNodeId = Number(match[1]);
			if (!entityBackendKeys.has(backendNodeId)) entityBackendKeys.set(backendNodeId, { key, entityIndex: i });
		}
	}
	if (!entityBackendKeys.size) return [];
	const indexed: IndexedPaintEntity[] = [];
	const seen = new Set<number>();
	for (const entry of entries) {
		if (seen.has(entry.backendNodeId)) continue;
		const keyed = entityBackendKeys.get(entry.backendNodeId);
		if (!keyed) continue;
		const area = rectArea(entry.bounds);
		if (area <= 0) continue;
		indexed.push({ ...entry, key: keyed.key, entityIndex: keyed.entityIndex, area });
		seen.add(entry.backendNodeId);
	}
	if (indexed.length < 2) return [];
	indexed.sort((a, b) => a.paintOrder - b.paintOrder || a.backendNodeId - b.backendNodeId);
	const buckets = new Map<string, IndexedPaintEntity[]>();
	for (const item of indexed) {
		for (const key of bucketKeys(item.bounds)) {
			const current = buckets.get(key);
			if (current) current.push(item);
			else buckets.set(key, [item]);
		}
	}
	const anchors: RelationAnchor[] = [];
	for (const lower of indexed) {
		const candidates = new Map<string, IndexedPaintEntity>();
		for (const key of bucketKeys(lower.bounds)) {
			for (const candidate of buckets.get(key) || []) {
				if (candidate.key !== lower.key && candidate.paintOrder > lower.paintOrder) candidates.set(candidate.key, candidate);
			}
		}
		let best: { item: IndexedPaintEntity; intersection: number; ratio: number } | undefined;
		for (const candidate of candidates.values()) {
			const intersection = rectIntersectionArea(lower.bounds, candidate.bounds);
			if (intersection < MIN_OCCLUSION_OVERLAP_AREA) continue;
			const ratio = intersection / Math.max(1, Math.min(lower.area, candidate.area));
			if (ratio < MIN_OCCLUSION_OVERLAP_RATIO) continue;
			if (!best
				|| candidate.paintOrder < best.item.paintOrder
				|| (candidate.paintOrder === best.item.paintOrder && ratio > best.ratio)
				|| (candidate.paintOrder === best.item.paintOrder && ratio === best.ratio && candidate.backendNodeId < best.item.backendNodeId)) {
				best = { item: candidate, intersection, ratio };
			}
		}
		if (!best) continue;
		const evidence = {
			paintOrder: true,
			sourcePaintOrder: lower.paintOrder,
			targetPaintOrder: best.item.paintOrder,
			overlapArea: Math.round(best.intersection),
			overlapRatio: Number(best.ratio.toFixed(3)),
		};
		anchors.push({ sourceKey: lower.key, type: "coveredBy", targetKey: best.item.key, source: "geometry", confidence: "medium", evidence });
		anchors.push({ sourceKey: best.item.key, type: "occludes", targetKey: lower.key, source: "geometry", confidence: "medium", evidence });
	}
	return anchors;
}

export type RelationHighlight = { type: RelationType; sourceRef: string; targetRef: string; source: "ax" | "dom" | "geometry" | "timing" | "event" };
export type RelationGraphEdge = EntityRelation & {
	id: string;
	sourceRef: string;
	targetRef: string;
};
export type RelationGraph = {
	schemaVersion: 1;
	edgeCount: number;
	edges: RelationGraphEdge[];
	bySource: Record<string, string[]>;
	byTarget: Record<string, string[]>;
	byType: Record<string, string[]>;
};

// Attach additional relations (e.g. `triggered` edges, whose targets are network refs rather
// than entities, so they bypass the anchor→ref materialize pass) to a single entity, reusing the
// same dedupe + deterministic ordering as materializeRelations. Returns a new entity; input untouched.
export function addEntityRelations(entity: Entity, added: EntityRelation[]): Entity {
	if (!added.length) return entity;
	return { ...entity, relations: sortRelations(dedupeRelations([...(entity.relations ?? []), ...added])) };
}
export type RelationSummary = { summary: Record<string, number>; highlights: RelationHighlight[]; highlightCount?: number };

function confidenceRank(confidence: EntityRelation["confidence"]): number {
	switch (confidence) {
		case "high": return 0;
		case "medium": return 1;
		case "low": return 2;
	}
}

function relationEdgeSort(a: Omit<RelationGraphEdge, "id">, b: Omit<RelationGraphEdge, "id">): number {
	if (a.sourceRef !== b.sourceRef) return a.sourceRef < b.sourceRef ? -1 : 1;
	const rank = typeRank(a.type) - typeRank(b.type);
	if (rank !== 0) return rank;
	if (a.targetRef !== b.targetRef) return a.targetRef < b.targetRef ? -1 : 1;
	if (a.source !== b.source) return a.source < b.source ? -1 : 1;
	return confidenceRank(a.confidence) - confidenceRank(b.confidence);
}

function edgeKey(edge: Pick<RelationGraphEdge, "sourceRef" | "type" | "targetRef">): string {
	return `${edge.sourceRef}|${edge.type}|${edge.targetRef}`;
}

function mergeEdgeEvidence(current: Omit<RelationGraphEdge, "id">, next: Omit<RelationGraphEdge, "id">, preferred: Omit<RelationGraphEdge, "id">): Omit<RelationGraphEdge, "id"> {
	if (!current.evidence && !next.evidence) return preferred;
	return { ...preferred, evidence: { ...(current.evidence ?? {}), ...(next.evidence ?? {}) } };
}

function preferredEdge(current: Omit<RelationGraphEdge, "id">, next: Omit<RelationGraphEdge, "id">): Omit<RelationGraphEdge, "id"> {
	const confidence = confidenceRank(next.confidence) - confidenceRank(current.confidence);
	if (confidence < 0) return mergeEdgeEvidence(current, next, next);
	if (confidence > 0) return mergeEdgeEvidence(current, next, current);
	const source = next.source < current.source ? -1 : next.source > current.source ? 1 : 0;
	return mergeEdgeEvidence(current, next, source < 0 ? next : current);
}

function relationGraphFromEdges(input: Array<Omit<RelationGraphEdge, "id">>): RelationGraph {
	const deduped = new Map<string, Omit<RelationGraphEdge, "id">>();
	for (const edge of input) {
		const key = edgeKey(edge);
		const current = deduped.get(key);
		deduped.set(key, current ? preferredEdge(current, edge) : edge);
	}
	const sorted = Array.from(deduped.values()).sort(relationEdgeSort);
	const edges: RelationGraphEdge[] = [];
	for (let i = 0; i < sorted.length; i += 1) edges.push({ id: `rel:${i + 1}`, ...sorted[i]! });
	const bySource: Record<string, string[]> = {};
	const byTarget: Record<string, string[]> = {};
	const byType: Record<string, string[]> = {};
	for (const edge of edges) {
		(bySource[edge.sourceRef] ||= []).push(edge.id);
		(byTarget[edge.targetRef] ||= []).push(edge.id);
		(byType[edge.type] ||= []).push(edge.id);
	}
	return {
		schemaVersion: 1,
		edgeCount: edges.length,
		edges,
		bySource,
		byTarget,
		byType,
	};
}

function graphEdgesFromAnchors(entities: Entity[], anchors: RelationAnchor[]): Array<Omit<RelationGraphEdge, "id">> {
	if (!anchors.length) return [];
	const keyToRef = new Map<string, string>();
	for (const entity of entities) {
		for (const key of entityRelationKeys(entity)) {
			if (!keyToRef.has(key)) keyToRef.set(key, entity.ref);
		}
	}
	const edges: Array<Omit<RelationGraphEdge, "id">> = [];
	for (const anchor of anchors) {
		const sourceRef = keyToRef.get(anchor.sourceKey);
		let targetRef = keyToRef.get(anchor.targetKey);
		if (!targetRef && anchor.targetKeyFallbacks) {
			for (const fallback of anchor.targetKeyFallbacks) { targetRef = keyToRef.get(fallback); if (targetRef) break; }
		}
		if (!sourceRef || !targetRef || sourceRef === targetRef) continue;
		edges.push({
			sourceRef,
			type: anchor.type,
			targetRef,
			source: anchor.source,
			confidence: anchor.confidence,
			...(anchor.evidence ? { evidence: anchor.evidence } : {}),
		});
	}
	return edges;
}

function entitiesWithGraphRelations(entities: Entity[], graph: RelationGraph): Entity[] {
	if (!graph.edgeCount) return entities;
	const relationsBySource = new Map<string, EntityRelation[]>();
	const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
	for (const [sourceRef, edgeIds] of Object.entries(graph.bySource)) {
		const relations: EntityRelation[] = [];
		for (const edgeId of edgeIds) {
			const edge = edgeById.get(edgeId);
			if (!edge) continue;
			relations.push({
				type: edge.type,
				targetRef: edge.targetRef,
				source: edge.source,
				confidence: edge.confidence,
				...(edge.evidence ? { evidence: edge.evidence } : {}),
			});
		}
		if (relations.length) relationsBySource.set(sourceRef, sortRelations(relations));
	}
	return entities.map((entity) => {
		const relations = relationsBySource.get(entity.ref);
		return relations ? { ...entity, relations } : entity;
	});
}

export function buildRelationGraph(entities: Entity[]): RelationGraph {
	const edges: Array<Omit<RelationGraphEdge, "id">> = [];
	for (const entity of entities) {
		for (const relation of entity.relations ?? []) {
			edges.push({
				sourceRef: entity.ref,
				type: relation.type,
				targetRef: relation.targetRef,
				source: relation.source,
				confidence: relation.confidence,
				...(relation.evidence ? { evidence: relation.evidence } : {}),
			});
		}
	}
	return relationGraphFromEdges(edges);
}

export function materializeRelationGraph(entities: Entity[], anchors: RelationAnchor[]): { entities: Entity[]; graph: RelationGraph } {
	const graph = relationGraphFromEdges(graphEdgesFromAnchors(entities, anchors));
	return { entities: entitiesWithGraphRelations(entities, graph), graph };
}

// Table-structural relation types are already encoded in `tableCells` (distinct cell count).
// Their per-type counts add noise to the summary (a documentation page with 100 table cells
// buries the combobox controls:4 under cellOf:100). Exclude from summary counts AND highlights;
// the full table structure remains navigable via entity.relations[].
const TABLE_STRUCTURAL_TYPES = new Set<RelationType>(["cellOf", "rowOf", "columnOf", "headerFor"]);

// Compact relation disclosure for the envelope top-level. `summary` counts SEMANTIC edges by type
// (controls/owns/expandedTarget/currentIn/labelledBy/describedBy/occludes/coveredBy) plus
// `tableCells` (distinct table cells, the structural summary). Table-hierarchy per-type counts
// (cellOf/rowOf/columnOf/headerFor) are omitted — they're noisy on documentation pages and
// redundant with tableCells. Always present when abmlIntegrated.
// `highlights` is the deterministic semantic (non-table-structural) edge list. The observation
// projection folds it and exposes the complete saved value as a resource when needed.
export function buildRelationSummary(entities: Entity[]): RelationSummary {
	const summary: Record<string, number> = {};
	const tableCellRefs = new Set<string>();
	const highlights: RelationHighlight[] = [];
	for (const entity of entities) {
		for (const relation of entity.relations ?? []) {
			if (relation.type === "cellOf") tableCellRefs.add(entity.ref);
			if (TABLE_STRUCTURAL_TYPES.has(relation.type)) continue; // encoded as tableCells below
			summary[relation.type] = (summary[relation.type] ?? 0) + 1;
			highlights.push({ type: relation.type, sourceRef: entity.ref, targetRef: relation.targetRef, source: relation.source });
		}
	}
	if (tableCellRefs.size) summary.tableCells = tableCellRefs.size;
	highlights.sort((a, b) => {
		const rank = typeRank(a.type) - typeRank(b.type);
		if (rank !== 0) return rank;
		if (a.sourceRef !== b.sourceRef) return a.sourceRef < b.sourceRef ? -1 : 1;
		return a.targetRef < b.targetRef ? -1 : a.targetRef > b.targetRef ? 1 : 0;
	});
	// Dedupe (type, sourceRef, targetRef) in case AX + DOM paths both resolve to the same edge.
	const seen = new Set<string>();
	const dedupedHighlights = highlights.filter((h) => {
		const key = `${h.type}|${h.sourceRef}|${h.targetRef}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return { summary, highlights: dedupedHighlights };
}
