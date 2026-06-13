import type { TemporalDecision, TemporalPlan, TemporalReason, TemporalSource } from "./types.js";

export type PlanPreDispatchSyncInput = {
	continuity: TemporalDecision;
	remainingMs: number;
	reusableHandle?: string;
};

export type PlanPostActionSyncInput = {
	navigated?: boolean;
	targetRegionDirty?: boolean;
	signalPartial?: boolean;
	remainingMs: number;
};

export type PlanWaitAttemptInput = {
	wait: TemporalDecision;
	remainingMs: number;
	diagnoseAllowed?: boolean;
	retryBudgetMs?: number;
};

function plan(action: TemporalPlan["action"], budgetMs: number, reason: TemporalReason, expectedEvidence: TemporalSource[], decision?: TemporalDecision): TemporalPlan {
	return {
		action,
		budgetMs,
		reason,
		expectedEvidence,
		frontier: decision?.frontier,
		verdict: decision?.verdict,
	};
}

export function planPreDispatchSync(input: PlanPreDispatchSyncInput): TemporalPlan {
	const { verdict, frontier } = input.continuity;
	const primaryReason = verdict.reasons[0] ?? "target_possibly_stale";
	if (verdict.status === "fresh") {
		return {
			action: "none",
			budgetMs: 0,
			reason: primaryReason,
			expectedEvidence: [],
			frontier: { next: "reuse_target", handle: input.reusableHandle },
			verdict,
		};
	}
	if (verdict.status === "possibly_stale" && input.remainingMs > 0 && !verdict.reasons.includes("target_stale_before_dispatch")) {
		return plan("immediate_probe", Math.min(50, input.remainingMs), primaryReason, ["page_signal"], input.continuity);
	}
	if (frontier.next === "fail_closed" || input.remainingMs <= 0) return plan("fail_closed", 0, primaryReason, [], input.continuity);
	return plan("reobserve_required", 0, primaryReason, ["observation_snapshot"], input.continuity);
}

export function planPostActionSync(input: PlanPostActionSyncInput): TemporalPlan {
	if (input.signalPartial) return plan("immediate_probe", Math.min(50, input.remainingMs), "signal_unavailable", ["page_signal"]);
	if (input.navigated) return plan("quiet_read", Math.min(100, input.remainingMs), "url_changed", ["page_signal", "driver_snapshot"]);
	if (input.targetRegionDirty) return plan("quiet_read", Math.min(50, input.remainingMs), "target_region_dirty", ["page_signal"]);
	return plan("none", 0, "same_target", []);
}

export function planWaitAttempt(input: PlanWaitAttemptInput): TemporalPlan {
	const { verdict, frontier } = input.wait;
	const primaryReason = verdict.reasons[0] ?? "underconstrained_wait";
	if (verdict.status === "fresh") return plan("none", 0, primaryReason, [], input.wait);
	if (frontier.next === "diagnose") {
		if (input.diagnoseAllowed && input.remainingMs > 0) return plan("diagnose", Math.min(100, input.remainingMs), primaryReason, ["wait_diagnose"], input.wait);
		return plan("fail_closed", 0, primaryReason, [], input.wait);
	}
	if (frontier.next === "retry_same_wait" && input.remainingMs > 0) {
		return plan("wait", Math.min(input.retryBudgetMs ?? input.remainingMs, input.remainingMs), primaryReason, ["wait_supervisor"], input.wait);
	}
	if (frontier.next === "reobserve") return plan("reobserve_required", 0, primaryReason, ["observation_snapshot"], input.wait);
	return plan("fail_closed", 0, primaryReason, [], input.wait);
}
