export function sanitizeSemanticText(value: unknown, maxChars = 160): string | undefined {
	if (typeof value !== "string") return undefined;
	const raw = value.trim();
	if (!raw) return undefined;
	const stripped = raw.replace(/<[^>]*>/g, " ").replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi, " ").replace(/\s+/g, " ").trim();
	if (!stripped) return undefined;
	if (looksLikeUnsafeSemantic(raw, stripped)) return undefined;
	return stripped.length > maxChars ? `${stripped.slice(0, maxChars)}…` : stripped;
}

export function firstSafeSemanticText(values: unknown[], maxChars = 160): string | undefined {
	for (const value of values) {
		const text = sanitizeSemanticText(value, maxChars);
		if (text) return text;
	}
	return undefined;
}

export function isItemLikePreview(value: unknown): boolean {
	const text = sanitizeSemanticText(value, 1_000);
	if (!text) return false;
	const lower = text.toLowerCase();
	const words = text.split(/\s+/).filter(Boolean);
	const separators = (text.match(/[|•·,;:：，；、]/g) || []).length;
	const moneyTokens = (text.match(/(?:[$€£¥￥]\s*\d|\d+(?:\.\d+)?\s*(?:usd|eur|gbp|cny|rmb|元|美元|人民币)|(?:input|output|cache|token|price|billing|per\s+1m|pricing|计费|价格|输入|输出|缓存|倍率))/gi) || []).length;
	const keyValueTokens = (text.match(/[\p{L}\p{N}][\p{L}\p{N}\s_-]{0,24}[:：=]\s*[^:：=|,;，；]{1,40}/gu) || []).length;
	const metricTokens = (text.match(/\b\d+(?:\.\d+)?\s*(?:x|倍|k|m|b|ms|s|gb|mb|tb|tokens?|req(?:uest)?s?)\b/gi) || []).length;
	const fieldWords = (lower.match(/\b(?:input|output|cache|cached|context|price|rate|billing|plan|model|request|token|usage|free|pro|enterprise)\b/g) || []).length;
	const cjkFieldWords = (text.match(/(?:输入|输出|缓存|价格|计费|模型|倍率|上下文|请求|额度|套餐|供应商|话题|用户|时间)/g) || []).length;
	if (text.length > 96) return true;
	if (words.length >= 14) return true;
	if (moneyTokens >= 2 || keyValueTokens >= 2 || metricTokens >= 3) return true;
	if ((moneyTokens || metricTokens) && (fieldWords + cjkFieldWords >= 2 || separators >= 2)) return true;
	if (fieldWords + cjkFieldWords >= 4 && separators >= 2) return true;
	return false;
}

export function safeContainerLabelText(value: unknown, maxChars = 80): string | undefined {
	const text = sanitizeSemanticText(value, maxChars);
	if (!text) return undefined;
	if (isItemLikePreview(text)) return undefined;
	const words = text.split(/\s+/).filter(Boolean);
	if (text.length > maxChars || words.length > 8) return undefined;
	return text;
}

function looksLikeUnsafeSemantic(raw: string, stripped: string): boolean {
	const text = stripped.trim();
	const lower = text.toLowerCase();
	const rawLower = raw.toLowerCase();
	if (!text) return true;
	if (/^<\/?(?:svg|path|g|use|polygon|polyline|circle|rect|ellipse|line|defs|clipPath|mask)\b/i.test(raw.trim())) return true;
	if (/^<[^>]+>$/.test(raw.trim()) && raw.replace(/<[^>]*>/g, "").trim().length === 0) return true;
	if (/^(?:[.#][A-Za-z0-9_-]+|[A-Za-z][\w-]*(?:[#.:[\]-]|\s*[>+~]\s*)+)$/.test(text)) return true;
	if (/^(?:div|span|button|a|input|svg|path|g|use|ul|li|section|article|nav|main)(?:[.#:[\]\w-]|\s*[>+~]\s*)+$/i.test(text)) return true;
	if (/^[MmZzLlHhVvCcSsQqTtAa][\d\s,.-]+$/.test(text) && /\d/.test(text)) return true;
	if (/^(?:d|viewbox|xmlns|fill|stroke|clip-rule|fill-rule|evenodd|currentcolor|none|true|false|null|undefined)$/i.test(text)) return true;
	if (/^(?:[a-f0-9]{12,}|[a-z0-9_-]{24,})$/i.test(text) && !/[\s]/.test(text)) return true;
	if (rawLower.includes("<path") || rawLower.includes("<svg")) return text.length <= 2 || /^[\d\s,.;:-]+$/.test(text);
	if (/^[{}()[\].,:;#>+~*="'`/\\|-]+$/.test(text)) return true;
	if (lower === "path" || lower === "svg") return true;
	return false;
}
