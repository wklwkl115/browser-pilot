// ABML mechanism arm — M2c living snapshot projection (pure core).
//
// M1 emits current structure templates and M2a emits template-level deltas. This module combines
// those two ARIA-grounded views into a compact persisted projection: current templates + attached
// delta buckets where available. It intentionally does not mint refs, resolve actions, or infer DOM
// structure from tag/class/selector patterns.
import type { Entity, EntityKind } from "./entity.js";
import { buildTemplateSummary, MAX_TEMPLATES, MIN_TEMPLATE_INSTANCES, templateGroupDescriptorForEntity, type StructureTemplate, type TemplateGroupDescriptor, type TemplateVaryField } from "./templating.js";
import type { TreeDiff, TreeDiffChangedBucket, TreeDiffInstanceBucket, TreeTemplateDiff } from "./treeDiff.js";

export type SnapshotProjectionDelta = {
	beforeCount: number;
	afterCount: number;
	appeared: TreeDiffInstanceBucket;
	disappeared: TreeDiffInstanceBucket;
	changed: TreeDiffChangedBucket;
	reordered?: TreeTemplateDiff["reordered"];
};

export type SnapshotProjectionTemplate = {
	templateKey: string;
	container?: string;
	containerName?: string;
	role: string;
	kind: EntityKind;
	count: number;
	setSize?: number;
	varies: TemplateVaryField[];
	constant: Record<string, unknown>;
	instanceRefs: string[];
	instanceRefCount: number;
	sample?: StructureTemplate["sample"];
	delta?: SnapshotProjectionDelta;
	deltaOnly?: boolean;
};

export type SnapshotProjectionSummary = {
	templateCount: number;
	instanceCount: number;
	projectedInstanceRefCount: number;
	changedTemplateCount?: number;
	appeared?: number;
	disappeared?: number;
	changed?: number;
	reordered?: number;
	partialBaseline?: boolean;
	unavailable?: string;
};

export type SnapshotProjection = {
	summary: SnapshotProjectionSummary;
	templates: SnapshotProjectionTemplate[];
};

export type SnapshotProjectionOptions = {
	treeDiff?: TreeDiff;
};

type TemplateGroup = { descriptor: TemplateGroupDescriptor; members: Entity[] };

function groupEntities(entities: Entity[]): TemplateGroup[] {
	const groups = new Map<string, TemplateGroup>();
	for (const entity of entities) {
		const descriptor = templateGroupDescriptorForEntity(entity);
		if (!descriptor) continue;
		const group = groups.get(descriptor.key);
		if (group) group.members.push(entity);
		else groups.set(descriptor.key, { descriptor, members: [entity] });
	}
	return Array.from(groups.values()).filter((group) => group.members.length >= MIN_TEMPLATE_INSTANCES);
}

function cloneInstanceBucket(bucket: TreeDiffInstanceBucket): TreeDiffInstanceBucket {
	return {
		count: bucket.count,
		instances: bucket.instances.map((item) => ({ ...item })),
		...(bucket.truncated ? { truncated: true } : {}),
	};
}

function cloneChangedBucket(bucket: TreeDiffChangedBucket): TreeDiffChangedBucket {
	return {
		count: bucket.count,
		instances: bucket.instances.map((item) => ({ ...item, fields: item.fields.map((field) => ({ ...field })) })),
		...(bucket.truncated ? { truncated: true } : {}),
	};
}

function projectionDelta(diff: TreeTemplateDiff): SnapshotProjectionDelta | undefined {
	if (!diff.appeared.count && !diff.disappeared.count && !diff.changed.count && !diff.reordered) return undefined;
	return {
		beforeCount: diff.beforeCount,
		afterCount: diff.afterCount,
		appeared: cloneInstanceBucket(diff.appeared),
		disappeared: cloneInstanceBucket(diff.disappeared),
		changed: cloneChangedBucket(diff.changed),
		...(diff.reordered ? { reordered: { ...diff.reordered, beforeSample: [...diff.reordered.beforeSample], afterSample: [...diff.reordered.afterSample] } } : {}),
	};
}

function templateFromGroup(group: TemplateGroup, delta?: SnapshotProjectionDelta): SnapshotProjectionTemplate | undefined {
	const template = buildTemplateSummary(group.members).templates[0];
	if (!template) return undefined;
	return {
		templateKey: group.descriptor.key,
		...(template.container ? { container: template.container } : {}),
		...(template.containerName ? { containerName: template.containerName } : {}),
		role: template.role,
		kind: template.kind,
		count: template.count,
		...(typeof template.setSize === "number" ? { setSize: template.setSize } : {}),
		varies: template.varies,
		constant: template.constant,
		instanceRefs: template.instanceRefs,
		instanceRefCount: template.instanceRefs.length,
		...(template.sample ? { sample: template.sample } : {}),
		...(delta ? { delta } : {}),
	};
}

function deltaOnlyTemplate(diff: TreeTemplateDiff, delta: SnapshotProjectionDelta): SnapshotProjectionTemplate {
	return {
		templateKey: diff.templateKey,
		...(diff.container ? { container: diff.container } : {}),
		...(diff.containerName ? { containerName: diff.containerName } : {}),
		role: diff.role,
		kind: diff.kind,
		count: diff.afterCount,
		varies: [],
		constant: { role: diff.role, kind: diff.kind },
		instanceRefs: [],
		instanceRefCount: 0,
		delta,
		deltaOnly: true,
	};
}

export function buildSnapshotProjection(entities: Entity[], options: SnapshotProjectionOptions = {}): SnapshotProjection {
	const deltaByKey = new Map<string, SnapshotProjectionDelta>();
	for (const diff of options.treeDiff?.templates ?? []) {
		const delta = projectionDelta(diff);
		if (delta) deltaByKey.set(diff.templateKey, delta);
	}
	const templates: SnapshotProjectionTemplate[] = [];
	for (const group of groupEntities(entities)) {
		const template = templateFromGroup(group, deltaByKey.get(group.descriptor.key));
		if (!template) continue;
		templates.push(template);
		deltaByKey.delete(group.descriptor.key);
	}
	for (const diff of options.treeDiff?.templates ?? []) {
		const delta = deltaByKey.get(diff.templateKey);
		if (!delta) continue;
		templates.push(deltaOnlyTemplate(diff, delta));
	}
	const capped = templates
		.sort((a, b) => Math.max(b.count, b.delta?.beforeCount ?? 0) - Math.max(a.count, a.delta?.beforeCount ?? 0))
		.slice(0, MAX_TEMPLATES);
	const summary: SnapshotProjectionSummary = {
		templateCount: capped.length,
		instanceCount: capped.reduce((sum, item) => sum + item.count, 0),
		projectedInstanceRefCount: capped.reduce((sum, item) => sum + item.instanceRefCount, 0),
		...(typeof options.treeDiff?.summary.changedTemplateCount === "number" ? { changedTemplateCount: options.treeDiff.summary.changedTemplateCount } : {}),
		...(typeof options.treeDiff?.summary.appeared === "number" ? { appeared: options.treeDiff.summary.appeared } : {}),
		...(typeof options.treeDiff?.summary.disappeared === "number" ? { disappeared: options.treeDiff.summary.disappeared } : {}),
		...(typeof options.treeDiff?.summary.changed === "number" ? { changed: options.treeDiff.summary.changed } : {}),
		...(typeof options.treeDiff?.summary.reordered === "number" ? { reordered: options.treeDiff.summary.reordered } : {}),
		...(options.treeDiff?.summary.partialBaseline ? { partialBaseline: true } : {}),
		...(options.treeDiff?.summary.unavailable ? { unavailable: options.treeDiff.summary.unavailable } : {}),
	};
	return { summary, templates: capped };
}
