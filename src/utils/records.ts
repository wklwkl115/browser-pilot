export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

export function toTabId(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isInteger(n) && n > 0 ? n : undefined;
}
