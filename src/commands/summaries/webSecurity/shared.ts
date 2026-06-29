import { asArray, increment, isRecord, summaryTable, textPreview, topCounts, type Summary } from "../common.js";
import { redactSensitiveText as redactCommonSensitiveText, redactSensitiveValue } from "../../../utils/redaction.js";

export { asArray, increment, isRecord, summaryTable, textPreview, topCounts, type Summary };

export function resultItems(value: unknown): Record<string, unknown>[] {
	if (!isRecord(value)) return [];
	return asArray(value.results).filter(isRecord);
}

export function hostOf(value: unknown): string {
	try { return new URL(String(value || "")).host || "unknown"; } catch { return "unknown"; }
}

export function techPreview(value: unknown): string {
	return Array.isArray(value) ? value.slice(0, 4).join(", ") : "";
}

export function fingerprintPreview(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value.slice(0, 4).map((item) => isRecord(item) ? item.label : item).filter(Boolean).join(", ");
}

export function redactSensitiveText(text: string): string {
	return redactCommonSensitiveText(text);
}

export function redactSensitiveSummaryValue<T>(value: T): T {
	return redactSensitiveValue(value) as T;
}

export function redactSensitiveSummaryTextValue(value: unknown): unknown {
	return typeof value === "string" ? redactSensitiveText(value) : redactSensitiveValue(value);
}

export function bodyPreview(body: unknown): string {
	return isRecord(body) && typeof body.text === "string" ? textPreview(redactSensitiveText(body.text), 220) : "";
}

export function bridgeArtifacts(value: unknown, runs: Record<string, unknown>[]): Record<string, unknown>[] {
	const topLevel = isRecord(value) ? asArray(value.artifacts).filter(isRecord) : [];
	if (topLevel.length) return topLevel;
	return runs.flatMap((run) => asArray(run.artifacts).filter(isRecord));
}

export function artifactPath(value: unknown): unknown {
	return isRecord(value) ? value.path : undefined;
}
