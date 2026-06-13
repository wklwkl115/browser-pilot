import test from "node:test";
import assert from "node:assert/strict";
import { estimatePageFreshness, estimateTargetContinuity, estimateWaitContinuity } from "../../../src/temporal-core/estimate.ts";
import type { TemporalAnchor, TemporalStamp } from "../../../src/temporal-core/types.ts";

function stamp(overrides: Partial<TemporalStamp> = {}): TemporalStamp {
	return {
		version: "temporal-stamp/v1",
		browserSessionId: "session-1",
		tabId: 7,
		tabHandle: "tab-handle-1",
		targetRef: "pi-tab://session-1/7",
		selectionVersion: 3,
		pageEpoch: "epoch-1",
		url: "https://example.test/app",
		changeSeq: 10,
		networkSeq: 4,
		hookSeq: 2,
		capturedAtMs: 1000,
		clockDomain: "driver_wall",
		...overrides,
	};
}

function anchor(stampValue = stamp()): TemporalAnchor {
	return { version: "temporal-anchor/v1", source: "ref", stamp: stampValue, evidence: { locators: [{ by: "backendNodeId", value: 42 }] } };
}

test("estimateTargetContinuity proves same stable target and rejects replacement", () => {
	const same = estimateTargetContinuity({ anchor: anchor(), current: stamp({ capturedAtMs: 1200 }) });
	assert.equal(same.verdict.status, "fresh");
	assert.equal(same.verdict.reasons[0], "same_page_epoch");
	assert.equal(same.frontier.next, "reuse_target");

	const replaced = estimateTargetContinuity({ anchor: anchor(), current: stamp({ tabHandle: "tab-handle-2" }) });
	assert.equal(replaced.verdict.status, "stale");
	assert.equal(replaced.verdict.reasons[0], "tab_replaced");
	assert.equal(replaced.frontier.next, "reobserve");
});

test("estimateTargetContinuity refuses cross-domain continuity when no stable identity survives", () => {
	const unknown = estimateTargetContinuity({
		anchor: anchor(stamp({ tabHandle: undefined, targetRef: undefined, tabId: undefined, changeSeq: undefined, networkSeq: undefined, hookSeq: undefined, sequence: undefined })),
		current: stamp({ tabHandle: undefined, targetRef: undefined, tabId: undefined, changeSeq: undefined, networkSeq: undefined, hookSeq: undefined, sequence: undefined, clockDomain: "page_wall" }),
	});
	assert.equal(unknown.verdict.status, "unknown");
	assert.equal(unknown.verdict.reasons[0], "unknown_due_to_clock_domain");
});

test("estimatePageFreshness classifies dirty target windows before dispatch", () => {
	const stale = estimatePageFreshness({ anchor: anchor(), current: stamp({ capturedAtMs: 1010 }), targetRegionDirty: true, stableLocator: true });
	assert.equal(stale.verdict.status, "stale");
	assert.deepEqual(stale.verdict.reasons, ["target_stale_before_dispatch", "target_region_dirty"]);

	const aged = estimatePageFreshness({ anchor: anchor(), current: stamp({ capturedAtMs: 3000 }), maxSameDomainAgeMs: 500 });
	assert.equal(aged.verdict.status, "possibly_stale");
	assert.equal(aged.verdict.reasons[0], "target_possibly_stale");
});

test("estimateWaitContinuity distinguishes event history loss from poll fallback confidence", () => {
	assert.equal(estimateWaitContinuity({ previousWorkerBootId: "a", currentWorkerBootId: "b" }).verdict.confidence, "lost");
	const fallback = estimateWaitContinuity({ previousWorkerBootId: "a", currentWorkerBootId: "a", eventSource: "poll_fallback" });
	assert.equal(fallback.verdict.status, "possibly_stale");
	assert.equal(fallback.verdict.confidence, "bounded");
	assert.equal(fallback.source, "poll_fallback");
});
