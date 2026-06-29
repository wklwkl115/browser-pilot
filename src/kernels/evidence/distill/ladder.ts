import { stableJson } from "../../../utils/json.js";
import { isRecord } from "../../../utils/records.js";
import { compactEntityRenderingValue, compactSummaryValue } from "./granularity.js";

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
	identity?: Record<string, unknown>;
	diff?: Record<string, unknown>;
	causal?: Record<string, unknown>;
	treeDiff?: Record<string, unknown>;
	snapshotProjection?: Record<string, unknown>;
	collections?: Array<Record<string, unknown>>;
	nextActions?: string[];
	saved?: Record<string, unknown>;
	[key: string]: unknown;
};

export const SUMMARY_MAX_CHARS = 12_000;

const PREVIEW_FALLBACK_CHARS = 800;
const OVERFLOW_GUARD_LIMITS = { stringChars: 800, arrayItems: 20, tableRows: 20 } as const;
const SUMMARY_LOW_PRIORITY_KEYS = new Set(["textPreview", "interactive", "headings", "samples", "failed", "nodes", "matches", "selections", "frames", "iframe_notes"]);
const ENVELOPE_LIFTED_KEYS = ["snapshotProjection", "collections", "identity", "entities", "outline", "relations", "treeDiff", "diff", "causal", "gist"] as const;
// Envelope field survival under budget pressure, expressed as explicit value tiers so survival is by
// declared rank in ONE place — never scattered by-name patches across the fit phases. Reprioritizing
// a field = move it between these lists. The fit phases below are ordered to spend bytes well: a
// verbose summary is worth less than the ESSENTIAL structural fields on a large page, so the summary
// is hard-shrunk before any ESSENTIAL field is dropped.
//   DROP_FIRST — low value-per-byte; removed before the summary is shrunk.
//   ESSENTIAL  — high value (structure/change/orientation); kept through summary shrink, dropped only on extreme overflow.
//   CORE       — densest orientation; the last fields to survive any truncation.
const ENVELOPE_DROP_FIRST = ["entities", "outline", "relations", "causal"] as const;
const ENVELOPE_ESSENTIAL = ["diff", "identity", "treeDiff", "snapshotProjection", "collections", "gist"] as const;
const ENVELOPE_CORE = ["identity", "gist"] as const;

function pickPresentEnvelopeFields<T extends BudgetedEnvelope>(out: T, keys: readonly string[]): Record<string, unknown> {
	const picked: Record<string, unknown> = {};
	for (const key of keys) if (out[key as keyof T] !== undefined) picked[key] = out[key as keyof T];
	return picked;
}

function pickDefined(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		const value = record[key];
		if (value !== undefined && value !== null && value !== "") out[key] = value;
	}
	return out;
}

type MeasuredSummary = { summary: DistilledSummary; length: number };

function stableJsonLength(value: unknown): number {
	return stableJson(value).length;
}

function measureSummary(summary: DistilledSummary): MeasuredSummary {
	try {
		return { summary, length: stableJsonLength(summary) };
	} catch (error) {
		if (!(error instanceof RangeError)) throw error;
		const compacted = compactSummaryValue(summary, OVERFLOW_GUARD_LIMITS) as DistilledSummary;
		return { summary: compacted, length: stableJsonLength(compacted) };
	}
}

function dropLowPrioritySummaryFields(summary: DistilledSummary, budget: number, initialLength = stableJsonLength(summary)): MeasuredSummary {
	const out: DistilledSummary = { ...summary };
	const dropped: string[] = [];
	let length = initialLength;
	for (const key of SUMMARY_LOW_PRIORITY_KEYS) {
		if (length <= budget) break;
		if (Object.hasOwn(out, key)) {
			delete out[key];
			dropped.push(key);
			length = stableJsonLength(out);
		}
	}
	if (dropped.length) {
		out.summaryOmitted = dropped;
		length = stableJsonLength(out);
	}
	return { summary: out, length };
}

function scalarIdentityFields(summary: DistilledSummary): DistilledSummary {
	const out: DistilledSummary = {};
	for (const [key, value] of Object.entries(summary)) {
		if (typeof value === "number" || typeof value === "boolean") out[key] = value;
		else if (typeof value === "string" && value.length <= 200) out[key] = value;
	}
	return out;
}

function canonicalPageObservationMarker(summary: DistilledSummary): DistilledSummary | undefined {
	const pageObservation = summary.pageObservation;
	if (isRecord(pageObservation) && pageObservation.model === "PageObservation" && pageObservation.canonical === true) return { model: "PageObservation", canonical: true };
	return undefined;
}

function withCanonicalPageObservationMarker(candidate: DistilledSummary, source: DistilledSummary, budget: number): DistilledSummary {
	const marker = canonicalPageObservationMarker(source);
	if (!marker) return candidate;
	if (isRecord(candidate.pageObservation) && candidate.pageObservation.model === "PageObservation" && candidate.pageObservation.canonical === true) return candidate;
	const withMarker = { ...candidate, pageObservation: marker };
	if (stableJsonLength(withMarker) <= budget) return withMarker;
	const withoutPreview = { ...candidate };
	delete withoutPreview.preview;
	const compact = { ...withoutPreview, pageObservation: marker };
	return stableJsonLength(compact) <= budget ? compact : candidate;
}

export function fitSummaryBudget(summary: DistilledSummary, budget: number): DistilledSummary {
	const original = measureSummary(summary);
	const workingSummary = original.summary;
	const finalize = (candidate: DistilledSummary): DistilledSummary => withCanonicalPageObservationMarker(candidate, workingSummary, budget);
	if (original.length <= budget) return workingSummary;
	for (const limits of [
		{ stringChars: 800, arrayItems: 20, tableRows: 20 },
		{ stringChars: 480, arrayItems: 12, tableRows: 12 },
		{ stringChars: 240, arrayItems: 8, tableRows: 8 },
		{ stringChars: 120, arrayItems: 5, tableRows: 5 },
	]) {
		const compacted = measureSummary(compactSummaryValue(workingSummary, limits) as DistilledSummary);
		if (compacted.length <= budget) return finalize(compacted.summary);
	}
	const compact120 = compactSummaryValue(workingSummary, { stringChars: 120, arrayItems: 5, tableRows: 5 }) as DistilledSummary;
	const dropped = dropLowPrioritySummaryFields(compact120, budget);
	if (dropped.length <= budget) return finalize(dropped.summary);
	const keptScalars = scalarIdentityFields(workingSummary);
	const droppedKeys = Object.keys(workingSummary).filter((key) => !(key in keptScalars));
	const scalarBase: DistilledSummary = { ...keptScalars, summaryTruncatedToBudget: true, ...(droppedKeys.length ? { summaryOmitted: droppedKeys } : {}) };
	const scalarBaseLength = stableJsonLength(scalarBase);
	const minimalBase: DistilledSummary = scalarBaseLength <= budget
		? scalarBase
		: {
			summaryTruncatedToBudget: true,
			summaryOmitted: Array.from(new Set([...(Array.isArray(dropped.summary.summaryOmitted) ? dropped.summary.summaryOmitted : []), ...Object.keys(workingSummary)])),
			keys: Object.keys(workingSummary).slice(0, 40),
		};
	const previewSource = stableJson(compactSummaryValue(workingSummary, { stringChars: 60, arrayItems: 3, tableRows: 3 }));
	let previewChars = Math.max(0, Math.min(previewSource.length, budget, PREVIEW_FALLBACK_CHARS));
	while (previewChars >= 0) {
		const candidate = previewChars > 0 ? { ...minimalBase, preview: previewSource.slice(0, previewChars) } : minimalBase;
		if (stableJson(candidate).length <= budget) return finalize(candidate);
		previewChars = previewChars <= 32 ? -1 : Math.floor(previewChars * 0.75);
	}
	return finalize({ summaryTruncatedToBudget: true });
}

function compactEntityForEnvelope(entity: Record<string, unknown>): Record<string, unknown> {
	const out = compactEntityRenderingValue(entity);
	return Object.keys(out).length ? out : compactSummaryValue(entity, { stringChars: 80, arrayItems: 2, tableRows: 2 }) as Record<string, unknown>;
}

function compactLiftedEnvelopeValue(key: string, value: unknown): unknown {
	if (key === "entities" && Array.isArray(value)) return value.slice(0, 4).filter(isRecord).map((entity) => compactEntityForEnvelope(entity));
	if (key === "relations" && isRecord(value)) return pickDefined(value, ["summary"]);
	if (key === "identity" && isRecord(value)) return pickDefined(value, ["entityCount", "backendNodeIdCount", "backendNodeIdCoverage", "anchorCount", "triggeredCount", "sourceCounts"]);
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
	if (key === "collections" && Array.isArray(value)) {
		return value.slice(0, 4).filter(isRecord).map((collection) => ({
			...pickDefined(collection, ["collectionId", "kind", "containerRef", "containerRole", "containerName", "containerNameContext", "containerNameSource", "itemRole", "observedCount", "itemRefCount", "declaredTotal", "estimatedTotal", "hiddenCount", "completeness", "confidence"]),
			...(Array.isArray(collection.itemRefs) ? { itemRefs: collection.itemRefs.slice(0, 6) } : {}),
			...(isRecord(collection.continuation) ? { continuation: pickDefined(collection.continuation, ["kind", "handle", "confidence", "evidenceRefs"]) } : {}),
			...(Array.isArray(collection.evidence) ? { evidence: collection.evidence.slice(0, 3).filter(isRecord).map((item) => pickDefined(item, ["source", "summary", "jsonPath", "ref"])) } : {}),
		}));
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
	for (const key of ENVELOPE_DROP_FIRST) {
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
	// Hard-shrink the summary while retaining the ESSENTIAL structural/orientation fields — a verbose
	// summary is worth less than collections/treeDiff/identity/gist on a large page.
	const essential = markEnvelopeBudgetOmissions({
		tool: out.tool,
		command: out.command,
		browserSessionId: out.browserSessionId,
		detailLevel: out.detailLevel,
		summary: fitSummaryBudget(out.summary, 300),
		diagnostics: out.diagnostics,
		limits: out.limits,
		privacy: out.privacy,
		...pickPresentEnvelopeFields(out, ENVELOPE_ESSENTIAL),
		nextActions: out.nextActions?.slice(0, 2),
		saved: out.saved,
	} as T, [...omitted, "nonessential_metadata"]);
	if (stableJson(essential).length <= budget) return essential;
	// Extreme overflow: only the densest CORE orientation survives.
	const droppedEssential = ENVELOPE_ESSENTIAL.filter((k) => !ENVELOPE_CORE.includes(k as typeof ENVELOPE_CORE[number]) && out[k as keyof T] !== undefined);
	return markEnvelopeBudgetOmissions({
		tool: out.tool,
		command: out.command,
		browserSessionId: out.browserSessionId,
		detailLevel: out.detailLevel,
		summary: fitSummaryBudget(out.summary, 300),
		diagnostics: out.diagnostics,
		limits: out.limits,
		privacy: out.privacy,
		...pickPresentEnvelopeFields(out, ENVELOPE_CORE),
		nextActions: out.nextActions?.slice(0, 2),
		saved: out.saved,
	} as T, [...omitted, "nonessential_metadata", ...droppedEssential]);
}
