import type { TemporalDecision } from "./types.js";

export type DeadlinePressureInput = {
	remainingMs: number;
	requiredMs: number;
	queueDelayMs?: number;
	queueDepthAtEnqueue?: number;
};

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
