import { isRecord, toTabId } from "./records.js";

export function asPositiveInt(value: unknown, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.ceil(n) : fallback;
}

export { isRecord };

export function normalizeTabId(value: unknown): number | undefined {
	return toTabId(value);
}
