import { randomUUID } from "node:crypto";
import type { AgentActionSpace, CollectionSummary, CompactCollection, ObservationFrontierItem, PageObservationContent, PageObservationV3, PageObservationView, PublicCausalSummary, PublicRelationSummary, PublicVisualObservation } from "../../kernels/abml/pageObservation.js";
import { isRecord } from "../../utils/records.js";

const ROOT_SAMPLE_SIZE = 3;
const ROOT_CONTENT_MAX_CHARS = 6_000;
const ROOT_HEADINGS_LIMIT = 16;
const ROOT_OUTLINE_LIMIT = 8;
const ROOT_FRONTIER_LIMIT = 12;
const ROOT_STRUCTURE_LIMIT = 12;
const ROOT_RESULT_TARGET_BYTES = 30 * 1024;

export const OBSERVATION_RESOURCE_URI_PREFIX = "browser-pilot://observation/";
export const OBSERVATION_RESOURCES_DETAIL_KEY = "browser-pilot/internal-observation-resources";

export type ObservationResourceDescriptor = {
	uri: string;
	name: string;
	mimeType: "application/json";
	path: string;
	expiresAt: number;
	snapshotId: string;
	ref: string;
	kind: ObservationFrontierItem["kind"];
	label?: string;
	jsonPath?: string;
	contentSection?: number;
};

export type ObservationContentSection = { label: string; text: string };

type IndexedContentSection = ObservationContentSection & { index: number };
type RootContentProjection = { text: string; complete: boolean; includedBySection: Map<number, number> };
type SnapshotTemplate = NonNullable<PageObservationV3["snapshotProjection"]>["templates"][number];

export function semanticContentSections(content: PageObservationContent): ObservationContentSection[] {
	const text = content.text.trim();
	if (!text) return [];
	const positions: Array<{ label: string; start: number }> = [];
	let cursor = 0;
	for (const raw of content.headings ?? []) {
		if (cursor >= text.length) break;
		const label = raw.trim();
		if (!label) continue;
		const start = text.indexOf(label, cursor);
		if (start < 0) continue;
		positions.push({ label, start });
		cursor = start + label.length;
	}
	if (!positions.length) return [{ label: "Page content", text }];
	const sections: ObservationContentSection[] = [];
	if (positions[0]!.start > 0) sections.push({ label: "Page introduction", text: text.slice(0, positions[0]!.start).trim() });
	for (const [index, position] of positions.entries()) {
		const end = positions[index + 1]?.start ?? text.length;
		const sectionText = text.slice(position.start, end).trim();
		if (sectionText) sections.push({ label: position.label, text: sectionText });
	}
	return sections.filter((section) => section.text);
}

function indexedContentSections(content: PageObservationContent): IndexedContentSection[] {
	return semanticContentSections(content).map((section, index) => ({ ...section, index }));
}

function compactRecord(value: Record<string, unknown> | undefined): string | undefined {
	if (!value || !Object.keys(value).length) return undefined;
	return JSON.stringify(value);
}

function templateSemanticDefaults(template: SnapshotTemplate): Record<string, unknown> {
	const { role: _role, kind: _kind, ...constant } = template.constant;
	return { ...constant, ...template.defaults };
}

function structureMapLines(observation: PageObservationV3): string[] {
	const lines: string[] = [];
	for (const item of observation.outline ?? []) {
		if (typeof item.container !== "string" || typeof item.memberCount !== "number") continue;
		const label = typeof item.name === "string" && item.name ? item.name : item.container;
		lines.push(`section ${label} (${item.memberCount})`);
	}
	const templates = observation.snapshotProjection?.templates ?? [];
	for (const collection of observation.collections ?? []) {
		const label = collection.name || collection.kind;
		const total = collection.total === undefined ? String(collection.observed) : `${collection.observed}/${collection.total}`;
		const template = templates.find((item) =>
			(!collection.itemRole || item.role === collection.itemRole)
			&& (!collection.containerRole || item.container === collection.containerRole)
			&& (!collection.name || !item.containerName || item.containerName === collection.name));
		const defaults = template ? compactRecord(templateSemanticDefaults(template)) : undefined;
		const varies = template?.varies.length ? template.varies.join(",") : undefined;
		lines.push(`collection ${label} (${total}, ${collection.completeness})${template ? ` item=${template.role}` : ""}${defaults ? ` defaults=${defaults}` : ""}${varies ? ` varies=${varies}` : ""}`);
	}
	return lines;
}

function withoutLeadingLabel(text: string, label: string): string {
	const trimmed = text.trim();
	return trimmed.startsWith(label) ? trimmed.slice(label.length).trim() : trimmed;
}

function rootContentProjection(observation: PageObservationV3, sections: IndexedContentSection[]): RootContentProjection | undefined {
	const content = observation.content;
	const structure = structureMapLines(observation);
	if (!content && !structure.length) return undefined;
	const prefix = structure.length ? `Map\n${structure.join("\n")}` : "";
	const separator = prefix && content?.text ? "\n\nContent\n" : "";
	const full = `${prefix}${separator}${content?.text ?? ""}`;
	const includedBySection = new Map<number, number>();
	if (full.length <= ROOT_CONTENT_MAX_CHARS) {
		for (const section of sections) includedBySection.set(section.index, section.text.length);
		return { text: full, complete: content?.complete !== false, includedBySection };
	}
	const budgetAfterPrefix = Math.max(0, ROOT_CONTENT_MAX_CHARS - prefix.length - separator.length);
	const labelChars = sections.reduce((sum, section) => sum + section.label.length + 4, 0);
	const previewChars = sections.length ? Math.max(0, Math.floor((budgetAfterPrefix - labelChars) / sections.length)) : 0;
	const previews = sections.map((section) => {
		const fullBody = withoutLeadingLabel(section.text, section.label);
		const body = fullBody.slice(0, previewChars);
		return { section, fullBody, body, line: `[${section.label}]${body ? ` ${body}` : ""}` };
	});
	let offset = 0;
	for (const { section, fullBody, body, line } of previews) {
		const visible = Math.max(0, Math.min(line.length, budgetAfterPrefix - offset));
		const labelVisible = Math.max(0, Math.min(section.label.length, visible - 1));
		const bodyVisible = Math.max(0, Math.min(body.length, visible - section.label.length - 3));
		const complete = visible === line.length && body.length === fullBody.length;
		includedBySection.set(section.index, complete ? section.text.length : Math.min(section.text.length, (section.text.startsWith(section.label) ? labelVisible : 0) + bodyVisible));
		offset += line.length + 1;
	}
	return { text: `${prefix}${separator}${previews.map((preview) => preview.line).join("\n")}`.slice(0, ROOT_CONTENT_MAX_CHARS), complete: false, includedBySection };
}

function compactOutline(outline: PageObservationV3["outline"]): PageObservationV3["outline"] {
	return outline?.slice(0, ROOT_OUTLINE_LIMIT).flatMap((item) => {
		if (typeof item.container !== "string" || typeof item.memberCount !== "number" || !Array.isArray(item.memberRefs)) return [];
		return [{
			container: item.container,
			...(typeof item.name === "string" ? { name: item.name } : {}),
			memberCount: item.memberCount,
			...(typeof item.controlCount === "number" ? { controlCount: item.controlCount } : {}),
			memberRefs: item.memberRefs.filter((ref): ref is string => typeof ref === "string" && ref.startsWith("bp-ref://")).slice(0, ROOT_SAMPLE_SIZE),
		}];
	});
}

export function publicWarnings(value: PageObservationV3["diagnostics"]): string[] {
	if (!isRecord(value)) return [];
	const visualUnavailable = Array.isArray(value.providerFailures) && value.providerFailures.some((failure) => isRecord(failure) && failure.provider === "visual");
	return [...new Set([
		...(value.abmlIntegrated === false ? ["Semantic structure was unavailable; using the page scan fallback."] : []),
		...(isRecord(value.axFusion) && value.axFusion.degraded === true ? ["Accessibility enrichment was incomplete."] : []),
		...(visualUnavailable ? ["Requested visual evidence was unavailable."] : []),
		...(Array.isArray(value.warnings) ? value.warnings.filter((warning): warning is string => typeof warning === "string") : []),
	])];
}

export function publicGist(gist: PageObservationV3["gist"], title?: string): PageObservationView["gist"] {
	const landmarks = Array.isArray(gist?.landmarks) ? gist.landmarks.filter((item): item is string => typeof item === "string") : [];
	return title || landmarks.length ? { ...(title ? { title } : {}), ...(landmarks.length ? { landmarks } : {}) } : undefined;
}

export function publicVisual(value: PageObservationV3["visual"]): PublicVisualObservation | undefined {
	if (!value) return undefined;
	return {
		ref: value.ref,
		resourceUri: value.resourceUri,
		actionableGrounding: value.actionableGrounding,
		coordinateSpace: value.coordinateSpace,
		image: { width: value.image.width, height: value.image.height },
		targets: value.targets,
	};
}

export function publicSnapshotProjection(value: PageObservationV3["snapshotProjection"]): Record<string, unknown> | undefined {
	if (!value) return undefined;
	return {
		summary: { templateCount: value.summary.templateCount, instanceCount: value.summary.instanceCount },
		templates: value.templates.map((template) => ({
			...(template.container ? { container: template.container } : {}),
			...(template.containerName ? { containerName: template.containerName } : {}),
			role: template.role,
			kind: template.kind,
			count: template.count,
			...(template.setSize !== undefined ? { setSize: template.setSize } : {}),
			varies: template.varies,
			defaults: templateSemanticDefaults(template),
			exceptions: template.exceptions.map((item) => ({ index: item.index, ...(item.ref ? { ref: item.ref } : {}), values: item.values })),
			instanceRefs: template.instanceRefs,
			...(template.sample ? { sample: { ...(template.sample.ref ? { ref: template.sample.ref } : {}), ...(template.sample.name ? { name: template.sample.name } : {}), ...(template.sample.value ? { value: template.sample.value } : {}) } } : {}),
		})),
	};
}

function publicTreeDiffSummary(value: NonNullable<PageObservationV3["treeDiff"]>["summary"]) {
	return {
		templateCount: value.templateCount,
		changedTemplateCount: value.changedTemplateCount,
		appeared: value.appeared,
		disappeared: value.disappeared,
		changed: value.changed,
		reordered: value.reordered,
		...(value.sample ? { sample: {
			...(value.sample.appeared ? { appeared: value.sample.appeared } : {}),
			...(value.sample.disappeared ? { disappeared: value.sample.disappeared } : {}),
			...(value.sample.changed ? { changed: value.sample.changed } : {}),
		} } : {}),
		...(value.partialBaseline !== undefined ? { partialBaseline: value.partialBaseline } : {}),
		...(value.unavailable ? { unavailable: value.unavailable } : {}),
	};
}

export function publicTreeDiff(value: PageObservationV3["treeDiff"]): Record<string, unknown> | undefined {
	if (!value) return undefined;
	const instances = (items: Array<{ ref: string; confidence: string; name?: string; value?: string; posInSet?: number }>) => items.map((item) => ({
		ref: item.ref,
		confidence: item.confidence,
		...(item.name ? { name: item.name } : {}),
		...(item.value ? { value: item.value } : {}),
		...(item.posInSet !== undefined ? { posInSet: item.posInSet } : {}),
	}));
	return {
		summary: publicTreeDiffSummary(value.summary),
		templates: value.templates.map((template) => ({
			...(template.container ? { container: template.container } : {}),
			...(template.containerName ? { containerName: template.containerName } : {}),
			role: template.role,
			kind: template.kind,
			beforeCount: template.beforeCount,
			afterCount: template.afterCount,
			appeared: { count: template.appeared.count, instances: instances(template.appeared.instances) },
			disappeared: { count: template.disappeared.count, instances: instances(template.disappeared.instances) },
			changed: { count: template.changed.count, instances: template.changed.instances.map((item) => ({ ref: item.afterRef, confidence: item.confidence, fields: item.fields, ...(item.name ? { name: item.name } : {}) })) },
			...(template.reordered ? { reordered: { changed: true, commonCount: template.reordered.commonCount } } : {}),
		})),
	};
}

export function publicCollection(value: CollectionSummary): Record<string, unknown> {
	const paginationControl = isRecord(value.paginationControl) ? {
		...(typeof value.paginationControl.ref === "string" ? { ref: value.paginationControl.ref } : {}),
		...(typeof value.paginationControl.label === "string" ? { label: value.paginationControl.label } : {}),
		...(typeof value.paginationControl.kind === "string" ? { kind: value.paginationControl.kind } : {}),
	} : undefined;
	return {
		ref: value.ref,
		kind: value.kind,
		...(value.name ? { name: value.name } : {}),
		observed: value.observed,
		...(value.total !== undefined ? { total: value.total } : {}),
		completeness: value.completeness,
		confidence: value.confidence,
		itemRefs: value.itemRefs,
		...(paginationControl && Object.keys(paginationControl).length ? { paginationControl } : {}),
	};
}

function descriptor(observation: PageObservationV3, path: string, input: Omit<ObservationResourceDescriptor, "uri" | "mimeType" | "path" | "expiresAt" | "snapshotId">): ObservationResourceDescriptor {
	return {
		...input,
		uri: `${OBSERVATION_RESOURCE_URI_PREFIX}${randomUUID()}`,
		mimeType: "application/json",
		path,
		expiresAt: observation.snapshot.capturedAt + observation.snapshot.ttlMs,
		snapshotId: observation.snapshot.snapshotId,
	};
}

function fullObservationResource(observation: PageObservationV3, path: string, ref: string, label: string): { resource: ObservationResourceDescriptor; item: ObservationFrontierItem } {
	const resource = descriptor(observation, path, { name: label, ref, kind: "details", label, jsonPath: "$" });
	return { resource, item: { ref, kind: "details", state: "folded", label, resourceUri: resource.uri } };
}

function actionSpaceWindow(actionSpace: AgentActionSpace, count: number): AgentActionSpace {
	const items = actionSpace.items.slice(0, count);
	const scopeIds = new Set(items.flatMap((item) => item.scope ? [item.scope.id] : []));
	return {
		...actionSpace,
		scopes: actionSpace.scopes.filter((scope) => scopeIds.has(scope.id)),
		items,
	};
}

function addSnapshotProjectionResource(observation: PageObservationV3, path: string, resources: ObservationResourceDescriptor[], items: ObservationFrontierItem[]): void {
	const projection = observation.snapshotProjection;
	if (!projection?.templates.length) return;
	const ref = "frontier:details:structure";
	const label = "Structure templates";
	const resource = descriptor(observation, path, { name: label, ref, kind: "details", label, jsonPath: "snapshotProjection" });
	resources.push(resource);
	items.push({ ref, kind: "details", state: "folded", label, observed: 0, total: projection.templates.length, resourceUri: resource.uri });
}

function limitedFrontier(observation: PageObservationV3, path: string, resources: ObservationResourceDescriptor[], items: ObservationFrontierItem[]) {
	const priority: Record<ObservationFrontierItem["kind"], number> = { "action-space": 0, content: 1, details: 2, "collection-window": 3 };
	const itemPriority = (item: ObservationFrontierItem): number => item.kind === "action-space" ? -2 : item.state === "unavailable" ? -1 : priority[item.kind];
	const ranked = items
		.map((item, index) => ({ item, index }))
		.sort((a, b) => itemPriority(a.item) - itemPriority(b.item) || a.index - b.index);
	const selectedCount = ranked.length > ROOT_FRONTIER_LIMIT ? ROOT_FRONTIER_LIMIT - 1 : ROOT_FRONTIER_LIMIT;
	const selected = ranked.slice(0, selectedCount).map(({ item }) => item);
	const omitted = ranked.length - selected.length;
	let fallbackResource: ObservationResourceDescriptor | undefined;
	if (omitted > 0) {
		const fallback = fullObservationResource(observation, path, "frontier:budget", "Complete semantic observation");
		fallbackResource = fallback.resource;
		selected.push({ ...fallback.item, observed: selected.length, total: ranked.length });
	}
	const visibleUris = new Set(selected.flatMap((item) => item.resourceUri ? [item.resourceUri] : []));
	return {
		items: selected,
		resources: [...resources.filter((resource) => visibleUris.has(resource.uri)), ...(fallbackResource ? [fallbackResource] : [])],
		refs: new Set(selected.map((item) => item.ref)),
	};
}

function addDetailsResource(observation: PageObservationV3, path: string, resources: ObservationResourceDescriptor[], items: ObservationFrontierItem[], input: { ref: string; label: string; jsonPath: "treeDiff" | "causal" | "relations"; observed: number; total: number }): void {
	const resource = descriptor(observation, path, { name: input.label, ref: input.ref, kind: "details", label: input.label, jsonPath: input.jsonPath });
	resources.push(resource);
	items.push({ ref: input.ref, kind: "details", state: "folded", label: input.label, observed: input.observed, total: input.total, resourceUri: resource.uri });
}

function projectTreeDiff(observation: PageObservationV3, path: string, resources: ObservationResourceDescriptor[], items: ObservationFrontierItem[]): PageObservationView["treeDiff"] {
	const treeDiff = observation.treeDiff;
	if (!treeDiff) return undefined;
	if (treeDiff.templates.length) addDetailsResource(observation, path, resources, items, { ref: "frontier:details:tree-diff", label: "Tree diff details", jsonPath: "treeDiff", observed: 0, total: treeDiff.templates.length });
	return { summary: publicTreeDiffSummary(treeDiff.summary) };
}

export function publicCausal(causal: PageObservationV3["causal"], limit = Number.POSITIVE_INFINITY): PublicCausalSummary | undefined {
	if (!causal) return undefined;
	const events = causal.events?.slice(0, limit).map((event) => ({
		ref: event.ref,
		type: event.type,
		...(event.at !== undefined ? { at: event.at } : {}),
		...(event.summary ? { summary: event.summary } : {}),
		...(event.selector ? { selector: event.selector } : {}),
	}));
	if (!("requests" in causal)) return { unavailable: "Recent request activity was unavailable.", ...(events?.length ? { events } : {}), ...(causal.events && causal.events.length > (events?.length ?? 0) ? { eventCount: causal.events.length } : {}) };
	const requests = causal.requests.slice(0, limit).map((request) => ({
		ref: request.ref,
		...(request.method ? { method: request.method } : {}),
		...(request.url ? { url: request.url } : {}),
		...(request.status !== undefined ? { status: request.status } : {}),
		...(request.type ? { type: request.type } : {}),
		...(request.at !== undefined ? { at: request.at } : {}),
		...(request.initiatorType ? { initiatorType: request.initiatorType } : {}),
		...(request.passive !== undefined ? { passive: request.passive } : {}),
	}));
	return {
		requests,
		...(causal.requests.length > requests.length ? { requestCount: causal.requests.length } : {}),
		...(events?.length ? { events } : {}),
		...(causal.events && causal.events.length > (events?.length ?? 0) ? { eventCount: causal.events.length } : {}),
	};
}

function projectCausal(observation: PageObservationV3, path: string, resources: ObservationResourceDescriptor[], items: ObservationFrontierItem[]): PublicCausalSummary | undefined {
	const causal = observation.causal;
	if (!causal) return undefined;
	const projected = publicCausal(causal, ROOT_SAMPLE_SIZE);
	const total = ("requests" in causal ? causal.requests.length : 0) + (causal.events?.length ?? 0);
	const observed = (projected && "requests" in projected ? projected.requests.length : 0) + (projected?.events?.length ?? 0);
	if (total > observed) addDetailsResource(observation, path, resources, items, { ref: "frontier:details:causal", label: "Complete causal activity", jsonPath: "causal", observed, total });
	return projected;
}

export function publicRelations(relations: PageObservationV3["relations"], limit = Number.POSITIVE_INFINITY): PublicRelationSummary | undefined {
	if (!relations) return undefined;
	const highlights = relations.highlights.slice(0, limit).map(({ type, sourceRef, targetRef }) => ({ type, sourceRef, targetRef }));
	const summary = Object.fromEntries(Object.entries(relations.summary).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] >= 0));
	return { summary, highlights, ...(relations.highlights.length > highlights.length ? { highlightCount: relations.highlights.length } : {}) };
}

function projectRelations(observation: PageObservationV3, path: string, resources: ObservationResourceDescriptor[], items: ObservationFrontierItem[]): PublicRelationSummary | undefined {
	const relations = observation.relations;
	if (!relations) return undefined;
	const projected = publicRelations(relations, ROOT_SAMPLE_SIZE)!;
	if (relations.highlights.length > projected.highlights.length) addDetailsResource(observation, path, resources, items, { ref: "frontier:details:relations", label: "Complete relation highlights", jsonPath: "relations", observed: projected.highlights.length, total: relations.highlights.length });
	return projected;
}

function projectCollections(observation: PageObservationV3, path: string, resources: ObservationResourceDescriptor[], items: ObservationFrontierItem[]): CompactCollection[] | undefined {
	if (!observation.collections?.length) return undefined;
	const selected = observation.collections.slice(0, ROOT_STRUCTURE_LIMIT);
	if (observation.collections.length > selected.length) {
		const ref = "frontier:collections:unavailable";
		const label = "Complete collections";
		const resource = descriptor(observation, path, { name: label, ref, kind: "details", label, jsonPath: "collections" });
		resources.push(resource);
		items.push({ ref, kind: "details", state: "folded", label, observed: selected.length, total: observation.collections.length, resourceUri: resource.uri });
	}
	return selected.map((collection: CollectionSummary, index) => {
		const hasOverflow = collection.itemRefs.length > ROOT_SAMPLE_SIZE;
		const incomplete = collection.completeness !== "complete";
		const needsFrontier = hasOverflow || incomplete;
		const ref = collection.frontierRef ?? `frontier:collection:${collection.collectionId ?? index}`;
		const controlRef = collection.paginationControl && typeof collection.paginationControl.ref === "string" ? collection.paginationControl.ref : undefined;
		if (needsFrontier) {
			const label = collection.name || `Collection ${index + 1}`;
			const resource = hasOverflow ? descriptor(observation, path, { name: label, ref, kind: "collection-window", label, jsonPath: `collections[${index}]` }) : undefined;
			if (resource) resources.push(resource);
			items.push({
				ref,
				kind: "collection-window",
				state: collection.completeness === "virtualized" || collection.completeness === "paginated" || collection.completeness === "lazy" || collection.completeness === "viewport-window" ? collection.completeness : "folded",
				label,
				observed: collection.observed,
				...(collection.total !== undefined ? { total: collection.total } : {}),
				...(controlRef ? { controlRef } : {}),
				...(resource ? { resourceUri: resource.uri } : controlRef ? {} : { unavailableReason: "No additional captured collection items are available." }),
			});
		}
		return {
			ref: collection.ref,
			kind: collection.kind,
			...(collection.name ? { name: collection.name } : {}),
			observed: collection.observed,
			...(collection.total !== undefined ? { total: collection.total } : {}),
			completeness: collection.completeness,
			confidence: collection.confidence,
			itemRefs: collection.itemRefs.slice(0, ROOT_SAMPLE_SIZE),
			...(needsFrontier ? { frontierRef: ref } : {}),
		};
	});
}

export function projectObservationResources(observation: PageObservationV3, path: string): { observation: PageObservationView; resources: ObservationResourceDescriptor[] } {
	const resources: ObservationResourceDescriptor[] = [];
	const items: ObservationFrontierItem[] = [];
	const deltaOnly = observation.delta === "session" || observation.baselineSnapshotId !== undefined || observation.diff !== undefined || observation.treeDiff !== undefined;
	const sections = observation.content && !deltaOnly ? indexedContentSections(observation.content) : [];
	const rootContent = deltaOnly ? undefined : rootContentProjection(observation, sections);
	for (const section of sections) {
		const observed = rootContent?.includedBySection.get(section.index) ?? 0;
		if (observed >= section.text.length) continue;
		const ref = `frontier:content:${section.index}`;
		const resource = descriptor(observation, path, { name: section.label, ref, kind: "content", label: section.label, contentSection: section.index });
		resources.push(resource);
		items.push({ ref, kind: "content", state: "folded", label: section.label, observed, total: section.text.length, resourceUri: resource.uri });
	}
	if (observation.content?.complete === false) items.push({ ref: "frontier:content:unavailable", kind: "content", state: "unavailable", label: "Uncaptured page content", unavailableReason: "capture reached the internal safety ceiling" });
	addSnapshotProjectionResource(observation, path, resources, items);
	const collections = projectCollections(observation, path, resources, items);
	const treeDiff = projectTreeDiff(observation, path, resources, items);
	const causal = projectCausal(observation, path, resources, items);
	const relations = projectRelations(observation, path, resources, items);
	const headings = observation.content?.headings?.slice(0, ROOT_HEADINGS_LIMIT);
	const title = headings?.[0];
	const outline = compactOutline(observation.outline);
	const gist = publicGist(observation.gist, title);
	const visual = publicVisual(observation.visual);
	const warnings = publicWarnings(observation.diagnostics);
	const buildView = (frontier: ReturnType<typeof limitedFrontier>, actionSpace?: AgentActionSpace): PageObservationView => {
		const publicCollections = collections?.map((collection) => {
			if (!collection.frontierRef || frontier.refs.has(collection.frontierRef)) return collection;
			const { frontierRef: _frontierRef, ...withoutFrontier } = collection;
			return withoutFrontier;
		});
		return {
			target: { ...(observation.target.url ? { url: observation.target.url } : {}) },
			...(gist ? { gist } : {}),
			...(rootContent ? { content: { text: rootContent.text, ...(headings?.length ? { headings } : {}), complete: rootContent.complete } } : {}),
			...(visual ? { visual } : {}),
			...(outline?.length ? { outline } : {}),
			...(actionSpace ? { actionSpace } : {}),
			...(publicCollections?.length ? { collections: publicCollections } : {}),
			...(treeDiff ? { treeDiff } : {}),
			...(causal ? { causal } : {}),
			...(relations ? { relations } : {}),
			...(warnings.length ? { warnings } : {}),
			...(observation.nextActions?.length ? { nextActions: observation.nextActions.slice(0, 8) } : {}),
			...(frontier.items.length ? { frontier: { items: frontier.items } } : {}),
		};
	};

	let frontier = limitedFrontier(observation, path, resources, items);
	const fullActionSpace = observation.actionSpace && actionSpaceWindow(observation.actionSpace, observation.actionSpace.items.length);
	let projected = buildView(frontier, fullActionSpace);
	if (fullActionSpace && Buffer.byteLength(JSON.stringify(projected), "utf8") > ROOT_RESULT_TARGET_BYTES) {
		const ref = "frontier:action-space";
		const label = "Complete action space";
		const resource = descriptor(observation, path, { name: label, ref, kind: "action-space", label, jsonPath: "actionSpace" });
		resources.push(resource);
		items.push({ ref, kind: "action-space", state: "folded", label, observed: 0, total: fullActionSpace.coverage.captured, resourceUri: resource.uri });
		frontier = limitedFrontier(observation, path, resources, items);
		let low = 0;
		let high = fullActionSpace.items.length;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			const candidate = buildView(frontier, actionSpaceWindow(fullActionSpace, mid));
			if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= ROOT_RESULT_TARGET_BYTES - 128) low = mid;
			else high = mid - 1;
		}
		const actionItem = frontier.items.find((item) => item.ref === ref);
		if (actionItem) actionItem.observed = low;
		projected = buildView(frontier, actionSpaceWindow(fullActionSpace, low));
	}
	return { observation: projected, resources: frontier.resources };
}

export function projectObservationOverflow(observation: PageObservationV3, path: string): { observation: PageObservationView; resources: ObservationResourceDescriptor[] } {
	const full = fullObservationResource(observation, path, "frontier:observation", "Complete semantic observation");
	const resources = [full.resource];
	const items = [full.item];
	let actionSpace: AgentActionSpace | undefined;
	if (observation.actionSpace) {
		const ref = "frontier:action-space";
		const label = "Complete action space";
		const resource = descriptor(observation, path, { name: label, ref, kind: "action-space", label, jsonPath: "actionSpace" });
		resources.unshift(resource);
		items.unshift({ ref, kind: "action-space", state: "folded", label, observed: 0, total: observation.actionSpace.coverage.captured, resourceUri: resource.uri });
		actionSpace = actionSpaceWindow(observation.actionSpace, 0);
	}
	return {
		observation: {
			target: { ...(observation.target.url ? { url: observation.target.url } : {}) },
			...(actionSpace ? { actionSpace } : {}),
			frontier: { items },
		},
		resources,
	};
}
