import { stableJson } from "../utils/json.js";
import { isRecord } from "../utils/records.js";
import { compactSummaryValue } from "./granularity.js";
import { fitEnvelopeBudget, type BudgetedEnvelope } from "./ladder.js";

const LIFTED_KEYS = ["snapshotProjection", "causal", "diff", "treeDiff", "relations", "gist", "outline", "entities"] as const;
const REQUIRED_CONTINUITY_KEYS = ["snapshotProjection", "diff", "treeDiff"] as const;
const MIN_MARGINAL_DENSITY = 0.12;
const MAX_SALIENCE_TO_LADDER_RATIO = 1.05;
const STRUCTURE_SCORE: Record<(typeof LIFTED_KEYS)[number], number> = {
	snapshotProjection: 950,
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
	cost: number;
	score: number;
};

function referencedPiRefs(envelope: BudgetedEnvelope): Set<string> {
	const refs = new Set<string>();
	const actions = envelope["nextActions"];
	for (const action of Array.isArray(actions) ? actions : []) {
		if (typeof action !== "string") continue;
		for (const match of action.matchAll(/pi-ref:\/\/[^)\s]+/g)) refs.add(match[0]);
	}
	return refs;
}

function compactEntity(entity: Record<string, unknown>): Record<string, unknown> {
	const hints = isRecord(entity.hints) ? entity.hints : {};
	return {
		...(typeof entity.ref === "string" ? { ref: entity.ref } : {}),
		...(typeof entity.kind === "string" ? { kind: entity.kind } : {}),
		...(typeof entity.role === "string" ? { role: entity.role } : {}),
		...(typeof entity.name === "string" ? { name: entity.name } : {}),
		...(typeof hints.selector === "string" || typeof hints.listContainer === "boolean" ? { hints: { ...(typeof hints.selector === "string" ? { selector: hints.selector } : {}), ...(typeof hints.listContainer === "boolean" ? { listContainer: hints.listContainer } : {}) } } : {}),
	};
}

function compactEntities(value: unknown, envelope: BudgetedEnvelope): unknown {
	if (!Array.isArray(value)) return compactSummaryValue(value, { stringChars: 160, arrayItems: 6, tableRows: 6 });
	const records = value.filter(isRecord);
	const refs = referencedPiRefs(envelope);
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

export function countDistillTruncationMarkers(value: unknown): number {
	const text = stableJson(value);
	return (text.match(/truncated|omitted|…|\.\.\./gi) || []).length;
}

function acceptedCandidate<T extends BudgetedEnvelope>(salience: T, ladder: T): T {
	for (const key of REQUIRED_CONTINUITY_KEYS) {
		if (salience[key] === undefined && ladder[key] !== undefined) return ladder;
	}
	const salienceChars = stableJson(salience).length;
	const ladderChars = stableJson(ladder).length;
	if (salienceChars > Math.ceil(ladderChars * MAX_SALIENCE_TO_LADDER_RATIO)) return ladder;
	if (countDistillTruncationMarkers(salience) > countDistillTruncationMarkers(ladder)) return ladder;
	return salience;
}

export function fitSalienceEnvelopeBudget<T extends BudgetedEnvelope>(envelope: T, maxChars: number): T {
	const budget = Math.max(1_000, Math.floor(maxChars));
	const ladder = fitEnvelopeBudget(envelope, maxChars);
	if (stableJson(envelope).length <= budget) return acceptedCandidate(envelope, ladder);
	let out: T = { ...envelope };
	for (const key of LIFTED_KEYS) delete out[key];
	const baseCost = stableJson(out).length;
	if (baseCost >= budget) return fitEnvelopeBudget(envelope, maxChars);

	const chosen = new Set<string>();
	let spent = baseCost;
	const omitted: string[] = [];
	const candidates: Candidate[] = [];
	for (const key of LIFTED_KEYS) {
		const value = envelope[key];
		if (value === undefined) continue;
		const fullCost = stableJson(value).length;
		candidates.push({ key, granularity: "full", value, cost: fullCost, score: STRUCTURE_SCORE[key] });
		const compact = compactLiftedValue(key, value, envelope);
		const compactCost = stableJson(compact).length;
		if (compactCost < fullCost) candidates.push({ key, granularity: "compact", value: compact, cost: compactCost, score: Math.floor(STRUCTURE_SCORE[key] * 0.75) });
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
	const fitted = stableJson(out).length <= budget ? out : fitEnvelopeBudget(out, maxChars);
	return acceptedCandidate(fitted, ladder);
}
