import { stableJson } from "../utils/json.js";

export function tokenEstimate(text: string): number {
	let tokens = 0;
	const len = text.length;
	for (let i = 0; i < len; i += 1) {
		const code = text.charCodeAt(i);
		if (code < 0x80) tokens += 0.25;
		else if (code > 0x2e7f) {
			tokens += 0.6;
			if (code >= 0xd800 && code <= 0xdbff) {
				const next = i + 1 < len ? text.charCodeAt(i + 1) : 0;
				if (next >= 0xdc00 && next <= 0xdfff) i += 1;
			}
		} else tokens += 0.4;
	}
	return Math.ceil(tokens);
}

export function jsonCost(value: unknown): number {
	return stableJson(value).length;
}
