export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function firstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
	for (const key of keys) if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
	return undefined;
}

export function pickDefined(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		const value = record[key];
		if (value !== undefined && value !== null && value !== "") out[key] = value;
	}
	return out;
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

export function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text || undefined;
}

export function finiteNumber(value: unknown): number | undefined {
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}

export function toTabId(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isInteger(n) && n > 0 ? n : undefined;
}
