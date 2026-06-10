import { RELEVANCE_TUNING } from "./relevanceTuning.js";
import type { RelevanceTapTerm } from "./relevanceTaps.js";

export type RelevanceSourceTag = "A" | "B" | "C" | "D" | "E";

export type RelevanceTerm = RelevanceTapTerm & {
	source: RelevanceSourceTag;
	age?: number;
};

export type RelevanceInput = {
	ref: string;
	fields?: {
		name?: string;
		role?: string;
		container?: string;
		landmark?: string;
		value?: string;
		selector?: string;
		href?: string;
	};
	neighbors?: {
		containerKey?: string;
		labelledBySources?: string[];
	};
};

export type RelevanceMatch = {
	score: number;
	sources: RelevanceSourceTag[];
};

export type RelevanceResult = {
	byRef: Map<string, RelevanceMatch>;
	boosted: number;
	signals: RelevanceSourceTag[];
	scoreFields: (fields: Record<string, unknown>) => number;
	sourcesForRef: (ref: string) => RelevanceSourceTag[];
};

type PreparedTerm = {
	needle: string;
	grams: string[];
	source: RelevanceSourceTag;
	kind: RelevanceTapTerm["kind"];
	weight: number;
};

type RelevanceAccumulator = {
	score: number;
	sources: RelevanceSourceTag[];
};

function normalizeText(value: unknown): string {
	return typeof value === "string" ? value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim() : "";
}

function cjkBigrams(value: string): string[] {
	const chars = Array.from(value.replace(/\s+/g, "")).filter((char) => /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char));
	const grams: string[] = [];
	for (let i = 0; i < chars.length - 1; i += 1) grams.push(`${chars[i]}${chars[i + 1]}`);
	return grams;
}

function sourceBase(term: RelevanceTerm): number {
	if (term.source === "C") return RELEVANCE_TUNING.intentMatch;
	if (term.source === "D") return RELEVANCE_TUNING.urlMatch;
	if (term.source === "E") return RELEVANCE_TUNING.intentMatch;
	return term.kind === "literal" && /[#.[]/.test(term.term) ? RELEVANCE_TUNING.selectorMatch : RELEVANCE_TUNING.directMatch;
}

function ageDecay(term: RelevanceTerm): number {
	const age = Math.max(0, Math.floor(term.age ?? 0));
	return age <= 0 ? 1 : Math.pow(0.5, age / RELEVANCE_TUNING.traceHalfLifeCalls);
}

function prepareTerms(terms: RelevanceTerm[]): PreparedTerm[] {
	const seen = new Set<string>();
	const out: PreparedTerm[] = [];
	for (const term of terms) {
		const needle = normalizeText(term.term);
		if (needle.length < 2) continue;
		const key = `${term.source}\u0000${term.kind}\u0000${needle}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			needle,
			grams: cjkBigrams(needle),
			source: term.source,
			kind: term.kind,
			weight: Math.max(0.1, term.weight ?? 1) * ageDecay(term),
		});
		if (out.length >= RELEVANCE_TUNING.maxTerms) break;
	}
	return out;
}

function fieldScore(value: unknown, term: PreparedTerm, fieldWeight: number): number {
	const haystack = normalizeText(value);
	if (!haystack) return 0;
	let matched = false;
	if (haystack.includes(term.needle) || term.needle.includes(haystack) && haystack.length >= 3) matched = true;
	else if (term.grams.length) matched = term.grams.some((gram) => haystack.includes(gram));
	if (!matched) return 0;
	const base = term.kind === "url" ? RELEVANCE_TUNING.urlMatch : sourceBase({ term: term.needle, kind: term.kind, source: term.source, weight: term.weight });
	return base * term.weight * fieldWeight;
}

function scoreInputFields(fields: Record<string, unknown>, terms: PreparedTerm[]): { score: number; sources: Set<RelevanceSourceTag> } {
	let score = 0;
	const sources = new Set<RelevanceSourceTag>();
	const weights = RELEVANCE_TUNING.fieldWeights;
	for (const term of terms) {
		const before = score;
		score += fieldScore(fields.name, term, weights.name);
		score += fieldScore(fields.role, term, weights.role);
		score += fieldScore(fields.container, term, weights.container);
		score += fieldScore(fields.landmark, term, weights.landmark);
		score += fieldScore(fields.value, term, weights.value);
		score += fieldScore(fields.selector, term, weights.selector);
		score += fieldScore(fields.href, term, weights.href);
		if (score > before) sources.add(term.source);
	}
	return { score: Math.min(RELEVANCE_TUNING.maxScore, Math.round(score)), sources };
}

function addRawMatch(map: Map<string, RelevanceAccumulator>, ref: string, score: number, sources: Iterable<RelevanceSourceTag>): void {
	if (score <= 0) return;
	const prev = map.get(ref);
	if (prev) {
		prev.score = Math.min(RELEVANCE_TUNING.maxScore, Math.round(prev.score + score));
		for (const source of sources) prev.sources.push(source);
		return;
	}
	map.set(ref, { score: Math.min(RELEVANCE_TUNING.maxScore, Math.round(score)), sources: Array.from(sources) });
}

function finalizeMatches(raw: Map<string, RelevanceAccumulator>): Map<string, RelevanceMatch> {
	const out = new Map<string, RelevanceMatch>();
	for (const [ref, match] of raw) {
		if (match.score <= 0) continue;
		out.set(ref, {
			score: match.score,
			sources: Array.from(new Set(match.sources)).sort() as RelevanceSourceTag[],
		});
	}
	return out;
}

export function computeRelevanceMap(inputs: RelevanceInput[], terms: RelevanceTerm[]): RelevanceResult {
	const prepared = prepareTerms(terms);
	const rawByRef = new Map<string, RelevanceAccumulator>();
	if (prepared.length) {
		const byContainer = new Map<string, string[]>();
		const containerBoosts = new Map<string, RelevanceAccumulator>();
		const scoredInputs: Array<{ input: RelevanceInput; score: number; sources: Set<RelevanceSourceTag> }> = [];
		for (const input of inputs) {
			const containerKey = input.neighbors?.containerKey;
			if (containerKey) {
				const list = byContainer.get(containerKey) ?? [];
				list.push(input.ref);
				byContainer.set(containerKey, list);
			}
			const scored = scoreInputFields(input.fields ?? {}, prepared);
			if (scored.score <= 0) continue;
			scoredInputs.push({ input, score: scored.score, sources: scored.sources });
			addRawMatch(rawByRef, input.ref, scored.score, scored.sources);
			if (containerKey) addRawMatch(containerBoosts, containerKey, scored.score * RELEVANCE_TUNING.containerPropagation, scored.sources);
		}
		for (const [containerKey, boost] of containerBoosts) {
			for (const ref of byContainer.get(containerKey) ?? []) addRawMatch(rawByRef, ref, boost.score, boost.sources);
		}
		for (const { input, score, sources } of scoredInputs) {
			for (const ref of input.neighbors?.labelledBySources ?? []) addRawMatch(rawByRef, ref, score * RELEVANCE_TUNING.relationPropagation, sources);
		}
	}
	const byRef = finalizeMatches(rawByRef);
	const signals = Array.from(new Set(Array.from(byRef.values()).flatMap((match) => match.sources))).sort() as RelevanceSourceTag[];
	return {
		byRef,
		boosted: Array.from(byRef.values()).filter((match) => match.score > 0).length,
		signals,
		scoreFields: (fields) => scoreInputFields(fields, prepared).score,
		sourcesForRef: (ref) => byRef.get(ref)?.sources ?? [],
	};
}
