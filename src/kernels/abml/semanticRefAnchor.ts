// ABML mechanism arm — M2b semantic ref anchor candidates (pure core).
//
// Repeated-structure instances are matched by semantic keys without changing bp-ref minting.
import type { Entity, EntityKind } from "./entity.js";
import {
	displayEntityText,
	groupEntities as rawGroupEntities,
	normalizeEntityText,
	suppressNestedNonControlGroups,
	type IndexedEntity,
	type TemplateGroup,
} from "./grouping.js";

export type SemanticRefAnchorConfidence = "high" | "low";
export type SemanticRefAnchorReason = "unique-name" | "duplicate-name" | "duplicate-container" | "missing-name";

export type SemanticRefAnchor = {
	scope: "abml-template";
	confidence: SemanticRefAnchorConfidence;
	reason: SemanticRefAnchorReason;
	mintingEligible: boolean;
	containerRole?: string;
	containerName?: string;
	setSize?: number;
	role: string;
	kind: EntityKind;
	name?: string;
	normalizedName?: string;
	posInSet?: number;
};

export type SemanticRefAnchorCandidate = {
	ref: string;
	anchor: SemanticRefAnchor;
};

export type SemanticRefAnchorSummary = {
	anchors: SemanticRefAnchorCandidate[];
	highConfidenceCount: number;
	lowConfidenceCount: number;
	mintingEligibleCount: number;
};

function groupEntities(entities: Entity[]): TemplateGroup[] {
	return suppressNestedNonControlGroups(rawGroupEntities(entities))
		.sort((a, b) => b.members.length - a.members.length);
}

function nameCounts(group: TemplateGroup): Map<string, number> {
	const counts = new Map<string, number>();
	for (const item of group.members) {
		const name = normalizeEntityText(item.entity.name);
		if (!name) continue;
		counts.set(name, (counts.get(name) || 0) + 1);
	}
	return counts;
}

function anchorFor(group: TemplateGroup, item: IndexedEntity, counts: Map<string, number>): SemanticRefAnchor | undefined {
	const normalizedName = normalizeEntityText(item.entity.name);
	const rawName = displayEntityText(item.entity.name);
	const posInSet = item.entity.structure?.posInSet;
	const namedUniquely = normalizedName && (counts.get(normalizedName) || 0) === 1;
	const base = {
		scope: "abml-template" as const,
		...(group.descriptor.container ? { containerRole: group.descriptor.container } : {}),
		...(group.descriptor.containerName ? { containerName: group.descriptor.containerName } : {}),
		...(typeof group.descriptor.setSize === "number" ? { setSize: group.descriptor.setSize } : {}),
		role: group.descriptor.role,
		kind: group.descriptor.kind,
		...(rawName ? { name: rawName } : {}),
		...(normalizedName ? { normalizedName } : {}),
		...(typeof posInSet === "number" ? { posInSet } : {}),
	};
	if (namedUniquely) {
		return {
			...base,
			confidence: "high",
			reason: "unique-name",
			mintingEligible: Boolean(group.descriptor.container),
		};
	}
	if (typeof posInSet !== "number") return undefined;
	return { ...base, confidence: "low", reason: normalizedName ? "duplicate-name" : "missing-name", mintingEligible: false };
}

export function deriveSemanticRefAnchors(entities: Entity[]): SemanticRefAnchorSummary {
	const anchors: SemanticRefAnchorCandidate[] = [];
	for (const group of groupEntities(entities)) {
		const counts = nameCounts(group);
		for (const item of group.members) {
			const anchor = anchorFor(group, item, counts);
			if (anchor) anchors.push({ ref: item.entity.ref, anchor });
		}
	}
	const signatures = new Map<string, number>();
	for (const { anchor } of anchors) {
		if (!anchor.mintingEligible) continue;
		const key = JSON.stringify([anchor.containerRole, anchor.containerName ?? "", anchor.role, anchor.kind, anchor.normalizedName]);
		signatures.set(key, (signatures.get(key) ?? 0) + 1);
	}
	for (const item of anchors) {
		const anchor = item.anchor;
		if (!anchor.mintingEligible) continue;
		const key = JSON.stringify([anchor.containerRole, anchor.containerName ?? "", anchor.role, anchor.kind, anchor.normalizedName]);
		if ((signatures.get(key) ?? 0) > 1) item.anchor = { ...anchor, confidence: "low", reason: "duplicate-container", mintingEligible: false };
	}
	return {
		anchors,
		highConfidenceCount: anchors.filter((item) => item.anchor.confidence === "high").length,
		lowConfidenceCount: anchors.filter((item) => item.anchor.confidence === "low").length,
		mintingEligibleCount: anchors.filter((item) => item.anchor.mintingEligible).length,
	};
}
