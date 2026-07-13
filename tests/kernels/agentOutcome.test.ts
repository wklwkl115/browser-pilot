import assert from "node:assert/strict";
import test from "node:test";
import { mapBrowserOperationToAgentOutcome, assertAgentOutcomeInvariants } from "../../src/kernels/agent/agentOutcome.js";
import type { BrowserOperationStatus } from "../../src/kernels/session/browserOperation.js";

const STATUSES: BrowserOperationStatus[] = [
	"completed",
	"effect_observed",
	"ambiguous",
	"target_lost",
	"deadline",
	"no_effect",
	"stalled",
	"failed",
];

test("AgentOutcome maps 1:1 from classifyBrowserOperationStatus", () => {
	for (const status of STATUSES) {
		const outcome = mapBrowserOperationToAgentOutcome(status, { completionSource: "test" });
		assertAgentOutcomeInvariants(outcome);
		if (status === "completed") {
			assert.equal(outcome.ok, true);
			assert.equal(outcome.classification, "success");
			assert.equal(outcome.completionVerified, true);
			assert.equal(outcome.replay, "not_needed");
		} else {
			assert.equal(outcome.ok, false);
			assert.notEqual(outcome.classification, "success");
			assert.equal(outcome.completionVerified, false);
			assert.equal(outcome.replay, "do_not_retry");
		}
	}
});

test("target_lost is inconclusive with OPERATION_TARGET_LOST", () => {
	const outcome = mapBrowserOperationToAgentOutcome("target_lost");
	assert.equal(outcome.classification, "inconclusive");
	assert.equal(outcome.code, "OPERATION_TARGET_LOST");
	assert.equal(outcome.ok, false);
});

test("assertAgentOutcomeInvariants rejects promoted success", () => {
	assert.throws(() => assertAgentOutcomeInvariants({
		classification: "success",
		status: "effect_observed",
		completionVerified: true,
		ok: true,
		replay: "do_not_retry",
		automaticActionsTaken: [],
	}));
});
