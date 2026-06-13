import type { TemporalCost, TemporalDecision, TemporalFrontierNext, TemporalPlan, TemporalPlanAction, TemporalReason, TemporalSource, TemporalVerdict } from "./types.js";

export type TemporalBudgetCandidate = {
	action: TemporalPlanAction;
	reason: TemporalReason;
	cost: TemporalCost;
	expectedEvidence: TemporalSource[];
	frontierNext?: TemporalFrontierNext;
	verdict?: TemporalVerdict;
};

export type AllocateTemporalBudgetInput = {
	remainingMs: number;
	candidates: TemporalBudgetCandidate[];
	reserveMs?: number;
};

export type DeadlinePressureInput = {
	remainingMs: number;
	requiredMs: number;
	queueDelayMs?: number;
	queueDepthAtEnqueue?: number;
};

export function compareTemporalCost(a: TemporalCost, b: TemporalCost): number {
	return a.wallMs - b.wallMs
		|| a.bridgeRoundTrips - b.bridgeRoundTrips
		|| a.expectedToolCalls - b.expectedToolCalls
		|| a.tokenChars - b.tokenChars
		|| a.confidenceLoss - b.confidenceLoss;
}

export function allocateTemporalBudget(input: AllocateTemporalBudgetInput): TemporalPlan {
	const usableMs = Math.max(0, input.remainingMs - (input.reserveMs ?? 0));
	const viable = input.candidates
		.filter((candidate) => candidate.cost.wallMs <= usableMs)
		.slice()
		.sort((a, b) => compareTemporalCost(a.cost, b.cost));
	const selected = viable[0];
	if (!selected) {
		return { action: "fail_closed", budgetMs: 0, reason: "queue_delay_budget_exceeded", expectedEvidence: [], frontier: { next: "fail_closed" } };
	}
	return {
		action: selected.action,
		budgetMs: selected.cost.wallMs,
		reason: selected.reason,
		expectedEvidence: selected.expectedEvidence,
		frontier: selected.frontierNext ? { next: selected.frontierNext } : undefined,
		verdict: selected.verdict,
	};
}

export function classifyDeadlinePressure(input: DeadlinePressureInput): TemporalDecision {
	if (input.queueDelayMs !== undefined && input.queueDelayMs > input.remainingMs) {
		return {
			verdict: { status: "unknown", confidence: "partial", reasons: ["queue_delay_budget_exceeded"] },
			frontier: { next: "retry_same_wait" },
			source: "driver_snapshot",
		};
	}
	if ((input.queueDepthAtEnqueue ?? 0) > 2) {
		return {
			verdict: { status: "possibly_stale", confidence: "bounded", reasons: ["queue_saturated"] },
			frontier: { next: "retry_same_wait" },
			source: "driver_snapshot",
		};
	}
	if (input.requiredMs > input.remainingMs) {
		return {
			verdict: { status: "unknown", confidence: "partial", reasons: ["queue_delay_budget_exceeded"] },
			frontier: { next: "fail_closed" },
			source: "driver_snapshot",
		};
	}
	return {
		verdict: { status: "fresh", confidence: "mechanical", reasons: ["same_target"] },
		frontier: { next: "reuse_target" },
		source: "driver_snapshot",
	};
}
