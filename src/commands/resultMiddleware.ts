import { stableJson } from "../utils/json.js";
import { buildSaveTextArtifactPlan, artifactPlanReasons, type ArtifactPlan, type ArtifactPlanReason } from "../kernels/evidence/distill/artifactPlan.js";
import { normalizeDetailLevel, type DetailLevel } from "../utils/params.js";
import { jsonResult, textResult, type BrowserTextCommandResult } from "../utils/toolResult.js";
import { containsSensitiveEvidence } from "../artifacts/artifactPrivacy.js";
import { saveTextArtifact } from "../artifacts/artifactFiles.js";
import { distillValue } from "./distillerRegistry.js";
import { asArray, isRecord } from "./summaries/common.js";
import { summarizeHtmlSnapshot } from "./summaries/index.js";
import { fitCommandSummaryBudget, SUMMARY_MAX_CHARS } from "./resultBudgeting.js";
import type { CommandFactGranularity, DistilledEnvelope, DistilledSummary } from "./resultTypes.js";
import { factRenderingDiagnostics, fitResponseEnvelope, renderedOmittedCount, rendererMarker } from "./resultEnvelopeBudget.js";
import { buildResultEvidence } from "./resultEvidence.js";
import { normalizedNextActions } from "./resultNextActions.js";
import { normalizedPrivacy, redactForModel } from "./resultRedaction.js";
import { collectRefs } from "../kernels/refs/text.js";
import { firstDefined, pickDefined } from "../utils/records.js";
import { hasJsonPathValue } from "../utils/jsonPath.js";

// Mandatory-read pair with commandRuntime.ts: keep envelope fields, redaction, distillation,
// artifact fallback, and evidence behavior centralized here.
type DistillBaseOptions = {
	commandName: string;
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
	activeContext?: Record<string, unknown>;
	diagnostics?: Record<string, unknown>;
	artifactThreshold?: number;
	entities?: Array<Record<string, unknown>>;
	error?: Record<string, unknown>;
	/**
	 * Deprecated compatibility only. Model-facing output is always redacted; raw
	 * values are retrieved through browser_artifact jsonPath/pick pointers.
	 */
	redact?: boolean;
	rawArtifactValue?: unknown;
	granularityCeiling?: Exclude<CommandFactGranularity, "omit">;
	stableRefs?: Set<string>;
	onAllocation?: (allocation: { budgetUsedRatio: number; omittedCount: number }) => void;
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

function rawArtifactPlan(options: DistillBaseOptions, raw: string, sensitiveRaw: boolean, threshold: number, level: DetailLevel): ArtifactPlan | undefined {
	return buildSaveTextArtifactPlan({
		text: raw,
		fallbackName: options.fallbackName,
		outputPath: options.outputPath,
		reasons: artifactPlanReasons({
			outputPath: options.outputPath,
			sensitiveRaw,
			rawLength: raw.length,
			threshold,
			summaryThreshold: Math.min(threshold, 8_000),
			summaryLike: level === "summary",
		}),
	});
}

function forcedArtifactPlan(options: DistillBaseOptions, raw: string, reason: ArtifactPlanReason): ArtifactPlan {
	return { kind: "saveText", text: raw, fallbackName: options.fallbackName, outputPath: options.outputPath, reasons: [reason] };
}

async function executeArtifactPlan(options: DistillBaseOptions, plan: ArtifactPlan | undefined): Promise<Record<string, unknown> | undefined> {
	if (!plan) return undefined;
	return await saveTextArtifact(options.ctx, plan.outputPath, plan.fallbackName, plan.text);
}

function compactArtifactDescriptor(saved?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!saved) return undefined;
	return pickDefined(saved, ["path", "bytes", "chars", "mime"]);
}

function envelopeWithArtifactDescriptor(envelope: DistilledEnvelope, saved: Record<string, unknown>): DistilledEnvelope {
	const descriptor = compactArtifactDescriptor(saved) || {};
	const diagnostics = envelope.diagnostics && isRecord(envelope.diagnostics.artifact)
		? { ...envelope.diagnostics, artifact: descriptor }
		: envelope.diagnostics;
	const evidence = envelope.evidence
		? {
			...envelope.evidence,
			artifacts: envelope.evidence.artifacts.map((artifact) => artifact.path === saved.path
				? {
					...artifact,
					...(typeof saved.bytes === "number" ? { bytes: saved.bytes } : {}),
					...(typeof saved.chars === "number" ? { chars: saved.chars } : {}),
				}
				: artifact),
		}
		: undefined;
	const artifactHints = envelope.artifact_hints ? { ...envelope.artifact_hints, saved: descriptor } : undefined;
	return {
		...envelope,
		...(artifactHints ? { artifact_hints: artifactHints } : {}),
		...(diagnostics ? { diagnostics } : {}),
		saved: descriptor,
		...(evidence ? { evidence } : {}),
	};
}

function finalEnvelopeArtifactContent(rawValue: Record<string, unknown>, envelope: DistilledEnvelope, saved: Record<string, unknown>): { content: string; envelope: DistilledEnvelope; saved: Record<string, unknown> } {
	let finalSaved = saved;
	for (let iteration = 0; iteration < 16; iteration += 1) {
		const finalEnvelope = envelopeWithArtifactDescriptor(envelope, finalSaved);
		const content = stableJson({ ...rawValue, envelope: finalEnvelope });
		const chars = content.length;
		const bytes = Buffer.byteLength(content, "utf8");
		if (finalSaved.chars === chars && finalSaved.bytes === bytes) return { content, envelope: finalEnvelope, saved: finalSaved };
		finalSaved = { ...finalSaved, chars, bytes };
	}
	throw new Error("final artifact descriptor did not converge");
}

async function saveFinalEnvelopeArtifact(options: DistillBaseOptions, saved: Record<string, unknown> | undefined, rawValue: unknown, envelope: DistilledEnvelope): Promise<{ envelope: DistilledEnvelope; saved?: Record<string, unknown> }> {
	if (!saved || !isRecord(rawValue) || typeof saved.path !== "string") return { envelope, saved };
	const finalized = finalEnvelopeArtifactContent(rawValue, envelope, saved);
	const persisted = await saveTextArtifact(options.ctx, saved.path, options.fallbackName, finalized.content);
	const finalSaved = { ...finalized.saved, ...persisted };
	return { envelope: envelopeWithArtifactDescriptor(finalized.envelope, finalSaved), saved: finalSaved };
}

function collectPathHint(paths: Record<string, string>, reads: Array<Record<string, unknown>>, value: unknown, label: string, jsonPath: string, kind?: string): void {
	if (!hasJsonPathValue(value, jsonPath)) return;
	paths[label] = jsonPath;
	if (!reads.some((read) => read.jsonPath === jsonPath)) reads.push({ label, jsonPath, ...(kind ? { kind } : {}) });
}

function mergeSummaryArtifactHints(summary: DistilledSummary, paths: Record<string, string>, reads: Array<Record<string, unknown>>, rawValue: unknown): void {
	const hints = isRecord(summary.artifact_hints) ? summary.artifact_hints : undefined;
	const jsonPaths = isRecord(hints?.jsonPaths) ? hints.jsonPaths as Record<string, unknown> : {};
	for (const [label, value] of Object.entries(jsonPaths)) if (typeof value === "string" && value && hasJsonPathValue(rawValue, value)) paths[label] = value;
	for (const read of asArray(hints?.preferredReads).filter(isRecord)) {
		const jsonPath = typeof read.jsonPath === "string" ? read.jsonPath : undefined;
		if (!jsonPath || !hasJsonPathValue(rawValue, jsonPath) || reads.some((item) => item.jsonPath === jsonPath)) continue;
		reads.push(pickDefined(read, ["label", "jsonPath", "kind", "count"]));
	}
}

function artifactSchemaKind(options: DistillBaseOptions, rawValue: unknown): string {
	if (options.commandName === "browser_observe") return "PageObservation";
	if (options.commandName === "browser_execute" && options.command === "program") return "ExecuteProgramResult";
	if (options.commandName === "browser_execute") return "ExecuteResult";
	if (options.commandName === "browser_crawl") return "CrawlResult";
	if (options.commandName === "browser_artifact") return "ArtifactReadResult";
	if (isRecord(rawValue) && typeof rawValue.type === "string") return rawValue.type;
	return "BrowserCommandResult";
}

function compactArtifactHints(options: DistillBaseOptions, summary: DistilledSummary, saved: Record<string, unknown> | undefined, rawValue: unknown): Record<string, unknown> | undefined {
	const paths: Record<string, string> = {};
	const preferredReads: Array<Record<string, unknown>> = [];
	collectPathHint(paths, preferredReads, rawValue, "summary", "summary", "summary");
	collectPathHint(paths, preferredReads, rawValue, "data", "data", "primary-data");
	collectPathHint(paths, preferredReads, rawValue, "items", "items", "primary-items");
	collectPathHint(paths, preferredReads, rawValue, "pages", "pages", "primary-items");
	collectPathHint(paths, preferredReads, rawValue, "executed", "executed", "program-frames");
	collectPathHint(paths, preferredReads, rawValue, "result", "result", "execute-result");
	collectPathHint(paths, preferredReads, rawValue, "body", "body", "body");
	collectPathHint(paths, preferredReads, rawValue, "text", "text", "text");
	collectPathHint(paths, preferredReads, rawValue, "content text", "data.content", "text");
	collectPathHint(paths, preferredReads, rawValue, "actionables", "data.actionables", "primary-items");
	collectPathHint(paths, preferredReads, rawValue, "list hints", "data.list_hints", "primary-items");
	collectPathHint(paths, preferredReads, rawValue, "rows", "data.rows", "primary-items");
	collectPathHint(paths, preferredReads, rawValue, "media candidates", "data.media_candidates", "primary-items");
	mergeSummaryArtifactHints(summary, paths, preferredReads, rawValue);
	const savedDescriptor = compactArtifactDescriptor(saved);
	if (!Object.keys(paths).length && !savedDescriptor) return undefined;
	return {
		kind: artifactSchemaKind(options, rawValue),
		schemaVersion: 1,
		...(Object.keys(paths).length ? { jsonPaths: paths } : {}),
		...(preferredReads.length ? { preferredReads } : {}),
		...(savedDescriptor ? { saved: savedDescriptor } : {}),
	};
}

function collectBrowserPilotRefs(value: unknown, refs: string[]): void {
	refs.push(...collectRefs(value));
}

function inferenceEvidenceRefs(summary: DistilledSummary, focus?: Record<string, unknown>): Set<string> {
	const refs: string[] = [];
	const collect = (inference: unknown): void => {
		if (!isRecord(inference)) return;
		for (const intent of asArray(inference.intents).filter(isRecord)) collectBrowserPilotRefs(intent.evidence, refs);
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

function envelopeIdentity(summary: DistilledSummary): Record<string, unknown> | undefined {
	return isRecord(summary.identity) ? structuredClone(summary.identity) as Record<string, unknown> : undefined;
}

function envelopeDiff(summary: DistilledSummary): Record<string, unknown> | undefined {
	if (isRecord(summary.diff)) return structuredClone(summary.diff) as Record<string, unknown>;
	const focus = isRecord(summary.focus) ? summary.focus : undefined;
	return isRecord(focus?.diff) ? structuredClone(focus.diff) as Record<string, unknown> : undefined;
}

// Causal block lifted from the (uncompressed) summary so the network delta survives the
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

function envelopeCollections(summary: DistilledSummary): Array<Record<string, unknown>> | undefined {
	if (Array.isArray(summary.collections)) return structuredClone(summary.collections).filter(isRecord) as Array<Record<string, unknown>>;
	const focus = isRecord(summary.focus) ? summary.focus : undefined;
	const collections = Array.isArray(focus?.collections) ? focus.collections.filter(isRecord) : [];
	return collections.length ? structuredClone(collections) as Array<Record<string, unknown>> : undefined;
}

function envelopeError(summary: DistilledSummary, explicit?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (explicit && Object.keys(explicit).length) return explicit;
	if (summary.failed === true || typeof summary.error_code === "string") {
		return pickDefined(summary, ["failed", "error_code", "message", "recovery"]);
	}
	return undefined;
}

function normalizedTarget(options: DistillBaseOptions, summary: DistilledSummary): Record<string, unknown> | undefined {
	const summaryTarget = isRecord(summary.target) ? summary.target : {};
	const target = {
		...pickDefined(summary, ["browserId", "tabId", "tabHandle", "targetRef", "requestedTabId", "replacedFrom", "replacedByTabId", "replacementHops", "openerTabId", "frameId", "url", "origin", "targetSource", "targetImplicit", "browserSessionId", "selectionVersionAtDispatch", "selectionVersionAtResolve"]),
		...pickDefined(summaryTarget, ["browserSessionId", "browserId", "tabId", "tabHandle", "targetRef", "requestedTabId", "replacedFrom", "replacedByTabId", "replacementHops", "openerTabId", "frameId", "url", "origin", "source", "implicit", "selectionVersion", "selectionVersionAtDispatch", "selectionVersionAtResolve"]),
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

function normalizedDiagnostics(summary: DistilledSummary, saved?: Record<string, unknown>, operation?: Record<string, unknown>, snapshot?: Record<string, unknown>, extra?: Record<string, unknown>): Record<string, unknown> | undefined {
	const warnings: string[] = [];
	const omitted = firstDefined(summary, ["summaryOmitted"]);
	if (Array.isArray(omitted) && omitted.length) warnings.push(`summary_omitted:${omitted.join(",")}`);
	if (summary.bodyUnavailableReason) warnings.push(`body_unavailable:${String(summary.bodyUnavailableReason)}`);
	if (summary.empty === true) warnings.push("empty_result");
	if (summary.truncated === true || summary.bodyTruncated === true || summary.truncatedCases === true || summary.truncatedCandidates) warnings.push("truncated");
	if (saved?.path) warnings.push("raw_result_saved_to_artifact");
	const diagnostics: Record<string, unknown> = {
		...(extra || {}),
		...pickDefined(summary, ["ok", "error_code", "message", "bodyAvailability", "bodyUnavailableReason", "failureCount", "matchedCount", "entryCount", "source_count", "waitId", "sessionId", "requestId", "listenerId", "selectionVersionAtDispatch", "selectionVersionAtResolve", "sourceMode"]),
		...pickDefined(operation || {}, ["operationId", "snapshotId", "sourceMode"]),
		...pickDefined(snapshot || {}, ["snapshotId", "sourceMode"]),
		...(saved ? { artifact: compactArtifactDescriptor(saved) } : {}),
	};
	const extraWarnings = Array.isArray(extra?.warnings) ? extra.warnings.filter((item): item is string => typeof item === "string") : [];
	if (warnings.length || extraWarnings.length) diagnostics.warnings = Array.from(new Set([...extraWarnings, ...warnings]));
	return Object.keys(diagnostics).length ? diagnostics : undefined;
}

function reportAllocation(options: DistillBaseOptions, envelope: DistilledEnvelope, rendered: string): void {
	if (!options.onAllocation) return;
	const budget = Math.max(1, Math.floor(options.maxChars));
	options.onAllocation({
		budgetUsedRatio: Math.max(0, Math.min(1, rendered.length / budget)),
		omittedCount: renderedOmittedCount(envelope),
	});
}

function responseEnvelope(options: DistillBaseOptions, summary: DistilledSummary, saved?: Record<string, unknown>, sensitiveRaw = false): DistilledEnvelope {
	const maybeRedact = <T>(value: T): T => redactForModel(value, saved, options.rawArtifactValue);
	const redactedSummary = maybeRedact(summary) as DistilledSummary;
	const redactedEntitiesOption = options.entities ? maybeRedact(options.entities) as Array<Record<string, unknown>> : undefined;
	const redactedExplicitError = options.error ? maybeRedact(options.error) as Record<string, unknown> : undefined;
	const summaryHintActions = Array.isArray(redactedSummary.nextActions)
		? redactedSummary.nextActions.filter((item): item is string => typeof item === "string")
		: [];
	const summaryForFitting = { ...redactedSummary };
	delete summaryForFitting.nextActions;
	const preFitBudget = Math.max(1_000, Math.min(SUMMARY_MAX_CHARS, Math.floor(Number(options.maxChars || SUMMARY_MAX_CHARS) * 0.7)));
	const fittedSummary = fitCommandSummaryBudget(summaryForFitting, preFitBudget);
	const redactedOperation = options.operation ? maybeRedact(options.operation) as Record<string, unknown> : undefined;
	const redactedSnapshot = options.snapshot ? maybeRedact(options.snapshot) as Record<string, unknown> : undefined;
	const redactedActiveContext = options.activeContext && Object.keys(options.activeContext).length ? maybeRedact(options.activeContext) as Record<string, unknown> : undefined;
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
	const identity = envelopeIdentity(redactedSummary);
	const diff = envelopeDiff(redactedSummary);
	const causal = envelopeCausal(redactedSummary);
	const treeDiff = envelopeTreeDiff(redactedSummary);
	const snapshotProjection = envelopeSnapshotProjection(redactedSummary);
	const collections = envelopeCollections(redactedSummary);
	const error = envelopeError(redactedSummary, redactedExplicitError);
	const delta = redactedSummary.delta === "session" ? "session" : undefined;
	const baselineSnapshotId = typeof redactedSummary.baselineSnapshotId === "string" ? redactedSummary.baselineSnapshotId : undefined;
	const diagnostics = normalizedDiagnostics(fittedSummary, saved, redactedOperation, redactedSnapshot, options.diagnostics);
	const target = normalizedTarget(options, fittedSummary);
	const limits = normalizedLimits(options, fittedSummary);
	const artifact_hints = compactArtifactHints(options, fittedSummary, saved, options.rawArtifactValue);
	const savedDescriptor = compactArtifactDescriptor(saved);
	const privacy = normalizedPrivacy(saved, sensitiveRaw);
	const nextActions = normalizedNextActions(options, redactedSummary, saved, artifact_hints, summaryHintActions);
	const evidence = buildResultEvidence({
		summary: fittedSummary,
		entities,
		nextActions,
		operation: redactedOperation,
		snapshot: redactedSnapshot,
		artifact: saved,
		redactionApplied: sensitiveRaw || Boolean(privacy),
	});
	const envelopeMetadata = pickDefined({ renderer: rendererMarker(), delta, baselineSnapshotId }, ["renderer", "delta", "baselineSnapshotId"]);
	const envelopeArtifact = pickDefined({ artifact_hints }, ["artifact_hints"]);
	const envelopePlanes = pickDefined({ entities, abmlIntegrated, gist, outline, relations, identity, diff, causal, treeDiff, snapshotProjection, collections, error }, ["entities", "abmlIntegrated", "gist", "outline", "relations", "identity", "diff", "causal", "treeDiff", "snapshotProjection", "collections", "error"]);
	const envelopeTail = pickDefined({ activeContext: redactedActiveContext, correlation: Object.keys(correlation).length ? correlation : undefined }, ["activeContext", "correlation"]);
	return fitResponseEnvelope({
		tool: options.commandName,
		command: options.command,
		browserSessionId: options.browserSessionId,
		detailLevel: normalizeDetailLevel(options.detailLevel),
		...envelopeMetadata,
		summary: fittedSummary,
		diagnostics,
		target,
		limits,
		...envelopeArtifact,
		privacy,
		...envelopePlanes,
		nextActions,
		operation: redactedOperation,
		snapshot: redactedSnapshot,
		...envelopeTail,
		saved: savedDescriptor,
		evidence,
	}, options.maxChars, options);
}

function attachSerializeTiming(envelope: DistilledEnvelope, options: DistillBaseOptions, serializeMs: number): DistilledEnvelope {
	const timings = isRecord(options.diagnostics?.observeTimings) ? options.diagnostics.observeTimings as Record<string, unknown> : undefined;
	if (!timings) return envelope;
	return {
		...envelope,
		diagnostics: {
			...(envelope.diagnostics || {}),
			observeTimings: {
				...timings,
				serializeMs,
			},
		},
	};
}

function renderEnvelopeWithSerializeTiming(envelope: DistilledEnvelope, options: DistillBaseOptions): { envelope: DistilledEnvelope; rendered: string } {
	const serializeStartedAt = Date.now();
	const renderedWithoutTiming = stableJson(envelope);
	const withTiming = attachSerializeTiming(envelope, options, Date.now() - serializeStartedAt);
	if (withTiming === envelope) return { envelope, rendered: renderedWithoutTiming };
	return { envelope: withTiming, rendered: stableJson(withTiming) };
}

function textResultSummary(text: string, options: DistilledTextOptions): Record<string, unknown> {
	return options.summary || options.distill?.(text) || summarizeHtmlSnapshot(text);
}

export async function distilledJsonResult(value: unknown, options: DistilledJsonOptions): Promise<BrowserTextCommandResult> {
	const level = normalizeDetailLevel(options.detailLevel);
	const maxChars = Math.max(1, Math.floor(options.maxChars));
	const rawValue = options.artifactValue ?? value;
	const raw = stableJson(rawValue);
	const summary = options.distill ? options.distill(value) : distillValue(options.commandName, options.command, value);
	const factRendering = factRenderingDiagnostics(options, value, maxChars);
	const threshold = Math.max(1, options.artifactThreshold ?? maxChars);
	const sensitiveRaw = containsSensitiveEvidence(rawValue);
	let saved: Record<string, unknown> | undefined;
	options.rawArtifactValue = rawValue;
	saved = await executeArtifactPlan(options, rawArtifactPlan(options, raw, sensitiveRaw, threshold, level));
	if (level === "summary" || level === "preview") {
		let envelope = responseEnvelope(options, summary, saved, sensitiveRaw);
		if (!saved && stableJson(envelope).length > maxChars) {
			saved = await executeArtifactPlan(options, forcedArtifactPlan(options, raw, "fallback-over-budget"));
			envelope = responseEnvelope(options, summary, saved, sensitiveRaw);
		}
		const renderedEnvelope = renderEnvelopeWithSerializeTiming(envelope, options);
		envelope = renderedEnvelope.envelope;
		const finalizedArtifact = await saveFinalEnvelopeArtifact(options, saved, rawValue, envelope);
		saved = finalizedArtifact.saved;
		envelope = finalizedArtifact.envelope;
		const rendered = stableJson(envelope);
		reportAllocation(options, envelope, rendered);
		return {
			content: [{ type: "text", text: rendered }],
			details: { ...(options.details || {}), saved, factRendering },
		};
	}
	if (level === "full" && (sensitiveRaw || raw.length > maxChars)) {
		const fullSaved = saved || await executeArtifactPlan(options, forcedArtifactPlan(options, raw, "full-sensitive-or-over-budget"));
		let envelope = responseEnvelope(options, { ...summary, fullResult: "saved_to_artifact", ...(sensitiveRaw ? { privacy: { sensitiveEvidence: true } } : {}) }, fullSaved, sensitiveRaw);
		const renderedEnvelope = renderEnvelopeWithSerializeTiming(envelope, options);
		envelope = renderedEnvelope.envelope;
		const rendered = renderedEnvelope.rendered;
		reportAllocation(options, envelope, rendered);
		return jsonResult(envelope, { ...(options.details || {}), saved: fullSaved, factRendering }, Math.min(maxChars, SUMMARY_MAX_CHARS));
	}
	return jsonResult(value, { ...(options.details || {}), saved, summary, factRendering }, maxChars);
}

export async function distilledTextResult(text: string, options: DistilledTextOptions): Promise<BrowserTextCommandResult> {
	const level = normalizeDetailLevel(options.detailLevel);
	const maxChars = Math.max(1, Math.floor(options.maxChars));
	const summary = textResultSummary(text, options);
	const rawValue = options.artifactValue ?? text;
	const raw = typeof rawValue === "string" ? rawValue : stableJson(rawValue);
	const threshold = Math.max(1, options.artifactThreshold ?? maxChars);
	const sensitiveRaw = containsSensitiveEvidence(rawValue);
	let saved: Record<string, unknown> | undefined;
	options.rawArtifactValue = rawValue;
	saved = await executeArtifactPlan(options, rawArtifactPlan(options, raw, sensitiveRaw, threshold, level));
	if (level === "summary" || level === "preview") {
		let envelope = responseEnvelope(options, summary, saved, sensitiveRaw);
		if (!saved && stableJson(envelope).length > maxChars) {
			saved = await executeArtifactPlan(options, forcedArtifactPlan(options, raw, "fallback-over-budget"));
			envelope = responseEnvelope(options, summary, saved, sensitiveRaw);
		}
		const renderedEnvelope = renderEnvelopeWithSerializeTiming(envelope, options);
		envelope = renderedEnvelope.envelope;
		const finalizedArtifact = await saveFinalEnvelopeArtifact(options, saved, rawValue, envelope);
		saved = finalizedArtifact.saved;
		envelope = finalizedArtifact.envelope;
		const rendered = stableJson(envelope);
		reportAllocation(options, envelope, rendered);
		return {
			content: [{ type: "text", text: rendered }],
			details: { ...(options.details || {}), saved },
		};
	}
	if (level === "full" && (sensitiveRaw || text.length > maxChars)) {
		const fullSaved = saved || await executeArtifactPlan(options, forcedArtifactPlan(options, raw, "full-sensitive-or-over-budget"));
		let envelope = responseEnvelope(options, { ...summary, fullResult: "saved_to_artifact", ...(sensitiveRaw ? { privacy: { sensitiveEvidence: true } } : {}) }, fullSaved, sensitiveRaw);
		const renderedEnvelope = renderEnvelopeWithSerializeTiming(envelope, options);
		envelope = renderedEnvelope.envelope;
		const rendered = renderedEnvelope.rendered;
		reportAllocation(options, envelope, rendered);
		return jsonResult(envelope, { ...(options.details || {}), saved: fullSaved }, Math.min(maxChars, SUMMARY_MAX_CHARS));
	}
	return textResult(text, { ...(options.details || {}), saved, summary }, maxChars);
}
