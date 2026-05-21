import { stableJson } from "../utils/json";
import { normalizeDetailLevel, type DetailLevel } from "../utils/params";
import { jsonResult, textResult, type PiTextToolResult } from "../utils/toolResult";
import { containsSensitiveEvidence, redactSensitiveValue } from "./artifactPrivacy";
import { saveTextArtifact } from "./artifacts";
import { isRecord } from "./summaries/common";
import { summarizeEvidenceData, summarizeGenericValue, summarizeHtmlSnapshot, summarizeNetworkData, summarizeOrchestrationData, summarizeScanData } from "./summaries/index";

export { summarizeEvidenceData, summarizeGenericValue, summarizeHtmlSnapshot, summarizeNetworkData, summarizeOrchestrationData, summarizeScanData } from "./summaries/index";

export type DistilledSummary = Record<string, unknown>;
export type DistilledEnvelope = {
	tool: string;
	command?: string;
	detailLevel: DetailLevel;
	summary: DistilledSummary;
	saved?: Record<string, unknown>;
};

const SUMMARY_MAX_CHARS = 12_000;
const SUMMARY_BUDGET_CHARS = 8_000;
const SUMMARY_LOW_PRIORITY_KEYS = new Set(["textPreview", "interactive", "headings", "samples", "failed", "nodes", "matches", "selections", "frames", "iframe_notes"]);

type DistillBaseOptions = {
	toolName: string;
	command?: string;
	detailLevel?: unknown;
	maxChars: number;
	ctx?: { cwd?: string };
	outputPath?: string;
	fallbackName: string;
	details?: Record<string, unknown>;
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

export function distillValue(toolName: string, command: string | undefined, value: unknown): Record<string, unknown> {
	if (toolName === "browser_evidence" || command === "evidence.collect") return summarizeEvidenceData(isRecord(value) && value.data !== undefined ? value.data : value);
	if (toolName === "browser_network" || String(command || "").startsWith("network.")) return summarizeNetworkData(isRecord(value) && value.data !== undefined ? value.data : value);
	if (toolName === "browser_orchestrate" || String(command || "").startsWith("orchestration.")) return summarizeOrchestrationData(isRecord(value) && value.data !== undefined ? value.data : value);
	return summarizeGenericValue(value);
}

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
	return dropLowPrioritySummaryFields(compactSummaryValue(summary, { stringChars: 120, arrayItems: 5, tableRows: 5 }) as DistilledSummary, budget);
}

function responseEnvelope(options: DistillBaseOptions, summary: DistilledSummary, saved?: Record<string, unknown>): DistilledEnvelope {
	const rawBudget = Math.floor(Number(options.maxChars || SUMMARY_BUDGET_CHARS) * 0.7);
	const budget = Math.max(1_000, Math.min(SUMMARY_BUDGET_CHARS, rawBudget));
	return { tool: options.toolName, command: options.command, detailLevel: normalizeDetailLevel(options.detailLevel), summary: fitSummaryBudget(redactSensitiveValue(summary) as DistilledSummary, budget), saved };
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
		let envelope = responseEnvelope(options, summary, saved);
		if (!saved && stableJson(envelope).length > maxChars) {
			saved = await saveRawArtifact(options, raw);
			envelope = responseEnvelope(options, summary, saved);
		}
		return jsonResult(envelope, { ...(options.details || {}), saved }, Math.min(maxChars, SUMMARY_MAX_CHARS));
	}
	if (level === "full" && (sensitiveRaw || raw.length > maxChars)) {
		const fullSaved = saved || await saveRawArtifact(options, raw);
		return jsonResult(responseEnvelope(options, { ...summary, fullResult: "saved_to_artifact", ...(sensitiveRaw ? { privacy: { sensitiveEvidence: true } } : {}) }, fullSaved), { ...(options.details || {}), saved: fullSaved }, Math.min(maxChars, SUMMARY_MAX_CHARS));
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
		let envelope = responseEnvelope(options, summary, saved);
		if (!saved && stableJson(envelope).length > maxChars) {
			saved = await saveRawArtifact(options, raw);
			envelope = responseEnvelope(options, summary, saved);
		}
		return jsonResult(envelope, { ...(options.details || {}), saved }, Math.min(maxChars, SUMMARY_MAX_CHARS));
	}
	if (level === "full" && (sensitiveRaw || text.length > maxChars)) {
		const fullSaved = saved || await saveRawArtifact(options, raw);
		return jsonResult(responseEnvelope(options, { ...summary, fullResult: "saved_to_artifact", ...(sensitiveRaw ? { privacy: { sensitiveEvidence: true } } : {}) }, fullSaved), { ...(options.details || {}), saved: fullSaved }, Math.min(maxChars, SUMMARY_MAX_CHARS));
	}
	return textResult(text, { ...(options.details || {}), saved, summary }, maxChars);
}
