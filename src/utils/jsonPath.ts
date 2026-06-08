export type JsonPathToken = string | number;

function parseJsonPathInternal(jsonPath: string | undefined): { tokens: JsonPathToken[]; invalid: boolean } {
	const text = String(jsonPath || "").trim();
	if (!text || text === "$") return { tokens: [], invalid: false };
	const normalized = text.startsWith("$.") ? text.slice(2) : text.startsWith("$") ? text.slice(1) : text;
	const tokens: JsonPathToken[] = [];
	let i = 0;
	while (i < normalized.length) {
		if (normalized[i] === ".") {
			i += 1;
			continue;
		}
		if (normalized[i] === "[") {
			const close = normalized.indexOf("]", i + 1);
			if (close < 0) return { tokens, invalid: true };
			const inner = normalized.slice(i + 1, close).trim();
			if (/^\d+$/.test(inner)) tokens.push(Number(inner));
			else if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
				const quote = inner[0];
				const body = inner.slice(1, -1);
				tokens.push(body.replace(new RegExp(`\\\\${quote}`, "g"), quote).replace(/\\\\/g, "\\"));
			} else if (inner.startsWith("'") || inner.startsWith('"') || inner.endsWith("'") || inner.endsWith('"')) {
				return { tokens, invalid: true };
			} else if (inner) {
				tokens.push(inner);
			}
			i = close + 1;
			continue;
		}
		let end = i;
		while (end < normalized.length && normalized[end] !== "." && normalized[end] !== "[") end += 1;
		const part = normalized.slice(i, end);
		if (part) tokens.push(part);
		i = end;
	}
	return { tokens, invalid: false };
}

export function parseJsonPath(jsonPath: string | undefined): JsonPathToken[] {
	return parseJsonPathInternal(jsonPath).tokens;
}

export function getJsonPath(value: unknown, jsonPath: string | undefined): { exists: boolean; value: unknown } {
	let current = value;
	const parsed = parseJsonPathInternal(jsonPath);
	if (parsed.invalid) return { exists: false, value: undefined };
	for (const token of parsed.tokens) {
		if (current === null || current === undefined || typeof current !== "object") return { exists: false, value: undefined };
		if (!Object.prototype.hasOwnProperty.call(current, token)) return { exists: false, value: undefined };
		current = (current as Record<string | number, unknown>)[token];
	}
	return { exists: true, value: current };
}
