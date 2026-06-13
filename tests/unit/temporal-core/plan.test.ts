import test from "node:test";
import assert from "node:assert/strict";
import { planPostActionSync, planPreDispatchSync, planWaitAttempt } from "../../../src/temporal-core/plan.ts";
import type { TemporalDecision } from "../../../src/temporal-core/types.ts";

const fresh: TemporalDecision = {
	verdict: { status: "fresh", confidence: "mechanical", reasons: ["same_target"] },
	frontier: { next: "reuse_target" },
	source: "driver_snapshot",
};

test("planPreDispatchSync reuses only fresh targets and exposes reobserve for stale refs", () => {
	const reuse = planPreDispatchSync({ continuity: fresh, remainingMs: 100, reusableHandle: "pi-ref://control/pay" });
	assert.equal(reuse.action, "none");
	assert.equal(reuse.frontier?.handle, "pi-ref://control/pay");

	const stale: TemporalDecision = {
		verdict: { status: "stale", confidence: "mechanical", reasons: ["target_stale_before_dispatch"] },
		frontier: { next: "reobserve" },
		source: "execute_effect",
	};
	assert.equal(planPreDispatchSync({ continuity: stale, remainingMs: 100 }).action, "reobserve_required");
});

test("planPostActionSync requests cheap mechanical reads only for local evidence gaps", () => {
	assert.equal(planPostActionSync({ remainingMs: 100 }).action, "none");
	assert.equal(planPostActionSync({ remainingMs: 100, signalPartial: true }).action, "immediate_probe");
	assert.equal(planPostActionSync({ remainingMs: 100, navigated: true }).action, "quiet_read");
	assert.equal(planPostActionSync({ remainingMs: 20, targetRegionDirty: true }).budgetMs, 20);
});

test("planWaitAttempt respects diagnose ownership and retry frontiers", () => {
	const needsDiagnose: TemporalDecision = {
		verdict: { status: "unknown", confidence: "partial", reasons: ["underconstrained_wait"] },
		frontier: { next: "diagnose" },
		source: "wait_supervisor",
	};
	assert.equal(planWaitAttempt({ wait: needsDiagnose, remainingMs: 100, diagnoseAllowed: false }).action, "fail_closed");
	assert.equal(planWaitAttempt({ wait: needsDiagnose, remainingMs: 100, diagnoseAllowed: true }).action, "diagnose");

	const retry: TemporalDecision = {
		verdict: { status: "possibly_stale", confidence: "bounded", reasons: ["lease_timeout"] },
		frontier: { next: "retry_same_wait" },
		source: "wait_supervisor",
	};
	assert.equal(planWaitAttempt({ wait: retry, remainingMs: 100, retryBudgetMs: 40 }).budgetMs, 40);
});
