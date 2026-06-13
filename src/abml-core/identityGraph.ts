import type { Entity } from "./entity.js";
import type { CausalSummary } from "./causal.js";
import { deriveSemanticRefAnchors } from "./semanticRefAnchor.js";
import { isRecord } from "../utils/records.js";

export type IdentityGraphEntry = {
	anchorKey?: string;
	anchorConfidence?: "high" | "low";
	backendNodeId?: number;
	nodeKey?: string;
	triggeredRequests: string[];
};

export type IdentityGraph = {
	byRef: Record<string, IdentityGraphEntry>;
	entityCount: number;
	backendNodeIdCount: number;
	anchorCount: number;
	triggeredCount: number;
	sourceCounts: Record<string, number>;
};

export type IdentityGraphSummary = {
	entityCount: number;
	backendNodeIdCount: number;
	backendNodeIdCoverage: number;
	anchorCount: number;
	triggeredCount: number;
	sourceCounts: Record<string, number>;
};

function backendNodeIdFor(entity: Entity): number | undefined {
	const locator = entity.locators?.find((item) => item.by === "backendNodeId");
	return locator?.by === "backendNodeId" ? locator.value : undefined;
}

export function buildIdentityGraph(entities: Entity[], _causal: CausalSummary | undefined): IdentityGraph {
	const { anchors } = deriveSemanticRefAnchors(entities);
	const anchorByRef = new Map(anchors.map((a) => [a.ref, a]));

	const triggeredByEntity = new Map<string, string[]>();
	for (const entity of entities) {
		if (!Array.isArray(entity.relations)) continue;
		for (const rel of entity.relations) {
			if (!isRecord(rel) || rel.type !== "triggered" || typeof rel.targetRef !== "string") continue;
			const list = triggeredByEntity.get(entity.ref);
			if (list) list.push(rel.targetRef);
			else triggeredByEntity.set(entity.ref, [rel.targetRef]);
		}
	}

	const byRef: Record<string, IdentityGraphEntry> = {};
	const sourceCounts: Record<string, number> = {};
	let anchorCount = 0;
	let backendNodeIdCount = 0;
	let triggeredCount = 0;

	for (const entity of entities) {
		sourceCounts[entity.source] = (sourceCounts[entity.source] || 0) + 1;
		const anchor = anchorByRef.get(entity.ref);
		const backendNodeId = backendNodeIdFor(entity);
		const triggered = triggeredByEntity.get(entity.ref) || [];
		if (backendNodeId !== undefined) backendNodeIdCount++;
		if (!anchor && backendNodeId === undefined && !triggered.length) continue;
		const entry: IdentityGraphEntry = { triggeredRequests: triggered };
		if (backendNodeId !== undefined) {
			entry.backendNodeId = backendNodeId;
			entry.nodeKey = `b:${backendNodeId}`;
		}
		if (anchor) {
			const a = anchor.anchor;
			entry.anchorKey = [a.containerRole, a.containerName, a.normalizedName, a.role, a.kind].filter(Boolean).join("/");
			entry.anchorConfidence = a.confidence;
			anchorCount++;
		}
		if (triggered.length) triggeredCount += triggered.length;
		byRef[entity.ref] = entry;
	}

	return { byRef, entityCount: entities.length, backendNodeIdCount, anchorCount, triggeredCount, sourceCounts };
}

export function identityGraphSummary(graph: IdentityGraph): IdentityGraphSummary {
	return {
		entityCount: graph.entityCount,
		backendNodeIdCount: graph.backendNodeIdCount,
		backendNodeIdCoverage: graph.entityCount ? Number((graph.backendNodeIdCount / graph.entityCount).toFixed(3)) : 0,
		anchorCount: graph.anchorCount,
		triggeredCount: graph.triggeredCount,
		sourceCounts: graph.sourceCounts,
	};
}
