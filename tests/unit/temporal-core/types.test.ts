import test from "node:test";
import assert from "node:assert/strict";
import { TEMPORAL_CONFIDENCES, TEMPORAL_FRONTIER_NEXT, TEMPORAL_PLAN_ACTIONS, TEMPORAL_REASONS, TEMPORAL_REASON_MODEL_CAP, TEMPORAL_SOURCES, TEMPORAL_VERDICT_STATUSES } from "../../../src/temporal-core/types.ts";
import { TEMPORAL_REASONS as BARREL_REASONS } from "../../../src/temporal-core/index.ts";

test("temporal V1 vocabulary matches the executable contract", () => {
	assert.deepEqual(TEMPORAL_VERDICT_STATUSES, ["fresh", "possibly_stale", "stale", "unknown"]);
	assert.deepEqual(TEMPORAL_CONFIDENCES, ["mechanical", "bounded", "partial", "lost"]);
	assert.deepEqual(TEMPORAL_SOURCES, ["driver_snapshot", "observation_snapshot", "ref_descriptor", "execute_effect", "wait_supervisor", "wait_diagnose", "page_signal", "cdp_event", "poll_fallback"]);
	assert.deepEqual(TEMPORAL_FRONTIER_NEXT, ["reuse_target", "retry_same_wait", "reobserve", "diagnose", "fail_closed"]);
	assert.deepEqual(TEMPORAL_PLAN_ACTIONS, ["none", "immediate_probe", "wait", "diagnose", "quiet_read", "reobserve_required", "fail_closed"]);
	assert.equal(TEMPORAL_REASON_MODEL_CAP, 3);
	assert.equal(BARREL_REASONS, TEMPORAL_REASONS);
});

test("temporal V1 reasons include stale, timeout, and state-loss classes", () => {
	for (const reason of [
		"same_target",
		"target_stale_before_dispatch",
		"target_region_dirty",
		"url_changed",
		"selection_version_changed",
		"queue_delay_budget_exceeded",
		"no_ack",
		"acked_bridge_timeout",
		"lease_timeout",
		"worker_restarted_history_lost",
		"unknown_due_to_history_loss",
		"unknown_due_to_clock_domain",
		"unknown_due_to_missing_anchor",
	]) {
		assert(TEMPORAL_REASONS.includes(reason as never), `${reason} must be a frozen temporal reason`);
	}
});
