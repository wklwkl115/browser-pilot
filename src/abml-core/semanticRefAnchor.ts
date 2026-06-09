// ABML mechanism arm — M2b semantic ref anchor candidates (pure core).
//
// M2a proved repeated-structure instances can be matched by semantic keys for treeDiff without
// changing pi-ref minting. This module keeps M2b's first stages safe: derive candidate anchors and
// shadow hash payloads only. Runtime ref minting must not consume these until the P3 gates pass.
import type { Entity, EntityKind } from "./entity.js";
import type { RefDescriptor } from "./types.js";
import { MAX_TEMPLATES, MIN_TEMPLATE_INSTANCES, templateGroupDescriptorForEntity, type TemplateGroupDescriptor } from "./templating.js";

export type SemanticRefAnchorConfidence = "high" | "low";
export type SemanticRefAnchorReason = "unique-name" | "duplicate-name" | "missing-name";

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

export type SemanticRefAnchorHashInput = {
	scope: "abml-template";
	kind: RefDescriptor["kind"];
	tabId?: number;
	origin?: string;
	url?: string;
	anchor: {
		containerRole?: string;
		containerName?: string;
		setSize?: number;
		role: string;
		kind: EntityKind;
		normalizedName: string;
	};
};

type GroupedEntity = { entity: Entity; index: number };
type TemplateGroup = { descriptor: TemplateGroupDescriptor; members: GroupedEntity[] };

function normalizeName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim().replace(/\s+/g, " ").toLowerCase();
	return text || undefined;
}

function displayName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim().replace(/\s+/g, " ");
	return text ? text.slice(0, 120) : undefined;
}

function structureScopeKey(descriptor: TemplateGroupDescriptor): string {
	return descriptor.container
		? JSON.stringify(["c", descriptor.container, descriptor.containerName || ""])
		: JSON.stringify(["s", descriptor.setSize ?? ""]);
}

function suppressNestedNonControlGroups(groups: TemplateGroup[]): TemplateGroup[] {
	const scopesWithControls = new Set(groups.filter((group) => group.descriptor.kind === "control").map((group) => structureScopeKey(group.descriptor)));
	if (!scopesWithControls.size) return groups;
	return groups.filter((group) => group.descriptor.kind === "control" || !scopesWithControls.has(structureScopeKey(group.descriptor)));
}

function groupEntities(entities: Entity[]): TemplateGroup[] {
	const groups = new Map<string, TemplateGroup>();
	entities.forEach((entity, index) => {
		const descriptor = templateGroupDescriptorForEntity(entity);
		if (!descriptor) return;
		const group = groups.get(descriptor.key);
		if (group) group.members.push({ entity, index });
		else groups.set(descriptor.key, { descriptor, members: [{ entity, index }] });
	});
	return suppressNestedNonControlGroups(Array.from(groups.values()).filter((group) => group.members.length >= MIN_TEMPLATE_INSTANCES))
		.sort((a, b) => b.members.length - a.members.length)
		.slice(0, MAX_TEMPLATES);
}

function nameCounts(group: TemplateGroup): Map<string, number> {
	const counts = new Map<string, number>();
	for (const item of group.members) {
		const name = normalizeName(item.entity.name);
		if (!name) continue;
		counts.set(name, (counts.get(name) || 0) + 1);
	}
	return counts;
}

function anchorFor(group: TemplateGroup, item: GroupedEntity, counts: Map<string, number>): SemanticRefAnchor | undefined {
	const normalizedName = normalizeName(item.entity.name);
	const rawName = displayName(item.entity.name);
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
	return {
		anchors,
		highConfidenceCount: anchors.filter((item) => item.anchor.confidence === "high").length,
		lowConfidenceCount: anchors.filter((item) => item.anchor.confidence === "low").length,
		mintingEligibleCount: anchors.filter((item) => item.anchor.mintingEligible).length,
	};
}

export function semanticRefAnchorHashInput(descriptor: Pick<RefDescriptor, "kind" | "owner" | "documentEpoch">, anchor: SemanticRefAnchor): SemanticRefAnchorHashInput | undefined {
	if (!anchor.mintingEligible || anchor.confidence !== "high" || !anchor.normalizedName || !anchor.containerRole) return undefined;
	return {
		scope: "abml-template",
		kind: descriptor.kind,
		...(typeof descriptor.owner.tabId === "number" ? { tabId: descriptor.owner.tabId } : {}),
		...(descriptor.owner.topLevelOrigin ? { origin: descriptor.owner.topLevelOrigin } : {}),
		...(descriptor.documentEpoch?.url ? { url: descriptor.documentEpoch.url } : {}),
		anchor: {
			containerRole: anchor.containerRole,
			containerName: anchor.containerName || "",
			role: anchor.role,
			kind: anchor.kind,
			normalizedName: anchor.normalizedName,
		},
	};
}
