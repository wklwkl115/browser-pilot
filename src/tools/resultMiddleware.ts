import { stableJson } from "../utils/json";
import { normalizeDetailLevel, type DetailLevel } from "../utils/params";
import { jsonResult, textResult, type PiTextToolResult } from "../utils/toolResult";
import { saveTextArtifact } from "./artifacts";
import { isRecord } from "./summaries/common";
import { summarizeElementActionData, summarizeEvidenceData, summarizeGenericValue, summarizeHtmlSnapshot, summarizeNetworkData, summarizeScanData } from "./summaries/index";

export { summarizeElementActionData, summarizeEvidenceData, summarizeGenericValue, summarizeHtmlSnapshot, summarizeNetworkData, summarizeScanData } from "./summaries/index";

export type DistilledSummary = Record<string, unknown>;
export type DistilledEnvelope = {
	tool: string;
	command?: string;
	detailLevel: DetailLevel;
	summary: DistilledSummary;
	saved?: Record<string, unknown>;
};

const SUMMARY_MAX_CHARS = 12_000;

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
};

export function distillValue(toolName: string, command: string | undefined, value: unknown): Record<string, unknown> {
	if (toolName === "browser_evidence" || command === "evidence.collect") return summarizeEvidenceData(isRecord(value) && value.data !== undefined ? value.data : value);
	if (toolName === "browser_network" || String(command || "").startsWith("network.")) return summarizeNetworkData(isRecord(value) && value.data !== undefined ? value.data : value);
	if (toolName === "browser_query" || toolName === "browser_click" || toolName === "browser_type") return summarizeElementActionData(isRecord(value) && value.data !== undefined ? value.data : value);
	return summarizeGenericValue(value);
}

async function saveRawArtifact(options: DistillBaseOptions, raw: string): Promise<Record<string, unknown> | undefined> {
	return await saveTextArtifact(options.ctx, options.outputPath, options.fallbackName, raw);
}

function responseEnvelope(options: DistillBaseOptions, summary: DistilledSummary, saved?: Record<string, unknown>): DistilledEnvelope {
	return { tool: options.toolName, command: options.command, detailLevel: normalizeDetailLevel(options.detailLevel), summary, saved };
}

export async function distilledJsonResult(value: unknown, options: DistilledJsonOptions): Promise<PiTextToolResult> {
	const level = normalizeDetailLevel(options.detailLevel);
	const maxChars = Math.max(1, Math.floor(options.maxChars));
	const rawValue = options.artifactValue ?? value;
	const raw = stableJson(rawValue);
	const summary = options.distill ? options.distill(value) : distillValue(options.toolName, options.command, value);
	const threshold = Math.max(1, options.artifactThreshold ?? maxChars);
	let saved: Record<string, unknown> | undefined;
	if (options.outputPath || raw.length > threshold || (level === "summary" && raw.length > Math.min(threshold, 8_000))) saved = await saveRawArtifact(options, raw);
	if (level === "summary") return jsonResult(responseEnvelope(options, summary, saved), { ...(options.details || {}), saved }, Math.min(maxChars, SUMMARY_MAX_CHARS));
	if (level === "full" && raw.length > maxChars) {
		const fullSaved = saved || await saveRawArtifact(options, raw);
		return jsonResult(responseEnvelope(options, { ...summary, fullResult: "saved_to_artifact" }, fullSaved), { ...(options.details || {}), saved: fullSaved }, Math.min(maxChars, SUMMARY_MAX_CHARS));
	}
	return jsonResult(value, { ...(options.details || {}), saved, summary }, maxChars);
}

export async function distilledTextResult(text: string, options: DistilledTextOptions): Promise<PiTextToolResult> {
	const level = normalizeDetailLevel(options.detailLevel);
	const maxChars = Math.max(1, Math.floor(options.maxChars));
	const summary = options.summary || options.distill?.(text) || summarizeHtmlSnapshot(text);
	const threshold = Math.max(1, options.artifactThreshold ?? maxChars);
	let saved: Record<string, unknown> | undefined;
	if (options.outputPath || text.length > threshold || (level === "summary" && text.length > Math.min(threshold, 8_000))) saved = await saveRawArtifact(options, text);
	if (level === "summary") return jsonResult(responseEnvelope(options, summary, saved), { ...(options.details || {}), saved }, Math.min(maxChars, SUMMARY_MAX_CHARS));
	if (level === "full" && text.length > maxChars) {
		const fullSaved = saved || await saveRawArtifact(options, text);
		return jsonResult(responseEnvelope(options, { ...summary, fullResult: "saved_to_artifact" }, fullSaved), { ...(options.details || {}), saved: fullSaved }, Math.min(maxChars, SUMMARY_MAX_CHARS));
	}
	return textResult(text, { ...(options.details || {}), saved, summary }, maxChars);
}
