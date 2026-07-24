import { randomUUID } from "node:crypto";
import type { AgentActionSpace, CollectionSummary, CompactCollection, ObservationFrontierItem, PageObservationContent, PageObservationV3, PageObservationView, PublicProviderExecutionReport } from "../../kernels/abml/pageObservation.js";
import type { SnapshotProjection, SnapshotProjectionTemplate } from "../../kernels/abml/snapshotProjection.js";
import type { TreeDiffChangedBucket, TreeDiffInstanceBucket, TreeTemplateDiff } from "../../kernels/abml/treeDiff.js";
import { computeRelevanceMap } from "../../kernels/evidence/distill/relevance.js";
import { extractScalarTerm } from "../../kernels/evidence/distill/relevanceTaps.js";
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
export const OBSERVATION_RESOURCE_SCHEMA = "browser-page-observation-resource/v1";

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

type IndexedContentSection = ObservationContentSection & { index: number; score: number };

export function semanticContentSections(content: PageObservationContent): ObservationContentSection[] {
	const text = content.text.trim();
	if (!text) return [];
	const positions: Array<{ label: string; start: number }> = [];
	let cursor = 0;
	for (const raw of content.headings ?? []) {
		const label = raw.trim();
		if (!label) continue;
		const start = text.indexOf(label, cursor);
		if (start < 0 || positions.some((item) => item.start === start)) continue;
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

function rankedContentSections(content: PageObservationContent, intent?: string): IndexedContentSection[] {
	const sections = semanticContentSections(content);
	const terms = extractScalarTerm(intent, "intent", 1.35).map((term) => ({ ...term, source: "E" as const }));
	const relevance = terms.length ? computeRelevanceMap([], terms) : undefined;
	return sections.map((section, index) => ({
		...section,
		index,
		score: relevance?.scoreFields({ name: section.label, value: section.text }) ?? 0,
	}));
}

function rootContentSection(content: PageObservationContent, sections: IndexedContentSection[], intent?: string): IndexedContentSection | undefined {
	if (!sections.length) return undefined;
	const title = content.headings?.[0]?.trim();
	const titleSection = sections.find((section) => title && section.label === title);
	const normalizedIntent = intent?.normalize("NFKC").toLowerCase() ?? "";
	const relevant = sections
		.filter((section) => section.label !== "Page introduction" && (section.text.length >= 120 || normalizedIntent.includes(section.label.normalize("NFKC").toLowerCase())))
		.sort((a, b) => b.score - a.score || a.index - b.index)[0];
	if (relevant && relevant.score > 0) return relevant;
	return titleSection
		?? sections.find((section) => section.label !== "Page introduction")
		?? sections[0];
}

function compactOutline(outline: PageObservationV3["outline"]): PageObservationV3["outline"] {
	return outline?.slice(0, ROOT_OUTLINE_LIMIT).map((item) => ({
		...item,
		...(Array.isArray(item.memberRefs) ? { memberRefs: item.memberRefs.slice(0, ROOT_SAMPLE_SIZE) } : {}),
	}));
}

function compactDiagnostics(value: PageObservationV3["diagnostics"]): PageObservationV3["diagnostics"] {
	if (!isRecord(value)) return undefined;
	const axFusion = isRecord(value.axFusion) && value.axFusion.degraded === true
		? { degraded: true, ...(isRecord(value.axFusion.skipped) ? { skipped: value.axFusion.skipped } : {}) }
		: undefined;
	const diagnostics = {
		...(value.abmlIntegrated === false ? { abmlIntegrated: false } : {}),
		...(Array.isArray(value.warnings) && value.warnings.length ? { warnings: value.warnings.filter((warning): warning is string => typeof warning === "string") } : {}),
		...(axFusion ? { axFusion } : {}),
	};
	return Object.keys(diagnostics).length ? diagnostics : undefined;
}

function compactProviders(value: PageObservationV3["providers"]): PublicProviderExecutionReport {
	return Object.fromEntries(Object.entries(value).map(([provider, item]) => [provider, {
		status: item.status,
		...(item.reason ? { reason: item.reason } : {}),
	}]));
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
		coverage: { ...actionSpace.coverage, returned: items.length, projectionComplete: items.length === actionSpace.coverage.captured },
		scopes: actionSpace.scopes.filter((scope) => scopeIds.has(scope.id)),
		items,
	};
}

function compactInstanceBucket(bucket: TreeDiffInstanceBucket): TreeDiffInstanceBucket {
	return { count: bucket.count, instances: bucket.instances.slice(0, ROOT_SAMPLE_SIZE) };
}

function compactChangedBucket(bucket: TreeDiffChangedBucket): TreeDiffChangedBucket {
	return { count: bucket.count, instances: bucket.instances.slice(0, ROOT_SAMPLE_SIZE) };
}

function compactTreeTemplate(template: TreeTemplateDiff): TreeTemplateDiff {
	return {
		...template,
		appeared: compactInstanceBucket(template.appeared),
		disappeared: compactInstanceBucket(template.disappeared),
		changed: compactChangedBucket(template.changed),
	};
}

function treeDiffDetailCount(templates: TreeTemplateDiff[]): number {
	return templates.reduce((count, template) => count + 1 + template.appeared.instances.length + template.disappeared.instances.length + template.changed.instances.length, 0);
}

function compactTemplate(template: SnapshotProjectionTemplate): SnapshotProjectionTemplate {
	const delta = template.delta ? {
		...template.delta,
		appeared: compactInstanceBucket(template.delta.appeared),
		disappeared: compactInstanceBucket(template.delta.disappeared),
		changed: compactChangedBucket(template.delta.changed),
	} : undefined;
	return { ...template, instanceRefs: template.instanceRefs.slice(0, ROOT_SAMPLE_SIZE), ...(template.sample ? { sample: { ...template.sample } } : {}), ...(delta ? { delta } : {}) };
}

function projectTemplates(observation: PageObservationV3, path: string, resources: ObservationResourceDescriptor[], items: ObservationFrontierItem[], deltaOnly = false): SnapshotProjection | undefined {
	const projection = observation.snapshotProjection;
	if (!projection) return undefined;
	const available = deltaOnly ? projection.templates.filter((template) => template.delta || template.deltaOnly) : projection.templates;
	if (!available.length) return undefined;
	const selected = available.slice(0, ROOT_STRUCTURE_LIMIT);
	if (available.length > selected.length) {
		const ref = "frontier:templates:unavailable";
		const label = "Complete structure templates";
		const resource = descriptor(observation, path, { name: label, ref, kind: "details", label, jsonPath: "snapshotProjection" });
		resources.push(resource);
		items.push({ ref, kind: "details", state: "folded", label, observed: selected.length, total: available.length, resourceUri: resource.uri });
	}
	const templates = selected.map((template) => {
		const index = projection.templates.indexOf(template);
		const compact = compactTemplate(template);
		if (template.instanceRefCount <= compact.instanceRefs.length) return compact;
		const ref = `frontier:template:${template.templateKey}`;
		const label = `Instances of ${template.templateKey}`;
		const resource = descriptor(observation, path, { name: label, ref, kind: "template-instances", label, jsonPath: `snapshotProjection.templates[${index}].instanceRefs` });
		resources.push(resource);
		items.push({ ref, kind: "template-instances", state: "folded", label, observed: compact.instanceRefs.length, total: template.instanceRefCount, resourceUri: resource.uri });
		return compact;
	});
	return { summary: projection.summary, templates };
}

function limitedFrontier(observation: PageObservationV3, path: string, resources: ObservationResourceDescriptor[], items: ObservationFrontierItem[]) {
	const priority: Record<ObservationFrontierItem["kind"], number> = { "action-space": 0, details: 1, "collection-window": 2, content: 3, "template-instances": 4 };
	const itemPriority = (item: ObservationFrontierItem): number => item.kind === "action-space" ? -2 : item.ref === "frontier:content:root" || item.state === "unavailable" ? -1 : priority[item.kind];
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

function projectTreeDiff(observation: PageObservationV3, path: string, resources: ObservationResourceDescriptor[], items: ObservationFrontierItem[]): PageObservationV3["treeDiff"] {
	const treeDiff = observation.treeDiff;
	if (!treeDiff) return undefined;
	const shown = treeDiff.templates.slice(0, ROOT_SAMPLE_SIZE).map(compactTreeTemplate);
	const folded = treeDiff.templates.length > shown.length || treeDiff.templates.some((template) => template.appeared.instances.length > ROOT_SAMPLE_SIZE || template.disappeared.instances.length > ROOT_SAMPLE_SIZE || template.changed.instances.length > ROOT_SAMPLE_SIZE);
	if (folded) addDetailsResource(observation, path, resources, items, { ref: "frontier:details:tree-diff", label: "Complete tree diff", jsonPath: "treeDiff", observed: treeDiffDetailCount(shown), total: treeDiffDetailCount(treeDiff.templates) });
	return { summary: treeDiff.summary, templates: shown };
}

function projectCausal(observation: PageObservationV3, path: string, resources: ObservationResourceDescriptor[], items: ObservationFrontierItem[]): PageObservationV3["causal"] {
	const causal = observation.causal;
	if (!causal || !("requests" in causal)) return causal;
	const requests = causal.requests.slice(0, ROOT_SAMPLE_SIZE);
	const events = causal.events?.slice(0, ROOT_SAMPLE_SIZE);
	const total = causal.requests.length + (causal.events?.length ?? 0);
	const observed = requests.length + (events?.length ?? 0);
	if (total > observed) addDetailsResource(observation, path, resources, items, { ref: "frontier:details:causal", label: "Complete causal activity", jsonPath: "causal", observed, total });
	return {
		sinceSeq: causal.sinceSeq,
		requests,
		...(causal.requests.length > requests.length ? { requestCount: causal.requests.length } : {}),
		...(events?.length ? { events } : {}),
		...(causal.events && causal.events.length > (events?.length ?? 0) ? { eventCount: causal.events.length } : {}),
	};
}

function projectRelations(observation: PageObservationV3, path: string, resources: ObservationResourceDescriptor[], items: ObservationFrontierItem[]): PageObservationV3["relations"] {
	const relations = observation.relations;
	if (!relations) return undefined;
	const highlights = relations.highlights.slice(0, ROOT_SAMPLE_SIZE);
	if (relations.highlights.length > highlights.length) addDetailsResource(observation, path, resources, items, { ref: "frontier:details:relations", label: "Complete relation highlights", jsonPath: "relations", observed: highlights.length, total: relations.highlights.length });
	return { summary: relations.summary, highlights, ...(relations.highlights.length > highlights.length ? { highlightCount: relations.highlights.length } : {}) };
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
		const needsResource = collection.completeness !== "complete" || collection.itemRefs.length > ROOT_SAMPLE_SIZE || Boolean(collection.evidence?.length) || Boolean(collection.dataSources?.length);
		const ref = collection.frontierRef ?? `frontier:collection:${collection.collectionId ?? index}`;
		if (needsResource) {
			const label = collection.name || `Collection ${index + 1}`;
			const resource = descriptor(observation, path, { name: label, ref, kind: "collection-window", label, jsonPath: `collections[${index}]` });
			resources.push(resource);
			items.push({ ref, kind: "collection-window", state: collection.completeness === "virtualized" || collection.completeness === "paginated" || collection.completeness === "lazy" || collection.completeness === "viewport-window" ? collection.completeness : "folded", label, observed: collection.observed, ...(collection.total !== undefined ? { total: collection.total } : {}), ...(collection.paginationControl && typeof collection.paginationControl.ref === "string" ? { controlRef: collection.paginationControl.ref } : {}), resourceUri: resource.uri });
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
			...(needsResource ? { frontierRef: ref } : {}),
		};
	});
}

export function projectObservationResources(observation: PageObservationV3, path: string, intent?: string): { observation: PageObservationView; resources: ObservationResourceDescriptor[] } {
	const resources: ObservationResourceDescriptor[] = [];
	const items: ObservationFrontierItem[] = [];
	const deltaOnly = observation.delta === "session" || observation.baselineSnapshotId !== undefined || observation.diff !== undefined || observation.treeDiff !== undefined;
	const sections = observation.content && !deltaOnly ? rankedContentSections(observation.content, intent) : [];
	const rootSection = observation.content ? rootContentSection(observation.content, sections, intent) : undefined;
	if (rootSection && rootSection.text.length > ROOT_CONTENT_MAX_CHARS) {
		const resource = descriptor(observation, path, { name: rootSection.label, ref: "frontier:content:root", kind: "content", label: rootSection.label, contentSection: rootSection.index });
		resources.push(resource);
		items.push({ ref: "frontier:content:root", kind: "content", state: "folded", label: rootSection.label, observed: ROOT_CONTENT_MAX_CHARS, total: rootSection.text.length, resourceUri: resource.uri });
	}
	for (const section of [...sections].sort((a, b) => b.score - a.score || a.index - b.index)) {
		if (section.index === rootSection?.index) continue;
		const ref = `frontier:content:${section.index}`;
		const resource = descriptor(observation, path, { name: section.label, ref, kind: "content", label: section.label, contentSection: section.index });
		resources.push(resource);
		items.push({ ref, kind: "content", state: "folded", label: section.label, observed: section.text.length, total: section.text.length, resourceUri: resource.uri });
	}
	if (observation.content?.complete === false) items.push({ ref: "frontier:content:unavailable", kind: "content", state: "unavailable", label: "Uncaptured page content", unavailableReason: "capture reached the internal safety ceiling" });
	const snapshotProjection = projectTemplates(observation, path, resources, items, deltaOnly);
	const collections = projectCollections(observation, path, resources, items);
	const treeDiff = projectTreeDiff(observation, path, resources, items);
	const causal = projectCausal(observation, path, resources, items);
	const relations = projectRelations(observation, path, resources, items);
	const headings = observation.content?.headings?.slice(0, ROOT_HEADINGS_LIMIT);
	const title = headings?.[0];
	const outline = compactOutline(observation.outline);
	const diagnostics = compactDiagnostics(observation.diagnostics);
	const buildView = (frontier: ReturnType<typeof limitedFrontier>, actionSpace?: AgentActionSpace): PageObservationView => {
		const publicCollections = collections?.map((collection) => {
			if (!collection.frontierRef || frontier.refs.has(collection.frontierRef)) return collection;
			const { frontierRef: _frontierRef, ...withoutFrontier } = collection;
			return withoutFrontier;
		});
		return {
			schema: observation.schema,
			tool: observation.tool,
			model: observation.model,
			canonical: false,
			target: { ...(observation.target.url ? { url: observation.target.url } : {}) },
			snapshot: { snapshotId: observation.snapshot.snapshotId, capturedAt: observation.snapshot.capturedAt, ttlMs: observation.snapshot.ttlMs },
			...(observation.gist || title ? { gist: { ...(observation.gist ?? {}), ...(title ? { title } : {}) } } : {}),
			...(rootSection ? { content: { text: rootSection.text.slice(0, ROOT_CONTENT_MAX_CHARS), ...(headings?.length ? { headings } : {}), complete: observation.content?.complete !== false && sections.length <= 1 && rootSection.text.length <= ROOT_CONTENT_MAX_CHARS } } : {}),
			...(observation.visual ? { visual: observation.visual } : {}),
			...(outline?.length ? { outline } : {}),
			...(actionSpace ? { actionSpace } : {}),
			...(snapshotProjection ? { snapshotProjection } : {}),
			...(publicCollections?.length ? { collections: publicCollections } : {}),
			...(treeDiff ? { treeDiff } : {}),
			...(causal ? { causal } : {}),
			...(relations ? { relations } : {}),
			...(observation.inference ? { inference: observation.inference } : {}),
			providers: compactProviders(observation.providers),
			...(diagnostics ? { diagnostics } : {}),
			...(observation.nextActions?.length ? { nextActions: observation.nextActions.slice(0, 8) } : {}),
			frontier: { items: frontier.items },
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
			schema: observation.schema,
			tool: observation.tool,
			model: observation.model,
			canonical: false,
			target: {},
			snapshot: { snapshotId: observation.snapshot.snapshotId, capturedAt: observation.snapshot.capturedAt, ttlMs: observation.snapshot.ttlMs },
			...(actionSpace ? { actionSpace } : {}),
			providers: Object.fromEntries(Object.entries(observation.providers).map(([provider, item]) => [provider, { status: item.status }])),
			frontier: { items },
		},
		resources,
	};
}
