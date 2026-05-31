import { truncateText } from "../../utils/json.js";

export type Summary = Record<string, unknown>;
export type CountItem = { key: string; count: number };
export type SummaryTable = { columns: string[]; rows: unknown[][]; count: number; truncated?: number };
export type SummaryColumn<T> = { key: string; value: (item: T) => unknown };

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

export function summaryTable<T>(items: T[], columns: SummaryColumn<T>[], limit = 20): SummaryTable {
	const rows = items.slice(0, limit).map((item) => columns.map((column) => column.value(item)));
	const table: SummaryTable = { columns: columns.map((column) => column.key), rows, count: items.length };
	if (items.length > rows.length) table.truncated = items.length - rows.length;
	return table;
}
