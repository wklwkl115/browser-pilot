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

export type ArtifactHintRead = { label: string; jsonPath: string; kind?: string; count?: number };
export type ArtifactHints = {
	artifact_hints: {
		jsonPaths: Record<string, string>;
		preferredReads: Array<{ label: string; jsonPath: string; kind?: string; count?: number }>;
	};
};

/**
 * Build the `artifact_hints` summary field — the single source of truth for which
 * sub-collections of the RAW saved artifact are worth reading on demand. Pi's
 * artifactReadActions() already consumes preferredReads to generate targeted
 * `browser_artifact ... jsonPath=` nextActions; the MCP adapter consumes the same
 * to register Layer-1 section sub-resources. jsonPaths are addressed against the
 * raw saved artifact (which is flat — the distiller input keys sit at top level).
 * Returns `undefined` when there are no resolvable sections (caller spreads nothing).
 */
export function artifactHints(reads: ArtifactHintRead[]): ArtifactHints | Record<string, never> {
	const usable = reads.filter((r) => r.jsonPath);
	if (!usable.length) return {};
	const jsonPaths: Record<string, string> = {};
	for (const r of usable) jsonPaths[r.label] = r.jsonPath;
	return {
		artifact_hints: {
			jsonPaths,
			preferredReads: usable.map((r) => ({ label: r.label, jsonPath: r.jsonPath, ...(r.kind ? { kind: r.kind } : {}), ...(r.count != null ? { count: r.count } : {}) })),
		},
	};
}
