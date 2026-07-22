import type { Entity } from "./entity.js";
import type { CausalSummary } from "./causal.js";
import { backendNodeKey, cleanTargetId } from "./nodeKey.js";
import { deriveSemanticRefAnchors } from "./semanticRefAnchor.js";
import { isRecord } from "../../utils/records.js";
import type { IntentRefRegistry } from "../../kernels/session/intentRefRegistry.js";

export type IdentityGraphEntry = {
	anchorKey?: string;
	anchorConfidence?: "high" | "low";
	backendNodeId?: number;
	targetId?: string;
	nodeKey?: string;
	triggeredRequests: string[];
};

export type IntentRefInfo = {
	ref: string;
	anchorKey: string;
	previousRefs?: string[];
	navigationCount?: number;
};

export type IdentityGraph = {
	byRef: Record<string, IdentityGraphEntry>;
	entityCount: number;
	backendNodeIdCount: number;
	anchorCount: number;
	triggeredCount: number;
	sourceCounts: Record<string, number>;
	intentRefs?: IntentRefInfo[];
};

export type IdentityGraphSummary = {
	entityCount: number;
	backendNodeIdCount: number;
	backendNodeIdCoverage: number;
	anchorCount: number;
	triggeredCount: number;
	sourceCounts: Record<string, number>;
};

function backendNodeIdentityFor(entity: Entity): { backendNodeId: number; targetId?: string } | undefined {
	const locator = entity.locators?.find((item) => item.by === "backendNodeId");
	const hintedTargetId = cleanTargetId(entity.hints?.targetId ?? entity.hints?.cdpTargetId);
	if (locator?.by === "backendNodeId") {
		return { backendNodeId: locator.value, targetId: cleanTargetId(locator.targetId) ?? hintedTargetId };
	}
	const hintedBackendNodeId = Number(entity.hints?.backendNodeId);
	return Number.isFinite(hintedBackendNodeId) ? { backendNodeId: hintedBackendNodeId, targetId: hintedTargetId } : undefined;
}

export function buildIdentityGraph(entities: Entity[], _causal: CausalSummary | undefined, intentRegistry?: IntentRefRegistry): IdentityGraph {
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
		const backendIdentity = backendNodeIdentityFor(entity);
		const triggered = triggeredByEntity.get(entity.ref) || [];
		if (backendIdentity) backendNodeIdCount++;
		if (!anchor && !backendIdentity && !triggered.length) continue;
		const entry: IdentityGraphEntry = { triggeredRequests: triggered };
		if (backendIdentity) {
			entry.backendNodeId = backendIdentity.backendNodeId;
			if (backendIdentity.targetId) entry.targetId = backendIdentity.targetId;
			entry.nodeKey = backendNodeKey(backendIdentity);
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

	// Resolve cross-navigation intent refs from the registry when available.
	let intentRefs: IntentRefInfo[] | undefined;
	if (intentRegistry) {
		const resolved: IntentRefInfo[] = [];
		for (const [ref, entry] of Object.entries(byRef)) {
			if (!entry.anchorKey || entry.anchorConfidence !== "high") continue;
			const match = intentRegistry.resolveByPreviousRef(ref);
			if (match && match.navigationCount > 0) {
				resolved.push({
					ref: match.currentRef,
					anchorKey: match.anchorKey,
					...(match.previousRefs.length ? { previousRefs: match.previousRefs } : {}),
					...(match.navigationCount ? { navigationCount: match.navigationCount } : {}),
				});
			}
		}
		if (resolved.length) intentRefs = resolved;
	}

	return { byRef, entityCount: entities.length, backendNodeIdCount, anchorCount, triggeredCount, sourceCounts, ...(intentRefs ? { intentRefs } : {}) };
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
