import { randomUUID } from "node:crypto";
import type { CollectionSummary, CompactCollection, ObservationFrontierItem, PageObservationContent, PageObservationV3 } from "../../kernels/abml/pageObservation.js";
import type { SnapshotProjection, SnapshotProjectionTemplate } from "../../kernels/abml/snapshotProjection.js";

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

function compactTemplate(template: SnapshotProjectionTemplate): SnapshotProjectionTemplate {
	return { ...template, instanceRefs: template.instanceRefs.slice(0, 3), ...(template.sample ? { sample: { ...template.sample } } : {}) };
}

function projectTemplates(observation: PageObservationV3, path: string, resources: ObservationResourceDescriptor[], items: ObservationFrontierItem[]): SnapshotProjection | undefined {
	const projection = observation.snapshotProjection;
	if (!projection) return undefined;
	const templates = projection.templates.map((template, index) => {
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

function projectCollections(observation: PageObservationV3, path: string, resources: ObservationResourceDescriptor[], items: ObservationFrontierItem[]): CompactCollection[] | undefined {
	if (!observation.collections?.length) return undefined;
	return observation.collections.map((collection: CollectionSummary, index) => {
		const needsResource = collection.completeness !== "complete" || collection.itemRefs.length > 3 || Boolean(collection.evidence?.length) || Boolean(collection.dataSources?.length);
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
			itemRefs: collection.itemRefs.slice(0, 3),
			...(needsResource ? { frontierRef: ref } : {}),
		};
	});
}

export function projectObservationResources(observation: PageObservationV3, path: string): { observation: PageObservationV3; resources: ObservationResourceDescriptor[] } {
	const resources: ObservationResourceDescriptor[] = [];
	const items: ObservationFrontierItem[] = [];
	const sections = observation.content ? semanticContentSections(observation.content) : [];
	for (const [index, section] of sections.entries()) {
		if (index === 0) continue;
		const ref = `frontier:content:${index}`;
		const resource = descriptor(observation, path, { name: section.label, ref, kind: "content", label: section.label, contentSection: index });
		resources.push(resource);
		items.push({ ref, kind: "content", state: "folded", label: section.label, observed: section.text.length, total: section.text.length, resourceUri: resource.uri });
	}
	if (observation.content?.complete === false) items.push({ ref: "frontier:content:unavailable", kind: "content", state: "unavailable", label: "Uncaptured page content", unavailableReason: "capture reached the internal safety ceiling" });
	const snapshotProjection = projectTemplates(observation, path, resources, items);
	const collections = projectCollections(observation, path, resources, items);
	const { content: _content, snapshotProjection: _snapshotProjection, collections: _collections, ...base } = observation;
	return {
		observation: {
			...base,
			...(sections[0] ? { content: { text: sections[0].text, ...(observation.content?.headings?.length ? { headings: observation.content.headings } : {}), complete: observation.content?.complete !== false && sections.length <= 1 } } : {}),
			...(snapshotProjection ? { snapshotProjection } : {}),
			...(collections ? { collections } : {}),
			frontier: { items },
		},
		resources,
	};
}
