import { stableJson } from "../utils/json.js";
import { isRecord } from "../utils/records.js";
import { COMPACTION_TUNING } from "./compactionTuning.js";
import { jsonBudgetLength } from "./fit.js";
import { buildProjectionFrontier, type DistillFrontier } from "./frontier.js";

export type JsonProjectionOptions = {
	jsonPath?: string;
	offset?: number;
	limit?: number;
	maxChars?: number;
	scoreItem?: (item: Record<string, unknown>, sourceIndex: number) => number;
};

export type FoldedJsonProjection = {
	projection: "folded-v1";
	type: "array";
	count: number;
	offset: number;
	limit: number;
	nextOffset: number | null;
	template: {
		constants?: Record<string, unknown>;
		exceptions?: Record<string, { default: unknown; items: Array<[number, unknown]> }>;
		ranges?: Record<string, { min: number; max: number }>;
	};
	fields: string[];
	items: Array<{ i: number; v: unknown[] }>;
	frontier: DistillFrontier;
};

type FieldStats = {
	key: string;
	values: unknown[];
	present: number;
	unique: Map<string, unknown>;
	numericValues: number[];
};

type InferredShape = {
	keys: string[];
	constants: Record<string, unknown>;
	exceptions: Record<string, { default: unknown; items: Array<[number, unknown]> }>;
	ranges: Record<string, { min: number; max: number }>;
	variant: FieldStats[];
};

const PREFERRED_FIELD_ORDER = new Map([
	["index", 0],
	["id", 1],
	["requestId", 2],
	["name", 3],
	["label", 4],
	["action", 5],
	["role", 6],
	["tag", 7],
	["status", 8],
	["method", 9],
	["href", 10],
	["url", 11],
	["selector", 12],
	["point", 13],
	["rect", 14],
]);

function normalizedOffset(value: unknown): number {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function normalizedLimit(value: unknown, fallback: number): number {
	const n = Number(value ?? fallback);
	return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : fallback;
}

function stableKey(value: unknown): string {
	const text = stableJson(value, 0);
	return text === undefined ? "undefined" : text;
}

function valuesEqual(a: unknown, b: unknown): boolean {
	return stableKey(a) === stableKey(b);
}

function orderedKeys(items: Record<string, unknown>[]): string[] {
	const seen = new Set<string>();
	const keys: string[] = [];
	for (const item of items) {
		for (const key of Object.keys(item)) {
			if (seen.has(key)) continue;
			seen.add(key);
			keys.push(key);
		}
	}
	return keys;
}

function exceptionEncoding(sourceIndices: number[], values: unknown[]): { default: unknown; items: Array<[number, unknown]> } | undefined {
	const counts = new Map<string, { value: unknown; count: number }>();
	for (const value of values) {
		const key = stableKey(value);
		const prev = counts.get(key);
		if (prev) prev.count += 1;
		else counts.set(key, { value, count: 1 });
	}
	let best: { value: unknown; count: number } | undefined;
	for (const candidate of counts.values()) {
		if (!best || candidate.count > best.count || candidate.count === best.count && stableKey(candidate.value) < stableKey(best.value)) best = candidate;
	}
	if (!best || best.count === values.length) return undefined;
	const items: Array<[number, unknown]> = [];
	for (const [index, value] of values.entries()) {
		if (!valuesEqual(value, best.value)) items.push([sourceIndices[index] ?? index, value]);
	}
	const fullCost = jsonBudgetLength(values, 0);
	const exception = { default: best.value, items };
	return jsonBudgetLength(exception, 0) < fullCost ? exception : undefined;
}

function inferShape(selectedItems: Array<{ item: Record<string, unknown>; sourceIndex: number }>): InferredShape {
	const items = selectedItems.map((entry) => entry.item);
	const sourceIndices = selectedItems.map((entry) => entry.sourceIndex);
	const keys = orderedKeys(items);
	const constants: Record<string, unknown> = {};
	const exceptions: Record<string, { default: unknown; items: Array<[number, unknown]> }> = {};
	const ranges: Record<string, { min: number; max: number }> = {};
	const variant: FieldStats[] = [];
	for (const key of keys) {
		const values = items.map((item) => item[key]);
		const present = items.filter((item) => Object.hasOwn(item, key)).length;
		const unique = new Map<string, unknown>();
		const numericValues: number[] = [];
		for (const value of values) {
			unique.set(stableKey(value), value);
			if (typeof value === "number" && Number.isFinite(value)) numericValues.push(value);
		}
		if (present === items.length && unique.size === 1) {
			constants[key] = values[0];
			continue;
		}
		const exception = exceptionEncoding(sourceIndices, values);
		if (exception) {
			exceptions[key] = exception;
			continue;
		}
		if (numericValues.length === items.length && numericValues.length > 0) {
			ranges[key] = { min: Math.min(...numericValues), max: Math.max(...numericValues) };
		}
		variant.push({ key, values, present, unique, numericValues });
	}
	return { keys, constants, exceptions, ranges, variant };
}

function fieldRank(field: FieldStats, itemCount: number): number {
	const preferred = PREFERRED_FIELD_ORDER.get(field.key);
	const preferredScore = preferred === undefined ? 0 : 200 - preferred;
	const cardinalityScore = field.unique.size * 8;
	const presenceScore = field.present === itemCount ? 20 : 12;
	const numericScore = field.numericValues.length === itemCount ? 16 : 0;
	const averageCost = jsonBudgetLength(field.values, 0) / Math.max(1, itemCount);
	return preferredScore + cardinalityScore + presenceScore + numericScore - averageCost / 8;
}

function sortedVariantFields(fields: FieldStats[], itemCount: number): FieldStats[] {
	return [...fields].sort((a, b) => {
		const byRank = fieldRank(b, itemCount) - fieldRank(a, itemCount);
		if (byRank !== 0) return byRank;
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});
}

function selectItems(items: Record<string, unknown>[], offset: number, limit: number, scoreItem?: JsonProjectionOptions["scoreItem"]): Array<{ item: Record<string, unknown>; sourceIndex: number }> {
	const candidates = items.slice(offset).map((item, index) => {
		const sourceIndex = offset + index;
		return { item, sourceIndex, score: scoreItem?.(item, sourceIndex) ?? 0 };
	});
	const selected = scoreItem
		? [...candidates].sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex).slice(0, limit)
		: candidates.slice(0, limit);
	return selected
		.sort((a, b) => a.sourceIndex - b.sourceIndex)
		.map(({ item, sourceIndex }) => ({ item, sourceIndex }));
}

function compactTemplate(shape: InferredShape): FoldedJsonProjection["template"] {
	return {
		...(Object.keys(shape.constants).length ? { constants: shape.constants } : {}),
		...(Object.keys(shape.exceptions).length ? { exceptions: shape.exceptions } : {}),
		...(Object.keys(shape.ranges).length ? { ranges: shape.ranges } : {}),
	};
}

function renderProjection(input: {
	count: number;
	offset: number;
	limit: number;
	nextOffset: number | null;
	shape: InferredShape;
	items: Array<{ item: Record<string, unknown>; sourceIndex: number }>;
	fields: string[];
	droppedFields: string[];
	jsonPath?: string;
}): FoldedJsonProjection {
	return {
		projection: "folded-v1",
		type: "array",
		count: input.count,
		offset: input.offset,
		limit: input.limit,
		nextOffset: input.nextOffset,
		template: compactTemplate(input.shape),
		fields: input.fields,
		items: input.items.map(({ item, sourceIndex }) => ({ i: sourceIndex, v: input.fields.map((field) => item[field]) })),
		frontier: buildProjectionFrontier({
			jsonPath: input.jsonPath,
			offset: input.offset,
			limit: input.limit,
			nextOffset: input.nextOffset,
			droppedFields: input.droppedFields,
			droppedItems: Math.max(0, input.count - input.items.length),
			foldedKinds: ["template"],
		}),
	};
}

function withExceptions(shape: InferredShape, exceptions: InferredShape["exceptions"]): InferredShape {
	return { ...shape, exceptions };
}

export function projectJsonValue(value: unknown, options: JsonProjectionOptions = {}): FoldedJsonProjection | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const offset = normalizedOffset(options.offset);
	const limit = normalizedLimit(options.limit, Math.max(1, value.length - offset));
	if (!value.every(isRecord)) return undefined;
	const allItems = value as Record<string, unknown>[];
	if (offset >= allItems.length) return undefined;
	const count = value.length;
	const nextOffset = offset + limit < count ? offset + limit : null;
	const rankedItems = selectItems(allItems, offset, limit, options.scoreItem);
	if (!rankedItems.length) return undefined;
	const shape = inferShape(rankedItems);
	if (!Object.keys(shape.constants).length && !Object.keys(shape.exceptions).length && !Object.keys(shape.ranges).length && !shape.variant.length) return undefined;
	let workingShape = withExceptions(shape, {});
	const droppedExceptionFields: string[] = [];
	const budget = Math.max(1_000, Math.floor(options.maxChars ?? COMPACTION_TUNING.jsonProjectionDefaultBudget));
	const templateBudget = Math.max(1_000, Math.floor(budget * COMPACTION_TUNING.jsonProjectionTemplateBudgetRatio));
	const renderBudget = Math.max(1_000, Math.floor(budget * COMPACTION_TUNING.jsonProjectionRenderBudgetRatio));
	for (const [key, exception] of Object.entries(shape.exceptions).sort((a, b) => jsonBudgetLength(a[1], 0) - jsonBudgetLength(b[1], 0) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
		const nextExceptions = { ...workingShape.exceptions, [key]: exception };
		const candidateShape = withExceptions(shape, nextExceptions);
		const candidate = renderProjection({ count, offset, limit, nextOffset, shape: candidateShape, items: rankedItems, fields: [], droppedFields: [], jsonPath: options.jsonPath });
		if (jsonBudgetLength(candidate) <= templateBudget) workingShape = candidateShape;
		else droppedExceptionFields.push(key);
	}
	const rankedFields = sortedVariantFields(shape.variant, rankedItems.length);
	const selectedFields: string[] = [];
	const droppedFields: string[] = [...droppedExceptionFields];
	for (const field of rankedFields) {
		const candidateFields = [...selectedFields, field.key];
		const candidate = renderProjection({ count, offset, limit, nextOffset, shape: workingShape, items: rankedItems, fields: candidateFields, droppedFields: [], jsonPath: options.jsonPath });
		if (jsonBudgetLength(candidate) <= renderBudget) selectedFields.push(field.key);
		else droppedFields.push(field.key);
	}
	for (const field of rankedFields) {
		if (!selectedFields.includes(field.key) && !droppedFields.includes(field.key)) droppedFields.push(field.key);
	}
	while (selectedFields.length) {
		const candidate = renderProjection({ count, offset, limit, nextOffset, shape: workingShape, items: rankedItems, fields: selectedFields, droppedFields, jsonPath: options.jsonPath });
		if (jsonBudgetLength(candidate) <= renderBudget) break;
		const removed = selectedFields.pop();
		if (removed && !droppedFields.includes(removed)) droppedFields.push(removed);
	}
	return renderProjection({ count, offset, limit, nextOffset, shape: workingShape, items: rankedItems, fields: selectedFields, droppedFields, jsonPath: options.jsonPath });
}
