export const SAFE_REGEX_DEFAULT_MAX_PATTERN_CHARS = 512;
export const SAFE_REGEX_DEFAULT_MAX_INPUT_CHARS = 8192;

export function unsafeRegexReason(pattern: unknown, maxPatternChars = SAFE_REGEX_DEFAULT_MAX_PATTERN_CHARS): string | undefined {
	const text = String(pattern || "");
	if (!text) return "empty_pattern";
	if (text.length > maxPatternChars) return "pattern_too_long";
	if (/\\(?:[1-9]|k[<'])/.test(text)) return "backreference";
	if (/\(\?[^:]/.test(text)) return "lookaround_or_special_group";
	if (/\([^)]*(?:[*+]|\{\d)[^)]*\)\s*(?:[*+?]|\{\d)/.test(text)) return "nested_quantifier";
	if (/\([^)]*\|[^)]*\)\s*(?:[*+?]|\{\d)/.test(text)) return "quantified_alternation";
	if ((text.match(/\.\*/g) || []).length > 6) return "too_many_wildcards";
	return undefined;
}
