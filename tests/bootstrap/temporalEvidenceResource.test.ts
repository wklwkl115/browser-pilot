import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyDeadlinePressure } from "../../src/kernels/temporal/budget.ts";
import { classifyStateLoss, classifyStaleness, classifyTimeout, diagnoseWaitTimeout } from "../../src/kernels/temporal/classify.ts";
import { estimatePageFreshness, estimateTargetContinuity, estimateWaitContinuity } from "../../src/kernels/temporal/estimate.ts";
import type { TemporalAnchor, TemporalStamp } from "../../src/kernels/temporal/types.ts";
import { registerRefDescriptor, resolveRefUriDetailed } from "../../src/resources/resourceRefs.ts";

function tempArtifact(name: string, value: unknown): string {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-resource-test-"));
	const filePath = path.join(cwd, name);
	writeFileSync(filePath, JSON.stringify(value), "utf8");
	return filePath;
}

function stamp(overrides: Partial<TemporalStamp> = {}): TemporalStamp {
	return {
		version: "temporal-stamp/v1",
		browserSessionId: "session-1",
		tabHandle: "tab-1",
		targetRef: "target-1",
		tabId: 1,
		url: "https://example.test/app",
		clockDomain: "page_wall",
		capturedAtMs: 1_000,
		pageEpoch: "page-1",
		changeSeq: 7,
		...overrides,
	};
}

function anchor(overrides: Partial<TemporalStamp> = {}): TemporalAnchor {
	return { version: "temporal-anchor/v1", source: "observe", stamp: stamp(overrides) };
}

test("temporal estimates classify continuity, staleness, and wait recovery boundary branches", () => {
	assert.deepEqual(estimateTargetContinuity({}).verdict.reasons, ["unknown_due_to_missing_anchor"]);
	assert.equal(estimateTargetContinuity({ anchor: anchor(), current: stamp({ browserSessionId: "session-2" }) }).frontier.next, "fail_closed");
	assert.equal(estimateTargetContinuity({ anchor: anchor(), current: stamp({ tabHandle: "tab-2" }) }).verdict.reasons[0], "tab_replaced");
	assert.equal(estimateTargetContinuity({ anchor: anchor({ selectionVersion: 1 }), current: stamp({ selectionVersion: 2 }) }).verdict.reasons[0], "selection_version_changed");
	assert.equal(estimateTargetContinuity({ anchor: anchor({ clockDomain: "driver_wall", tabHandle: undefined, targetRef: undefined, tabId: undefined }), current: stamp({ clockDomain: "page_wall", tabHandle: undefined, targetRef: undefined, tabId: undefined, changeSeq: undefined }) }).verdict.reasons[0], "unknown_due_to_clock_domain");
	assert.equal(estimateTargetContinuity({ anchor: anchor({ pageEpoch: "page-1" }), current: stamp({ pageEpoch: "page-1" }) }).frontier.next, "reuse_target");

	assert.equal(estimatePageFreshness({ anchor: anchor(), current: stamp({ url: "https://example.test/other" }) }).verdict.status, "stale");
	assert.equal(estimatePageFreshness({ anchor: anchor(), current: stamp({ dirtySinceSeq: 3 }) }).verdict.status, "possibly_stale");
	assert.equal(estimatePageFreshness({ anchor: anchor({ clockDomain: "driver_wall", changeSeq: undefined }), current: stamp({ clockDomain: "page_wall", changeSeq: undefined }) }).verdict.reasons[0], "unknown_due_to_clock_domain");
	assert.equal(estimatePageFreshness({ anchor: anchor(), current: stamp({ capturedAtMs: 10_000 }), maxSameDomainAgeMs: 500 }).verdict.status, "possibly_stale");
	assert.equal(estimatePageFreshness({ anchor: anchor(), current: stamp() }).frontier.next, "reuse_target");

	assert.equal(estimateWaitContinuity({ historyLost: true }).frontier.next, "diagnose");
	assert.equal(estimateWaitContinuity({ previousWorkerBootId: "a", currentWorkerBootId: "b" }).verdict.confidence, "lost");
	assert.equal(estimateWaitContinuity({ eventSource: "poll_fallback" }).verdict.status, "possibly_stale");
	assert.equal(estimateWaitContinuity({ eventSource: "wait_supervisor" }).verdict.status, "fresh");
});

test("temporal classifiers cover timeout priorities and deadline fallbacks", () => {
	assert.equal(classifyStateLoss({ extensionUnavailable: true }).verdict.reasons[0], "extension_unavailable");
	assert.equal(classifyStateLoss({ tabDisconnected: true }).verdict.status, "stale");
	assert.equal(classifyStateLoss({ clientDisconnected: true }).source, "wait_supervisor");
	assert.equal(classifyStateLoss({}).frontier.next, "retry_same_wait");

	for (const [input, reason] of [
		[{ lateSuccessAfterDeadline: true }, "late_success_after_deadline"],
		[{ acknowledged: false }, "no_ack"],
		[{ ackedBridgeTimeout: true }, "acked_bridge_timeout"],
		[{ leaseTimedOut: true }, "lease_timeout"],
		[{ urlMismatch: true }, "url_mismatch"],
		[{ loadStateUnreached: true }, "load_state_unreached"],
		[{ selectorMissing: true }, "selector_missing"],
		[{ selectorUnstable: true }, "selector_unstable"],
		[{ networkActive: true }, "network_active"],
		[{ backgroundThrottlingSuspected: true }, "background_throttling_suspected"],
		[{ underconstrained: true }, "underconstrained_wait"],
		[{ signalUnavailable: true }, "signal_unavailable"],
	] as const) {
		assert.equal(classifyTimeout(input).verdict.reasons[0], reason);
	}

	assert.equal(classifyStaleness({ tabDisconnected: true }).frontier.next, "fail_closed");
	assert.equal(classifyStaleness({ tabReplaced: true }).verdict.reasons[0], "tab_replaced");
	assert.equal(classifyStaleness({ anchorPresent: false }).verdict.status, "unknown");
	assert.equal(classifyStaleness({ signalUnavailable: true }).frontier.next, "diagnose");
	assert.equal(classifyStaleness({ selectionVersionChanged: true }).verdict.reasons[0], "selection_version_changed");
	assert.equal(classifyStaleness({ urlChanged: true }).verdict.reasons[0], "url_changed");
	assert.equal(classifyStaleness({ targetRegionDirty: true, stableLocator: true, cssOnlyLocator: false }).verdict.status, "stale");
	assert.equal(classifyStaleness({ dirtyRootsOverflow: true }).verdict.status, "possibly_stale");

	assert.equal(classifyDeadlinePressure({ remainingMs: 100, requiredMs: 10, queueDelayMs: 200 }).verdict.reasons[0], "queue_delay_budget_exceeded");
	assert.equal(classifyDeadlinePressure({ remainingMs: 100, requiredMs: 10, queueDepthAtEnqueue: 3 }).verdict.reasons[0], "queue_saturated");
	assert.equal(classifyDeadlinePressure({ remainingMs: 10, requiredMs: 100 }).frontier.next, "fail_closed");
	assert.equal(classifyDeadlinePressure({ remainingMs: 100, requiredMs: 10 }).verdict.status, "fresh");
});

test("wait diagnostics render selector, network, load-state, navigation, and generic branches", () => {
	assert.match(diagnoseWaitTimeout({ command: "wait.selector", reasons: ["selector_missing"], selector: "#submit" }).observedState, /not found/);
	assert.match(diagnoseWaitTimeout({ command: "wait.any", reasons: ["selector_unstable"], selector: ".toast" }).suggestion, /fluctuating/);
	assert.match(diagnoseWaitTimeout({ command: "wait.all", reasons: [], selectorFound: true, selectorState: "visible" }).observedState, /visible/);
	assert.match(diagnoseWaitTimeout({ command: "wait.networkIdle", reasons: [], pendingRequests: 1 }).suggestion, /1 network request/);
	assert.match(diagnoseWaitTimeout({ command: "network.wait", reasons: [] }).observedState, /in-flight/);
	assert.match(diagnoseWaitTimeout({ command: "wait.loadState", reasons: [], loadState: "loading", loadStateTarget: "load" }).suggestion, /increase timeout/);
	assert.match(diagnoseWaitTimeout({ command: "wait.navigation", reasons: ["url_changed"], urlAfter: "https://example.test/next" }).observedState, /now at/);
	assert.match(diagnoseWaitTimeout({ command: "wait.navigate", reasons: [] }).observedState, /no URL change/);
	assert.match(diagnoseWaitTimeout({ command: "other", reasons: [], clientDisconnected: true }).suggestion, /disconnected/);
	assert.match(diagnoseWaitTimeout({ command: "other", reasons: [], workerRestarts: 2 }).observedState, /restarted/);
	assert.match(diagnoseWaitTimeout({ command: "other", reasons: [], backgroundThrottling: true }).suggestion, /background tab/);
	assert.match(diagnoseWaitTimeout({ command: "other", reasons: [], bridgeTimeout: true }).observedState, /bridge/);
	assert.deepEqual(diagnoseWaitTimeout({ command: "custom.network.wait", reasons: ["signal_unavailable"] }), {
		waitType: "networkIdle",
		condition: "wait condition to be satisfied",
		observedState: "wait ended with reason: signal_unavailable",
		suggestion: "the wait timed out — try increasing the timeout, verify the page state, or use browser_observe to inspect current page content",
	});
});

test("ref store resolves current refs, tracks artifact freshness, and expires stale refs", () => {
	const artifactPath = tempArtifact("ref.json", { value: 1 });
	const now = Date.now();
	const ref = registerRefDescriptor({
		descriptor: {
			refId: "bp-ref://control/current-ref",
			kind: "control",
			locators: [{ by: "css", value: "#submit" }],
			owner: { browserSessionId: "session-2" },
			policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true },
			observationId: "obs-2",
			createdAt: now,
			ttlMs: 60_000,
		},
		artifactPath,
	});
	const resolved = resolveRefUriDetailed(ref);
	assert.equal(resolved.ok, true);
	assert.equal(resolved.ok ? resolved.ref.fresh : undefined, true);
	writeFileSync(artifactPath, JSON.stringify({ value: "changed" }), "utf8");
	const changed = resolveRefUriDetailed(ref);
	assert.equal(changed.ok ? changed.ref.fresh : undefined, false);
	assert.deepEqual(resolveRefUriDetailed("not-a-ref"), { ok: false, code: "HANDLE_NOT_FOUND", error: "Unrecognized ref URI" });

	const expiredRef = registerRefDescriptor({
		descriptor: {
			refId: "bp-ref://control/expired-ref",
			kind: "control",
			locators: [],
			owner: {},
			policy: { redaction: "default", shareableAcrossSessions: true, liveActionsAllowed: false },
			observationId: "obs-expired",
			createdAt: now - 10_000,
			ttlMs: 1,
		},
	});
	assert.deepEqual(resolveRefUriDetailed(expiredRef), { ok: false, code: "REF_STALE", error: "Ref expired" });
});
