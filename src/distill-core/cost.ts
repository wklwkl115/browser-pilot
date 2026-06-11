import { stableJson } from "../utils/json.js";

export function tokenEstimate(text: string): number {
	let tokens = 0;
	for (const ch of text) {
		const codePoint = ch.codePointAt(0) ?? 0;
		tokens += codePoint > 0x2e7f ? 0.6 : codePoint < 0x80 ? 0.25 : 0.4;
	}
	return Math.ceil(tokens);
}

export function jsonCost(value: unknown): number {
	return stableJson(value).length;
}
