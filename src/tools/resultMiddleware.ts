import { stableJson } from "../utils/json.js";
import { normalizeDetailLevel, type DetailLevel } from "../utils/params.js";
import { jsonResult, textResult, type PiTextToolResult } from "../utils/toolResult.js";
import { containsSensitiveEvidence, redactSensitiveValueWithPointers } from "./artifactPrivacy.js";
import { saveTextArtifact } from "./artifacts.js";
import { distillValue } from "./distillerRegistry.js";
import { asArray, isRecord } from "./summaries/common.js";
import { summarizeHtmlSnapshot } from "./summaries/index.js";
import { appendMemoryAutoSurface } from "./memory/autoSurface.js";

export { distillValue } from "./distillerRegistry.js";
export { summarizeHtmlSnapshot } from "./summaries/index.js";

export type DistilledSummary = Record<string, unknown>;
export type DistilledEnvelope = {
	tool: string;
	command?: string;
	browserSessionId?: string;
	detailLevel: DetailLevel;
	summary: DistilledSummary;
	diagnostics?: Record<string, unknown>;
	target?: Record<string, unknown>;
	limits?: Record<string, unknown>;
	privacy?: Record<string, unknown>;
	entities?: Array<Record<string, unknown>>;
	// Disclosure layers lifted to envelope top-level so the budget squeeze on `summary`
	// never hides them (gist = L0 page overview, outline = L1 container fold).
	abmlIntegrated?: boolean;
	gist?: Record<string, unknown>;
	outline?: Array<Record<string, unknown>>;
	// R1 relationship graph (relations.summary = type→count, always present when abmlIntegrated;
	// relations.highlights = deterministic capped sample). Lifted here so the budget never hides it.
	relations?: Record<string, unknown>;
	// R2 inference layer (detected ARIA semantic patterns — intents[]: login/search/data-grid/…).
	// Lifted here so the budget never hides it.
	inference?: Record<string, unknown>;
	// R3 temporal entity diff (appeared/disappeared/changed/focusedRef). Present only when
	// the caller supplies a baseline to browser_observe/readStructure.
	diff?: Record<string, unknown>;
	// R3.x causal plane — network requests fired since the baseline observation (passive,
	// no control attribution): { sinceSeq, requests[] } or { unavailable }. Present only when
	// browser_observe(mode:scan) is given a baseline. Lifted here so the budget never hides it.
	causal?: Record<string, unknown>;
	// ABML mechanism arm M1 — structure templates (repeated list/table/card folded to template +
	// instances + handles). Lifted here so the budget never hides the large-page compression.
	templates?: Array<Record<string, unknown>>;
	// ABML mechanism arm M2a — template-level living diff. Present only when browser_observe gets a
	// full baseline. Lifted here so re-observe can stay O(change) under tight budgets.
	treeDiff?: Record<string, unknown>;
	// ABML mechanism arm M2c — persisted living structure snapshot: current templates plus attached
	// template deltas where available. Lifted here so saved-artifact follow-up can stay structure-first.
	snapshotProjection?: Record<string, unknown>;
	error?: Record<string, unknown>;
	nextActions?: string[];
	correlation?: Record<string, unknown>;
	operation?: Record<string, unknown>;
	snapshot?: Record<string, unknown>;
	saved?: Record<string, unknown>;
	// Layer-1 section handles. Populated only by the MCP adapter (which owns the
	// resource store); Pi core leaves this unset.
	sections?: Array<{ name: string; kind: string; count?: number; handle?: string }>;
};

const SUMMARY_MAX_CHARS = 12_000;
const SUMMARY_BUDGET_CHARS = 8_000;
// Last-resort orientation snippet cap when the summary overflows even after compaction and falls to the
// scalar-identity fallback. The real page model lives in the lifted top-level fields (entities/gist/
// outline/diff/treeDiff/causal) + the saved artifact, so this preview only needs to ORIENT, not carry
// data — capping it small kills the multi-KB re-dump blob that drowned the answer (blind-eval F2).
const PREVIEW_FALLBACK_CHARS = 800;
const SUMMARY_LOW_PRIORITY_KEYS = new Set(["textPreview", "interactive", "headings", "samples", "failed", "nodes", "matches", "selections", "frames", "iframe_notes"]);
const ENVELOPE_LIFTED_KEYS = ["snapshotProjection", "entities", "outline", "relations", "treeDiff", "diff", "causal", "gist"] as const;
const ENVELOPE_REMOVABLE_KEYS = ["entities", "outline", "relations", "causal", "gist"] as const;

type DistillBaseOptions = {
	toolName: string;
	command?: string;
	browserSessionId?: string;
	detailLevel?: unknown;
	maxChars: number;
	ctx?: { cwd?: string };
	outputPath?: string;
	fallbackName: string;
	details?: Record<string, unknown>;
	operation?: Record<string, unknown>;
	snapshot?: Record<string, unknown>;
	artifactThreshold?: number;
	entities?: Array<Record<string, unknown>>;
	error?: Record<string, unknown>;
	/**
	 * Deprecated compatibility only. Model-facing output is always redacted; raw
	 * values are retrieved through browser_artifact jsonPath/pick pointers.
	 */
	redact?: boolean;
	rawArtifactValue?: unknown;
};

type DistilledJsonOptions = DistillBaseOptions & {
	distill?: (value: unknown) => Record<string, unknown>;
	artifactValue?: unknown;
};

type DistilledTextOptions = DistillBaseOptions & {
	summary?: Record<string, unknown>;
	distill?: (text: string) => Record<string, unknown>;
	artifactValue?: unknown;
};

async function saveRawArtifact(options: DistillBaseOptions, raw: string): Promise<Record<string, unknown> | undefined> {
	return await saveTextArtifact(options.ctx, options.outputPath, options.fallbackName, raw);
}

function compactSummaryValue(value: unknown, limits: { stringChars: number; arrayItems: number; tableRows: number }, depth = 0): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return value.length > limits.stringChars ? `${value.slice(0, limits.stringChars)}…` : value;
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value !== "object") return String(value);
	if (Array.isArray(value)) return value.slice(0, limits.arrayItems).map((item) => compactSummaryValue(item, limits, depth + 1));
	if (depth >= 5) return { type: "object", keyCount: Object.keys(value as Record<string, unknown>).length };
	const record = value as Record<string, unknown>;
	if (Array.isArray(record.columns) && Array.isArray(record.rows)) {
		const rows = record.rows.slice(0, limits.tableRows).map((row) => Array.isArray(row) ? row.map((cell) => compactSummaryValue(cell, limits, depth + 1)) : row);
		return { ...record, rows, truncated: Number(record.count || rows.length) > rows.length ? Number(record.count || rows.length) - rows.length : record.truncated };
	}
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record)) out[key] = compactSummaryValue(item, limits, depth + 1);
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

// Cheap scalar identity fields (url/title/readyState/counts/tabId/…) cost almost nothing but tell an
// agent WHAT page this is + WHERE to look. Keep them even in the extreme budget fallback instead of
// nuking the whole summary to a generic preview (observed on a 9-iframe page degrading to an unusable
// summary in a real agent session, 2026-06-05). Operates on the already-redacted summary, so safe.
function scalarIdentityFields(summary: DistilledSummary): DistilledSummary {
	const out: DistilledSummary = {};
	for (const [key, value] of Object.entries(summary)) {
		if (typeof value === "number" || typeof value === "boolean") out[key] = value;
		else if (typeof value === "string" && value.length <= 200) out[key] = value;
	}
	return out;
}

function fitSummaryBudget(summary: DistilledSummary, budget: number): DistilledSummary {
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
	// Keep the cheap scalar identity core when it fits; only if even that overflows fall back to the
	// bare omit-everything shape.
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

function firstDefined(record: Record<string, unknown>, keys: string[]): unknown {
	for (const key of keys) if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
	return undefined;
}

function pickDefined(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		const value = record[key];
		if (value !== undefined && value !== null && value !== "") out[key] = value;
	}
	return out;
}

function compactArtifactDescriptor(saved?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!saved) return undefined;
	return pickDefined(saved, ["path", "bytes", "chars", "mime"]);
}

function collectPiRefs(value: unknown, refs: string[]): void {
	if (typeof value === "string") {
		if (value.startsWith("pi-ref://")) refs.push(value);
		return;
	}
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) collectPiRefs(item, refs);
		return;
	}
	for (const item of Object.values(value as Record<string, unknown>)) collectPiRefs(item, refs);
}

function inferenceEvidenceRefs(summary: DistilledSummary, focus?: Record<string, unknown>): Set<string> {
	const refs: string[] = [];
	const collect = (inference: unknown): void => {
		if (!isRecord(inference)) return;
		for (const intent of asArray(inference.intents).filter(isRecord)) collectPiRefs(intent.evidence, refs);
	};
	collect(summary.inference);
	collect(focus?.inference);
	return new Set(refs);
}

function dedupeEntityRecords(entities: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	const seen = new Set<string>();
	const out: Array<Record<string, unknown>> = [];
	for (const entity of entities) {
		const ref = typeof entity.ref === "string" ? entity.ref : undefined;
		const key = ref || stableJson(entity);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(entity);
	}
	return out;
}

function envelopeEntities(summary: DistilledSummary, explicit?: Array<Record<string, unknown>>): Array<Record<string, unknown>> | undefined {
	if (Array.isArray(explicit) && explicit.length) return explicit;
	const focus = isRecord(summary.focus) ? summary.focus : undefined;
	const primary = asArray(focus?.primary_entities).filter(isRecord) as Array<Record<string, unknown>>;
	const list = asArray(focus?.list_entities).filter(isRecord) as Array<Record<string, unknown>>;
	const visual = asArray(focus?.visual_regions).filter(isRecord) as Array<Record<string, unknown>>;
	const referenced = asArray(focus?.referenced_entities).filter(isRecord) as Array<Record<string, unknown>>;
	const candidates = [...primary, ...list, ...visual, ...referenced];
	const evidenceRefs = inferenceEvidenceRefs(summary, focus);
	const evidenceEntities = evidenceRefs.size ? candidates.filter((entity) => typeof entity.ref === "string" && evidenceRefs.has(entity.ref)) : [];
	const ordered = dedupeEntityRecords([...evidenceEntities, ...primary, ...list, ...visual, ...referenced]);
	return ordered.length ? ordered.slice(0, 12) : undefined;
}

// L0/L1 disclosure layers pulled from the (uncompressed) summary so they survive the
// summary-budget squeeze — the agent always gets a cheap page overview + container fold.
function envelopeGist(summary: DistilledSummary): Record<string, unknown> | undefined {
	const focus = isRecord(summary.focus) ? summary.focus : undefined;
	// Clone so the top-level copy never shares a reference with summary.focus.gist — when the
	// summary isn't budget-compressed (small pages) a shared ref makes stableJson emit
	// "[Circular]" for the second occurrence.
	return isRecord(focus?.gist) ? structuredClone(focus.gist) as Record<string, unknown> : undefined;
}

function envelopeOutline(summary: DistilledSummary): Array<Record<string, unknown>> | undefined {
	const focus = isRecord(summary.focus) ? summary.focus : undefined;
	const outline = asArray(focus?.outline).filter(isRecord);
	return outline.length ? structuredClone(outline) as Array<Record<string, unknown>> : undefined;
}

// R1 relations summary lifted from the (uncompressed) focus so relations.summary survives the
// budget squeeze — cloned for the same [Circular]-avoidance reason as gist/outline.
function envelopeRelations(summary: DistilledSummary): Record<string, unknown> | undefined {
	const focus = isRecord(summary.focus) ? summary.focus : undefined;
	return isRecord(focus?.relations) ? structuredClone(focus.relations) as Record<string, unknown> : undefined;
}

function envelopeDiff(summary: DistilledSummary): Record<string, unknown> | undefined {
	if (isRecord(summary.diff)) return structuredClone(summary.diff) as Record<string, unknown>;
	const focus = isRecord(summary.focus) ? summary.focus : undefined;
	return isRecord(focus?.diff) ? structuredClone(focus.diff) as Record<string, unknown> : undefined;
}

// R3.x causal block lifted from the (uncompressed) summary so the network-delta survives the
// budget squeeze — cloned for the same [Circular]-avoidance reason as gist/diff/relations.
function envelopeCausal(summary: DistilledSummary): Record<string, unknown> | undefined {
	return isRecord(summary.causal) ? structuredClone(summary.causal) as Record<string, unknown> : undefined;
}

function envelopeTreeDiff(summary: DistilledSummary): Record<string, unknown> | undefined {
	if (isRecord(summary.treeDiff)) return structuredClone(summary.treeDiff) as Record<string, unknown>;
	const focus = isRecord(summary.focus) ? summary.focus : undefined;
	return isRecord(focus?.treeDiff) ? structuredClone(focus.treeDiff) as Record<string, unknown> : undefined;
}

function envelopeSnapshotProjection(summary: DistilledSummary): Record<string, unknown> | undefined {
	if (isRecord(summary.snapshotProjection)) return structuredClone(summary.snapshotProjection) as Record<string, unknown>;
	const focus = isRecord(summary.focus) ? summary.focus : undefined;
	return isRecord(focus?.snapshotProjection) ? structuredClone(focus.snapshotProjection) as Record<string, unknown> : undefined;
}

function envelopeError(summary: DistilledSummary, explicit?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (explicit && Object.keys(explicit).length) return explicit;
	if (summary.failed === true || typeof summary.error_code === "string") {
		return pickDefined(summary, ["failed", "error_code", "message", "recovery"]);
	}
	return undefined;
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

function markEnvelopeBudgetOmissions(envelope: DistilledEnvelope, omitted: string[]): DistilledEnvelope {
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

function fitEnvelopeBudget(envelope: DistilledEnvelope, maxChars: number): DistilledEnvelope {
	const budget = Math.max(1_000, Math.floor(maxChars));
	if (stableJson(envelope).length <= budget) return envelope;
	let out: DistilledEnvelope = { ...envelope };
	const omitted: string[] = [];
	const tryFinish = (): DistilledEnvelope | undefined => {
		const marked = markEnvelopeBudgetOmissions(out, omitted);
		return stableJson(marked).length <= budget ? marked : undefined;
	};
	// Phase 1: compact lifted keys (snapshotProjection, entities, outline, …)
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
	// Phase 2: remove removable keys (entities, outline, relations, …)
	for (const key of ENVELOPE_REMOVABLE_KEYS) {
		if (out[key] === undefined) continue;
		out = { ...out };
		delete out[key];
		omitted.push(key);
		const finished = tryFinish();
		if (finished) return finished;
	}
	// Phase 3: fit the summary AFTER freeing budget from lifted/removable fields
	const overhead = stableJson({ ...out, summary: {} }).length;
	const summaryBudget = Math.max(300, budget - overhead);
	if (stableJson(out.summary).length > summaryBudget) {
		out = { ...out, summary: fitSummaryBudget(out.summary, summaryBudget) };
		if (stableJson(out).length <= budget) return out;
	}
	// Phase 4: re-fit summary against post-removal overhead
	const overhead2 = stableJson({ ...out, summary: {}, diagnostics: out.diagnostics }).length;
	out = { ...out, summary: fitSummaryBudget(out.summary, Math.max(300, budget - overhead2)) };
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
	}, [...omitted, "nonessential_metadata"]);
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
	}, [...omitted, "nonessential_metadata", ...(out.diff ? ["diff"] : []), ...(out.treeDiff ? ["treeDiff"] : []), ...(out.snapshotProjection ? ["snapshotProjection"] : [])]);
}

function normalizedTarget(options: DistillBaseOptions, summary: DistilledSummary): Record<string, unknown> | undefined {
	const summaryTarget = isRecord(summary.target) ? summary.target : {};
	const target = {
		...pickDefined(summary, ["browserId", "tabId", "frameId", "url", "origin", "targetSource", "targetImplicit", "browserSessionId", "selectionVersionAtDispatch", "selectionVersionAtResolve"]),
		...pickDefined(summaryTarget, ["browserSessionId", "browserId", "tabId", "frameId", "url", "origin", "source", "implicit", "selectionVersion", "selectionVersionAtDispatch", "selectionVersionAtResolve"]),
	};
	if (options.browserSessionId !== undefined) target.browserSessionId = options.browserSessionId;
	return Object.keys(target).length ? target : undefined;
}

function normalizedLimits(options: DistillBaseOptions, summary: DistilledSummary): Record<string, unknown> | undefined {
	const limits = {
		maxChars: options.maxChars,
		detailLevel: normalizeDetailLevel(options.detailLevel),
		...pickDefined(summary, ["truncated", "originalLength", "original_length", "original_bytes", "bodyTruncated", "truncatedCases", "truncatedCandidates", "truncatedDiscoveredDirectories", "maxDepth", "requestCount", "caseCount", "candidateCount"]),
	};
	return Object.keys(limits).length ? limits : undefined;
}

function normalizedDiagnostics(summary: DistilledSummary, saved?: Record<string, unknown>, operation?: Record<string, unknown>, snapshot?: Record<string, unknown>): Record<string, unknown> | undefined {
	const warnings: string[] = [];
	const omitted = firstDefined(summary, ["summaryOmitted"]);
	if (Array.isArray(omitted) && omitted.length) warnings.push(`summary_omitted:${omitted.join(",")}`);
	if (summary.bodyUnavailableReason) warnings.push(`body_unavailable:${String(summary.bodyUnavailableReason)}`);
	if (summary.empty === true) warnings.push("empty_result");
	if (summary.truncated === true || summary.bodyTruncated === true || summary.truncatedCases === true || summary.truncatedCandidates) warnings.push("truncated");
	if (saved?.path) warnings.push("raw_result_saved_to_artifact");
	const diagnostics = {
		...pickDefined(summary, ["ok", "error_code", "message", "bodyAvailability", "bodyUnavailableReason", "failureCount", "matchedCount", "entryCount", "source_count", "waitId", "sessionId", "requestId", "listenerId", "selectionVersionAtDispatch", "selectionVersionAtResolve", "sourceMode"]),
		...pickDefined(operation || {}, ["operationId", "snapshotId", "sourceMode"]),
		...pickDefined(snapshot || {}, ["snapshotId", "sourceMode"]),
		...(warnings.length ? { warnings: Array.from(new Set(warnings)) } : {}),
		...(saved ? { artifact: compactArtifactDescriptor(saved) } : {}),
	};
	return Object.keys(diagnostics).length ? diagnostics : undefined;
}

function normalizedPrivacy(saved?: Record<string, unknown>, sensitiveRaw = false): Record<string, unknown> | undefined {
	const savedPrivacy = isRecord(saved?.privacy) ? saved.privacy : undefined;
	if (!savedPrivacy && !sensitiveRaw) return undefined;
	return {
		...pickDefined(savedPrivacy || {}, ["classification", "localOnly", "redaction"]),
		...(sensitiveRaw ? { sensitiveEvidence: true, modelFacingRedaction: "default" } : {}),
	};
}

function artifactReadActions(summary: DistilledSummary, saved?: Record<string, unknown>, operation?: Record<string, unknown>, snapshot?: Record<string, unknown>): string[] {
	if (!saved?.path) return [];
	const hints = isRecord(summary.artifact_hints) ? summary.artifact_hints : undefined;
	const preferredReads = asArray(hints?.preferredReads).filter(isRecord);
	// H2: include mode=json in the hint so agents can translate it directly to a CLI call without
	// having to know that --json-path requires --mode json (blind-eval H2, n=2, bilibili+linux.do).
	const actions = preferredReads
		.map((hint) => typeof hint.jsonPath === "string" && hint.jsonPath ? `read_saved_artifact mode=json jsonPath=${hint.jsonPath}` : undefined)
		.filter((item): item is string => !!item)
		.slice(0, 3);
	// H1: when the execute/command result is already fully inline in summary.data (small return value,
	// F1 fix), emitting correlation-ID artifact hints as nextActions is misleading noise — the agent
	// already has the data and doesn't need to call browser_artifact. Suppress them when dataInline is
	// set (blind-eval H1, n=2, bilibili+linux.do). For all other tools (observe, network, hook, …)
	// correlation hints remain useful for evidence linkage.
	const dataAlreadyInline = summary.dataInline === true;
	if (!dataAlreadyInline) {
		const correlationPaths = [
			{ key: "operationId", path: "operation.operationId", value: operation?.operationId },
			{ key: "snapshotId", path: "snapshot.snapshotId", value: snapshot?.snapshotId },
			{ key: "requestId", path: "data.requestId", value: summary.requestId },
			{ key: "waitId", path: "data.waitId", value: summary.waitId },
			{ key: "listenerId", path: "data.listenerId", value: summary.listenerId },
		].filter((item) => item.value !== undefined && item.value !== null && item.value !== "");
		for (const item of correlationPaths.slice(0, 3)) actions.push(`read_saved_artifact mode=json jsonPath=${item.path}`);
	}
	return actions.length ? Array.from(new Set(actions)) : ["read_saved_artifact mode=json", "read_saved_artifact mode=text"];
}

function normalizedNextActions(options: DistillBaseOptions, summary: DistilledSummary, saved?: Record<string, unknown>, operation?: Record<string, unknown>, snapshot?: Record<string, unknown>, summaryHintActions: string[] = []): string[] | undefined {
	const actions: string[] = [];
	const entities = envelopeEntities(summary, options.entities);
	actions.push(...summaryHintActions.filter((item) => !item.includes("path=")));
	actions.push(...artifactReadActions(summary, saved, operation, snapshot));
	if (entities?.length) {
		const first = entities.find((entity) => typeof entity.ref === "string") || entities[0];
		const ref = typeof first?.ref === "string" ? first.ref : undefined;
		const kind = typeof first?.kind === "string" ? first.kind : undefined;
		if (ref) {
			actions.push(`read(${ref})`);
			if (kind === "control" || kind === "element") actions.push(`click(${ref})`);
			if (kind === "region") actions.push(`inspect(${ref})`);
			if (kind === "frame") actions.push(`frame(${ref})`);
		}
	}
	if (saved?.path && summary.nextOffset !== undefined && summary.nextOffset !== null) actions.push(`read_saved_artifact offset=${String(summary.nextOffset)}`);
	if (summary.bodyUnavailableReason) actions.push("inspect network body with a fresh recorder entry or recapture with captureBodies enabled");
	if (summary.empty === true || summary.notFound === true) actions.push("narrow the target ref/filter or re-read with mode=scan|html");
	if (summary.truncated === true || summary.bodyTruncated === true || summary.truncatedCases === true || summary.truncatedCandidates) actions.push("increase maxChars/maxBodyBytes or inspect the saved artifact by jsonPath/offset");
	if (options.browserSessionId === undefined && (summary.tabId !== undefined || isRecord(summary.target))) actions.push("pass explicit tabId/browserSessionId for follow-up tab-scoped calls");
	return actions.length ? Array.from(new Set(actions)).slice(0, 7) : undefined;
}

function redactForModel<T>(value: T, saved?: Record<string, unknown>, rawArtifactValue?: unknown): T {
	return redactSensitiveValueWithPointers(value, {
		rawArtifactPath: typeof saved?.path === "string" ? saved.path : undefined,
		rawArtifactBytes: typeof saved?.bytes === "number" ? saved.bytes : undefined,
		artifactValue: rawArtifactValue,
	}) as T;
}

function responseEnvelope(options: DistillBaseOptions, summary: DistilledSummary, saved?: Record<string, unknown>, sensitiveRaw = false): DistilledEnvelope {
	const maybeRedact = <T>(value: T): T => redactForModel(value, saved, options.rawArtifactValue);
	const rawBudget = Math.floor(Number(options.maxChars || SUMMARY_BUDGET_CHARS) * 0.7);
	const budget = Math.max(1_000, Math.min(SUMMARY_BUDGET_CHARS, rawBudget));
	const redactedSummary = maybeRedact(summary) as DistilledSummary;
	const redactedEntitiesOption = options.entities ? maybeRedact(options.entities) as Array<Record<string, unknown>> : undefined;
	const redactedExplicitError = options.error ? maybeRedact(options.error) as Record<string, unknown> : undefined;
	const summaryHintActions = Array.isArray(redactedSummary.nextActions)
		? redactedSummary.nextActions.filter((item): item is string => typeof item === "string")
		: [];
	const summaryForFitting = { ...redactedSummary };
	delete summaryForFitting.nextActions;
	const fittedSummary = fitSummaryBudget(summaryForFitting, budget);
	const redactedOperation = options.operation ? maybeRedact(options.operation) as Record<string, unknown> : undefined;
	const redactedSnapshot = options.snapshot ? maybeRedact(options.snapshot) as Record<string, unknown> : undefined;
	const correlation = {
		...pickDefined(redactedSummary, ["requestId", "waitId", "listenerId", "sessionId", "browserSessionId", "selectionVersionAtDispatch", "selectionVersionAtResolve", "sourceMode"]),
		...pickDefined(redactedOperation || {}, ["operationId", "snapshotId", "sourceMode"]),
		...pickDefined(redactedSnapshot || {}, ["snapshotId", "sourceMode"]),
	};
	const entities = envelopeEntities(redactedSummary, redactedEntitiesOption);
	const abmlIntegrated = typeof redactedSummary.abmlIntegrated === "boolean" ? redactedSummary.abmlIntegrated : undefined;
	const gist = envelopeGist(redactedSummary);
	const outline = envelopeOutline(redactedSummary);
	const relations = envelopeRelations(redactedSummary);
	const diff = envelopeDiff(redactedSummary);
	const causal = envelopeCausal(redactedSummary);
	const treeDiff = envelopeTreeDiff(redactedSummary);
	const snapshotProjection = envelopeSnapshotProjection(redactedSummary);
	const error = envelopeError(redactedSummary, redactedExplicitError);
	return fitEnvelopeBudget({
		tool: options.toolName,
		command: options.command,
		browserSessionId: options.browserSessionId,
		detailLevel: normalizeDetailLevel(options.detailLevel),
		summary: fittedSummary,
		diagnostics: normalizedDiagnostics(fittedSummary, saved, redactedOperation, redactedSnapshot),
		target: normalizedTarget(options, fittedSummary),
		limits: normalizedLimits(options, fittedSummary),
		privacy: normalizedPrivacy(saved, sensitiveRaw),
		...(entities ? { entities } : {}),
		...(abmlIntegrated !== undefined ? { abmlIntegrated } : {}),
		...(gist ? { gist } : {}),
		...(outline ? { outline } : {}),
		...(relations ? { relations } : {}),
		...(diff ? { diff } : {}),
		...(causal ? { causal } : {}),
		...(treeDiff ? { treeDiff } : {}),
		...(snapshotProjection ? { snapshotProjection } : {}),
		...(error ? { error } : {}),
		nextActions: normalizedNextActions({ ...options, entities }, redactedSummary, saved, redactedOperation, redactedSnapshot, summaryHintActions),
		operation: redactedOperation,
		snapshot: redactedSnapshot,
		...(Object.keys(correlation).length ? { correlation } : {}),
		saved,
	}, options.maxChars);
}

export async function distilledJsonResult(value: unknown, options: DistilledJsonOptions): Promise<PiTextToolResult> {
	const level = normalizeDetailLevel(options.detailLevel);
	const maxChars = Math.max(1, Math.floor(options.maxChars));
	const rawValue = options.artifactValue ?? value;
	const raw = stableJson(rawValue);
	const summary = options.distill ? options.distill(value) : distillValue(options.toolName, options.command, value);
	const threshold = Math.max(1, options.artifactThreshold ?? maxChars);
	const sensitiveRaw = containsSensitiveEvidence(rawValue);
	let saved: Record<string, unknown> | undefined;
	options.rawArtifactValue = rawValue;
	if (options.outputPath || sensitiveRaw || raw.length > threshold || (level === "summary" && raw.length > Math.min(threshold, 8_000))) saved = await saveRawArtifact(options, raw);
	if (level === "summary" || level === "preview") {
		let envelope = await appendMemoryAutoSurface({ cwd: options.ctx?.cwd, envelope: responseEnvelope(options, summary, saved, sensitiveRaw) });
		if (!saved && stableJson(envelope).length > maxChars) {
			saved = await saveRawArtifact(options, raw);
			envelope = await appendMemoryAutoSurface({ cwd: options.ctx?.cwd, envelope: responseEnvelope(options, summary, saved, sensitiveRaw) });
		}
		return {
			content: [{ type: "text", text: stableJson(envelope) }],
			details: { ...(options.details || {}), saved },
		};
	}
	if (level === "full" && (sensitiveRaw || raw.length > maxChars)) {
		const fullSaved = saved || await saveRawArtifact(options, raw);
		return jsonResult(responseEnvelope(options, { ...summary, fullResult: "saved_to_artifact", ...(sensitiveRaw ? { privacy: { sensitiveEvidence: true } } : {}) }, fullSaved, sensitiveRaw), { ...(options.details || {}), saved: fullSaved }, Math.min(maxChars, SUMMARY_MAX_CHARS));
	}
	return jsonResult(value, { ...(options.details || {}), saved, summary }, maxChars);
}

export async function distilledTextResult(text: string, options: DistilledTextOptions): Promise<PiTextToolResult> {
	const level = normalizeDetailLevel(options.detailLevel);
	const maxChars = Math.max(1, Math.floor(options.maxChars));
	const summary = options.summary || options.distill?.(text) || summarizeHtmlSnapshot(text);
	const rawValue = options.artifactValue ?? text;
	const raw = typeof rawValue === "string" ? rawValue : stableJson(rawValue);
	const threshold = Math.max(1, options.artifactThreshold ?? maxChars);
	const sensitiveRaw = containsSensitiveEvidence(rawValue);
	let saved: Record<string, unknown> | undefined;
	options.rawArtifactValue = rawValue;
	if (options.outputPath || sensitiveRaw || raw.length > threshold || (level === "summary" && raw.length > Math.min(threshold, 8_000))) saved = await saveRawArtifact(options, raw);
	if (level === "summary" || level === "preview") {
		let envelope = await appendMemoryAutoSurface({ cwd: options.ctx?.cwd, envelope: responseEnvelope(options, summary, saved, sensitiveRaw) });
		if (!saved && stableJson(envelope).length > maxChars) {
			saved = await saveRawArtifact(options, raw);
			envelope = await appendMemoryAutoSurface({ cwd: options.ctx?.cwd, envelope: responseEnvelope(options, summary, saved, sensitiveRaw) });
		}
		return {
			content: [{ type: "text", text: stableJson(envelope) }],
			details: { ...(options.details || {}), saved },
		};
	}
	if (level === "full" && (sensitiveRaw || text.length > maxChars)) {
		const fullSaved = saved || await saveRawArtifact(options, raw);
		return jsonResult(responseEnvelope(options, { ...summary, fullResult: "saved_to_artifact", ...(sensitiveRaw ? { privacy: { sensitiveEvidence: true } } : {}) }, fullSaved, sensitiveRaw), { ...(options.details || {}), saved: fullSaved }, Math.min(maxChars, SUMMARY_MAX_CHARS));
	}
	return textResult(text, { ...(options.details || {}), saved, summary }, maxChars);
}
