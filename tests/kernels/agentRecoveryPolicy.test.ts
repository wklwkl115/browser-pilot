import assert from "node:assert/strict";
import test from "node:test";
import { classifyRecovery, mayAutoReplayMutation } from "../../src/kernels/agent/recoveryPolicy.js";

test("never auto-replays after ACK", () => {
	assert.equal(mayAutoReplayMutation("acked"), false);
	assert.equal(mayAutoReplayMutation("terminal"), false);
	assert.equal(mayAutoReplayMutation("sent_unacked", false), false);
	assert.equal(mayAutoReplayMutation("sent_unacked", true), true);
	assert.equal(mayAutoReplayMutation("not_started"), true);
});

test("identity change pre-dispatch reanchors without mutation replay", () => {
	const decision = classifyRecovery({
		condition: "page_identity_changed_pre_dispatch",
		dispatchBoundary: "prepared",
	});
	assert.equal(decision.mutationReplay, false);
	assert.equal(decision.action, "reanchor_page");
});

test("ambiguous target stops without replay", () => {
	const decision = classifyRecovery({
		condition: "target_lineage_ambiguous",
		dispatchBoundary: "prepared",
	});
	assert.equal(decision.allow, false);
	assert.equal(decision.mutationReplay, false);
});

test("acked connection loss is observe-only", () => {
	const decision = classifyRecovery({
		condition: "mutation_acked_connection_lost",
		dispatchBoundary: "acked",
	});
	assert.equal(decision.mutationReplay, false);
	assert.equal(decision.action, "observe_only");
});
