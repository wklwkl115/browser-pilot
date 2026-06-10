import { stableJson } from "../utils/json.js";
import { isRecord } from "../utils/records.js";
import { compactSummaryValue } from "./granularity.js";

export type DistilledSummary = Record<string, unknown>;
export type BudgetedEnvelope = {
	tool: string;
	command?: string;
	browserSessionId?: string;
	detailLevel: unknown;
	summary: DistilledSummary;
	diagnostics?: Record<string, unknown>;
	limits?: Record<string, unknown>;
	privacy?: Record<string, unknown>;
	entities?: Array<Record<string, unknown>>;
	gist?: Record<string, unknown>;
	outline?: Array<Record<string, unknown>>;
	relations?: Record<string, unknown>;
	diff?: Record<string, unknown>;
	causal?: Record<string, unknown>;
	treeDiff?: Record<string, unknown>;
	snapshotProjection?: Record<string, unknown>;
	nextActions?: string[];
	saved?: Record<string, unknown>;
	[key: string]: unknown;
};

export const SUMMARY_MAX_CHARS = 12_000;

const PREVIEW_FALLBACK_CHARS = 800;
const SUMMARY_LOW_PRIORITY_KEYS = new Set(["textPreview", "interactive", "headings", "samples", "failed", "nodes", "matches", "selections", "frames", "iframe_notes"]);
const ENVELOPE_LIFTED_KEYS = ["snapshotProjection", "entities", "outline", "relations", "treeDiff", "diff", "causal", "gist"] as const;
const ENVELOPE_REMOVABLE_KEYS = ["entities", "outline", "relations", "causal", "gist"] as const;

function pickDefined(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		const value = record[key];
		if (value !== undefined && value !== null && value !== "") out[key] = value;
	}
	return out;
}

function dropLowPrioritySummaryFields(summary: DistilledSummary, budget: number): DistilledSummary {
	const out: DistilledSummary = { ...summary };
	const dropped: string[] = [];
	for (const key of SUMMARY_LOW_PRIORITY_KEYS) {
		if (stableJson(out).length <= budget) break;
		if (Object.hasOwn(out, key)) {
			delete out[key];
			dropped.push(key);
		}
	}
	if (dropped.length) out.summaryOmitted = dropped;
	return out;
}

function scalarIdentityFields(summary: DistilledSummary): DistilledSummary {
	const out: DistilledSummary = {};
	for (const [key, value] of Object.entries(summary)) {
		if (typeof value === "number" || typeof value === "boolean") out[key] = value;
		else if (typeof value === "string" && value.length <= 200) out[key] = value;
	}
	return out;
}

export function fitSummaryBudget(summary: DistilledSummary, budget: number): DistilledSummary {
	if (stableJson(summary).length <= budget) return summary;
	for (const limits of [
		{ stringChars: 800, arrayItems: 20, tableRows: 20 },
		{ stringChars: 480, arrayItems: 12, tableRows: 12 },
		{ stringChars: 240, arrayItems: 8, tableRows: 8 },
		{ stringChars: 120, arrayItems: 5, tableRows: 5 },
	]) {
		const compacted = compactSummaryValue(summary, limits) as DistilledSummary;
		if (stableJson(compacted).length <= budget) return compacted;
	}
	const compact120 = compactSummaryValue(summary, { stringChars: 120, arrayItems: 5, tableRows: 5 }) as DistilledSummary;
	const dropped = dropLowPrioritySummaryFields(compact120, budget);
	if (stableJson(dropped).length <= budget) return dropped;
	const keptScalars = scalarIdentityFields(summary);
	const droppedKeys = Object.keys(summary).filter((key) => !(key in keptScalars));
	const scalarBase: DistilledSummary = { ...keptScalars, summaryTruncatedToBudget: true, ...(droppedKeys.length ? { summaryOmitted: droppedKeys } : {}) };
	const minimalBase: DistilledSummary = stableJson(scalarBase).length <= budget
		? scalarBase
		: {
			summaryTruncatedToBudget: true,
			summaryOmitted: Array.from(new Set([...(Array.isArray(dropped.summaryOmitted) ? dropped.summaryOmitted : []), ...Object.keys(summary)])),
			keys: Object.keys(summary).slice(0, 40),
		};
	const previewSource = stableJson(compactSummaryValue(summary, { stringChars: 60, arrayItems: 3, tableRows: 3 }));
	let previewChars = Math.max(0, Math.min(previewSource.length, budget, PREVIEW_FALLBACK_CHARS));
	while (previewChars >= 0) {
		const candidate = previewChars > 0 ? { ...minimalBase, preview: previewSource.slice(0, previewChars) } : minimalBase;
		if (stableJson(candidate).length <= budget) return candidate;
		previewChars = previewChars <= 32 ? -1 : Math.floor(previewChars * 0.75);
	}
	return { summaryTruncatedToBudget: true };
}

function compactEntityForEnvelope(entity: Record<string, unknown>): Record<string, unknown> {
	const out = pickDefined(entity, ["ref", "kind", "role", "name", "label"]);
	const hints = isRecord(entity.hints) ? pickDefined(entity.hints, ["selector", "listContainer", "itemCount"]) : {};
	if (Object.keys(hints).length) out.hints = hints;
	return Object.keys(out).length ? out : compactSummaryValue(entity, { stringChars: 80, arrayItems: 2, tableRows: 2 }) as Record<string, unknown>;
}

function compactLiftedEnvelopeValue(key: string, value: unknown): unknown {
	if (key === "entities" && Array.isArray(value)) return value.slice(0, 4).filter(isRecord).map((entity) => compactEntityForEnvelope(entity));
	if (key === "relations" && isRecord(value)) return pickDefined(value, ["summary"]);
	if (key === "treeDiff" && isRecord(value)) {
		const compactInstances = (bucket: unknown): unknown => {
			if (!isRecord(bucket)) return bucket;
			const instances = Array.isArray(bucket.instances)
				? bucket.instances.slice(0, 4).filter(isRecord).map((instance) => pickDefined(instance, ["key", "name", "role", "kind", "confidence", "fields"]))
				: undefined;
			return {
				...pickDefined(bucket, ["count"]),
				...(instances ? { instances } : {}),
			};
		};
		const templates = Array.isArray(value.templates)
			? value.templates.slice(0, 4).filter(isRecord).map((template) => ({
				...pickDefined(template, ["templateKey", "container", "containerName", "role", "kind", "beforeCount", "afterCount"]),
				...(template.appeared ? { appeared: compactInstances(template.appeared) } : {}),
				...(template.disappeared ? { disappeared: compactInstances(template.disappeared) } : {}),
				...(template.changed ? { changed: compactInstances(template.changed) } : {}),
				...(template.reordered ? { reordered: pickDefined(template.reordered as Record<string, unknown>, ["commonCount", "sample"]) } : {}),
			}))
			: undefined;
		return {
			...(isRecord(value.summary) ? { summary: compactSummaryValue(value.summary, { stringChars: 120, arrayItems: 4, tableRows: 4 }) } : {}),
			...(templates ? { templates } : {}),
		};
	}
	if (key === "diff" && isRecord(value)) {
		const summary = isRecord(value.summary) ? value.summary : {};
		const summaryItems = Array.isArray(summary.items)
			? summary.items.slice(0, 4).filter(isRecord).map((item) => pickDefined(item, ["kind", "ref", "changeKind", "score", "signal", "entityKind", "role", "name", "fields", "appeared", "disappeared", "sampleAppeared", "sampleDisappeared"]))
			: undefined;
		return {
			...pickDefined(value, ["focusedRef"]),
			...(Object.keys(summary).length ? {
				summary: {
					...pickDefined(summary, ["changed", "appeared", "disappeared", "focusedRef"]),
					...(summaryItems ? { items: summaryItems } : {}),
				},
			} : {}),
		};
	}
	if (key === "snapshotProjection" && isRecord(value)) {
		const compactInstances = (bucket: unknown): unknown => {
			if (!isRecord(bucket)) return bucket;
			const instances = Array.isArray(bucket.instances)
				? bucket.instances.slice(0, 4).filter(isRecord).map((instance) => pickDefined(instance, ["key", "name", "role", "kind", "confidence", "fields"]))
				: undefined;
			return {
				...pickDefined(bucket, ["count"]),
				...(instances ? { instances } : {}),
			};
		};
		const compactDelta = (delta: unknown): unknown => {
			if (!isRecord(delta)) return undefined;
			return {
				...pickDefined(delta, ["beforeCount", "afterCount"]),
				...(delta.appeared ? { appeared: compactInstances(delta.appeared) } : {}),
				...(delta.disappeared ? { disappeared: compactInstances(delta.disappeared) } : {}),
				...(delta.changed ? { changed: compactInstances(delta.changed) } : {}),
				...(delta.reordered && isRecord(delta.reordered) ? { reordered: pickDefined(delta.reordered, ["commonCount", "sample"]) } : {}),
			};
		};
		const templates = Array.isArray(value.templates)
			? value.templates.slice(0, 4).filter(isRecord).map((template) => ({
				...pickDefined(template, ["templateKey", "container", "containerName", "role", "kind", "count", "instanceRefCount", "varies", "constantText"]),
				...(template.delta ? { delta: compactDelta(template.delta) } : {}),
			}))
			: undefined;
		return {
			...(isRecord(value.summary) ? { summary: compactSummaryValue(value.summary, { stringChars: 120, arrayItems: 4, tableRows: 4 }) } : {}),
			...(templates ? { templates } : {}),
		};
	}
	return compactSummaryValue(value, { stringChars: 120, arrayItems: 4, tableRows: 4 });
}

function markEnvelopeBudgetOmissions<T extends BudgetedEnvelope>(envelope: T, omitted: string[]): T {
	if (!omitted.length) return envelope;
	const unique = Array.from(new Set(omitted));
	const diagnostics = isRecord(envelope.diagnostics) ? { ...envelope.diagnostics } : {};
	const warnings = Array.isArray(diagnostics.warnings) ? diagnostics.warnings.filter((item): item is string => typeof item === "string") : [];
	diagnostics.warnings = Array.from(new Set([...warnings, `envelope_omitted:${unique.join(",")}`]));
	return {
		...envelope,
		summary: {
			...envelope.summary,
			envelopeTruncatedToBudget: true,
			envelopeOmitted: unique,
		},
		diagnostics,
	};
}

export function fitEnvelopeBudget<T extends BudgetedEnvelope>(envelope: T, maxChars: number): T {
	const budget = Math.max(1_000, Math.floor(maxChars));
	if (stableJson(envelope).length <= budget) return envelope;
	let out: T = { ...envelope };
	const omitted: string[] = [];
	const tryFinish = (): T | undefined => {
		const marked = markEnvelopeBudgetOmissions(out, omitted);
		return stableJson(marked).length <= budget ? marked : undefined;
	};
	for (const key of ENVELOPE_LIFTED_KEYS) {
		const value = out[key];
		if (value === undefined) continue;
		const compacted = compactLiftedEnvelopeValue(key, value);
		const compactedLength = stableJson(compacted).length;
		const valueLength = stableJson(value).length;
		if (compactedLength < valueLength) {
			out = { ...out, [key]: compacted };
			omitted.push(`${key}:compact`);
			const finished = tryFinish();
			if (finished) return finished;
		}
	}
	for (const key of ENVELOPE_REMOVABLE_KEYS) {
		if (out[key] === undefined) continue;
		out = { ...out };
		delete out[key];
		omitted.push(key);
		const finished = tryFinish();
		if (finished) return finished;
	}
	const overhead = stableJson({ ...out, summary: {} }).length;
	const summaryBudget = Math.max(300, budget - overhead);
	out = { ...out, summary: fitSummaryBudget(out.summary, summaryBudget) };
	const finished = tryFinish();
	if (finished) return finished;
	const essentialWithDiff = markEnvelopeBudgetOmissions({
		tool: out.tool,
		command: out.command,
		browserSessionId: out.browserSessionId,
		detailLevel: out.detailLevel,
		summary: fitSummaryBudget(out.summary, 300),
		diagnostics: out.diagnostics,
		limits: out.limits,
		privacy: out.privacy,
		...(out.diff ? { diff: out.diff } : {}),
		...(out.treeDiff ? { treeDiff: out.treeDiff } : {}),
		...(out.snapshotProjection ? { snapshotProjection: out.snapshotProjection } : {}),
		nextActions: out.nextActions?.slice(0, 2),
		saved: out.saved,
	} as T, [...omitted, "nonessential_metadata"]);
	if (stableJson(essentialWithDiff).length <= budget) return essentialWithDiff;
	return markEnvelopeBudgetOmissions({
		tool: out.tool,
		command: out.command,
		browserSessionId: out.browserSessionId,
		detailLevel: out.detailLevel,
		summary: fitSummaryBudget(out.summary, 300),
		diagnostics: out.diagnostics,
		limits: out.limits,
		privacy: out.privacy,
		nextActions: out.nextActions?.slice(0, 2),
		saved: out.saved,
	} as T, [...omitted, "nonessential_metadata", ...(out.diff ? ["diff"] : []), ...(out.treeDiff ? ["treeDiff"] : []), ...(out.snapshotProjection ? ["snapshotProjection"] : [])]);
}
