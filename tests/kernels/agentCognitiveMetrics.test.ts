import assert from "node:assert/strict";
import test from "node:test";
import {
	accumulateFixtureStep,
	emptyCognitiveMetrics,
	hardGatesPass,
} from "../../src/kernels/agent/cognitiveMetrics.js";

test("fixture metrics accumulate recall and hard gates", () => {
	let m = emptyCognitiveMetrics();
	m = accumulateFixtureStep(m, {
		requiredActionableRefs: ["bp-ref://email", "bp-ref://submit"],
		blockingControlRefs: ["bp-ref://dialog-ok"],
	}, {
		returnedResourceRefs: ["bp-ref://email", "bp-ref://dialog-ok"],
		publicCalls: 1,
		opaqueMechanicalIdsCarried: 1,
		mutationReplayAttempts: 0,
		taskSuccess: false,
		defaultResponseChars: 1200,
	});
	assert.equal(m.publicCalls, 1);
	assert.equal(m.l0Required, 2);
	assert.equal(m.l0Hits, 1);
	assert.equal(m.blockingRequired, 1);
	assert.equal(m.blockingHits, 1);
	assert.ok(m.criticalActionableRecall < 1);
	assert.equal(m.blockingControlRecall, 1);
	assert.equal(hardGatesPass(m).ok, true);

	m = accumulateFixtureStep(m, {}, {
		returnedResourceRefs: [],
		publicCalls: 1,
		mutationReplayAttempts: 1,
	});
	const gates = hardGatesPass(m);
	assert.equal(gates.ok, false);
	assert.ok(gates.failures.some((f) => f.includes("mutationReplay")));
});
