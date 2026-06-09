import type { Entity } from "./entity.js";
import type { CausalSummary } from "./causal.js";
import { deriveSemanticRefAnchors } from "./semanticRefAnchor.js";
import { isRecord } from "../utils/records.js";

export type IdentityGraphEntry = {
	anchorKey?: string;
	anchorConfidence?: "high" | "low";
	triggeredRequests: string[];
};

export type IdentityGraph = {
	byRef: Record<string, IdentityGraphEntry>;
	anchorCount: number;
	triggeredCount: number;
};

export type IdentityGraphSummary = {
	anchorCount: number;
	triggeredCount: number;
};

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
	let anchorCount = 0;
	let triggeredCount = 0;

	for (const entity of entities) {
		const anchor = anchorByRef.get(entity.ref);
		const triggered = triggeredByEntity.get(entity.ref) || [];
		if (!anchor && !triggered.length) continue;
		const entry: IdentityGraphEntry = { triggeredRequests: triggered };
		if (anchor) {
			const a = anchor.anchor;
			entry.anchorKey = [a.containerRole, a.containerName, a.normalizedName, a.role, a.kind].filter(Boolean).join("/");
			entry.anchorConfidence = a.confidence;
			anchorCount++;
		}
		if (triggered.length) triggeredCount += triggered.length;
		byRef[entity.ref] = entry;
	}

	return { byRef, anchorCount, triggeredCount };
}

export function identityGraphSummary(graph: IdentityGraph): IdentityGraphSummary {
	return { anchorCount: graph.anchorCount, triggeredCount: graph.triggeredCount };
}
