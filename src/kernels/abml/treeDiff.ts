// ABML mechanism arm — M2a living tree-diff (pure core).
//
// M1 folds repeated sibling entities into structure templates. M2a projects an entity diff onto the
// same ARIA-grounded template groups so re-observing a large list/table reports O(change) structure
// changes instead of O(all) repeated entities. This phase intentionally does NOT change bp-ref
// minting: stable semantic anchors are used only for diff matching here.
import type { Entity, EntityKind } from "./entity.js";
import {
	displayEntityText,
	groupEntities as rawGroupEntities,
	normalizeEntityText,
	suppressNestedNonControlGroups,
	type IndexedEntity,
	type TemplateGroup,
} from "./grouping.js";
import { MAX_TEMPLATES, templateFieldValue, type TemplateVaryField } from "./templating.js";

export const MAX_TREE_DIFF_INSTANCES = 20;
export const MAX_TREE_DIFF_CHANGED_FIELDS = 8;
// A real-agent eval showed agents adopt treeDiff but stop at the summary counts and don't drill into
// templates[].*.instances[].name to answer "WHICH item changed" → they fall back to JS. Surface a flat
// sample of the changed-item names at the summary level (and in the scan hint) so the answer is one read away.
export const MAX_TREE_DIFF_SUMMARY_NAMES = 6;

export type TreeDiffAnchor = "name" | "posInSet" | "index";
export type TreeDiffConfidence = "high" | "low";

export type TreeDiffInstance = {
	key: string;
	ref: string;
	anchor: TreeDiffAnchor;
	confidence: TreeDiffConfidence;
	name?: string;
	value?: string;
	posInSet?: number;
};

export type TreeDiffFieldChange = {
	field: TemplateVaryField;
	before?: unknown;
	after?: unknown;
};

export type TreeDiffInstanceChange = {
	key: string;
	beforeRef: string;
	afterRef: string;
	anchor: TreeDiffAnchor;
	confidence: TreeDiffConfidence;
	fields: TreeDiffFieldChange[];
	fieldCount: number;
	fieldsTruncated?: boolean;
	name?: string;
};

export type TreeDiffInstanceBucket = {
	count: number;
	instances: TreeDiffInstance[];
	truncated?: boolean;
};

export type TreeDiffChangedBucket = {
	count: number;
	instances: TreeDiffInstanceChange[];
	truncated?: boolean;
};

export type TreeTemplateDiff = {
	templateKey: string;
	container?: string;
	containerName?: string;
	role: string;
	kind: EntityKind;
	beforeCount: number;
	afterCount: number;
	appeared: TreeDiffInstanceBucket;
	disappeared: TreeDiffInstanceBucket;
	changed: TreeDiffChangedBucket;
	reordered?: { changed: true; commonCount: number; beforeSample: string[]; afterSample: string[] };
};

export type TreeDiffSummary = {
	templateCount: number;
	changedTemplateCount: number;
	appeared: number;
	disappeared: number;
	changed: number;
	reordered: number;
	// Flat, capped names of the actually-changed items (pulled up from templates[].*.instances[].name)
	// so an agent can answer "which item appeared/left/changed" from the summary without drilling.
	sample?: { appeared?: string[]; disappeared?: string[]; changed?: string[] };
	partialBaseline?: boolean;
	unavailable?: string;
};

export type TreeDiff = {
	summary: TreeDiffSummary;
	templates: TreeTemplateDiff[];
};

export type TreeDiffOptions = {
	partialBaseline?: boolean;
};

type MatchedInstance = TreeDiffInstance & { entity: Entity; order: number };

const COMPARE_FIELDS: TemplateVaryField[] = ["name", "value", "checked", "selected", "pressed", "current", "disabled"];

function groupEntities(entities: Entity[]): TemplateGroup[] {
	return suppressNestedNonControlGroups(rawGroupEntities(entities));
}

function buildNameCounts(beforeGroups: TemplateGroup[], afterGroups: TemplateGroup[]): Map<string, { before: number; after: number }> {
	const counts = new Map<string, { before: number; after: number }>();
	const bump = (side: "before" | "after", group: TemplateGroup) => {
		for (const item of group.members) {
			const name = normalizeEntityText(item.entity.name);
			if (!name) continue;
			const key = `${group.descriptor.key}\u0000${name}`;
			const count = counts.get(key) || { before: 0, after: 0 };
			count[side] += 1;
			counts.set(key, count);
		}
	};
	for (const group of beforeGroups) bump("before", group);
	for (const group of afterGroups) bump("after", group);
	return counts;
}

function instanceKey(groupKey: string, item: IndexedEntity, counts: Map<string, { before: number; after: number }>): { key: string; anchor: TreeDiffAnchor; confidence: TreeDiffConfidence } {
	const name = normalizeEntityText(item.entity.name);
	if (name) {
		const count = counts.get(`${groupKey}\u0000${name}`);
		if ((count?.before ?? 0) <= 1 && (count?.after ?? 0) <= 1) return { key: `name:${name}`, anchor: "name", confidence: "high" };
	}
	const posInSet = item.entity.structure?.posInSet;
	if (typeof posInSet === "number" && Number.isFinite(posInSet)) return { key: `pos:${posInSet}`, anchor: "posInSet", confidence: "low" };
	return { key: `idx:${item.index + 1}`, anchor: "index", confidence: "low" };
}

function instanceSummary(match: MatchedInstance): TreeDiffInstance {
	return {
		key: match.key,
		ref: match.ref,
		anchor: match.anchor,
		confidence: match.confidence,
		...(displayEntityText(match.entity.name) ? { name: displayEntityText(match.entity.name) } : {}),
		...(displayEntityText(match.entity.value) ? { value: displayEntityText(match.entity.value) } : {}),
		...(typeof match.entity.structure?.posInSet === "number" ? { posInSet: match.entity.structure.posInSet } : {}),
	};
}

function matchedInstances(group: TemplateGroup, counts: Map<string, { before: number; after: number }>): MatchedInstance[] {
	return group.members.map((item, order) => {
		const key = instanceKey(group.descriptor.key, item, counts);
		return { ...key, ref: item.entity.ref, entity: item.entity, order };
	});
}

function bucket<T>(items: T[], shape: (item: T) => TreeDiffInstance): TreeDiffInstanceBucket {
	return { count: items.length, instances: items.slice(0, MAX_TREE_DIFF_INSTANCES).map(shape), ...(items.length > MAX_TREE_DIFF_INSTANCES ? { truncated: true } : {}) };
}

function changedBucket(items: TreeDiffInstanceChange[]): TreeDiffChangedBucket {
	return { count: items.length, instances: items.slice(0, MAX_TREE_DIFF_INSTANCES), ...(items.length > MAX_TREE_DIFF_INSTANCES ? { truncated: true } : {}) };
}

function fieldChanges(before: Entity, after: Entity): { fields: TreeDiffFieldChange[]; fieldCount: number } {
	const out: TreeDiffFieldChange[] = [];
	for (const field of COMPARE_FIELDS) {
		const beforeValue = templateFieldValue(before, field);
		const afterValue = templateFieldValue(after, field);
		if (beforeValue === afterValue) continue;
		out.push({ field, ...(beforeValue !== undefined ? { before: beforeValue } : {}), ...(afterValue !== undefined ? { after: afterValue } : {}) });
	}
	return { fields: out.slice(0, MAX_TREE_DIFF_CHANGED_FIELDS), fieldCount: out.length };
}

function reordered(before: MatchedInstance[], after: MatchedInstance[]): TreeTemplateDiff["reordered"] | undefined {
	const beforeKeys = before.map((item) => item.key);
	const afterKeySet = new Set(after.map((item) => item.key));
	const beforeCommon = beforeKeys.filter((key) => afterKeySet.has(key));
	const beforeKeySet = new Set(beforeKeys);
	const afterCommon = after.map((item) => item.key).filter((key) => beforeKeySet.has(key));
	if (beforeCommon.length < 2) return undefined;
	if (beforeCommon.join("\u0000") === afterCommon.join("\u0000")) return undefined;
	return { changed: true, commonCount: beforeCommon.length, beforeSample: beforeCommon.slice(0, 12), afterSample: afterCommon.slice(0, 12) };
}

function buildTemplateDiff(beforeGroup: TemplateGroup | undefined, afterGroup: TemplateGroup | undefined, counts: Map<string, { before: number; after: number }>): TreeTemplateDiff | undefined {
	const descriptor = afterGroup?.descriptor || beforeGroup?.descriptor;
	if (!descriptor) return undefined;
	const before = beforeGroup ? matchedInstances(beforeGroup, counts) : [];
	const after = afterGroup ? matchedInstances(afterGroup, counts) : [];
	const beforeByKey = new Map(before.map((item) => [item.key, item]));
	const afterByKey = new Map(after.map((item) => [item.key, item]));
	const appeared = after.filter((item) => !beforeByKey.has(item.key));
	const disappeared = before.filter((item) => !afterByKey.has(item.key));
	const changed: TreeDiffInstanceChange[] = [];
	for (const item of after) {
		const prior = beforeByKey.get(item.key);
		if (!prior) continue;
		const { fields, fieldCount } = fieldChanges(prior.entity, item.entity);
		if (!fields.length) continue;
		changed.push({
			key: item.key,
			beforeRef: prior.ref,
			afterRef: item.ref,
			anchor: item.anchor,
			confidence: item.confidence,
			fields,
			fieldCount,
			...(fieldCount > fields.length ? { fieldsTruncated: true } : {}),
			...(displayEntityText(item.entity.name) ? { name: displayEntityText(item.entity.name) } : {}),
		});
	}
	const order = reordered(before, after);
	if (!appeared.length && !disappeared.length && !changed.length && !order) return undefined;
	return {
		templateKey: descriptor.key,
		...(descriptor.container ? { container: descriptor.container } : {}),
		...(descriptor.containerName ? { containerName: descriptor.containerName } : {}),
		role: descriptor.role,
		kind: descriptor.kind,
		beforeCount: before.length,
		afterCount: after.length,
		appeared: bucket(appeared, instanceSummary),
		disappeared: bucket(disappeared, instanceSummary),
		changed: changedBucket(changed),
		...(order ? { reordered: order } : {}),
	};
}

function templateDiffSignalScore(diff: TreeTemplateDiff): number {
	return diff.changed.count * 40 + diff.appeared.count * 12 + diff.disappeared.count * 12 + (diff.reordered ? 4 : 0);
}

export function buildTreeDiff(beforeEntities: Entity[], afterEntities: Entity[], options: TreeDiffOptions = {}): TreeDiff {
	if (options.partialBaseline) return { summary: { templateCount: 0, changedTemplateCount: 0, appeared: 0, disappeared: 0, changed: 0, reordered: 0, partialBaseline: true, unavailable: "treeDiff requires a full baseline; partial baselines suppress structure-level change projection" }, templates: [] };
	const beforeGroups = groupEntities(beforeEntities);
	const afterGroups = groupEntities(afterEntities);
	const counts = buildNameCounts(beforeGroups, afterGroups);
	const allKeys = new Set([...beforeGroups.map((group) => group.descriptor.key), ...afterGroups.map((group) => group.descriptor.key)]);
	const beforeByKey = new Map(beforeGroups.map((group) => [group.descriptor.key, group]));
	const afterByKey = new Map(afterGroups.map((group) => [group.descriptor.key, group]));
	const templates = Array.from(allKeys)
		.map((key) => buildTemplateDiff(beforeByKey.get(key), afterByKey.get(key), counts))
		.filter((item): item is TreeTemplateDiff => !!item)
		.sort((a, b) => templateDiffSignalScore(b) - templateDiffSignalScore(a) || Math.max(b.beforeCount, b.afterCount) - Math.max(a.beforeCount, a.afterCount))
		.slice(0, MAX_TEMPLATES);
	const summary = templates.reduce<TreeDiffSummary>((acc, item) => ({
		templateCount: acc.templateCount,
		changedTemplateCount: acc.changedTemplateCount + 1,
		appeared: acc.appeared + item.appeared.count,
		disappeared: acc.disappeared + item.disappeared.count,
		changed: acc.changed + item.changed.count,
		reordered: acc.reordered + (item.reordered ? 1 : 0),
	}), { templateCount: allKeys.size, changedTemplateCount: 0, appeared: 0, disappeared: 0, changed: 0, reordered: 0 });
	const collectNames = (pick: (t: TreeTemplateDiff) => Array<{ name?: string }>): string[] => {
		const out: string[] = [];
		for (const t of templates) {
			for (const inst of pick(t)) {
				const name = inst.name;
				if (typeof name === "string" && name && !out.includes(name)) {
					out.push(name);
					if (out.length >= MAX_TREE_DIFF_SUMMARY_NAMES) return out;
				}
			}
		}
		return out;
	};
	const appearedNames = collectNames((t) => t.appeared.instances);
	const disappearedNames = collectNames((t) => t.disappeared.instances);
	const changedNames = collectNames((t) => t.changed.instances);
	const sample = appearedNames.length || disappearedNames.length || changedNames.length
		? { ...(appearedNames.length ? { appeared: appearedNames } : {}), ...(disappearedNames.length ? { disappeared: disappearedNames } : {}), ...(changedNames.length ? { changed: changedNames } : {}) }
		: undefined;
	return { summary: sample ? { ...summary, sample } : summary, templates };
}
