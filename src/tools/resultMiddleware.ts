import { stableJson } from "../utils/json.js";
import { buildSaveTextArtifactPlan, artifactPlanReasons, type ArtifactPlan, type ArtifactPlanReason } from "../distill-core/artifactPlan.js";
import { allocateFacts } from "../distill-core/allocate.js";
import { fitEnvelopeBudget, fitSummaryBudget, SUMMARY_MAX_CHARS, type DistilledSummary } from "../distill-core/ladder.js";
import { renderFacts, type RenderedFacts } from "../distill-core/render.js";
import { fitSalienceEnvelopeBudget } from "../distill-core/salienceEnvelope.js";
import type { FactGranularity } from "../distill-core/fact.js";
import { normalizeDetailLevel, type DetailLevel } from "../utils/params.js";
import { jsonResult, textResult, type PiTextToolResult } from "../utils/toolResult.js";
import { containsSensitiveEvidence, redactSensitiveValueWithPointers } from "./artifactPrivacy.js";
import { saveTextArtifact } from "./artifacts.js";
import { distillValue, getDistillerDefinition } from "./distillerRegistry.js";
import { asArray, isRecord } from "./summaries/common.js";
import { summarizeHtmlSnapshot } from "./summaries/index.js";
import { appendMemoryAutoSurface } from "./memory/autoSurface.js";
import type { MemoryAugmentationPlan } from "../memory-core/types.js";

export { distillValue } from "./distillerRegistry.js";
export { summarizeHtmlSnapshot } from "./summaries/index.js";

export type { DistilledSummary } from "../distill-core/ladder.js";
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
	memory?: Record<string, unknown>;
	renderer?: "salience-v1";
	delta?: "session";
	baselineSnapshotId?: string;
};

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
	granularityCeiling?: Exclude<FactGranularity, "omit">;
	stableRefs?: Set<string>;
	memoryAugmentationPlan?: MemoryAugmentationPlan;
	onAllocation?: (allocation: { budgetUsedRatio: number; omittedCount: number }) => void;
};

type FactRenderingDiagnostics = {
	rendered: number;
	skipped: number;
	markerCount: number;
	planes: string[];
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

const SESSION_DELTA_RECOVERY_TARGET_LIMIT = 3;

function recoveryTargetKey(action: string): string | undefined {
	if (action.startsWith("read_saved_artifact")) return action;
	const ref = action.match(/pi-ref:\/\/[^)\s]+/)?.[0];
	return ref;
}

function capSessionDeltaRecoveryFanout(actions: string[], delta?: string): string[] {
	if (delta !== "session") return actions;
	const seenTargets = new Set<string>();
	return actions.filter((action) => {
		const key = recoveryTargetKey(action);
		if (!key) return true;
		if (seenTargets.has(key)) return true;
		if (seenTargets.size >= SESSION_DELTA_RECOVERY_TARGET_LIMIT) return false;
		seenTargets.add(key);
		return true;
	});
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
	const unique = capSessionDeltaRecoveryFanout(Array.from(new Set(actions)), typeof summary.delta === "string" ? summary.delta : undefined);
	return unique.length ? unique.slice(0, 7) : undefined;
}

function redactForModel<T>(value: T, saved?: Record<string, unknown>, rawArtifactValue?: unknown): T {
	return redactSensitiveValueWithPointers(value, {
		rawArtifactPath: typeof saved?.path === "string" ? saved.path : undefined,
		rawArtifactBytes: typeof saved?.bytes === "number" ? saved.bytes : undefined,
		artifactValue: rawArtifactValue,
	}) as T;
}

function rendererMarker(): DistilledEnvelope["renderer"] | undefined {
	return process.env.PI_BROWSER_RENDERER === "ladder" ? undefined : "salience-v1";
}

function allocationCostModel(): "byte" | "token" {
	return process.env.PI_BROWSER_TOKEN_COST === "1" ? "token" : "byte";
}

function factRenderingDiagnostics(options: DistillBaseOptions, value: unknown, maxChars: number): FactRenderingDiagnostics | undefined {
	if (!rendererMarker()) return undefined;
	const factify = getDistillerDefinition(options.toolName)?.factify;
	if (!factify) return undefined;
	const facts = factify(value, options.command);
	if (!facts.length) return undefined;
	const budget = Math.max(256, Math.floor(maxChars * 0.25));
	const plan = allocateFacts(facts, budget, [{ plane: "summary", minFacts: 1, minGranularity: "compact" }], { minDensity: 0.01, costModel: allocationCostModel(), stableRefs: options.stableRefs });
	const rendered: RenderedFacts = renderFacts(facts, plan);
	const planes = Object.keys(rendered).filter((key) => key !== "omitted" && key !== "stats").sort();
	return {
		rendered: rendered.stats?.factsRendered ?? 0,
		skipped: rendered.stats?.factsOmitted ?? 0,
		markerCount: rendered.stats?.truncationMarkers ?? 0,
		planes,
	};
}

function fitResponseEnvelope(envelope: DistilledEnvelope, maxChars: number, options: DistillBaseOptions): DistilledEnvelope {
	return rendererMarker() ? fitSalienceEnvelopeBudget(envelope, maxChars, { granularityCeiling: options.granularityCeiling }) : fitEnvelopeBudget(envelope, maxChars);
}

export function livePlaneSignature(envelope: DistilledEnvelope): string {
	return stableJson({
		entities: envelope.entities,
		gist: envelope.gist,
		outline: envelope.outline,
		relations: envelope.relations,
		diff: envelope.diff,
		causal: envelope.causal,
		treeDiff: envelope.treeDiff,
		snapshotProjection: envelope.snapshotProjection,
		rendererOmitted: envelope.summary.rendererOmitted,
		envelopeOmitted: envelope.summary.envelopeOmitted,
		warnings: Array.isArray(envelope.diagnostics?.warnings) ? envelope.diagnostics.warnings : undefined,
	});
}

function fitResponseEnvelopeWithMemory(base: DistilledEnvelope, maxChars: number, options: DistillBaseOptions): DistilledEnvelope {
	const fittedBase = fitResponseEnvelope(base, maxChars, options);
	const plan = options.memoryAugmentationPlan;
	const memoryAllowed = options.toolName === "browser_observe" && (!options.command || ["scan", "scan.text", "navigate+scan", "navigate+text"].includes(options.command));
	if (!memoryAllowed || (!plan?.inline && !plan?.handleOnly)) return fittedBase;
	const baseSignature = livePlaneSignature(fittedBase);
	for (const variant of [plan.inline, plan.handleOnly]) {
		if (!variant) continue;
		const candidate = fitResponseEnvelope({ ...base, memory: variant }, maxChars, options);
		if (candidate.memory && livePlaneSignature(candidate) === baseSignature) return candidate;
	}
	return fittedBase;
}

function renderedOmittedCount(envelope: DistilledEnvelope): number {
	const omitted = envelope.summary.rendererOmitted;
	return Array.isArray(omitted) ? omitted.filter((item) => typeof item === "string").length : 0;
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
	const fittedSummary = fitSummaryBudget(summaryForFitting, preFitBudget);
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
	const delta = redactedSummary.delta === "session" ? "session" : undefined;
	const baselineSnapshotId = typeof redactedSummary.baselineSnapshotId === "string" ? redactedSummary.baselineSnapshotId : undefined;
	return fitResponseEnvelopeWithMemory({
		tool: options.toolName,
		command: options.command,
		browserSessionId: options.browserSessionId,
		detailLevel: normalizeDetailLevel(options.detailLevel),
		...(rendererMarker() ? { renderer: rendererMarker() } : {}),
		...(delta ? { delta } : {}),
		...(baselineSnapshotId ? { baselineSnapshotId } : {}),
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
	}, options.maxChars, options);
}

export async function distilledJsonResult(value: unknown, options: DistilledJsonOptions): Promise<PiTextToolResult> {
	const level = normalizeDetailLevel(options.detailLevel);
	const maxChars = Math.max(1, Math.floor(options.maxChars));
	const rawValue = options.artifactValue ?? value;
	const raw = stableJson(rawValue);
	const summary = options.distill ? options.distill(value) : distillValue(options.toolName, options.command, value);
	const factRendering = factRenderingDiagnostics(options, value, maxChars);
	const threshold = Math.max(1, options.artifactThreshold ?? maxChars);
	const sensitiveRaw = containsSensitiveEvidence(rawValue);
	let saved: Record<string, unknown> | undefined;
	options.rawArtifactValue = rawValue;
	saved = await executeArtifactPlan(options, rawArtifactPlan(options, raw, sensitiveRaw, threshold, level));
	if (level === "summary" || level === "preview") {
		let envelope = await appendMemoryAutoSurface({ cwd: options.ctx?.cwd, envelope: responseEnvelope(options, summary, saved, sensitiveRaw) });
		if (!saved && stableJson(envelope).length > maxChars) {
			saved = await executeArtifactPlan(options, forcedArtifactPlan(options, raw, "fallback-over-budget"));
			envelope = await appendMemoryAutoSurface({ cwd: options.ctx?.cwd, envelope: responseEnvelope(options, summary, saved, sensitiveRaw) });
		}
		const rendered = stableJson(envelope);
		reportAllocation(options, envelope, rendered);
		return {
			content: [{ type: "text", text: rendered }],
			details: { ...(options.details || {}), saved, factRendering },
		};
	}
	if (level === "full" && (sensitiveRaw || raw.length > maxChars)) {
		const fullSaved = saved || await executeArtifactPlan(options, forcedArtifactPlan(options, raw, "full-sensitive-or-over-budget"));
		const envelope = responseEnvelope(options, { ...summary, fullResult: "saved_to_artifact", ...(sensitiveRaw ? { privacy: { sensitiveEvidence: true } } : {}) }, fullSaved, sensitiveRaw);
		const rendered = stableJson(envelope);
		reportAllocation(options, envelope, rendered);
		return jsonResult(envelope, { ...(options.details || {}), saved: fullSaved, factRendering }, Math.min(maxChars, SUMMARY_MAX_CHARS));
	}
	return jsonResult(value, { ...(options.details || {}), saved, summary, factRendering }, maxChars);
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
	saved = await executeArtifactPlan(options, rawArtifactPlan(options, raw, sensitiveRaw, threshold, level));
	if (level === "summary" || level === "preview") {
		let envelope = await appendMemoryAutoSurface({ cwd: options.ctx?.cwd, envelope: responseEnvelope(options, summary, saved, sensitiveRaw) });
		if (!saved && stableJson(envelope).length > maxChars) {
			saved = await executeArtifactPlan(options, forcedArtifactPlan(options, raw, "fallback-over-budget"));
			envelope = await appendMemoryAutoSurface({ cwd: options.ctx?.cwd, envelope: responseEnvelope(options, summary, saved, sensitiveRaw) });
		}
		const rendered = stableJson(envelope);
		reportAllocation(options, envelope, rendered);
		return {
			content: [{ type: "text", text: rendered }],
			details: { ...(options.details || {}), saved },
		};
	}
	if (level === "full" && (sensitiveRaw || text.length > maxChars)) {
		const fullSaved = saved || await executeArtifactPlan(options, forcedArtifactPlan(options, raw, "full-sensitive-or-over-budget"));
		const envelope = responseEnvelope(options, { ...summary, fullResult: "saved_to_artifact", ...(sensitiveRaw ? { privacy: { sensitiveEvidence: true } } : {}) }, fullSaved, sensitiveRaw);
		const rendered = stableJson(envelope);
		reportAllocation(options, envelope, rendered);
		return jsonResult(envelope, { ...(options.details || {}), saved: fullSaved }, Math.min(maxChars, SUMMARY_MAX_CHARS));
	}
	return textResult(text, { ...(options.details || {}), saved, summary }, maxChars);
}
