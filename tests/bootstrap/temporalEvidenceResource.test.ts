import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { allocateTemporalBudget, classifyDeadlinePressure, compareTemporalCost } from "../../src/kernels/temporal/budget.ts";
import { classifyStateLoss, classifyStaleness, classifyTimeout, diagnoseWaitTimeout } from "../../src/kernels/temporal/classify.ts";
import { estimatePageFreshness, estimateTargetContinuity, estimateWaitContinuity } from "../../src/kernels/temporal/estimate.ts";
import type { TemporalAnchor, TemporalCost, TemporalStamp } from "../../src/kernels/temporal/types.ts";
import { fitInlineJsonToBudgetMeasured } from "../../src/kernels/evidence/distill/fit.ts";
import { countDistillTruncationMarkers, fitSalienceEnvelopeBudget } from "../../src/kernels/evidence/distill/salienceEnvelope.ts";
import type { BudgetedEnvelope } from "../../src/kernels/evidence/distill/ladder.ts";
import { applyVerificationStrike, memoryStampSetId, transitionStrikeCount, verifyMemoryAnchors } from "../../src/kernels/memory/staleness.ts";
import { clearResourceStore, listResources, parseBrowserPilotRefUri, parseResourceUri, pruneExpired, registerBrowserResultResource, registerRefDescriptor, resolveRefUriDetailed, resolveResourceUri, resourceRefStore, stats } from "../../src/resources/resourceRefs.ts";

function tempArtifact(name: string, value: unknown): string {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-task4-"));
	const filePath = path.join(cwd, name);
	writeFileSync(filePath, JSON.stringify(value), "utf8");
	return filePath;
}

function stamp(overrides: Partial<TemporalStamp> = {}): TemporalStamp {
	return {
		browserSessionId: "session-1",
		tabHandle: "tab-1",
		targetRef: "target-1",
		tabId: 1,
		url: "https://example.test/app",
		clockDomain: "dom",
		capturedAtMs: 1_000,
		pageEpoch: "page-1",
		changeSeq: 7,
		...overrides,
	};
}

function anchor(overrides: Partial<TemporalStamp> = {}): TemporalAnchor {
	return { stamp: stamp(overrides) };
}

test("temporal estimates classify continuity, staleness, and wait recovery boundary branches", () => {
	assert.deepEqual(estimateTargetContinuity({}).verdict.reasons, ["unknown_due_to_missing_anchor"]);
	assert.equal(estimateTargetContinuity({ anchor: anchor(), current: stamp({ browserSessionId: "session-2" }) }).frontier.next, "fail_closed");
	assert.equal(estimateTargetContinuity({ anchor: anchor(), current: stamp({ tabHandle: "tab-2" }) }).verdict.reasons[0], "tab_replaced");
	assert.equal(estimateTargetContinuity({ anchor: anchor({ selectionVersion: 1 }), current: stamp({ selectionVersion: 2 }) }).verdict.reasons[0], "selection_version_changed");
	assert.equal(estimateTargetContinuity({ anchor: anchor({ clockDomain: "a", tabHandle: undefined, targetRef: undefined, tabId: undefined }), current: stamp({ clockDomain: "b", tabHandle: undefined, targetRef: undefined, tabId: undefined, changeSeq: undefined }) }).verdict.reasons[0], "unknown_due_to_clock_domain");
	assert.equal(estimateTargetContinuity({ anchor: anchor({ pageEpoch: "page-1" }), current: stamp({ pageEpoch: "page-1" }) }).frontier.next, "reuse_target");

	assert.equal(estimatePageFreshness({ anchor: anchor(), current: stamp({ url: "https://example.test/other" }) }).verdict.status, "stale");
	assert.equal(estimatePageFreshness({ anchor: anchor(), current: stamp({ dirtySinceSeq: 3 }) }).verdict.status, "possibly_stale");
	assert.equal(estimatePageFreshness({ anchor: anchor({ clockDomain: "a", changeSeq: undefined }), current: stamp({ clockDomain: "b", changeSeq: undefined }) }).verdict.reasons[0], "unknown_due_to_clock_domain");
	assert.equal(estimatePageFreshness({ anchor: anchor(), current: stamp({ capturedAtMs: 10_000 }), maxSameDomainAgeMs: 500 }).verdict.status, "possibly_stale");
	assert.equal(estimatePageFreshness({ anchor: anchor(), current: stamp() }).frontier.next, "reuse_target");

	assert.equal(estimateWaitContinuity({ historyLost: true }).frontier.next, "diagnose");
	assert.equal(estimateWaitContinuity({ previousWorkerBootId: "a", currentWorkerBootId: "b" }).verdict.confidence, "lost");
	assert.equal(estimateWaitContinuity({ eventSource: "poll_fallback" }).verdict.status, "possibly_stale");
	assert.equal(estimateWaitContinuity({ eventSource: "wait_supervisor" }).verdict.status, "fresh");
});

test("temporal classifiers and budget planner cover timeout priorities and deadline fallbacks", () => {
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

	const cheap: TemporalCost = { wallMs: 50, bridgeRoundTrips: 1, expectedToolCalls: 1, tokenChars: 100, confidenceLoss: 1 };
	const expensive: TemporalCost = { wallMs: 60, bridgeRoundTrips: 1, expectedToolCalls: 1, tokenChars: 100, confidenceLoss: 1 };
	assert.ok(compareTemporalCost(cheap, expensive) < 0);
	assert.equal(allocateTemporalBudget({ remainingMs: 10, reserveMs: 5, candidates: [{ action: "reobserve", reason: "target_possibly_stale", cost: cheap, expectedEvidence: ["page_signal"] }] }).action, "fail_closed");
	assert.equal(allocateTemporalBudget({ remainingMs: 100, candidates: [{ action: "diagnose", reason: "signal_unavailable", cost: expensive, expectedEvidence: ["driver_snapshot"] }, { action: "reobserve", reason: "target_possibly_stale", cost: cheap, expectedEvidence: ["page_signal"], frontierNext: "reobserve", verdict: { status: "possibly_stale", confidence: "bounded", reasons: ["target_possibly_stale"] } }] }).action, "reobserve");
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
});

test("evidence fit trims array/object payloads and salience envelope prefers structural compact candidates", () => {
	const arrayResult = { value: { type: "array", offset: 2, count: 10, items: Array.from({ length: 8 }, (_, index) => ({ index, text: "x".repeat(80) })) } };
	const arrayFit = fitInlineJsonToBudgetMeasured(arrayResult, 400);
	assert.equal((arrayFit.value as typeof arrayResult).value.budgetTrimmed, true);
	assert.equal((arrayFit.value as typeof arrayResult).value.nextOffset, 3);
	assert.ok(arrayFit.length <= 400);

	const objectResult = { value: { a: "x".repeat(100), b: "y".repeat(100), c: "z".repeat(100), d: "w".repeat(100) } };
	const objectFit = fitInlineJsonToBudgetMeasured(objectResult, 260);
	assert.equal(typeof ((objectFit.value as typeof objectResult).value.truncatedKeys), "number");
	assert.equal(fitInlineJsonToBudgetMeasured({ value: { only: "x".repeat(500) } }, 50).length > 50, true);

	const envelope: BudgetedEnvelope = {
		tool: "browser_observe",
		detailLevel: "full",
		summary: { title: "Checkout", textPreview: "summary" },
		nextActions: ["Click bp-ref://control/pay"],
		diagnostics: { warnings: ["existing"] },
		snapshotProjection: { summary: { templateCount: 1, instanceCount: 2 }, templates: [{ templateKey: "checkout", count: 2, instances: [{ ref: "bp-ref://control/pay", name: "Pay now", role: "button" }, { ref: "bp-ref://control/cancel", name: "Cancel", role: "button" }] }] },
		collections: [{ kind: "list", itemRefs: ["bp-ref://control/pay"], completeness: "complete" }],
		diff: { summary: { changed: 1 }, verbose: "d".repeat(2_000) },
		treeDiff: { summary: { changed: 1 }, verbose: "t".repeat(2_000) },
		relations: { summary: { labelled: 1 }, verbose: "r".repeat(2_000) },
		entities: [
			{ ref: "bp-ref://control/cancel", name: "Cancel", role: "button", value: "c".repeat(500) },
			{ ref: "bp-ref://control/pay", name: "Pay now", role: "button", selector: "#pay", value: "p".repeat(500) },
		],
	};
	const fitted = fitSalienceEnvelopeBudget(envelope, 1_500, { granularityCeiling: "compact" });
	assert.ok(JSON.stringify(fitted).length <= 1_500);
	assert.equal(typeof fitted.summary, "object");
	assert.deepEqual(fitted.nextActions, envelope.nextActions);
	assert.equal(countDistillTruncationMarkers({ text: "truncated ... omitted …" }), 4);

	const ladderFallback = fitSalienceEnvelopeBudget({ ...envelope, summary: { textPreview: "x".repeat(10_000) } }, 50);
	assert.equal(ladderFallback.summary.summaryTruncatedToBudget === true || JSON.stringify(ladderFallback).length <= 1_000, true);
});

test("memory staleness kernel verifies anchors, stamp sets, and strike transitions", () => {
	assert.deepEqual(verifyMemoryAnchors(undefined, { canonicalUrl: "https://example.test/app" }), { status: "unverified", reasons: ["no-anchors"] });
	assert.deepEqual(verifyMemoryAnchors({ canonicalUrl: "https://example.test/app", stampSetId: "a", fingerprintSummary: { b: 2, a: [1] } }, { canonicalUrl: "https://example.test/app", stampSetId: "a", fingerprintSummary: { a: [1], b: 2 } }), { status: "fresh", reasons: ["anchors-match"] });
	assert.deepEqual(verifyMemoryAnchors({ canonicalUrl: "https://example.test/app", stampSetId: "a", fingerprintSummary: { count: 1 } }, { canonicalUrl: "https://example.test/other", stampSetId: "b", fingerprintSummary: { count: 2 } }).reasons, ["canonicalUrl", "stampSetId", "fingerprintSummary"]);
	assert.equal(memoryStampSetId({ b: "2", a: "1", empty: "" }), "a:1|b:2");
	assert.equal(memoryStampSetId({ empty: "" }), undefined);
	assert.equal(transitionStrikeCount(3, "fresh"), undefined);
	assert.equal(transitionStrikeCount(undefined, "stale"), 1);
	assert.equal(transitionStrikeCount(2, "unverified"), 2);
	const profile = { schemaVersion: 1 as const, origin: "https://example.test", sessions: [], termStats: {}, urls: [], strikes: { stale: 2, fresh: 1 } };
	assert.deepEqual(applyVerificationStrike(profile, "fresh", "fresh").strikes, { stale: 2 });
	assert.deepEqual(applyVerificationStrike(profile, "other", "stale").strikes, { stale: 2, fresh: 1, other: 1 });
});

test("resource store rejects traversal and malformed refs without leaking path payloads", () => {
	clearResourceStore();
	const artifactPath = tempArtifact("secret-local-path.json", { secret: "local-only" });
	const uri = registerBrowserResultResource({ kind: "evidence", artifactPath, name: "evidence" });
	const resource = resolveResourceUri(uri);
	assert.ok(resource);

	const sensitiveInputs = [
		"browser-result://../outside/secret-local-path.json",
		"browser-result://..%2foutside%2fsecret-local-path.json",
		"browser-result:///etc/passwd",
		"browser-result://C:/Users/Alice/AppData/secret-local-path.json",
		"browser-result://C:\\Users\\Alice\\AppData\\secret-local-path.json",
		"file:///C:/Users/Alice/AppData/secret-local-path.json",
		"https://example.test/secret-local-path.json",
		"bp-ref://data-slice/../outside/secret-local-path.json",
		"bp-ref://data-slice/..%2foutside%2fsecret-local-path.json",
		"bp-ref://data-slice/C:/Users/Alice/AppData/secret-local-path.json",
		"bp-ref://data-slice/C:\\Users\\Alice\\AppData\\secret-local-path.json",
		"bp-ref://data-slice/%2fetc%2fpasswd",
		"bp-ref://data-slice",
		"bp-ref://data-slice/other-scope/missing-id",
		`${resource.refId}/../outside/secret-local-path.json`,
	];

	for (const input of sensitiveInputs) {
		const resolved = resolveRefUriDetailed(input);
		assert.equal(resolved.ok, false, input);
		if (resolved.ok) continue;
		assert.match(resolved.error, /^(Unrecognized ref URI|Ref not found|Resource not found)$/);
		assert.doesNotMatch(resolved.error, /secret-local-path|Alice|AppData|etc\/passwd|\.\.|%2f|C:/i);
	}

	const missingResource = resolveRefUriDetailed("browser-result://missing-secret-local-path");
	assert.equal(missingResource.ok, false);
	assert.equal(missingResource.ok ? undefined : missingResource.error, "Resource not found");
	assert.doesNotMatch(missingResource.ok ? "" : missingResource.error, /missing-secret-local-path/);
	clearResourceStore();
});

test("resource store handles expired and missing backing refs without path disclosure", () => {
	clearResourceStore();
	const artifactPath = tempArtifact("cross-scope-secret.json", { ok: true });
	const uri = registerBrowserResultResource({ kind: "evidence", artifactPath, name: "evidence" });
	const resource = resolveResourceUri(uri);
	assert.ok(resource);
	const now = Date.now();
	const backedRef = registerRefDescriptor({
		descriptor: {
			kind: "data-slice",
			locators: [],
			owner: {},
			policy: { redaction: "default", shareableAcrossSessions: true, liveActionsAllowed: false },
			snapshot: { observationId: "obs-backed", resourceUri: uri, immutable: true },
			observationId: "obs-backed",
			createdAt: now,
			ttlMs: 60_000,
		},
		name: "backed",
	});
	assert.equal(resolveRefUriDetailed(backedRef).ok, true);
	resource.expiresAt = Date.now() - 1;
	const expiredBacking = resolveRefUriDetailed(backedRef);
	assert.equal(expiredBacking.ok, false);
	assert.equal(expiredBacking.ok ? undefined : expiredBacking.code, "HANDLE_EXPIRED");
	assert.equal(expiredBacking.ok ? undefined : expiredBacking.error, "Resource expired");
	assert.doesNotMatch(expiredBacking.ok ? "" : expiredBacking.error, /cross-scope-secret|browser-result|bp-ref|\.browser-pilot|[A-Z]:\\/i);

	const missingWrapped = resolveRefUriDetailed("bp-ref://data-slice/missing-cross-scope-secret");
	assert.equal(missingWrapped.ok, false);
	assert.equal(missingWrapped.ok ? undefined : missingWrapped.error, "Resource not found");
	assert.doesNotMatch(missingWrapped.ok ? "" : missingWrapped.error, /missing-cross-scope-secret|cross-scope-secret|[A-Z]:\\/i);

	const expiredRef = registerRefDescriptor({
		descriptor: {
			refId: "bp-ref://control/expired-local-secret",
			kind: "control",
			locators: [],
			owner: {},
			policy: { redaction: "default", shareableAcrossSessions: true, liveActionsAllowed: false },
			observationId: "obs-expired-local-secret",
			createdAt: Date.now() - 10_000,
			ttlMs: 1,
		},
	});
	const expired = resolveRefUriDetailed(expiredRef);
	assert.equal(expired.ok, false);
	assert.equal(expired.ok ? undefined : expired.code, "REF_STALE");
	assert.equal(expired.ok ? undefined : expired.error, "Ref expired");
	assert.doesNotMatch(expired.ok ? "" : expired.error, /expired-local-secret|bp-ref/);
	clearResourceStore();
});
test("resource store resolves wrapped refs, expiry, backing resources, and store ports", () => {
	clearResourceStore();
	const artifactPath = tempArtifact("network.json", { requests: [{ id: 1, body: "ok" }] });
	const uri = registerBrowserResultResource({ kind: "http-request", artifactPath, jsonPath: "$.requests[0]", name: "request", mime: "application/json", bytes: 10, browserSessionId: "session-1", redaction: "disabled" });
	assert.match(uri, /^browser-result:\/\//);
	assert.equal(parseResourceUri(`${uri}/extra?mode=json`), parseResourceUri(uri));
	assert.equal(parseResourceUri("http://example.test"), undefined);
	const resource = resolveResourceUri(uri);
	assert.ok(resource);
	assert.equal(resource.hash?.length, 64);
	assert.equal(resourceRefStore.isResourceFresh(resource), true);
	const wrapped = resolveRefUriDetailed(resource.refId);
	assert.equal(wrapped.ok, true);
	assert.equal(wrapped.ok ? wrapped.ref.resourceUri : undefined, uri);
	assert.equal(wrapped.ok ? wrapped.ref.redaction : undefined, "disabled");

	const now = Date.now();
	const backingRef = registerRefDescriptor({
		descriptor: {
			kind: "data-slice",
			locators: [],
			owner: {},
			policy: { redaction: "default", shareableAcrossSessions: true, liveActionsAllowed: false },
			snapshot: { observationId: "obs-1", resourceUri: uri, immutable: true },
			observationId: "obs-1",
			createdAt: now,
			ttlMs: 60_000,
		},
		name: "backed",
	});
	const backed = resolveRefUriDetailed(backingRef);
	assert.equal(backed.ok, true);
	assert.equal(backed.ok ? backed.ref.artifactPath : undefined, artifactPath);
	assert.deepEqual(parseBrowserPilotRefUri(backingRef)?.kind, "data-slice");

	const directRef = registerRefDescriptor({
		descriptor: {
			refId: "bp-ref://control/manual-control",
			kind: "control",
			locators: [{ by: "css", value: "#submit" }],
			owner: { browserSessionId: "session-2" },
			policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true },
			observationId: "obs-2",
			createdAt: now,
			ttlMs: 60_000,
		},
		artifactPath,
		resourceKind: "scan",
		browserSessionId: "session-2",
	});
	assert.equal(resolveRefUriDetailed(directRef).ok, true);
	assert.equal(resolveRefUriDetailed("not-a-ref").ok, false);
	assert.ok(listResources().length >= 1);
	assert.ok(stats().totalEntries >= 3);
	resource.expiresAt = Date.now() - 1;
	assert.equal(resolveResourceUri(uri), undefined);
	assert.equal(resolveRefUriDetailed(resource.refId).ok, false);

	const expiredRef = registerRefDescriptor({
		descriptor: {
			refId: "bp-ref://control/expired-ref",
			kind: "control",
			locators: [],
			owner: {},
			policy: { redaction: "default", shareableAcrossSessions: true, liveActionsAllowed: false },
			observationId: "obs-expired",
			createdAt: Date.now() - 10_000,
			ttlMs: 1,
		},
	});
	assert.equal(resolveRefUriDetailed(expiredRef).ok, false);
	pruneExpired();
	assert.equal(stats().lastEviction?.reason, undefined);
	clearResourceStore();
});
