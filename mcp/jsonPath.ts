export function parseJsonPath(jsonPath: string): Array<string | number> {
	const text = jsonPath.trim();
	if (!text || text === "$") return [];
	const normalized = text.startsWith("$.") ? text.slice(2) : text.startsWith("$") ? text.slice(1) : text;
	const tokens: Array<string | number> = [];
	for (const part of normalized.split(".")) {
		if (!part) continue;
		const re = /([^[]+)|\[(\d+)\]/g;
		let match: RegExpExecArray | null;
		while ((match = re.exec(part))) tokens.push(match[1] !== undefined ? match[1] : Number(match[2]));
	}
	return tokens;
}

export function getJsonPath(value: unknown, jsonPath: string | undefined): { exists: boolean; value: unknown } {
	let current = value;
	for (const token of parseJsonPath(jsonPath || "$")) {
		if (current === null || current === undefined || typeof current !== "object") return { exists: false, value: undefined };
		if (!Object.prototype.hasOwnProperty.call(current, token)) return { exists: false, value: undefined };
		current = (current as Record<string | number, unknown>)[token];
	}
	return { exists: true, value: current };
}
