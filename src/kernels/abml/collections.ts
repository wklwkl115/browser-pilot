// Concept: "Collection" and "Frontier" completeness (docs/concepts.md) — pure core.
//
// This module classifies repeated page structures as collections and reports whether the observed
// window is complete. It is perception-only and never asks the browser to scroll/click.
import { isAddressableEntity, type Entity, type EntityKind } from "./entity.js";
import type { SnapshotProjection, SnapshotProjectionTemplate } from "./snapshotProjection.js";
import type { StructureTemplate } from "./templating.js";
import { firstSafeSemanticText, safeContainerLabelText, sanitizeSemanticText } from "./semanticText.js";
import type { ScanActionable, ScanListHint } from "./pageWorldScan.js";
import { isRecord, nonEmptyString as stringValue } from "../../utils/records.js";

type ListHintInput = ScanListHint | Record<string, unknown>;
type ActionableInput = ScanActionable | Record<string, unknown>;

export type CollectionCompleteness = "complete" | "viewport-window" | "virtualized" | "paginated" | "lazy" | "unknown";

export type CollectionKind = "list" | "table" | "grid" | "feed" | "menu" | "tree" | "region";
export type CollectionConfidence = "high" | "medium" | "low";
export type CollectionDataSource = "aria" | "dom" | "snapshot";
export type CollectionEvidenceSource = "templates" | "itemEntities" | "listHints" | "relations";

export type PaginationControlKind = "next" | "previous" | "load-more" | "show-more" | "other";

export type PaginationControl = {
	ref?: string;
	label?: string;
	kind: PaginationControlKind;
};

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

	completeness: CollectionCompleteness;
	confidence: CollectionConfidence;

	paginationControl?: PaginationControl;

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
	actionables?: ActionableInput[];
};

export type BuildCollectionModelsInput = {
	entities: Entity[];
	templates?: StructureTemplate[];
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
	observedPositions?: number;
	declaredTotal?: number;
	estimatedTotal?: number;
	sourceRank: number;
	preferredCompleteness?: CollectionCompleteness;
	preferredConfidence?: CollectionConfidence;
	/** Viewport-relative union of member geometry; anchors pagination controls to their collection. */
	box?: Box;
	dataSources: NonNullable<CollectionModel["dataSources"]>;
	evidence: CollectionModel["evidence"];
};

type Box = { x: number; y: number; w: number; h: number };

function unionBox(boxes: Box[]): Box | undefined {
	if (!boxes.length) return undefined;
	const minX = Math.min(...boxes.map((box) => box.x));
	const minY = Math.min(...boxes.map((box) => box.y));
	const maxX = Math.max(...boxes.map((box) => box.x + box.w));
	const maxY = Math.max(...boxes.map((box) => box.y + box.h));
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

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
const COLLECTION_CONTAINER_ROLES = new Set(["feed", "grid", "list", "listbox", "menu", "menubar", "table", "tree"]);

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

function collectionKey(parts: {
	containerRef?: string;
	containerRole?: string;
	containerName?: string;
	containerKey?: string;
	itemRole?: string;
	declaredTotal?: number;
	jsonPath?: string;
}): string {
	return (
		[
			parts.containerRef,
			parts.containerRole,
			parts.containerName,
			parts.containerKey,
			parts.itemRole,
			parts.declaredTotal === undefined ? undefined : `total:${parts.declaredTotal}`,
			parts.jsonPath,
		]
			.filter((item): item is string => !!item)
			.join("\u0000") || "unknown"
	);
}

function normalizeNameKey(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function selectorContext(value: unknown): string | undefined {
	const selector = stringValue(value);
	if (!selector) return undefined;
	const match = selector.match(/(?:#([A-Za-z0-9_-]{2,})|\.([A-Za-z0-9_-]{2,}))/);
	const context = match ? sanitizeSemanticText((match[1] ?? match[2])?.replace(/[-_]+/g, " "), 80) : undefined;
	return context && context.length >= 2 ? context : undefined;
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

function templateKey(
	template: Pick<StructureTemplate, "container" | "containerName" | "containerKey" | "role" | "setSize">,
): string {
	return collectionKey({
		containerRole: template.container,
		containerName: template.containerName,
		containerKey: template.containerKey,
		itemRole: template.role,
		declaredTotal: template.setSize,
	});
}

function snapshotTemplateKey(
	template: Pick<SnapshotProjectionTemplate, "container" | "containerName" | "containerKey" | "role" | "setSize">,
): string {
	return collectionKey({
		containerRole: template.container,
		containerName: template.containerName,
		containerKey: template.containerKey,
		itemRole: template.role,
		declaredTotal: template.setSize,
	});
}

function entityCollectionKey(entity: Entity): string | undefined {
	const role = normalizeRole(entity.role);
	const setSize = numberValue(entity.structure?.setSize);
	const containerRole = normalizeRole(entity.hints?.containerRole);
	const containerName = sanitizeSemanticText(entity.hints?.containerName, 160);
	const containerKey = stringValue(entity.hints?.containerKey);
	const listContainer = entity.hints?.listContainer === true;
	if (containerRole || setSize !== undefined) {
		return collectionKey({ containerRole, containerName, containerKey, itemRole: role, declaredTotal: setSize });
	}
	if (listContainer)
		return collectionKey({
			containerRole: role,
			containerName: entity.name,
			jsonPath: stringValue(entity.hints?.jsonPath),
		});
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
	if (booleanish(hints.skeleton) || booleanish(hints.placeholder) || booleanish(hints.loadingPlaceholder))
		return true;
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
	const observedPositions = Math.max(existing.observedPositions ?? 0, draft.observedPositions ?? 0) || undefined;
	const refs =
		existing.observedPositions && draft.observedPositions
			? uniq([...existing.itemRefs, ...draft.itemRefs])
			: draft.observedPositions
				? draft.itemRefs
				: existing.observedPositions
					? existing.itemRefs
					: uniq([...existing.itemRefs, ...draft.itemRefs]);
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
		observedCount: observedPositions ?? Math.max(existing.observedCount, draft.observedCount),
		itemRefs: refs,
		itemRefCount:
			observedPositions ??
			Math.max(existing.itemRefCount ?? existing.itemRefs.length, draft.itemRefCount ?? draft.itemRefs.length),
		observedPositions,
		declaredTotal: existing.declaredTotal ?? draft.declaredTotal,
		estimatedTotal: Math.max(existing.estimatedTotal ?? 0, draft.estimatedTotal ?? 0) || undefined,
		sourceRank: Math.min(existing.sourceRank, draft.sourceRank),
		preferredCompleteness: existing.preferredCompleteness ?? draft.preferredCompleteness,
		preferredConfidence: existing.preferredConfidence ?? draft.preferredConfidence,
		...(existing.box || draft.box
			? { box: unionBox([...(existing.box ? [existing.box] : []), ...(draft.box ? [draft.box] : [])]) }
			: {}),
		dataSources,
		evidence,
	});
}

function templateDraft(template: StructureTemplate, sourceRank: number): DraftCollection {
	const observedCount = Math.max(0, template.count);
	const refs = uniq(template.instanceRefs);
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
		dataSources: [
			{
				source: "aria",
				summary:
					template.setSize !== undefined
						? `template has ${observedCount} entity instances across ${template.setSize} declared item positions`
						: `template has ${observedCount} entity instances`,
				confidence: "medium",
			},
		],
		evidence: [
			{
				source: "templates",
				summary: `repeated ${template.role} template contains ${observedCount} entity instances`,
				ref: template.sample?.ref,
			},
		],
	};
}

function snapshotDraft(template: SnapshotProjectionTemplate): DraftCollection {
	const observedCount = Math.max(0, template.count);
	const refs = uniq(template.instanceRefs);
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
		dataSources: [
			{
				source: "snapshot",
				summary:
					template.setSize !== undefined
						? `snapshot projection has ${observedCount} entity instances across ${template.setSize} declared item positions`
						: `snapshot projection has ${observedCount} entity instances`,
				confidence: "medium",
			},
		],
		evidence: [
			{
				source: "templates",
				summary: `snapshot template ${template.templateKey} contains ${observedCount} entity instances`,
				jsonPath: `envelope.snapshotProjection.templates[templateKey=${template.templateKey}]`,
				ref: template.sample?.ref,
			},
		],
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
		const itemMembers = members.filter((entity) => entity.hints?.listContainer !== true);
		const role = normalizeRole(first.role);
		const containerRole =
			normalizeRole(first.hints?.containerRole) ?? (first.hints?.listContainer === true ? role : undefined);
		const containerName =
			sanitizeSemanticText(first.hints?.containerName, 160) ?? sanitizeSemanticText(first.name, 160);
		const declaredTotal = numberValue(first.structure?.setSize);
		const positioned = new Map<number, Entity>();
		for (const entity of itemMembers) {
			const position = numberValue(entity.structure?.posInSet);
			if (position !== undefined && position > 0 && !positioned.has(position)) positioned.set(position, entity);
		}
		const positions = new Set(positioned.keys());
		const skeletonCount = skeletonsByKey.get(key) || 0;
		const observedCount = positions.size || itemMembers.length || numberValue(first.hints?.itemCount) || 0;
		const refs = uniq(
			(positions.size ? [...positioned.values()] : itemMembers)
				.filter(isAddressableEntity)
				.map((entity) => entity.ref),
		);
		const dataSources: NonNullable<CollectionModel["dataSources"]> = [];
		if (declaredTotal !== undefined || positions.size) {
			dataSources.push({
				source: "aria",
				summary:
					declaredTotal !== undefined
						? `ARIA set positions ${positions.size}/${declaredTotal}`
						: `ARIA positions ${positions.size}`,
				confidence: declaredTotal !== undefined ? "high" : "medium",
			});
		}
		if (first.hints?.listContainer === true || skeletonCount > 0) {
			dataSources.push({
				source: "dom",
				ref: first.ref,
				summary:
					skeletonCount > 0
						? `list container has ${skeletonCount} loading placeholders`
						: "list container hint",
				confidence: skeletonCount > 0 ? "medium" : "low",
			});
		}
		const evidence: CollectionModel["evidence"] = [
			{
				source: "itemEntities",
				summary:
					declaredTotal !== undefined
						? `item entities observed ${observedCount} of declared ${declaredTotal}`
						: `item entities observed ${observedCount}`,
				ref: first.ref,
			},
		];
		if (skeletonCount > 0) {
			evidence.push({
				source: "listHints",
				summary: `${skeletonCount} rendered loading placeholders indicate lazy hydration`,
				ref: first.ref,
			});
		}
		const box = unionBox(members.flatMap((entity) => (entity.geometry?.box ? [entity.geometry.box] : [])));
		addDraft(drafts, key, {
			kind: collectionKind(containerRole, role, first.kind),
			containerRef: first.hints?.listContainer === true ? first.ref : undefined,
			containerRole,
			containerName,
			itemRole: role,
			observedCount,
			itemRefs: refs,
			itemRefCount: observedCount,
			...(positions.size ? { observedPositions: positions.size } : {}),
			declaredTotal,
			sourceRank: 1,
			...(box ? { box } : {}),
			...(skeletonCount > 0 ? { preferredCompleteness: "lazy", preferredConfidence: "medium" } : {}),
			dataSources,
			evidence,
		});
	}
	return drafts;
}

function listHintNameParts(hint: ListHintInput, index: number): ListHintNameParts {
	const label = firstSafeSemanticText([hint.containerLabel], 80);
	const preview = safeContainerLabelText(hint.firstItemPreview, 80);
	const fallback = `list-${index}`;
	const context = selectorContext(hint.selector);
	if (label) return { name: label, ...(context ? { context } : {}), source: "safe-label" };
	if (preview) return { name: preview, ...(context ? { context } : {}), source: "safe-preview" };
	return { name: fallback, ...(context ? { context } : {}), source: "fallback" };
}

function listHintKey(hint: ListHintInput, index: number): string {
	return collectionKey({
		containerRole: "list",
		containerName: listHintNameParts(hint, index).name,
		jsonPath: `data.structure.listHints[${index}]`,
	});
}

function listHintDraft(hint: ListHintInput, index: number): DraftCollection {
	const observedCount = numberValue(hint.itemCount) ?? 0;
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
		sourceRank: 3,
		preferredCompleteness: "viewport-window",
		preferredConfidence: "low",
		dataSources: [
			{
				source: "dom",
				summary: `scan list hint observed ${observedCount}`,
				confidence: "low",
			},
		],
		evidence: [
			{
				source: "listHints",
				summary: firstItem ? `list hint sample: ${firstItem}` : "scan list hint",
				jsonPath: `data.structure.listHints[${index}]`,
			},
		],
	};
}

function actionableText(actionable: ActionableInput): string {
	return [actionable.action, actionable.label, actionable.text, actionable.name, actionable.ariaLabel]
		.map((item) => stringValue(item))
		.filter((item): item is string => !!item)
		.join(" ")
		.toLowerCase();
}

// Pagination vocabulary. English uses word boundaries; CJK has no word boundaries so those
// alternatives match as substrings. Keep every entry a short, unambiguous navigation phrase.
const PREVIOUS_PATTERN =
	/\bprevious\b|\bprev\b|\bback\b|\bnewer\b|上一页|上页|前一页|前へ|前のページ|zurück|précédent|anterior/i;
const NEXT_PATTERN = /\bnext\b|\bolder\b|下一页|下页|后一页|次へ|次のページ|weiter|nächste|suivant|siguiente/i;
const LOAD_MORE_PATTERN =
	/\bload\s*more\b|加载更多|载入更多|读取更多|さらに読み込む|mehr laden|charger plus|cargar más/i;
const SHOW_MORE_PATTERN =
	/\bshow\s*more\b|\bview\s*more\b|\bsee\s*more\b|查看更多|显示更多|展开更多|更多|もっと見る|mehr anzeigen|voir plus|ver más/i;
const PAGE_WORD_PATTERN = /\bpage\b|\bpages\b|第\s*\d+\s*页|页码|翻页|末页|首页|ページ/i;

type PaginationEdge = {
	completeness: "paginated" | "lazy";
	confidence: CollectionConfidence;
	summary: string;
	jsonPath?: string;
	control: PaginationControl;
	rect?: { x: number; y: number; w: number; h: number };
};

function classifyPaginationControlKind(text: string): PaginationControlKind {
	if (PREVIOUS_PATTERN.test(text)) return "previous";
	if (NEXT_PATTERN.test(text)) return "next";
	if (LOAD_MORE_PATTERN.test(text)) return "load-more";
	if (SHOW_MORE_PATTERN.test(text)) return "show-more";
	return "other";
}

function actionableRect(actionable: ActionableInput): PaginationEdge["rect"] {
	const rect: Record<string, unknown> | undefined = isRecord(actionable.rect) ? actionable.rect : undefined;
	const x = numberValue(rect?.x);
	const y = numberValue(rect?.y);
	const w = numberValue(rect?.width ?? rect?.w);
	const h = numberValue(rect?.height ?? rect?.h);
	return x !== undefined && y !== undefined && w !== undefined && h !== undefined ? { x, y, w, h } : undefined;
}

function paginationEdgeFor(actionable: ActionableInput, index: number): PaginationEdge | undefined {
	if (actionable.disabled === true || actionable.hidden === true) return undefined;
	const ref = stringValue(actionable.ref);
	const label = stringValue(actionable.label) ?? stringValue(actionable.text) ?? stringValue(actionable.ariaLabel);
	const control = (kind: PaginationControlKind): PaginationControl => ({
		...(ref ? { ref } : {}),
		...(label ? { label } : {}),
		kind,
	});
	const rect = actionableRect(actionable);
	const rel = new Set((stringValue(actionable.rel) ?? "").toLowerCase().split(/\s+/).filter(Boolean));
	const relKind = rel.has("next") ? "next" : rel.has("prev") || rel.has("previous") ? "previous" : undefined;
	if (relKind)
		return {
			completeness: "paginated",
			confidence: "high",
			summary: `HTML rel=${relKind === "next" ? "next" : "prev"} control`,
			jsonPath: `data.structure.actionables[${index}]`,
			control: control(relKind),
			...(rect ? { rect } : {}),
		};
	const text = actionableText(actionable);
	const kind = classifyPaginationControlKind(text);
	if (kind === "other") return undefined;
	const isPagination = kind === "next" || kind === "previous" || PAGE_WORD_PATTERN.test(text);
	return {
		completeness: isPagination ? "paginated" : "lazy",
		confidence: "low",
		summary: isPagination ? "pagination label heuristic" : "load-more label heuristic",
		jsonPath: `data.structure.actionables[${index}]`,
		control: control(kind),
		...(rect ? { rect } : {}),
	};
}

function paginationEdges(actionables: ActionableInput[] | undefined): PaginationEdge[] {
	const edges: PaginationEdge[] = [];
	for (const [index, actionable] of (actionables ?? []).entries()) {
		const edge = paginationEdgeFor(actionable, index);
		if (edge) edges.push(edge);
	}
	return edges;
}

function draftBox(draft: DraftCollection, entitiesByRef: Map<string, Entity>): Box | undefined {
	const boxes: Box[] = draft.box ? [draft.box] : [];
	for (const ref of [...(draft.containerRef ? [draft.containerRef] : []), ...draft.itemRefs]) {
		const box = entitiesByRef.get(ref)?.geometry?.box;
		if (box) boxes.push(box);
	}
	return unionBox(boxes);
}

/**
 * Pagination controls sit inside their collection (load-more inside a feed, "Next" in a table
 * footer) or directly below it, horizontally overlapping. Score each control against each
 * collection by that vertical gap and give every collection at most its closest control.
 */
function assignPaginationEdges(
	drafts: DraftCollection[],
	edges: PaginationEdge[],
	entitiesByRef: Map<string, Entity>,
): Map<DraftCollection, PaginationEdge> {
	const assigned = new Map<DraftCollection, PaginationEdge>();
	if (!edges.length) return assigned;
	if (drafts.length === 1 && edges.some((edge) => !edge.rect)) {
		// Without geometry the page-level heuristic only makes sense when there is a single collection.
		const best = edges.find((edge) => edge.confidence === "high") ?? edges[0]!;
		assigned.set(drafts[0]!, best);
		return assigned;
	}
	const boxes = drafts.map((draft) => draftBox(draft, entitiesByRef));
	const candidates: Array<{ draftIndex: number; edge: PaginationEdge; gap: number }> = [];
	for (const edge of edges) {
		if (!edge.rect) continue;
		const centerX = edge.rect.x + edge.rect.w / 2;
		for (const [draftIndex, box] of boxes.entries()) {
			if (!box) continue;
			const horizontallyAligned = centerX >= box.x - 48 && centerX <= box.x + box.w + 48;
			if (!horizontallyAligned) continue;
			const inside = edge.rect.y >= box.y && edge.rect.y <= box.y + box.h;
			const below = edge.rect.y >= box.y + box.h;
			const maxGap = Math.max(160, Math.min(480, box.h * 0.5));
			const gap = inside ? 0 : edge.rect.y - (box.y + box.h);
			if (!inside && (!below || gap > maxGap)) continue;
			candidates.push({ draftIndex, edge, gap });
		}
	}
	candidates.sort(
		(a, b) => (a.edge.confidence === "high" ? 0 : 1) - (b.edge.confidence === "high" ? 0 : 1) || a.gap - b.gap,
	);
	const usedEdges = new Set<PaginationEdge>();
	for (const candidate of candidates) {
		const draft = drafts[candidate.draftIndex]!;
		if (assigned.has(draft) || usedEdges.has(candidate.edge)) continue;
		assigned.set(draft, candidate.edge);
		usedEdges.add(candidate.edge);
	}
	return assigned;
}

function completenessForDraft(
	draft: DraftCollection,
	edge?: PaginationEdge,
): { completeness: CollectionCompleteness; confidence: CollectionConfidence; reason: string } {
	if (draft.declaredTotal !== undefined && draft.declaredTotal > 0) {
		if (draft.observedCount < draft.declaredTotal) {
			return {
				completeness: "virtualized",
				confidence: "high",
				reason: `observed ${draft.observedCount} of declared total ${draft.declaredTotal}`,
			};
		}
	}
	if (draft.declaredTotal !== undefined && draft.declaredTotal > 0) {
		if (draft.observedCount >= draft.declaredTotal) {
			return {
				completeness: "complete",
				confidence: "high",
				reason: `observed ${draft.observedCount} covers declared total ${draft.declaredTotal}`,
			};
		}
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

function modelFromDraft(
	index: number,
	draft: DraftCollection,
	edge?: PaginationEdge,
	ambiguousNames?: Set<string>,
): CollectionModel {
	const collectionId = `c${index + 1}`;
	const classified = completenessForDraft(draft, edge);
	const evidence = [...draft.evidence];
	if (edge) evidence.push({ source: "relations", summary: edge.summary, jsonPath: edge.jsonPath });
	const estimatedTotal =
		draft.estimatedTotal ?? (draft.declaredTotal !== undefined ? draft.declaredTotal : undefined);
	const hasAmbiguousName = !!draft.containerName && ambiguousNames?.has(normalizeNameKey(draft.containerName));
	const safeContext = hasAmbiguousName ? draft.containerNameContext : undefined;
	const containerName = hasAmbiguousName
		? disambiguatedCollectionName(draft.containerName, safeContext)
		: draft.containerName;
	const containerNameSource =
		hasAmbiguousName && containerName !== draft.containerName ? "disambiguated" : draft.containerNameSource;

	const paginationControl = edge?.control;

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
		completeness: classified.completeness,
		confidence: classified.confidence,
		...(draft.dataSources.length ? { dataSources: draft.dataSources } : {}),
		evidence,
	};

	if (paginationControl !== undefined) model.paginationControl = paginationControl;

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
	const sortedDrafts = [...drafts.values()]
		.filter((draft) => draft.observedCount > 0 || draft.itemRefs.length > 0)
		.sort(
			(a, b) =>
				a.sourceRank - b.sourceRank ||
				b.observedCount - a.observedCount ||
				(b.declaredTotal ?? 0) - (a.declaredTotal ?? 0),
		);
	const entitiesByRef = new Map(input.entities.map((entity) => [entity.ref, entity]));
	const edges = assignPaginationEdges(sortedDrafts, paginationEdges(input.scanEvidence?.actionables), entitiesByRef);
	const outputAmbiguousNames = ambiguousContainerNames(sortedDrafts);
	const inputAmbiguousNames = ambiguousContainerNames([...drafts.values()]);
	return uniqueCollectionNames(
		sortedDrafts.map((draft, index) =>
			modelFromDraft(
				index,
				draft,
				edges.get(draft),
				outputAmbiguousNames.has(normalizeNameKey(draft.containerName))
					? outputAmbiguousNames
					: inputAmbiguousNames,
			),
		),
	);
}
