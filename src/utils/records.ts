export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function recordValue<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown): T | undefined {
	return isRecord(value) ? value as T : undefined;
}

export function toTabId(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isInteger(n) && n > 0 ? n : undefined;
}
