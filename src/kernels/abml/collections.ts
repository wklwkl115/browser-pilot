// ABML collection completeness + continuation kernel (pure core).
//
// This module classifies repeated page structures as collections and reports whether the observed
// window is complete. It is perception-only: continuation handles are read-only evidence handles,
// not executable routes, and the classifier never asks the browser to scroll/click.
import type { Entity, EntityKind } from "./entity.js";
import type { SnapshotProjection, SnapshotProjectionTemplate } from "./snapshotProjection.js";
import type { StructureTemplate } from "./templating.js";
import type { TreeDiff } from "./treeDiff.js";
import { mintRef } from "../refs/index.js";

export type CollectionCompleteness =
	| "complete"
	| "folded"
	| "viewport-window"
	| "virtualized"
	| "paginated"
	| "lazy"
	| "unknown";

export type CollectionContinuationKind =
	| "read-ref"
	| "artifact-window"
	| "virtual-window"
	| "pagination-edge"
	| "expandable-edge"
	| "data-source"
	| "unknown";

export type CollectionKind = "list" | "table" | "grid" | "feed" | "menu" | "tree" | "region";
export type CollectionConfidence = "high" | "medium" | "low";
export type CollectionDataSource = "aria" | "dom" | "network" | "artifact" | "runtime-probe";
export type CollectionEvidenceSource = "templates" | "itemEntities" | "list_hints" | "rows" | "relations" | "causal" | "growthProbe";

export type CollectionContinuation = {
	kind: CollectionContinuationKind;
	handle: string;
	confidence: CollectionConfidence;
	evidenceRefs: string[];
};

export type CollectionModel = {
	collectionId: string;
	kind: CollectionKind;
	containerRef?: string;
	containerRole?: string;
	containerName?: string;
	itemRole?: string;

	observedCount: number;
	itemRefCount: number;
	itemRefs: string[];
	declaredTotal?: number;
	estimatedTotal?: number;
	hiddenCount?: number;

	completeness: CollectionCompleteness;
	confidence: CollectionConfidence;

	continuation?: CollectionContinuation;

	dataSources?: Array<{
		source: CollectionDataSource;
		ref?: string;
		summary: string;
		confidence: CollectionConfidence;
	}>;

	evidence: Array<{
		source: CollectionEvidenceSource;
		summary: string;
		jsonPath?: string;
		ref?: string;
	}>;
};

export type CollectionScanEvidence = {
	listHints?: Array<Record<string, unknown>>;
	rows?: Array<Record<string, unknown>>;
	actionables?: Array<Record<string, unknown>>;
	growthProbe?: Record<string, unknown>;
};

export type BuildCollectionModelsInput = {
	entities: Entity[];
	templates?: StructureTemplate[];
	treeDiff?: TreeDiff;
	snapshotProjection?: SnapshotProjection;
	scanEvidence?: CollectionScanEvidence;
};

type DraftCollection = {
	kind: CollectionKind;
	containerRef?: string;
	containerRole?: string;
	containerName?: string;
	itemRole?: string;
	observedCount: number;
	itemRefs: string[];
	itemRefCount?: number;
	declaredTotal?: number;
	estimatedTotal?: number;
	hiddenCount?: number;
	sourceRank: number;
	preferredCompleteness?: CollectionCompleteness;
	preferredConfidence?: CollectionConfidence;
	preferredContinuationKind?: CollectionContinuationKind;
	dataSources: NonNullable<CollectionModel["dataSources"]>;
	evidence: CollectionModel["evidence"];
};

const MAX_COLLECTIONS = 8;
const MAX_ITEM_REFS = 20;
const COLLECTION_ITEM_ROLES = new Set([
	"article",
	"cell",
	"gridcell",
	"listitem",
	"menuitem",
	"option",
	"row",
	"treeitem",
]);
const COLLECTION_CONTAINER_ROLES = new Set([
	"feed",
	"grid",
	"list",
	"listbox",
	"menu",
	"menubar",
	"table",
	"tree",
]);

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text : undefined;
}

function numberValue(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function booleanish(value: unknown): boolean {
	return value === true || value === "true" || value === 1;
}

function uniq(values: string[]): string[] {
	return Array.from(new Set(values.filter(Boolean)));
}

function cappedRefs(refs: string[]): string[] {
	return uniq(refs).slice(0, MAX_ITEM_REFS);
}

function normalizeRole(value: unknown): string | undefined {
	return stringValue(value)?.toLowerCase();
}

function collectionKind(containerRole?: string, itemRole?: string, entityKind?: EntityKind): CollectionKind {
	const container = containerRole?.toLowerCase();
	const item = itemRole?.toLowerCase();
	if (container === "feed" || item === "article") return "feed";
	if (container === "table" || item === "row" || item === "cell") return "table";
	if (container === "grid" || item === "gridcell") return "grid";
	if (container === "tree" || item === "treeitem") return "tree";
	if (container === "menu" || container === "menubar" || item === "menuitem") return "menu";
	if (container === "list" || container === "listbox" || item === "listitem" || item === "option") return "list";
	return entityKind === "region" ? "region" : "list";
}

function collectionKey(parts: { containerRef?: string; containerRole?: string; containerName?: string; itemRole?: string; declaredTotal?: number; jsonPath?: string }): string {
	return [
		parts.containerRef,
		parts.containerRole,
		parts.containerName,
		parts.itemRole,
		parts.declaredTotal === undefined ? undefined : `total:${parts.declaredTotal}`,
		parts.jsonPath,
	].filter((item): item is string => !!item).join("\u0000") || "unknown";
}

function templateKey(template: Pick<StructureTemplate, "container" | "containerName" | "role" | "setSize">): string {
	return collectionKey({
		containerRole: template.container,
		containerName: template.containerName,
		itemRole: template.role,
		declaredTotal: template.setSize,
	});
}

function snapshotTemplateKey(template: Pick<SnapshotProjectionTemplate, "container" | "containerName" | "role" | "setSize" | "templateKey">): string {
	return collectionKey({
		containerRole: template.container,
		containerName: template.containerName,
		itemRole: template.role,
		declaredTotal: template.setSize,
		jsonPath: template.templateKey,
	});
}

function entityCollectionKey(entity: Entity): string | undefined {
	const role = normalizeRole(entity.role);
	const setSize = numberValue(entity.structure?.setSize);
	const containerRole = normalizeRole(entity.hints?.containerRole);
	const containerName = stringValue(entity.hints?.containerName);
	const listContainer = entity.hints?.listContainer === true;
	if (containerRole || setSize !== undefined) {
		return collectionKey({ containerRole, containerName, itemRole: role, declaredTotal: setSize });
	}
	if (listContainer) return collectionKey({ containerRole: role, containerName: entity.name, jsonPath: stringValue(entity.hints?.jsonPath) });
	return undefined;
}

function isCollectionItem(entity: Entity): boolean {
	const role = normalizeRole(entity.role);
	if (!role) return false;
	if (COLLECTION_ITEM_ROLES.has(role)) return true;
	if (typeof entity.structure?.posInSet === "number" || typeof entity.structure?.setSize === "number") return true;
	return false;
}

function isSkeletonEntity(entity: Entity): boolean {
	const hints = entity.hints || {};
	if (booleanish(hints.skeleton) || booleanish(hints.placeholder) || booleanish(hints.loadingPlaceholder)) return true;
	const role = normalizeRole(entity.role);
	const name = `${entity.name || ""} ${entity.value || ""}`.toLowerCase();
	return role === "progressbar" || /\b(skeleton|placeholder|loading)\b/.test(name);
}

function roleLooksLikeCollectionContainer(role: string | undefined): boolean {
	return !!role && COLLECTION_CONTAINER_ROLES.has(role);
}

function addDraft(map: Map<string, DraftCollection>, key: string, draft: DraftCollection): void {
	const existing = map.get(key);
	if (!existing) {
		map.set(key, draft);
		return;
	}
	const refs = cappedRefs([...existing.itemRefs, ...draft.itemRefs]);
	const evidence = [...existing.evidence, ...draft.evidence];
	const dataSources = [...existing.dataSources, ...draft.dataSources];
	map.set(key, {
		...existing,
		kind: existing.kind || draft.kind,
		containerRef: existing.containerRef ?? draft.containerRef,
		containerRole: existing.containerRole ?? draft.containerRole,
		containerName: existing.containerName ?? draft.containerName,
		itemRole: existing.itemRole ?? draft.itemRole,
		observedCount: Math.max(existing.observedCount, draft.observedCount),
		itemRefs: refs,
		itemRefCount: Math.max(existing.itemRefCount ?? existing.itemRefs.length, draft.itemRefCount ?? draft.itemRefs.length),
		declaredTotal: existing.declaredTotal ?? draft.declaredTotal,
		estimatedTotal: Math.max(existing.estimatedTotal ?? 0, draft.estimatedTotal ?? 0) || undefined,
		hiddenCount: Math.max(existing.hiddenCount ?? 0, draft.hiddenCount ?? 0) || undefined,
		sourceRank: Math.min(existing.sourceRank, draft.sourceRank),
		preferredCompleteness: existing.preferredCompleteness ?? draft.preferredCompleteness,
		preferredConfidence: existing.preferredConfidence ?? draft.preferredConfidence,
		preferredContinuationKind: existing.preferredContinuationKind ?? draft.preferredContinuationKind,
		dataSources,
		evidence,
	});
}

function templateDraft(template: StructureTemplate, sourceRank: number): DraftCollection {
	const observedCount = Math.max(0, template.count);
	const refs = cappedRefs(template.instanceRefs);
	const folded = observedCount > refs.length;
	return {
		kind: collectionKind(template.container, template.role, template.kind),
		containerRole: template.container,
		containerName: template.containerName,
		itemRole: template.role,
		observedCount,
		itemRefs: refs,
		itemRefCount: observedCount,
		declaredTotal: template.setSize,
		sourceRank,
		...(folded ? { preferredCompleteness: "folded", preferredConfidence: "medium", preferredContinuationKind: "artifact-window" } : {}),
		dataSources: [{
			source: "aria",
			summary: template.setSize !== undefined ? `template count ${observedCount} with declared total ${template.setSize}` : `template count ${observedCount}`,
			confidence: "medium",
		}],
		evidence: [{
			source: "templates",
			summary: `repeated ${template.role} template observed ${observedCount}`,
			ref: template.sample?.ref,
		}],
	};
}

function snapshotDraft(template: SnapshotProjectionTemplate): DraftCollection {
	const observedCount = Math.max(0, template.count);
	const refs = cappedRefs(template.instanceRefs);
	const folded = observedCount > refs.length;
	return {
		kind: collectionKind(template.container, template.role, template.kind),
		containerRole: template.container,
		containerName: template.containerName,
		itemRole: template.role,
		observedCount,
		itemRefs: refs,
		itemRefCount: observedCount,
		declaredTotal: template.setSize,
		sourceRank: 0,
		...(folded ? { preferredCompleteness: "folded", preferredConfidence: "medium", preferredContinuationKind: "artifact-window" } : {}),
		dataSources: [{
			source: "artifact",
			summary: template.setSize !== undefined ? `snapshot projection count ${observedCount} with declared total ${template.setSize}` : `snapshot projection count ${observedCount}`,
			confidence: "medium",
		}],
		evidence: [{
			source: "templates",
			summary: `snapshot template ${template.templateKey} observed ${observedCount}`,
			jsonPath: `envelope.snapshotProjection.templates[templateKey=${template.templateKey}]`,
			ref: template.sample?.ref,
		}],
	};
}

function buildEntityDrafts(entities: Entity[]): Map<string, DraftCollection> {
	const groups = new Map<string, Entity[]>();
	const skeletonsByKey = new Map<string, number>();
	for (const entity of entities) {
		const key = entityCollectionKey(entity);
		if (!key) continue;
		if (isSkeletonEntity(entity)) {
			skeletonsByKey.set(key, (skeletonsByKey.get(key) || 0) + 1);
			continue;
		}
		if (!isCollectionItem(entity) && entity.hints?.listContainer !== true) continue;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(entity);
	}
	const drafts = new Map<string, DraftCollection>();
	for (const [key, members] of groups) {
		const first = members[0]!;
		const role = normalizeRole(first.role);
		const containerRole = normalizeRole(first.hints?.containerRole) ?? (first.hints?.listContainer === true ? role : undefined);
		const containerName = stringValue(first.hints?.containerName) ?? first.name;
		const declaredTotal = numberValue(first.structure?.setSize);
		const positions = new Set(members.map((entity) => numberValue(entity.structure?.posInSet)).filter((item): item is number => item !== undefined && item > 0));
		const hiddenCount = Math.max(...members.map((entity) => numberValue(entity.hints?.hiddenCount) ?? 0), 0);
		const skeletonCount = skeletonsByKey.get(key) || 0;
		const observedCount = members.filter((entity) => entity.hints?.listContainer !== true).length || numberValue(first.hints?.itemCount) || 0;
		const refs = cappedRefs(members.filter((entity) => entity.hints?.listContainer !== true).map((entity) => entity.ref));
		const dataSources: NonNullable<CollectionModel["dataSources"]> = [];
		if (declaredTotal !== undefined || positions.size) {
			dataSources.push({
				source: "aria",
				summary: declaredTotal !== undefined ? `ARIA set positions ${positions.size}/${declaredTotal}` : `ARIA positions ${positions.size}`,
				confidence: declaredTotal !== undefined ? "high" : "medium",
			});
		}
		if (first.hints?.listContainer === true || hiddenCount > 0 || skeletonCount > 0) {
			dataSources.push({
				source: "dom",
				ref: first.ref,
				summary: hiddenCount > 0 ? `list container reports ${hiddenCount} hidden items` : skeletonCount > 0 ? `list container has ${skeletonCount} loading placeholders` : "list container hint",
				confidence: hiddenCount > 0 || skeletonCount > 0 ? "medium" : "low",
			});
		}
		const evidence: CollectionModel["evidence"] = [{
			source: "itemEntities",
			summary: declaredTotal !== undefined ? `item entities observed ${observedCount} of declared ${declaredTotal}` : `item entities observed ${observedCount}`,
			ref: first.ref,
		}];
		if (skeletonCount > 0) {
			evidence.push({
				source: "list_hints",
				summary: `${skeletonCount} rendered loading placeholders indicate lazy hydration`,
				ref: first.ref,
			});
		}
		addDraft(drafts, key, {
			kind: collectionKind(containerRole, role, first.kind),
			containerRef: first.hints?.listContainer === true ? first.ref : undefined,
			containerRole,
			containerName,
			itemRole: role,
			observedCount,
			itemRefs: refs,
			itemRefCount: refs.length,
			declaredTotal,
			estimatedTotal: hiddenCount > 0 ? observedCount + hiddenCount : undefined,
			hiddenCount: hiddenCount || undefined,
			sourceRank: 1,
			...(skeletonCount > 0 ? { preferredCompleteness: "lazy", preferredConfidence: "medium", preferredContinuationKind: "virtual-window" } : {}),
			dataSources,
			evidence,
		});
	}
	return drafts;
}

function listHintKey(hint: Record<string, unknown>, index: number): string {
	return collectionKey({
		containerRole: "list",
		containerName: stringValue(hint.firstItemPreview) ?? stringValue(hint.selector) ?? `list-${index}`,
		jsonPath: `data.list_hints[${index}]`,
	});
}

function listHintDraft(hint: Record<string, unknown>, index: number): DraftCollection {
	const observedCount = numberValue(hint.itemCount) ?? 0;
	const hiddenCount = numberValue(hint.hiddenCount) ?? 0;
	const selector = stringValue(hint.selector);
	const firstItem = stringValue(hint.firstItemPreview);
	return {
		kind: "list",
		containerRole: "list",
		containerName: firstItem ?? selector ?? `list-${index}`,
		observedCount,
		itemRefs: [],
		itemRefCount: 0,
		estimatedTotal: hiddenCount > 0 ? observedCount + hiddenCount : undefined,
		hiddenCount: hiddenCount || undefined,
		sourceRank: 3,
		preferredCompleteness: hiddenCount > 0 ? "lazy" : "viewport-window",
		preferredConfidence: hiddenCount > 0 ? "medium" : "low",
		preferredContinuationKind: hiddenCount > 0 ? "virtual-window" : "unknown",
		dataSources: [{
			source: "dom",
			summary: hiddenCount > 0 ? `scan list hint observed ${observedCount} plus ${hiddenCount} hidden` : `scan list hint observed ${observedCount}`,
			confidence: hiddenCount > 0 ? "medium" : "low",
		}],
		evidence: [{
			source: "list_hints",
			summary: firstItem ? `list hint sample: ${firstItem}` : "scan list hint",
			jsonPath: `data.list_hints[${index}]`,
		}],
	};
}

function actionableText(actionable: Record<string, unknown>): string {
	return [actionable.action, actionable.label, actionable.text, actionable.name, actionable.ariaLabel]
		.map((item) => stringValue(item))
		.filter((item): item is string => !!item)
		.join(" ")
		.toLowerCase();
}

function paginationEdge(actionables: Array<Record<string, unknown>> | undefined): { kind: CollectionContinuationKind; confidence: CollectionConfidence; summary: string; jsonPath?: string } | undefined {
	for (const [index, actionable] of (actionables ?? []).entries()) {
		if (actionable.disabled === true || actionable.hidden === true) continue;
		const text = actionableText(actionable);
		if (/\b(next|more|load\s*more|show\s*more|older|newer)\b/.test(text)) {
			const isPagination = /\b(next|older|newer|page)\b/.test(text);
			return {
				kind: isPagination ? "pagination-edge" : "expandable-edge",
				confidence: "medium",
				summary: isPagination ? "visible next/page control" : "visible load/show more control",
				jsonPath: `data.actionables[${index}]`,
			};
		}
	}
	return undefined;
}

function growthProbeEvidence(probe: Record<string, unknown> | undefined): { confidence: CollectionConfidence; summary: string } | undefined {
	if (!probe) return undefined;
	const beforeCount = numberValue(probe.beforeCount ?? probe.oldCount);
	const afterCount = numberValue(probe.afterCount ?? probe.newCount);
	const beforeHeight = numberValue(probe.beforeScrollHeight ?? probe.oldScrollHeight);
	const afterHeight = numberValue(probe.afterScrollHeight ?? probe.newScrollHeight);
	const beforeFirstText = stringValue(probe.beforeFirstText);
	const afterFirstText = stringValue(probe.afterFirstText);
	const countGrew = beforeCount !== undefined && afterCount !== undefined && afterCount > beforeCount;
	const heightGrew = beforeHeight !== undefined && afterHeight !== undefined && afterHeight > beforeHeight;
	const windowShifted = (beforeFirstText !== undefined && afterFirstText !== undefined && beforeFirstText !== afterFirstText) || probe.windowShifted === true;
	if (!countGrew && !heightGrew && !windowShifted && probe.countGrew !== true && probe.heightGrew !== true) return undefined;
	const parts = [
		countGrew ? `count ${beforeCount}->${afterCount}` : undefined,
		heightGrew ? `scrollHeight ${beforeHeight}->${afterHeight}` : undefined,
		windowShifted ? "visible item window shifted" : undefined,
	].filter((item): item is string => !!item);
	return { confidence: countGrew || windowShifted ? "high" : "medium", summary: parts.join(", ") || "growth probe increased collection window" };
}

function completenessForDraft(draft: DraftCollection, edge?: ReturnType<typeof paginationEdge>, growth?: ReturnType<typeof growthProbeEvidence>): { completeness: CollectionCompleteness; confidence: CollectionConfidence; continuationKind?: CollectionContinuationKind; reason: string } {
	if (growth) {
		return {
			completeness: "virtualized",
			confidence: growth.confidence,
			continuationKind: "virtual-window",
			reason: `generic growth probe changed the observed window (${growth.summary})`,
		};
	}
	if (draft.declaredTotal !== undefined && draft.declaredTotal > 0) {
		if (draft.observedCount < draft.declaredTotal) {
			return {
				completeness: "virtualized",
				confidence: "high",
				continuationKind: "virtual-window",
				reason: `observed ${draft.observedCount} of declared total ${draft.declaredTotal}`,
			};
		}
	}
	if (draft.preferredCompleteness === "folded") {
		return {
			completeness: "folded",
			confidence: draft.preferredConfidence ?? "medium",
			continuationKind: draft.preferredContinuationKind ?? "artifact-window",
			reason: "collection has more item refs than the inline cap",
		};
	}
	if (draft.declaredTotal !== undefined && draft.declaredTotal > 0) {
		if (draft.observedCount >= draft.declaredTotal && draft.itemRefs.length >= Math.min(draft.declaredTotal, MAX_ITEM_REFS)) {
			return { completeness: "complete", confidence: "high", reason: `observed ${draft.observedCount} covers declared total ${draft.declaredTotal}` };
		}
	}
	if ((draft.hiddenCount ?? 0) > 0) {
		return {
			completeness: draft.preferredCompleteness ?? "lazy",
			confidence: draft.preferredConfidence ?? "medium",
			continuationKind: draft.preferredContinuationKind ?? "virtual-window",
			reason: `scan evidence reports ${draft.hiddenCount} hidden items`,
		};
	}
	if (draft.preferredCompleteness === "lazy") {
		return {
			completeness: "lazy",
			confidence: draft.preferredConfidence ?? "medium",
			continuationKind: draft.preferredContinuationKind ?? "virtual-window",
			reason: "rendered loading placeholders indicate lazy hydration",
		};
	}
	if (edge) {
		return {
			completeness: edge.kind === "pagination-edge" ? "paginated" : "lazy",
			confidence: edge.confidence,
			continuationKind: edge.kind,
			reason: edge.summary,
		};
	}
	if (draft.preferredCompleteness === "viewport-window") {
		return {
			completeness: "viewport-window",
			confidence: draft.preferredConfidence ?? "low",
			continuationKind: draft.preferredContinuationKind,
			reason: "visible list hint has no declared total or terminal boundary",
		};
	}
	if (draft.observedCount > 0 && roleLooksLikeCollectionContainer(draft.containerRole)) {
		return {
			completeness: "viewport-window",
			confidence: "low",
			continuationKind: "unknown",
			reason: "collection-like container observed without total or boundary proof",
		};
	}
	return { completeness: "unknown", confidence: "low", reason: "not enough collection evidence" };
}

function continuationFor(collectionId: string, kind: CollectionContinuationKind | undefined, confidence: CollectionConfidence, evidenceRefs: string[]): CollectionContinuation | undefined {
	if (!kind) return undefined;
	return {
		kind,
		handle: mintRef("collection", collectionId),
		confidence,
		evidenceRefs: uniq(evidenceRefs).slice(0, 8),
	};
}

function modelFromDraft(index: number, draft: DraftCollection, edge?: ReturnType<typeof paginationEdge>, growth?: ReturnType<typeof growthProbeEvidence>): CollectionModel {
	const collectionId = `c${index + 1}`;
	const classified = completenessForDraft(draft, edge, growth);
	const evidence = [...draft.evidence];
	if (edge) evidence.push({ source: "relations", summary: edge.summary, jsonPath: edge.jsonPath });
	if (growth) evidence.push({ source: "growthProbe", summary: growth.summary, jsonPath: "scanEvidence.growthProbe" });
	const estimatedTotal = draft.estimatedTotal ?? (draft.declaredTotal !== undefined ? draft.declaredTotal : undefined);
	const model: CollectionModel = {
		collectionId,
		kind: draft.kind,
		...(draft.containerRef ? { containerRef: draft.containerRef } : {}),
		...(draft.containerRole ? { containerRole: draft.containerRole } : {}),
		...(draft.containerName ? { containerName: draft.containerName } : {}),
		...(draft.itemRole ? { itemRole: draft.itemRole } : {}),
		observedCount: draft.observedCount,
		itemRefCount: draft.itemRefCount ?? draft.itemRefs.length,
		itemRefs: cappedRefs(draft.itemRefs),
		...(draft.declaredTotal !== undefined ? { declaredTotal: draft.declaredTotal } : {}),
		...(estimatedTotal !== undefined && estimatedTotal > 0 ? { estimatedTotal } : {}),
		...(draft.hiddenCount !== undefined ? { hiddenCount: draft.hiddenCount } : {}),
		completeness: classified.completeness,
		confidence: classified.confidence,
		...(draft.dataSources.length ? { dataSources: draft.dataSources.slice(0, 5) } : {}),
		evidence: evidence.slice(0, 8),
	};
	const evidenceRefs = model.evidence.map((item) => item.ref ?? item.jsonPath).filter((item): item is string => !!item);
	const continuation = continuationFor(collectionId, classified.continuationKind, classified.confidence, evidenceRefs);
	return continuation ? { ...model, continuation } : model;
}

export function summarizeCollectionCompleteness(model: CollectionModel): {
	completeness: CollectionCompleteness;
	reason: string;
	confidence: CollectionConfidence;
} {
	switch (model.completeness) {
		case "complete":
			return { completeness: model.completeness, confidence: model.confidence, reason: `observed ${model.observedCount}${model.declaredTotal !== undefined ? ` of declared ${model.declaredTotal}` : ""}` };
		case "folded":
			return { completeness: model.completeness, confidence: model.confidence, reason: `inline refs capped at ${model.itemRefs.length} for ${model.itemRefCount} observed items` };
		case "virtualized":
			return { completeness: model.completeness, confidence: model.confidence, reason: model.declaredTotal !== undefined ? `observed ${model.observedCount} of declared ${model.declaredTotal}` : "growth/window evidence indicates more items than the observed window" };
		case "lazy":
			return { completeness: model.completeness, confidence: model.confidence, reason: model.hiddenCount !== undefined ? `hidden/lazy count ${model.hiddenCount}` : "lazy placeholder or load-more evidence" };
		case "paginated":
			return { completeness: model.completeness, confidence: model.confidence, reason: "pagination edge is visible for this collection" };
		case "viewport-window":
			return { completeness: model.completeness, confidence: model.confidence, reason: "visible viewport window without terminal boundary proof" };
		default:
			return { completeness: model.completeness, confidence: model.confidence, reason: "insufficient evidence to prove collection completeness" };
	}
}

export function buildCollectionModels(input: BuildCollectionModelsInput): CollectionModel[] {
	const drafts = new Map<string, DraftCollection>();
	for (const template of input.snapshotProjection?.templates ?? []) {
		addDraft(drafts, snapshotTemplateKey(template), snapshotDraft(template));
	}
	if (!input.snapshotProjection && input.templates) {
		for (const template of input.templates) addDraft(drafts, templateKey(template), templateDraft(template, 1));
	}
	for (const [key, draft] of buildEntityDrafts(input.entities)) addDraft(drafts, key, draft);
	for (const [index, hint] of (input.scanEvidence?.listHints ?? []).entries()) {
		addDraft(drafts, listHintKey(hint, index), listHintDraft(hint, index));
	}
	const edge = paginationEdge(input.scanEvidence?.actionables);
	const growth = growthProbeEvidence(input.scanEvidence?.growthProbe);
	return [...drafts.values()]
		.filter((draft) => draft.observedCount > 0 || (draft.hiddenCount ?? 0) > 0 || draft.itemRefs.length > 0)
		.sort((a, b) => a.sourceRank - b.sourceRank || b.observedCount - a.observedCount || (b.declaredTotal ?? 0) - (a.declaredTotal ?? 0))
		.slice(0, MAX_COLLECTIONS)
		.map((draft, index) => modelFromDraft(index, draft, edge, growth));
}
