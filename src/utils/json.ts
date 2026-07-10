const DEFAULT_MAX_CHARS = 50_000;

export function tryJson(text: string): unknown | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function parseJsonOrThrow<T = unknown>(text: string, context: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

function stableJsonWithReplacer(value: unknown, spaces = 2): string {
	const ancestors: unknown[] = [];
	return JSON.stringify(value, function (this: unknown, _key, item) {
		if (typeof item === "bigint") return item.toString();
		if (item instanceof Error) return { name: item.name, message: item.message };
		if (item === null || typeof item !== "object") return item;
		while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
		if (ancestors.includes(item)) return "[Circular]";
		ancestors.push(item);
		return item;
	}, spaces);
}

export function stableJson(value: unknown, spaces = 2): string {
	if (value === null || (typeof value !== "object" && typeof value !== "bigint")) return JSON.stringify(value, undefined, spaces) as string;
	return stableJsonWithReplacer(value, spaces);
}

export function truncateText(text: string, maxChars = DEFAULT_MAX_CHARS): { text: string; truncated: boolean; originalLength: number } {
	const originalLength = text.length;
	if (originalLength <= maxChars) return { text, truncated: false, originalLength };
	const head = Math.max(0, Math.floor(maxChars * 0.7));
	const tail = Math.max(0, maxChars - head);
	return {
		text: `${text.slice(0, head)}\n\n[truncated ${originalLength - maxChars} chars]\n\n${text.slice(originalLength - tail)}`,
		truncated: true,
		originalLength,
	};
}

export function jsonPreview(value: unknown, maxChars = DEFAULT_MAX_CHARS): { text: string; truncated: boolean; originalLength: number } {
	return truncateText(stableJson(value), maxChars);
}
