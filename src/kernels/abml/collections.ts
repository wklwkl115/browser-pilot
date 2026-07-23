// ABML collection completeness kernel (pure core).
//
// This module classifies repeated page structures as collections and reports whether the observed
// window is complete. It is perception-only and never asks the browser to scroll/click.
import type { Entity, EntityKind } from "./entity.js";
import type { SnapshotProjection, SnapshotProjectionTemplate } from "./snapshotProjection.js";
import type { StructureTemplate } from "./templating.js";
import type { TreeDiff } from "./treeDiff.js";
import { firstSafeSemanticText, safeContainerLabelText, sanitizeSemanticText } from "./semanticText.js";
import type { ScanActionable, ScanGrowthProbe, ScanListHint, ScanRow } from "./pageWorldScan.js";
import { nonEmptyString as stringValue } from "../../utils/records.js";

type ListHintInput = ScanListHint | Record<string, unknown>;
type ActionableInput = ScanActionable | Record<string, unknown>;
type GrowthProbeInput = ScanGrowthProbe | Record<string, unknown>;

export type CollectionCompleteness =
	| "complete"
	| "folded"
	| "viewport-window"
	| "virtualized"
	| "paginated"
	| "lazy"
	| "unknown";

export type CollectionKind = "list" | "table" | "grid" | "feed" | "menu" | "tree" | "region";
export type CollectionConfidence = "high" | "medium" | "low";
export type CollectionDataSource = "aria" | "dom" | "network" | "snapshot" | "runtime-probe";
export type CollectionEvidenceSource = "templates" | "itemEntities" | "listHints" | "rows" | "relations" | "causal" | "growthProbe";

export type PaginationControlKind = "next" | "previous" | "load-more" | "show-more" | "other";

export type PaginationControl = {
	ref?: string;
	label?: string;
	kind: PaginationControlKind;
};

export type ScrollDirection = "vertical" | "horizontal" | "both";

export type CollectionModel = {
	collectionId: string;
	kind: CollectionKind;
	containerRef?: string;
	containerRole?: string;
	containerName?: string;
	containerNameContext?: string;
	containerNameSource?: "safe-label" | "safe-preview" | "fallback" | "disambiguated";
	itemRole?: string;

	observedCount: number;
	itemRefCount: number;
	itemRefs: string[];
	declaredTotal?: number;
	estimatedTotal?: number;
	hiddenCount?: number;

	completeness: CollectionCompleteness;
	confidence: CollectionConfidence;

	pageSize?: number;
	paginationControl?: PaginationControl;
	scrollDirection?: ScrollDirection;

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
	listHints?: ListHintInput[];
	rows?: Array<ScanRow | Record<string, unknown>>;
	actionables?: ActionableInput[];
	growthProbe?: GrowthProbeInput;
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
	containerNameContext?: string;
	containerNameSource?: NonNullable<CollectionModel["containerNameSource"]>;
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
	dataSources: NonNullable<CollectionModel["dataSources"]>;
	evidence: CollectionModel["evidence"];
};

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

function normalizeNameKey(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function collectionNameContext(parts: Array<string | undefined>): string | undefined {
	const text = sanitizeSemanticText(parts.filter(Boolean).join(" "), 80);
	return text && text.length >= 2 ? text : undefined;
}

function selectorContext(value: unknown): string | undefined {
	const selector = stringValue(value);
	if (!selector) return undefined;
	const match = selector.match(/(?:#([A-Za-z0-9_-]{2,})|\.([A-Za-z0-9_-]{2,}))/);
	return match ? collectionNameContext([(match[1] ?? match[2])?.replace(/[-_]+/g, " ")]) : undefined;
}

type ListHintNameParts = {
	name: string;
	context?: string;
	source: NonNullable<CollectionModel["containerNameSource"]>;
};

function disambiguatedCollectionName(name: string | undefined, context: string | undefined): string | undefined {
	if (!name || !context) return name;
	return normalizeNameKey(name) === normalizeNameKey(context) ? name : `${name} (${context})`;
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
	const containerName = sanitizeSemanticText(entity.hints?.containerName, 160);
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
	const refs = uniq([...existing.itemRefs, ...draft.itemRefs]);
	const evidence = [...existing.evidence, ...draft.evidence];
	const dataSources = [...existing.dataSources, ...draft.dataSources];
	map.set(key, {
		...existing,
		kind: existing.kind || draft.kind,
		containerRef: existing.containerRef ?? draft.containerRef,
		containerRole: existing.containerRole ?? draft.containerRole,
		containerName: existing.containerName ?? draft.containerName,
		containerNameContext: existing.containerNameContext ?? draft.containerNameContext,
		containerNameSource: existing.containerNameSource ?? draft.containerNameSource,
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
		dataSources,
		evidence,
	});
}

function templateDraft(template: StructureTemplate, sourceRank: number): DraftCollection {
	const observedCount = Math.max(0, template.count);
	const refs = uniq(template.instanceRefs);
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
		...(folded ? { preferredCompleteness: "folded", preferredConfidence: "medium" } : {}),
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
	const refs = uniq(template.instanceRefs);
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
		...(folded ? { preferredCompleteness: "folded", preferredConfidence: "medium" } : {}),
		dataSources: [{
			source: "snapshot",
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
		const containerName = sanitizeSemanticText(first.hints?.containerName, 160) ?? sanitizeSemanticText(first.name, 160);
		const declaredTotal = numberValue(first.structure?.setSize);
		const positions = new Set(members.map((entity) => numberValue(entity.structure?.posInSet)).filter((item): item is number => item !== undefined && item > 0));
		const hiddenCount = Math.max(...members.map((entity) => numberValue(entity.hints?.hiddenCount) ?? 0), 0);
		const skeletonCount = skeletonsByKey.get(key) || 0;
		const observedCount = members.filter((entity) => entity.hints?.listContainer !== true).length || numberValue(first.hints?.itemCount) || 0;
		const refs = uniq(members.filter((entity) => entity.hints?.listContainer !== true).map((entity) => entity.ref));
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
				source: "listHints",
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
			...(skeletonCount > 0 ? { preferredCompleteness: "lazy", preferredConfidence: "medium" } : {}),
			dataSources,
			evidence,
		});
	}
	return drafts;
}

function listHintNameParts(hint: ListHintInput, index: number): ListHintNameParts {
	const label = firstSafeSemanticText([hint.containerLabel, hint.containerName, hint.label], 80);
	const preview = safeContainerLabelText(hint.firstItemPreview, 80);
	const fallback = `list-${index}`;
	const context = collectionNameContext([
		selectorContext(hint.selector),
		sanitizeSemanticText(hint.heading, 40),
		sanitizeSemanticText(hint.nearestHeading, 40),
		sanitizeSemanticText(hint.landmarkName, 40),
		sanitizeSemanticText(hint.parentLabel, 40),
	]);
	if (label) return { name: label, ...(context ? { context } : {}), source: "safe-label" };
	if (preview) return { name: preview, ...(context ? { context } : {}), source: "safe-preview" };
	return { name: fallback, ...(context ? { context } : {}), source: "fallback" };
}

function listHintName(hint: ListHintInput, index: number): string {
	return listHintNameParts(hint, index).name;
}

function listHintKey(hint: ListHintInput, index: number): string {
	return collectionKey({
		containerRole: "list",
		containerName: listHintName(hint, index),
		jsonPath: `data.structure.listHints[${index}]`,
	});
}

function listHintDraft(hint: ListHintInput, index: number): DraftCollection {
	const observedCount = numberValue(hint.itemCount) ?? 0;
	const hiddenCount = numberValue(hint.hiddenCount) ?? 0;
	const firstItem = sanitizeSemanticText(hint.firstItemPreview, 160);
	const nameParts = listHintNameParts(hint, index);
	return {
		kind: "list",
		containerRole: "list",
		containerName: nameParts.name,
		containerNameContext: nameParts.context,
		containerNameSource: nameParts.source,
		observedCount,
		itemRefs: [],
		itemRefCount: 0,
		estimatedTotal: hiddenCount > 0 ? observedCount + hiddenCount : undefined,
		hiddenCount: hiddenCount || undefined,
		sourceRank: 3,
		preferredCompleteness: hiddenCount > 0 ? "lazy" : "viewport-window",
		preferredConfidence: hiddenCount > 0 ? "medium" : "low",
		dataSources: [{
			source: "dom",
			summary: hiddenCount > 0 ? `scan list hint observed ${observedCount} plus ${hiddenCount} hidden` : `scan list hint observed ${observedCount}`,
			confidence: hiddenCount > 0 ? "medium" : "low",
		}],
		evidence: [{
			source: "listHints",
			summary: firstItem ? `list hint sample: ${firstItem}` : "scan list hint",
			jsonPath: `data.structure.listHints[${index}]`,
		}],
	};
}

function actionableText(actionable: ActionableInput): string {
	return [actionable.action, actionable.label, actionable.text, actionable.name, actionable.ariaLabel]
		.map((item) => stringValue(item))
		.filter((item): item is string => !!item)
		.join(" ")
		.toLowerCase();
}

function classifyPaginationControlKind(text: string): PaginationControlKind {
	if (/\bprevious\b|\bprev\b|\bback\b/.test(text)) return "previous";
	if (/\bnext\b|\bolder\b|\bnewer\b/.test(text)) return "next";
	if (/\bload\s*more\b/.test(text)) return "load-more";
	if (/\bshow\s*more\b/.test(text)) return "show-more";
	return "other";
}

function paginationEdge(actionables: ActionableInput[] | undefined): { completeness: "paginated" | "lazy"; confidence: CollectionConfidence; summary: string; jsonPath?: string; control: PaginationControl } | undefined {
	for (const [index, actionable] of (actionables ?? []).entries()) {
		if (actionable.disabled === true || actionable.hidden === true) continue;
		const text = actionableText(actionable);
		if (/\b(next|more|load\s*more|show\s*more|older|newer)\b/.test(text)) {
			const isPagination = /\b(next|older|newer|page)\b/.test(text);
			const controlKind = classifyPaginationControlKind(text);
			const ref = stringValue(actionable.ref);
			const label = stringValue(actionable.label) ?? stringValue(actionable.text) ?? stringValue(actionable.ariaLabel);
			return {
					completeness: isPagination ? "paginated" : "lazy",
				confidence: "medium",
				summary: isPagination ? "visible next/page control" : "visible load/show more control",
				jsonPath: `data.structure.actionables[${index}]`,
				control: {
					...(ref ? { ref } : {}),
					...(label ? { label } : {}),
					kind: controlKind,
				},
			};
		}
	}
	return undefined;
}

function growthProbeEvidence(probe: GrowthProbeInput | undefined): { confidence: CollectionConfidence; summary: string } | undefined {
	if (!probe) return undefined;
	const beforeCount = numberValue(probe.beforeCount);
	const afterCount = numberValue(probe.afterCount);
	const beforeHeight = numberValue(probe.beforeScrollHeight);
	const afterHeight = numberValue(probe.afterScrollHeight);
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

function completenessForDraft(draft: DraftCollection, edge?: ReturnType<typeof paginationEdge>, growth?: ReturnType<typeof growthProbeEvidence>): { completeness: CollectionCompleteness; confidence: CollectionConfidence; reason: string } {
	if (growth) {
		return {
			completeness: "virtualized",
			confidence: growth.confidence,
			reason: `generic growth probe changed the observed window (${growth.summary})`,
		};
	}
	if (draft.declaredTotal !== undefined && draft.declaredTotal > 0) {
		if (draft.observedCount < draft.declaredTotal) {
			return {
				completeness: "virtualized",
				confidence: "high",
				reason: `observed ${draft.observedCount} of declared total ${draft.declaredTotal}`,
			};
		}
	}
	if (draft.preferredCompleteness === "folded") {
		return {
			completeness: "folded",
			confidence: draft.preferredConfidence ?? "medium",
			reason: "collection has fewer captured refs than observed items",
		};
	}
	if (draft.declaredTotal !== undefined && draft.declaredTotal > 0) {
		if (draft.observedCount >= draft.declaredTotal && draft.itemRefs.length >= draft.declaredTotal) {
			return { completeness: "complete", confidence: "high", reason: `observed ${draft.observedCount} covers declared total ${draft.declaredTotal}` };
		}
	}
	if ((draft.hiddenCount ?? 0) > 0) {
		return {
			completeness: draft.preferredCompleteness ?? "lazy",
			confidence: draft.preferredConfidence ?? "medium",
			reason: `scan evidence reports ${draft.hiddenCount} hidden items`,
		};
	}
	if (draft.preferredCompleteness === "lazy") {
		return {
			completeness: "lazy",
			confidence: draft.preferredConfidence ?? "medium",
			reason: "rendered loading placeholders indicate lazy hydration",
		};
	}
	if (edge) {
		return {
			completeness: edge.completeness,
			confidence: edge.confidence,
			reason: edge.summary,
		};
	}
	if (draft.preferredCompleteness === "viewport-window") {
		return {
			completeness: "viewport-window",
			confidence: draft.preferredConfidence ?? "low",
			reason: "visible list hint has no declared total or terminal boundary",
		};
	}
	if (draft.observedCount > 0 && roleLooksLikeCollectionContainer(draft.containerRole)) {
		return {
			completeness: "viewport-window",
			confidence: "low",
			reason: "collection-like container observed without total or boundary proof",
		};
	}
	return { completeness: "unknown", confidence: "low", reason: "not enough collection evidence" };
}

function inferPageSize(draft: DraftCollection, probe: GrowthProbeInput | undefined): number | undefined {
	if (probe) {
		const beforeCount = numberValue(probe.beforeCount);
		const afterCount = numberValue(probe.afterCount);
		if (beforeCount !== undefined && afterCount !== undefined && afterCount > beforeCount) {
			const size = afterCount - beforeCount;
			if (size > 0 && (draft.declaredTotal === undefined || size < draft.declaredTotal)) {
				return size;
			}
		}
	}
	return undefined;
}

function inferScrollDirection(probe: GrowthProbeInput | undefined): ScrollDirection | undefined {
	if (!probe) return undefined;
	const beforeHeight = numberValue(probe.beforeScrollHeight);
	const afterHeight = numberValue(probe.afterScrollHeight);
	if (beforeHeight !== undefined && afterHeight !== undefined && beforeHeight !== afterHeight) {
		return "vertical";
	}
	return undefined;
}

function modelFromDraft(index: number, draft: DraftCollection, edge?: ReturnType<typeof paginationEdge>, growth?: ReturnType<typeof growthProbeEvidence>, rawGrowthProbe?: GrowthProbeInput, ambiguousNames?: Set<string>): CollectionModel {
	const collectionId = `c${index + 1}`;
	const classified = completenessForDraft(draft, edge, growth);
	const evidence = [...draft.evidence];
	if (edge) evidence.push({ source: "relations", summary: edge.summary, jsonPath: edge.jsonPath });
	if (growth) evidence.push({ source: "growthProbe", summary: growth.summary, jsonPath: "scanEvidence.growthProbe" });
	const estimatedTotal = draft.estimatedTotal ?? (draft.declaredTotal !== undefined ? draft.declaredTotal : undefined);
	const hasAmbiguousName = !!draft.containerName && ambiguousNames?.has(normalizeNameKey(draft.containerName));
	const safeContext = hasAmbiguousName ? draft.containerNameContext : undefined;
	const containerName = hasAmbiguousName ? disambiguatedCollectionName(draft.containerName, safeContext) : draft.containerName;
	const containerNameSource = hasAmbiguousName && containerName !== draft.containerName ? "disambiguated" : draft.containerNameSource;

	const pageSize = inferPageSize(draft, rawGrowthProbe);
	const paginationControl = edge?.control;
	const scrollDirection = inferScrollDirection(rawGrowthProbe);

	const model: CollectionModel = {
		collectionId,
		kind: draft.kind,
		...(draft.containerRef ? { containerRef: draft.containerRef } : {}),
		...(draft.containerRole ? { containerRole: draft.containerRole } : {}),
		...(containerName ? { containerName } : {}),
		...(safeContext && containerName === draft.containerName ? { containerNameContext: safeContext } : {}),
		...(containerNameSource ? { containerNameSource } : {}),
		...(draft.itemRole ? { itemRole: draft.itemRole } : {}),
		observedCount: draft.observedCount,
		itemRefCount: draft.itemRefCount ?? draft.itemRefs.length,
		itemRefs: uniq(draft.itemRefs),
		...(draft.declaredTotal !== undefined ? { declaredTotal: draft.declaredTotal } : {}),
		...(estimatedTotal !== undefined && estimatedTotal > 0 ? { estimatedTotal } : {}),
		...(draft.hiddenCount !== undefined ? { hiddenCount: draft.hiddenCount } : {}),
		completeness: classified.completeness,
		confidence: classified.confidence,
		...(draft.dataSources.length ? { dataSources: draft.dataSources } : {}),
		evidence,
	};

	if (pageSize !== undefined) model.pageSize = pageSize;
	if (paginationControl !== undefined) model.paginationControl = paginationControl;
	if (scrollDirection !== undefined) model.scrollDirection = scrollDirection;

	return model;
}

function ambiguousContainerNames(drafts: DraftCollection[]): Set<string> {
	const counts = new Map<string, number>();
	for (const draft of drafts) {
		const key = normalizeNameKey(draft.containerName);
		if (!key) continue;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

function uniqueCollectionNames(models: CollectionModel[]): CollectionModel[] {
	const counts = new Map<string, number>();
	for (const model of models) {
		const key = normalizeNameKey(model.containerName);
		if (!key) continue;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const duplicateKeys = new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
	if (!duplicateKeys.size) return models;
	const used = new Set(models.map((model) => normalizeNameKey(model.containerName)).filter(Boolean));
	const seen = new Map<string, number>();
	return models.map((model) => {
		const key = normalizeNameKey(model.containerName);
		if (!key || !duplicateKeys.has(key) || !model.containerName) return model;
		const next = (seen.get(key) ?? 0) + 1;
		seen.set(key, next);
		used.delete(key);
		let suffix = next;
		let containerName = `${model.containerName} (${suffix})`;
		while (used.has(normalizeNameKey(containerName))) {
			suffix += 1;
			containerName = `${model.containerName} (${suffix})`;
		}
		used.add(normalizeNameKey(containerName));
		return { ...model, containerName, containerNameSource: "disambiguated" };
	});
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
	const rawGrowthProbe = input.scanEvidence?.growthProbe;
	const growth = growthProbeEvidence(rawGrowthProbe);
	const sortedDrafts = [...drafts.values()]
		.filter((draft) => draft.observedCount > 0 || (draft.hiddenCount ?? 0) > 0 || draft.itemRefs.length > 0)
		.sort((a, b) => a.sourceRank - b.sourceRank || b.observedCount - a.observedCount || (b.declaredTotal ?? 0) - (a.declaredTotal ?? 0));
	const outputAmbiguousNames = ambiguousContainerNames(sortedDrafts);
	const inputAmbiguousNames = ambiguousContainerNames([...drafts.values()]);
	return uniqueCollectionNames(sortedDrafts.map((draft, index) => modelFromDraft(index, draft, edge, growth, rawGrowthProbe, outputAmbiguousNames.has(normalizeNameKey(draft.containerName)) ? outputAmbiguousNames : inputAmbiguousNames)));
}
