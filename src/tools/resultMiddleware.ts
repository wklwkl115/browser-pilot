import { stableJson } from "../utils/json";
import { normalizeDetailLevel, type DetailLevel } from "../utils/params";
import { jsonResult, textResult, type PiTextToolResult } from "../utils/toolResult";
import { containsSensitiveEvidence, redactSensitiveValue } from "./artifactPrivacy";
import { saveTextArtifact } from "./artifacts";
import { asArray, isRecord } from "./summaries/common";
import { summarizeDomFlowData, summarizeEvidenceData, summarizeGenericValue, summarizeHtmlSnapshot, summarizeNetworkData, summarizeScanData, summarizeWsSessionData } from "./summaries/index";

export { summarizeEvidenceData, summarizeGenericValue, summarizeHtmlSnapshot, summarizeNetworkData, summarizeScanData } from "./summaries/index";

export function distillValue(toolName: string, command: string | undefined, value: unknown): Record<string, unknown> {
	if (toolName === "browser_evidence" || command === "evidence.collect") return summarizeEvidenceData(isRecord(value) && value.data !== undefined ? value.data : value);
	if (toolName === "browser_network" || String(command || "").startsWith("network.")) return summarizeNetworkData(isRecord(value) && value.data !== undefined ? value.data : value);
	if (toolName === "browser_hook" && ["hook.getNodeListeners", "hook.getListenerChain", "hook.getSinkHints"].includes(String(command || ""))) return summarizeDomFlowData(String(command), value);
	if (String(command || "").startsWith("ws.")) return summarizeWsSessionData(String(command || "ws"), isRecord(value) && value.data !== undefined ? value.data : value);
	return summarizeGenericValue(value);
}

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
	nextActions?: string[];
	correlation?: Record<string, unknown>;
	operation?: Record<string, unknown>;
	snapshot?: Record<string, unknown>;
	saved?: Record<string, unknown>;
};

const SUMMARY_MAX_CHARS = 12_000;
const SUMMARY_BUDGET_CHARS = 8_000;
const SUMMARY_LOW_PRIORITY_KEYS = new Set(["textPreview", "interactive", "headings", "samples", "failed", "nodes", "matches", "selections", "frames", "iframe_notes"]);

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
	const dropped = dropLowPrioritySummaryFields(compactSummaryValue(summary, { stringChars: 120, arrayItems: 5, tableRows: 5 }) as DistilledSummary, budget);
	if (stableJson(dropped).length <= budget) return dropped;
	const minimalBase: DistilledSummary = {
		summaryTruncatedToBudget: true,
		summaryOmitted: Array.from(new Set([...(Array.isArray(dropped.summaryOmitted) ? dropped.summaryOmitted : []), ...Object.keys(summary)])),
		keys: Object.keys(summary).slice(0, 40),
	};
	const previewSource = stableJson(compactSummaryValue(summary, { stringChars: 60, arrayItems: 3, tableRows: 3 }));
	let previewChars = Math.max(0, Math.min(previewSource.length, budget));
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
	const path = String(saved.path);
	const hints = isRecord(summary.artifact_hints) ? summary.artifact_hints : undefined;
	const preferredReads = asArray(hints?.preferredReads).filter(isRecord);
	const actions = preferredReads
		.map((hint) => typeof hint.jsonPath === "string" && hint.jsonPath ? `browser_artifact path=${path} mode=json jsonPath=${hint.jsonPath}` : undefined)
		.filter((item): item is string => !!item)
		.slice(0, 3);
	const correlationPaths = [
		{ key: "operationId", path: "operation.operationId", value: operation?.operationId },
		{ key: "snapshotId", path: "snapshot.snapshotId", value: snapshot?.snapshotId },
		{ key: "requestId", path: "data.requestId", value: summary.requestId },
		{ key: "waitId", path: "data.waitId", value: summary.waitId },
		{ key: "listenerId", path: "data.listenerId", value: summary.listenerId },
	].filter((item) => item.value !== undefined && item.value !== null && item.value !== "");
	for (const item of correlationPaths.slice(0, 3)) actions.push(`browser_artifact path=${path} mode=json jsonPath=${item.path}`);
	return actions.length ? Array.from(new Set(actions)) : [`browser_artifact path=${path} mode=json|text`];
}

function normalizedNextActions(options: DistillBaseOptions, summary: DistilledSummary, saved?: Record<string, unknown>, operation?: Record<string, unknown>, snapshot?: Record<string, unknown>, summaryHintActions: string[] = []): string[] | undefined {
	const actions: string[] = [];
	actions.push(...summaryHintActions);
	actions.push(...artifactReadActions(summary, saved, operation, snapshot));
	if (summary.nextOffset !== undefined && summary.nextOffset !== null) actions.push(`browser_artifact offset=${String(summary.nextOffset)}`);
	if (summary.bodyUnavailableReason) actions.push("browser_network body with a fresh recorder entry or recapture with captureBodies enabled");
	if (summary.empty === true || summary.notFound === true) actions.push("narrow selector/jsonPath or re-observe with browser_observe mode=scan|html");
	if (summary.truncated === true || summary.bodyTruncated === true || summary.truncatedCases === true || summary.truncatedCandidates) actions.push("increase maxChars/maxBodyBytes or read the saved artifact by offset/jsonPath");
	if (options.browserSessionId === undefined && (summary.tabId !== undefined || isRecord(summary.target))) actions.push("pass explicit tabId/browserSessionId for follow-up tab-scoped calls");
	return actions.length ? Array.from(new Set(actions)).slice(0, 7) : undefined;
}

function sanitizeDistilledEnvelope(envelope: DistilledEnvelope): DistilledEnvelope {
	return redactSensitiveValue(envelope) as DistilledEnvelope;
}

function responseEnvelope(options: DistillBaseOptions, summary: DistilledSummary, saved?: Record<string, unknown>, sensitiveRaw = false): DistilledEnvelope {
	const rawBudget = Math.floor(Number(options.maxChars || SUMMARY_BUDGET_CHARS) * 0.7);
	const budget = Math.max(1_000, Math.min(SUMMARY_BUDGET_CHARS, rawBudget));
	const redactedSummary = redactSensitiveValue(summary) as DistilledSummary;
	const summaryHintActions = Array.isArray(redactedSummary.nextActions)
		? redactedSummary.nextActions.filter((item): item is string => typeof item === "string")
		: [];
	const summaryForFitting = { ...redactedSummary };
	delete summaryForFitting.nextActions;
	const fittedSummary = fitSummaryBudget(summaryForFitting, budget);
	const redactedOperation = options.operation ? redactSensitiveValue(options.operation) as Record<string, unknown> : undefined;
	const redactedSnapshot = options.snapshot ? redactSensitiveValue(options.snapshot) as Record<string, unknown> : undefined;
	const correlation = {
		...pickDefined(redactedSummary, ["requestId", "waitId", "listenerId", "sessionId", "browserSessionId", "selectionVersionAtDispatch", "selectionVersionAtResolve", "sourceMode"]),
		...pickDefined(redactedOperation || {}, ["operationId", "snapshotId", "sourceMode"]),
		...pickDefined(redactedSnapshot || {}, ["snapshotId", "sourceMode"]),
	};
	return sanitizeDistilledEnvelope({
		tool: options.toolName,
		command: options.command,
		browserSessionId: options.browserSessionId,
		detailLevel: normalizeDetailLevel(options.detailLevel),
		summary: fittedSummary,
		diagnostics: normalizedDiagnostics(fittedSummary, saved, redactedOperation, redactedSnapshot),
		target: normalizedTarget(options, fittedSummary),
		limits: normalizedLimits(options, fittedSummary),
		privacy: normalizedPrivacy(saved, sensitiveRaw),
		nextActions: normalizedNextActions(options, fittedSummary, saved, redactedOperation, redactedSnapshot, summaryHintActions),
		operation: redactedOperation,
		snapshot: redactedSnapshot,
		...(Object.keys(correlation).length ? { correlation } : {}),
		saved,
	});
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
	if (options.outputPath || sensitiveRaw || raw.length > threshold || (level === "summary" && raw.length > Math.min(threshold, 8_000))) saved = await saveRawArtifact(options, raw);
	if (level === "summary" || level === "preview") {
		let envelope = responseEnvelope(options, summary, saved, sensitiveRaw);
		if (!saved && stableJson(envelope).length > maxChars) {
			saved = await saveRawArtifact(options, raw);
			envelope = responseEnvelope(options, summary, saved, sensitiveRaw);
		}
		return jsonResult(envelope, { ...(options.details || {}), saved }, Math.min(maxChars, SUMMARY_MAX_CHARS));
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
	if (options.outputPath || sensitiveRaw || raw.length > threshold || (level === "summary" && raw.length > Math.min(threshold, 8_000))) saved = await saveRawArtifact(options, raw);
	if (level === "summary" || level === "preview") {
		let envelope = responseEnvelope(options, summary, saved, sensitiveRaw);
		if (!saved && stableJson(envelope).length > maxChars) {
			saved = await saveRawArtifact(options, raw);
			envelope = responseEnvelope(options, summary, saved, sensitiveRaw);
		}
		return jsonResult(envelope, { ...(options.details || {}), saved }, Math.min(maxChars, SUMMARY_MAX_CHARS));
	}
	if (level === "full" && (sensitiveRaw || text.length > maxChars)) {
		const fullSaved = saved || await saveRawArtifact(options, raw);
		return jsonResult(responseEnvelope(options, { ...summary, fullResult: "saved_to_artifact", ...(sensitiveRaw ? { privacy: { sensitiveEvidence: true } } : {}) }, fullSaved, sensitiveRaw), { ...(options.details || {}), saved: fullSaved }, Math.min(maxChars, SUMMARY_MAX_CHARS));
	}
	return textResult(text, { ...(options.details || {}), saved, summary }, maxChars);
}
