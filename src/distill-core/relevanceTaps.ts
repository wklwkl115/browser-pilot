export type RelevanceTapKind = "literal" | "selectorLiteral" | "jsonPath" | "query" | "urlPathToken" | "urlQueryToken" | "ref" | "intent";

export type RelevanceTapTerm = {
	term: string;
	kind: RelevanceTapKind;
	weight?: number;
};

const STRING_LITERAL_RE = /(["'`])((?:\\.|(?!\1)[^\\]){3,256})\1/g;
const WORDISH_RE = /[\p{L}\p{N}_#.[\]/?=&:-]/u;
const MAX_LITERAL_TERMS = 8;

function cleanTerm(value: unknown, max = 96): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\\[nrt]/g, " ").replace(/\s+/g, " ").trim();
	if (text.length < 3 || text.length > 256) return undefined;
	if (!WORDISH_RE.test(text)) return undefined;
	return text.length > max ? text.slice(0, max) : text;
}

function isSelectorShaped(value: string): boolean {
	return /[#.[]/.test(value) || /^(button|input|select|textarea|a|form|main|nav|section)\b/i.test(value);
}

export function dedupeTapTerms(terms: RelevanceTapTerm[], limit = MAX_LITERAL_TERMS): RelevanceTapTerm[] {
	const seen = new Set<string>();
	const out: RelevanceTapTerm[] = [];
	for (const term of terms) {
		const cleaned = cleanTerm(term.term);
		if (!cleaned) continue;
		const key = `${term.kind}\u0000${cleaned.toLocaleLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ ...term, term: cleaned });
		if (out.length >= limit) break;
	}
	return out;
}

export function extractStringLiteralTerms(script: unknown): RelevanceTapTerm[] {
	if (typeof script !== "string" || !script) return [];
	const matches: RelevanceTapTerm[] = [];
	let match: RegExpExecArray | null;
	while ((match = STRING_LITERAL_RE.exec(script)) !== null) {
		const term = cleanTerm(match[2], 64);
		if (!term) continue;
		matches.push({ term, kind: "literal", weight: isSelectorShaped(term) ? 1.4 : 1 });
	}
	return dedupeTapTerms(matches, MAX_LITERAL_TERMS);
}

export function extractScalarTerm(value: unknown, kind: RelevanceTapKind, weight = 1): RelevanceTapTerm[] {
	const term = cleanTerm(value, 96);
	return term ? [{ term, kind, weight }] : [];
}

export function extractUrlTerms(value: unknown): RelevanceTapTerm[] {
	if (typeof value !== "string" || !value) return [];
	try {
		const url = new URL(value, "https://local.invalid/");
		const terms: RelevanceTapTerm[] = [];
		for (const part of url.pathname.split(/[/%._-]+/)) terms.push(...extractScalarTerm(part, "urlPathToken", 1.15));
		for (const [, item] of url.searchParams) terms.push(...extractScalarTerm(item, "urlQueryToken", 1.1));
		return dedupeTapTerms(terms, 10);
	} catch {
		return extractScalarTerm(value, "urlPathToken", 1);
	}
}
