import { truncateText } from "../../utils/json";

export type Summary = Record<string, unknown>;
export type CountItem = { key: string; count: number };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function increment(map: Record<string, number>, key: unknown) {
	const normalized = String(key || "unknown");
	map[normalized] = (map[normalized] || 0) + 1;
}

export function topCounts(map: Record<string, number>, limit = 10): CountItem[] {
	return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, count]) => ({ key, count }));
}

export function textPreview(text: string, maxChars: number): string {
	return truncateText(text.replace(/\s+/g, " ").trim(), maxChars).text;
}
