// ABML R1 — relationship graph (pure core). Turns relation *anchors* (typed edges keyed by
// pre-ref backend/AX node ids, extracted from the AX tree by the runtime layer) into typed
// EntityRelation edges on entities (keyed by materialized pi-ref:// targets), plus a compact,
// budget-immune relation summary for the envelope top-level.
//
// The two-pass split keeps unstable backend ids out of public output: the runtime extracts
// anchors and mints refs (DOM↔AX merge), then this pure module materializes anchors→refs and
// summarizes. No browser, Node, or tools imports — stays inside the abml-core boundary.
import type { Entity, EntityRelation, RelationType } from "./entity.js";

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

// Per-entity relation cap protects the envelope from pathological fan-out (a listbox owning
// 50 options). The top-level relations.summary is the guaranteed survivor; full relations
// remain reachable through the entity ref / artifact. Cap is deterministic (TYPE_ORDER then
// targetRef) and documented so consumers can rely on it.
const MAX_RELATIONS_PER_ENTITY = 8;
// Highlights are a capped, deterministic sample of the strongest edges for the envelope.
const MAX_HIGHLIGHTS = 8;

function typeRank(type: RelationType): number {
	const idx = TYPE_ORDER.indexOf(type);
	return idx === -1 ? TYPE_ORDER.length : idx;
}

// The keys an entity answers to, across the shared anchor key space:
//   b:<backendDOMNodeId> · a:<axNodeId> — AX-derived endpoints (property/table/currentIn relations)
//   s:<selector>          — DOM endpoints (occlusion relations match by CSS selector)
// All of an entity's keys register so an anchor keyed by any of them resolves to its ref.
export function entityRelationKeys(entity: Entity): string[] {
	const keys: string[] = [];
	const backend = entity.hints?.backendNodeId;
	if (typeof backend === "number" && Number.isFinite(backend)) keys.push(`b:${backend}`);
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

function capRelations(relations: EntityRelation[]): EntityRelation[] {
	if (relations.length <= MAX_RELATIONS_PER_ENTITY) return sortRelations(relations);
	return sortRelations(relations).slice(0, MAX_RELATIONS_PER_ENTITY);
}

function sortRelations(relations: EntityRelation[]): EntityRelation[] {
	return [...relations].sort((a, b) => {
		const rank = typeRank(a.type) - typeRank(b.type);
		if (rank !== 0) return rank;
		return a.targetRef < b.targetRef ? -1 : a.targetRef > b.targetRef ? 1 : 0;
	});
}

// Convert anchors → typed relations on entities. Builds a node-key → ref map from the final
// (merged + ref-minted) entity list, resolves each anchor's source/target to refs, drops
// unresolved or self edges, dedupes, and caps per entity. Returns a new entity list; entities
// with no relations are returned unchanged.
export function materializeRelations(entities: Entity[], anchors: RelationAnchor[]): Entity[] {
	if (!anchors.length) return entities;
	const keyToRef = new Map<string, string>();
	for (const entity of entities) {
		for (const key of entityRelationKeys(entity)) {
			if (!keyToRef.has(key)) keyToRef.set(key, entity.ref);
		}
	}
	const bySource = new Map<string, EntityRelation[]>();
	for (const anchor of anchors) {
		const sourceRef = keyToRef.get(anchor.sourceKey);
		let targetRef = keyToRef.get(anchor.targetKey);
		if (!targetRef && anchor.targetKeyFallbacks) {
			for (const fallback of anchor.targetKeyFallbacks) { targetRef = keyToRef.get(fallback); if (targetRef) break; }
		}
		if (!sourceRef || !targetRef || sourceRef === targetRef) continue;
		const relation: EntityRelation = {
			type: anchor.type,
			targetRef,
			source: anchor.source,
			confidence: anchor.confidence,
			...(anchor.evidence ? { evidence: anchor.evidence } : {}),
		};
		const list = bySource.get(sourceRef);
		if (list) list.push(relation);
		else bySource.set(sourceRef, [relation]);
	}
	if (!bySource.size) return entities;
	return entities.map((entity) => {
		const relations = bySource.get(entity.ref);
		if (!relations || !relations.length) return entity;
		return { ...entity, relations: capRelations(dedupeRelations(relations)) };
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

export type RelationHighlight = { type: RelationType; sourceRef: string; targetRef: string; source: "ax" | "dom" | "geometry" | "timing" | "event" };

// Attach additional relations (e.g. R3.x `triggered` edges, whose targets are network refs rather
// than entities, so they bypass the anchor→ref materialize pass) to a single entity, reusing the
// same dedupe + deterministic cap as materializeRelations. Returns a new entity; input untouched.
export function addEntityRelations(entity: Entity, added: EntityRelation[]): Entity {
	if (!added.length) return entity;
	return { ...entity, relations: capRelations(dedupeRelations([...(entity.relations ?? []), ...added])) };
}
export type RelationSummary = { summary: Record<string, number>; highlights: RelationHighlight[]; highlightCount?: number };

// Table-structural relation types are already encoded in `tableCells` (distinct cell count).
// Their per-type counts add noise to the summary (a documentation page with 100 table cells
// buries the combobox controls:4 under cellOf:100). Exclude from summary counts AND highlights;
// the full table structure remains navigable via entity.relations[].
const TABLE_STRUCTURAL_TYPES = new Set<RelationType>(["cellOf", "rowOf", "columnOf", "headerFor"]);

// Compact relation disclosure for the envelope top-level. `summary` counts SEMANTIC edges by type
// (controls/owns/expandedTarget/currentIn/labelledBy/describedBy/occludes/coveredBy) plus
// `tableCells` (distinct table cells, the structural summary). Table-hierarchy per-type counts
// (cellOf/rowOf/columnOf/headerFor) are omitted — they're noisy on documentation pages and
// redundant with tableCells. Always present when abmlIntegrated; budget-immune.
// `highlights` is a deterministic, capped sample of semantic (non-table-structural) edges.
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
	const cappedHighlights = dedupedHighlights.slice(0, MAX_HIGHLIGHTS);
	return { summary, highlights: cappedHighlights, ...(dedupedHighlights.length > cappedHighlights.length ? { highlightCount: dedupedHighlights.length } : {}) };
}
