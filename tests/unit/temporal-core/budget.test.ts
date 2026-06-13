import test from "node:test";
import assert from "node:assert/strict";
import { allocateTemporalBudget, classifyDeadlinePressure, compareTemporalCost } from "../../../src/temporal-core/budget.ts";
import type { TemporalCost } from "../../../src/temporal-core/types.ts";

const cheapProbe: TemporalCost = { wallMs: 20, bridgeRoundTrips: 1, expectedToolCalls: 0, tokenChars: 60, confidenceLoss: 1 };
const richerDiagnose: TemporalCost = { wallMs: 50, bridgeRoundTrips: 1, expectedToolCalls: 0, tokenChars: 140, confidenceLoss: 0 };

test("compareTemporalCost uses the closed deterministic tuple order", () => {
	assert(compareTemporalCost(cheapProbe, richerDiagnose) < 0);
	assert(compareTemporalCost({ ...cheapProbe, wallMs: 50, tokenChars: 80 }, richerDiagnose) < 0);
	assert(compareTemporalCost({ ...cheapProbe, wallMs: 50, tokenChars: 160 }, richerDiagnose) > 0);
});

test("allocateTemporalBudget picks viable plans and fails closed when none fit", () => {
	const selected = allocateTemporalBudget({
		remainingMs: 100,
		candidates: [
			{ action: "diagnose", reason: "underconstrained_wait", cost: richerDiagnose, expectedEvidence: ["wait_diagnose"], frontierNext: "diagnose" },
			{ action: "immediate_probe", reason: "target_possibly_stale", cost: cheapProbe, expectedEvidence: ["page_signal"], frontierNext: "reobserve" },
		],
	});
	assert.equal(selected.action, "immediate_probe");
	assert.equal(selected.budgetMs, 20);

	const failed = allocateTemporalBudget({ remainingMs: 10, candidates: [{ action: "wait", reason: "lease_timeout", cost: cheapProbe, expectedEvidence: ["wait_supervisor"] }] });
	assert.equal(failed.action, "fail_closed");
	assert.equal(failed.reason, "queue_delay_budget_exceeded");
});

test("classifyDeadlinePressure reports queue pressure separately from valid budget", () => {
	assert.equal(classifyDeadlinePressure({ remainingMs: 100, requiredMs: 50 }).verdict.status, "fresh");
	assert.equal(classifyDeadlinePressure({ remainingMs: 100, requiredMs: 50, queueDepthAtEnqueue: 4 }).verdict.reasons[0], "queue_saturated");
	assert.equal(classifyDeadlinePressure({ remainingMs: 100, requiredMs: 50, queueDelayMs: 120 }).frontier.next, "retry_same_wait");
	assert.equal(classifyDeadlinePressure({ remainingMs: 10, requiredMs: 50 }).frontier.next, "fail_closed");
});
