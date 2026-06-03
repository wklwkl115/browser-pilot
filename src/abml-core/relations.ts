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
	source: "ax" | "dom" | "geometry";
	confidence: "high" | "medium" | "low";
	evidence?: Record<string, unknown>;
};

// Deterministic ordering for per-entity caps and envelope highlights — interaction edges
// (controls/owns/expanded) lead, then labels, then table structure. Keeps output stable
// across runs (no Date.now()/random) so contract snapshots don't flake.
const TYPE_ORDER: RelationType[] = [
	"controls",
	"owns",
	"expandedTarget",
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
		const targetRef = keyToRef.get(anchor.targetKey);
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
		const containerKey = entity.hints?.currentContainerKey;
		if (entity.state.current !== undefined && entity.state.current !== false && typeof containerKey === "string" && containerKey) {
			out.push({ sourceKey, type: "currentIn", targetKey: containerKey, source: "ax", confidence: "high", evidence: { current: entity.state.current } });
		}
		const occluder = entity.hints?.occluderSelector;
		if (entity.state.occluded === true && typeof occluder === "string" && occluder) {
			out.push({ sourceKey, type: "coveredBy", targetKey: `s:${occluder}`, source: "geometry", confidence: "medium", evidence: { hitTest: true } });
			out.push({ sourceKey: `s:${occluder}`, type: "occludes", targetKey: sourceKey, source: "geometry", confidence: "medium" });
		}
	}
	return out;
}

export type RelationHighlight = { type: RelationType; sourceRef: string; targetRef: string; source: "ax" | "dom" | "geometry" };
export type RelationSummary = { summary: Record<string, number>; highlights: RelationHighlight[] };

// Compact relation disclosure for the envelope top-level. `summary` counts edges by type
// (plus tableCells = distinct cells with table context) and is always present when ABML is
// integrated, even if empty — agents can rely on it surviving the summary budget squeeze.
// `highlights` is a deterministic, capped sample.
export function buildRelationSummary(entities: Entity[]): RelationSummary {
	const summary: Record<string, number> = {};
	const tableCellRefs = new Set<string>();
	const highlights: RelationHighlight[] = [];
	for (const entity of entities) {
		for (const relation of entity.relations ?? []) {
			summary[relation.type] = (summary[relation.type] ?? 0) + 1;
			if (relation.type === "cellOf") tableCellRefs.add(entity.ref);
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
	return { summary, highlights: highlights.slice(0, MAX_HIGHLIGHTS) };
}
