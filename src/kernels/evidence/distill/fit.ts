import { stableJson } from "../../../utils/json.js";
import { isRecord } from "../../../utils/records.js";

export type FittedInlineJson = { value: unknown; length: number };

export function jsonBudgetLength(value: unknown, spaces = 2): number {
	return (stableJson(value, spaces) ?? "").length;
}

export function fitInlineJsonToBudgetMeasured(result: unknown, maxChars: number): FittedInlineJson {
	const initialLength = jsonBudgetLength(result);
	if (!isRecord(result) || initialLength <= maxChars) return { value: result, length: initialLength };
	const payload = result.value;
	if (isRecord(payload) && payload.type === "array" && Array.isArray(payload.items) && payload.items.length > 1) {
		const original = payload.items.slice();
		const offset = Number(payload.offset ?? 0);
		const count = Number(payload.count ?? original.length);
		const applyArray = (n: number) => {
			payload.items = original.slice(0, n);
			payload.limit = n;
			payload.nextOffset = offset + n < count ? offset + n : null;
			payload.budgetTrimmed = n < original.length;
		};
		let lo = 1, hi = original.length, best = 1;
		let bestLength = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			applyArray(mid);
			const length = jsonBudgetLength(result);
			if (length <= maxChars) { best = mid; bestLength = length; lo = mid + 1; } else hi = mid - 1;
		}
		applyArray(best);
		if (bestLength < 0) bestLength = jsonBudgetLength(result);
		return { value: result, length: bestLength };
	}
	if (isRecord(payload) && payload.type !== "array") {
		const keys = Object.keys(payload).filter((k) => k !== "truncatedKeys");
		if (keys.length <= 1) return { value: result, length: initialLength };
		const applyKeys = (k: number) => {
			const reduced: Record<string, unknown> = {};
			for (const key of keys.slice(0, k)) reduced[key] = payload[key];
			if (k < keys.length) reduced.truncatedKeys = keys.length - k;
			result.value = reduced;
		};
		let lo = 1, hi = keys.length, best = 1;
		let bestLength = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			applyKeys(mid);
			const length = jsonBudgetLength(result);
			if (length <= maxChars) { best = mid; bestLength = length; lo = mid + 1; } else hi = mid - 1;
		}
		applyKeys(best);
		if (bestLength < 0) bestLength = jsonBudgetLength(result);
		return { value: result, length: bestLength };
	}
	return { value: result, length: initialLength };
}

export function fitInlineJsonToBudget(result: unknown, maxChars: number): unknown {
	return fitInlineJsonToBudgetMeasured(result, maxChars).value;
}
