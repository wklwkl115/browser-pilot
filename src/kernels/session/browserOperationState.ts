import type { BrowserOperationStatus } from "./browserOperation.js";

export type BrowserOperationLivenessInput = {
	now: number;
	deadlineAt: number;
	dispatchFinishedAt: number;
	lastProgressAt: number;
	hasActivity: boolean;
	pending: boolean;
	downloadPending: boolean;
};

/** Time thresholds classify liveness only. This function can never produce completed. */
export function classifyBrowserOperationLiveness(input: BrowserOperationLivenessInput): Exclude<BrowserOperationStatus, "completed" | "ambiguous" | "target_lost" | "failed"> | undefined {
	if (input.now >= input.deadlineAt) return "deadline";
	if (input.hasActivity && !input.pending) return "effect_observed";
	const stalledAfterMs = input.downloadPending ? 10_000 : 5_000;
	if (input.hasActivity && input.pending && input.now - input.lastProgressAt >= stalledAfterMs) return "stalled";
	if (!input.hasActivity && input.now - input.dispatchFinishedAt >= 1_000) return "no_effect";
	return undefined;
}
