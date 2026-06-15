import { stableJson } from "../../../utils/json.js";
import { isRecord } from "../../../utils/records.js";
import { compactEntityRenderingValue, compactSummaryValue } from "./granularity.js";
import { fitEnvelopeBudget, type BudgetedEnvelope } from "./ladder.js";
import { FACT_GRANULARITY_ORDER, type FactGranularity } from "./fact.js";
import { extractRefsFromText } from "../../refs/index.js";

const LIFTED_KEYS = ["snapshotProjection", "collections", "causal", "diff", "treeDiff", "relations", "gist", "outline", "entities"] as const;
const REQUIRED_CONTINUITY_KEYS = ["snapshotProjection", "collections", "diff", "treeDiff"] as const;
const MIN_MARGINAL_DENSITY = 0.12;
const MAX_SALIENCE_TO_LADDER_RATIO = 1.05;
const STRUCTURE_SCORE: Record<(typeof LIFTED_KEYS)[number], number> = {
	snapshotProjection: 950,
	collections: 930,
	causal: 900,
	diff: 850,
	treeDiff: 820,
	relations: 650,
	gist: 600,
	outline: 520,
	entities: 500,
};

type Candidate = {
	key: (typeof LIFTED_KEYS)[number];
	granularity: "full" | "compact";
	value: unknown;
	text: string;
	cost: number;
	score: number;
};

export type SalienceEnvelopeOptions = {
	granularityCeiling?: Exclude<FactGranularity, "omit">;
};

function allowedByCeiling(granularity: Candidate["granularity"], ceiling?: Exclude<FactGranularity, "omit">): boolean {
	if (!ceiling) return true;
	return FACT_GRANULARITY_ORDER.indexOf(granularity) >= FACT_GRANULARITY_ORDER.indexOf(ceiling);
}

function referencedBrowserPilotRefs(envelope: BudgetedEnvelope): Set<string> {
	const refs = new Set<string>();
	const actions = envelope["nextActions"];
	for (const action of Array.isArray(actions) ? actions : []) {
		if (typeof action !== "string") continue;
		for (const ref of extractRefsFromText(action)) refs.add(ref);
	}
	return refs;
}

function compactEntity(entity: Record<string, unknown>): Record<string, unknown> {
	const compact = compactEntityRenderingValue(entity);
	return Object.keys(compact).length ? compact : compactSummaryValue(entity, { stringChars: 80, arrayItems: 2, tableRows: 2 }) as Record<string, unknown>;
}

function compactEntities(value: unknown, envelope: BudgetedEnvelope): unknown {
	if (!Array.isArray(value)) return compactSummaryValue(value, { stringChars: 160, arrayItems: 6, tableRows: 6 });
	const records = value.filter(isRecord);
	const refs = referencedBrowserPilotRefs(envelope);
	const targeted = refs.size ? records.filter((entity) => typeof entity.ref === "string" && refs.has(entity.ref)) : [];
	const rest = records.filter((entity) => !(typeof entity.ref === "string" && refs.has(entity.ref)));
	return [...targeted, ...rest].slice(0, targeted.length ? Math.min(6, Math.max(1, targeted.length)) : 6).map((entity) => compactEntity(entity));
}

function compactLiftedValue(key: string, value: unknown, envelope: BudgetedEnvelope): unknown {
	if (key === "entities") return compactEntities(value, envelope);
	if (key === "relations" && isRecord(value)) return { ...(isRecord(value.summary) ? { summary: value.summary } : {}) };
	return compactSummaryValue(value, { stringChars: 160, arrayItems: 6, tableRows: 6 });
}

function markOmitted<T extends BudgetedEnvelope>(envelope: T, omitted: string[]): T {
	if (!omitted.length) return envelope;
	const unique = Array.from(new Set(omitted));
	const diagnostics = isRecord(envelope.diagnostics) ? { ...envelope.diagnostics } : {};
	const warnings = Array.isArray(diagnostics.warnings) ? diagnostics.warnings.filter((item): item is string => typeof item === "string") : [];
	diagnostics.warnings = Array.from(new Set([...warnings, `salience_omitted:${unique.join(",")}`]));
	return {
		...envelope,
		summary: { ...envelope.summary, rendererOmitted: unique },
		diagnostics,
	};
}

function countTruncationMarkersInText(text: string): number {
	return (text.match(/truncated|omitted|…|\.\.\./gi) || []).length;
}

export function countDistillTruncationMarkers(value: unknown): number {
	return countTruncationMarkersInText(stableJson(value));
}

function acceptedCandidate<T extends BudgetedEnvelope>(salience: T, ladder: T, salienceText?: string, ladderText?: string): T {
	for (const key of REQUIRED_CONTINUITY_KEYS) {
		if (salience[key] === undefined && ladder[key] !== undefined) return ladder;
	}
	const resolvedSalienceText = salienceText ?? stableJson(salience);
	const resolvedLadderText = ladderText ?? stableJson(ladder);
	if (resolvedSalienceText.length > Math.ceil(resolvedLadderText.length * MAX_SALIENCE_TO_LADDER_RATIO)) return ladder;
	if (countTruncationMarkersInText(resolvedSalienceText) > countTruncationMarkersInText(resolvedLadderText)) return ladder;
	return salience;
}

export function fitSalienceEnvelopeBudget<T extends BudgetedEnvelope>(envelope: T, maxChars: number, options: SalienceEnvelopeOptions = {}): T {
	const budget = Math.max(1_000, Math.floor(maxChars));
	const envelopeText = stableJson(envelope);
	if (envelopeText.length <= budget) return envelope;
	let ladder: T | undefined;
	let ladderText: string | undefined;
	const fallbackLadder = (): T => {
		if (!ladder) {
			ladder = fitEnvelopeBudget(envelope, maxChars);
			ladderText = stableJson(ladder);
		}
		return ladder;
	};
	let out: T = { ...envelope };
	for (const key of LIFTED_KEYS) delete out[key];
	const baseText = stableJson(out);
	const baseCost = baseText.length;
	if (baseCost >= budget) return fallbackLadder();

	const chosen = new Set<string>();
	let spent = baseCost;
	const omitted: string[] = [];
	const candidates: Candidate[] = [];
	for (const key of LIFTED_KEYS) {
		const value = envelope[key];
		if (value === undefined) continue;
		const fullText = stableJson(value);
		const fullCost = fullText.length;
		if (allowedByCeiling("full", options.granularityCeiling)) candidates.push({ key, granularity: "full", value, text: fullText, cost: fullCost, score: STRUCTURE_SCORE[key] });
		const compact = compactLiftedValue(key, value, envelope);
		const compactText = stableJson(compact);
		const compactCost = compactText.length;
		if (compactCost < fullCost && allowedByCeiling("compact", options.granularityCeiling)) candidates.push({ key, granularity: "compact", value: compact, text: compactText, cost: compactCost, score: Math.floor(STRUCTURE_SCORE[key] * 0.75) });
	}
	for (const candidate of candidates.sort((a, b) => b.score / Math.max(1, b.cost) - a.score / Math.max(1, a.cost) || b.score - a.score)) {
		if (chosen.has(candidate.key)) continue;
		const density = candidate.score / Math.max(1, candidate.cost);
		if (density < MIN_MARGINAL_DENSITY) break;
		if (spent + candidate.cost > budget) continue;
		out = { ...out, [candidate.key]: candidate.value };
		spent += candidate.cost;
		chosen.add(candidate.key);
	}
	for (const key of LIFTED_KEYS) if (envelope[key] !== undefined && !chosen.has(key)) omitted.push(key);
	out = markOmitted(out, omitted);
	const outText = stableJson(out);
	const fitted = outText.length <= budget ? out : fitEnvelopeBudget(out, maxChars);
	const fittedText = fitted === out ? outText : stableJson(fitted);
	return acceptedCandidate(fitted, fallbackLadder(), fittedText, ladderText);
}
