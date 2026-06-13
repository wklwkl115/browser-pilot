import test from "node:test";
import assert from "node:assert/strict";
import { stableJson, resetStableJsonInvocationCounter, stableJsonInvocationCounter } from "../../../src/utils/json.ts";
import { compactEntityRenderingValue, compactSummaryValue } from "../../../src/distill-core/granularity.ts";
import { FACT_GRANULARITY_ORDER, type FactGranularity } from "../../../src/distill-core/fact.ts";
import { fitEnvelopeBudget, type BudgetedEnvelope } from "../../../src/distill-core/ladder.ts";
import { fitSalienceEnvelopeBudget } from "../../../src/distill-core/salienceEnvelope.ts";
import { isRecord } from "../../../src/utils/records.ts";

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

function allowedByCeiling(granularity: Candidate["granularity"], ceiling?: Exclude<FactGranularity, "omit">): boolean {
	if (!ceiling) return true;
	return FACT_GRANULARITY_ORDER.indexOf(granularity) >= FACT_GRANULARITY_ORDER.indexOf(ceiling);
}

function referencedPiRefs(envelope: BudgetedEnvelope): Set<string> {
	const refs = new Set<string>();
	const actions = envelope.nextActions;
	for (const action of Array.isArray(actions) ? actions : []) {
		if (typeof action !== "string") continue;
		for (const match of action.matchAll(/pi-ref:\/\/[^)\s]+/g)) refs.add(match[0]);
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

function countLegacyTruncationMarkers(value: unknown): number {
	const text = stableJson(value);
	return (text.match(/truncated|omitted|…|\.\.\./gi) || []).length;
}

function acceptedCandidateReference<T extends BudgetedEnvelope>(salience: T, ladder: T, salienceChars?: number): T {
	for (const key of REQUIRED_CONTINUITY_KEYS) {
		if (salience[key] === undefined && ladder[key] !== undefined) return ladder;
	}
	const ladderChars = stableJson(ladder).length;
	if ((salienceChars ?? stableJson(salience).length) > Math.ceil(ladderChars * MAX_SALIENCE_TO_LADDER_RATIO)) return ladder;
	if (countLegacyTruncationMarkers(salience) > countLegacyTruncationMarkers(ladder)) return ladder;
	return salience;
}

function fitSalienceEnvelopeBudgetReference<T extends BudgetedEnvelope>(envelope: T, maxChars: number, options: { granularityCeiling?: Exclude<FactGranularity, "omit"> } = {}): T {
	const budget = Math.max(1_000, Math.floor(maxChars));
	const envelopeChars = stableJson(envelope).length;
	if (envelopeChars <= budget) return envelope;
	let ladder: T | undefined;
	const fallbackLadder = (): T => {
		ladder ??= fitEnvelopeBudget(envelope, maxChars);
		return ladder;
	};
	let out: T = { ...envelope };
	for (const key of LIFTED_KEYS) delete out[key];
	const baseCost = stableJson(out).length;
	if (baseCost >= budget) return fallbackLadder();

	const chosen = new Set<string>();
	let spent = baseCost;
	const omitted: string[] = [];
	const candidates: Candidate[] = [];
	for (const key of LIFTED_KEYS) {
		const value = envelope[key];
		if (value === undefined) continue;
		const fullCost = stableJson(value).length;
		if (allowedByCeiling("full", options.granularityCeiling)) candidates.push({ key, granularity: "full", value, cost: fullCost, score: STRUCTURE_SCORE[key] });
		const compact = compactLiftedValue(key, value, envelope);
		const compactCost = stableJson(compact).length;
		if (compactCost < fullCost && allowedByCeiling("compact", options.granularityCeiling)) candidates.push({ key, granularity: "compact", value: compact, cost: compactCost, score: Math.floor(STRUCTURE_SCORE[key] * 0.75) });
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
	const fittedChars = stableJson(out).length;
	const fitted = fittedChars <= budget ? out : fitEnvelopeBudget(out, maxChars);
	return acceptedCandidateReference(fitted, fallbackLadder(), fittedChars <= budget ? fittedChars : undefined);
}

function acceptedCandidateThreadTextMutant<T extends BudgetedEnvelope>(salience: T, ladder: T): T {
	for (const key of REQUIRED_CONTINUITY_KEYS) {
		if (salience[key] === undefined && ladder[key] !== undefined) return ladder;
	}
	const salienceText = `${stableJson(salience)}${"x".repeat(300)}`;
	const ladderText = stableJson(ladder);
	const textMarkers = (text: string): number => (text.match(/truncated|omitted|…|\.\.\./gi) || []).length;
	if (salienceText.length > Math.ceil(ladderText.length * MAX_SALIENCE_TO_LADDER_RATIO)) return ladder;
	if (textMarkers(salienceText) > textMarkers(ladderText)) return ladder;
	return salience;
}

function makeUnderBudgetFixture(): BudgetedEnvelope {
	return {
		tool: "browser_observe",
		command: "scan",
		detailLevel: "summary",
		renderer: "salience-v1",
		summary: { title: "short" },
		gist: { title: "g" },
	};
}

function makeSalienceAcceptedFixture(): BudgetedEnvelope {
	return {
		tool: "browser_observe",
		command: "scan",
		detailLevel: "summary",
		renderer: "salience-v1",
		summary: { abmlIntegrated: true, title: "Search", textPreview: "v ".repeat(180) },
		entities: Array.from({ length: 8 }, (_, i) => ({
			ref: `pi-ref://control/${i}`,
			kind: "control",
			role: "button",
			name: `Action ${i} ${"pad ".repeat(6)}`,
			hints: { selector: `#id-${i}` },
		})),
		gist: { primary: "search", secondary: "filters" },
		nextActions: ["read(pi-ref://control/0)"],
	};
}

function makeLadderWinFixture(): BudgetedEnvelope {
	return {
		tool: "browser_observe",
		command: "scan",
		detailLevel: "summary",
		renderer: "salience-v1",
		summary: { abmlIntegrated: true, title: "Heavy diff", textPreview: "y ".repeat(600), summaryTruncatedToBudget: true, summaryOmitted: ["focus"] },
		gist: { primary: "compare", extra: "z".repeat(500) },
		entities: Array.from({ length: 10 }, (_, i) => ({
			ref: `pi-ref://control/${i}`,
			kind: "control",
			role: "button",
			name: `Item ${i} ${"pad ".repeat(18)}`,
			hints: { selector: `#item-${i}` },
		})),
		diff: {
			summary: { count: 12, changed: 7 },
			details: Array.from({ length: 20 }, (_, i) => ({ ref: `pi-ref://diff/${i}`, before: "a".repeat(80), after: "b".repeat(80) })),
		},
		treeDiff: {
			summary: { count: 8 },
			templates: Array.from({ length: 8 }, (_, i) => ({
				templateKey: `t-${i}`,
				container: "main",
				changed: { count: 1, instances: [{ key: `k-${i}`, name: "row", fields: { text: "x".repeat(50) } }] },
			})),
		},
	};
}

function makeContinuityFixture(): BudgetedEnvelope {
	return {
		tool: "browser_observe",
		command: "scan",
		detailLevel: "summary",
		renderer: "salience-v1",
		summary: { abmlIntegrated: true, title: "Projection continuity" },
		snapshotProjection: {
			summary: { templateCount: 8, instanceCount: 30 },
			templates: Array.from({ length: 12 }, (_, i) => ({
				templateKey: `proj-${i}`,
				container: "main",
				instances: Array.from({ length: 4 }, (_, j) => ({ ref: `pi-ref://inst/${i}-${j}`, text: "q".repeat(60) })),
			})),
		},
		entities: Array.from({ length: 4 }, (_, i) => ({ ref: `pi-ref://control/${i}`, kind: "control", role: "button", name: `Act ${i}` })),
		gist: { primary: "projection" },
	};
}

test("fitSalienceEnvelopeBudget preserves legacy bytes across representative cases", () => {
	const salienceAccepted = makeSalienceAcceptedFixture();
	const ladder = fitEnvelopeBudget(salienceAccepted, 1_500);
	const accepted = fitSalienceEnvelopeBudgetReference(salienceAccepted, 1_500);
	assert.notDeepEqual(acceptedCandidateThreadTextMutant(accepted, ladder), accepted);

	const cases = [
		{ label: "under-budget passthrough", envelope: makeUnderBudgetFixture(), budget: 5_000 },
		{ label: "salience candidate accepted", envelope: salienceAccepted, budget: 1_500 },
		{ label: "ladder fallback wins", envelope: makeLadderWinFixture(), budget: 1_400 },
		{ label: "continuity-required key keeps ladder result", envelope: makeContinuityFixture(), budget: 1_400 },
	];
	for (const { label, envelope, budget } of cases) {
		const legacy = fitSalienceEnvelopeBudgetReference(envelope, budget);
		const current = fitSalienceEnvelopeBudget(envelope, budget);
		assert.equal(stableJson(current), stableJson(legacy), `${label}: output bytes changed`);
	}
});

test("fitSalienceEnvelopeBudget reduces stableJson invocations on a representative over-budget fit", () => {
	const envelope = makeSalienceAcceptedFixture();
	resetStableJsonInvocationCounter();
	const legacy = fitSalienceEnvelopeBudgetReference(envelope, 1_500);
	const legacyCount = stableJsonInvocationCounter();
	resetStableJsonInvocationCounter();
	const current = fitSalienceEnvelopeBudget(envelope, 1_500);
	const currentCount = stableJsonInvocationCounter();
	assert.deepEqual(current, legacy);
	assert.equal(legacyCount, 17);
	assert.equal(currentCount, 15);
});
