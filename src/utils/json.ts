const DEFAULT_MAX_CHARS = 50_000;

export function stableJson(value: unknown, spaces = 2): string {
	return JSON.stringify(value, (_key, item) => {
		if (typeof item === "bigint") return item.toString();
		if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
		return item;
	}, spaces);
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
