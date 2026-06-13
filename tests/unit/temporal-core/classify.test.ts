import test from "node:test";
import assert from "node:assert/strict";
import { classifyStaleness, classifyStateLoss, classifyTimeout } from "../../../src/temporal-core/classify.ts";

test("classifyStaleness separates CSS-only stale risk from mechanical stable-locator staleness", () => {
	const cssOnly = classifyStaleness({ anchorPresent: true, targetRegionDirty: true, cssOnlyLocator: true });
	assert.equal(cssOnly.verdict.status, "possibly_stale");
	assert.equal(cssOnly.verdict.confidence, "bounded");
	assert.deepEqual(cssOnly.verdict.reasons, ["target_stale_before_dispatch", "target_region_dirty"]);
	assert.equal(cssOnly.frontier.next, "reobserve");

	const stable = classifyStaleness({ anchorPresent: true, targetRegionDirty: true, stableLocator: true });
	assert.equal(stable.verdict.status, "stale");
	assert.equal(stable.verdict.confidence, "mechanical");
	assert.deepEqual(stable.verdict.reasons, ["target_stale_before_dispatch", "target_region_dirty"]);
});

test("classifyStaleness treats missing anchors and tab loss as different recovery classes", () => {
	assert.deepEqual(classifyStaleness({ anchorPresent: false }).verdict, {
		status: "unknown",
		confidence: "partial",
		reasons: ["unknown_due_to_missing_anchor"],
	});
	assert.deepEqual(classifyStaleness({ tabDisconnected: true }).verdict, {
		status: "stale",
		confidence: "mechanical",
		reasons: ["tab_disconnected"],
	});
});

test("classifyTimeout keeps no-ACK, ACKed bridge timeout, lease timeout, and wait-state causes distinct", () => {
	assert.equal(classifyTimeout({ acknowledged: false }).verdict.reasons[0], "no_ack");
	assert.equal(classifyTimeout({ ackedBridgeTimeout: true }).verdict.reasons[0], "acked_bridge_timeout");
	assert.equal(classifyTimeout({ leaseTimedOut: true }).verdict.reasons[0], "lease_timeout");
	assert.equal(classifyTimeout({ urlMismatch: true }).frontier.next, "reobserve");
	assert.equal(classifyTimeout({ selectorMissing: true }).verdict.status, "possibly_stale");
	assert.equal(classifyTimeout({ networkActive: true }).verdict.reasons[0], "network_active");
});

test("classifyStateLoss never fabricates continuity across worker history loss", () => {
	const lost = classifyStateLoss({ historyLost: true, workerRestarts: 1 });
	assert.equal(lost.verdict.status, "unknown");
	assert.equal(lost.verdict.confidence, "lost");
	assert.deepEqual(lost.verdict.reasons, ["worker_restarted_history_lost", "unknown_due_to_history_loss"]);
	assert.equal(lost.frontier.next, "diagnose");
	assert.equal(classifyStateLoss({}).verdict.reasons[0], "same_wait_history");
});
