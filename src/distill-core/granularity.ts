export type CompactLimits = { stringChars: number; arrayItems: number; tableRows: number };

function cleanLineText(value: unknown, maxChars: number): string | undefined {
	const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : undefined;
	if (!text) return undefined;
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function lineEncodeEntity(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const ref = cleanLineText(record.ref, 120);
	if (!ref) return undefined;
	const parts = [
		ref,
		cleanLineText(record.kind, 24),
		cleanLineText(record.role, 32),
		cleanLineText(record.name ?? record.label, 96),
	].filter((item): item is string => !!item);
	return parts.join(" | ");
}

export function compactSummaryValue(value: unknown, limits: CompactLimits, depth = 0): unknown {
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
