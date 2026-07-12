import assert from "node:assert/strict";
import test from "node:test";
import { normalizedNextActions } from "../../src/commands/resultNextActions.ts";

test("result next actions only recommend saved artifact reads when inline evidence is insufficient", () => {
	const summary = {
		requestId: "request-1",
		waitId: "wait-1",
		listenerId: "listener-1",
		artifact_hints: {
			preferredReads: [{ jsonPath: "data.unverified" }],
		},
	};
	const verifiedArtifactHints = {
		preferredReads: [
			{ jsonPath: "data.items[0]" },
			{ jsonPath: "" },
			{ jsonPath: "data.items[1]" },
			{ jsonPath: "data.items[0]" },
		],
	};
	assert.equal(normalizedNextActions({}, summary, { path: "artifact.json" }, verifiedArtifactHints), undefined);
	assert.deepEqual(normalizedNextActions({}, { ...summary, dataInline: false }, { path: "artifact.json" }, verifiedArtifactHints), [
		"read_saved_artifact mode=json jsonPath=data.items[0]",
		"read_saved_artifact mode=json jsonPath=data.items[1]",
	]);
	assert.equal(normalizedNextActions({}, { dataInline: false, artifact_hints: summary.artifact_hints }, { path: "artifact.json" }), undefined);
	assert.equal(normalizedNextActions({}, { dataInline: true }, { path: "artifact.json" }, verifiedArtifactHints), undefined);
	assert.equal(normalizedNextActions({}, {}, { path: "artifact.json" }), undefined);
});

test("result next actions discard retired entity pseudo-verbs", () => {
	assert.deepEqual(normalizedNextActions({}, {}, undefined, undefined, [
		"click(bp-ref://element/one)",
		"read(bp-ref://element/one)",
		"browser_observe diff:true",
	]), ["browser_observe diff:true"]);
	assert.deepEqual(normalizedNextActions({}, { dataInline: false }, { path: "artifact.json" }, {
		jsonPaths: { verified: "data.verified" },
		preferredReads: [{ jsonPath: "data.verified" }],
	}, [
		"read_saved_artifact mode=json jsonPath=data.missing",
		"read_saved_artifact mode=json jsonPath=data.verified",
	]), ["read_saved_artifact mode=json jsonPath=data.verified"]);
	assert.equal(normalizedNextActions({}, {}, undefined, { jsonPaths: { verified: "data.verified" } }, [
		"read_saved_artifact mode=json jsonPath=data.verified",
	]), undefined);
});

test("result next actions characterize pagination, failure, truncation, and target recovery", () => {
	assert.deepEqual(normalizedNextActions({}, { nextOffset: 10 }, { path: "artifact.json" }), [
		"read_saved_artifact offset=10",
	]);
	assert.deepEqual(normalizedNextActions({}, { bodyUnavailableReason: "expired" }), ["inspect network body with a fresh recorder entry or recapture with captureBodies enabled"]);
	assert.deepEqual(normalizedNextActions({}, { notFound: true, nearestPath: "data.items" }), [
		"narrow the target ref/filter or re-run browser_observe; for exact DOM inspection use explicit legacy/debug projection browser_observe mode=html",
	]);
	assert.deepEqual(normalizedNextActions({}, { notFound: true, nearestPath: "data.items" }, { path: "artifact.json" }, { jsonPaths: { nearest: "data.items" } }), [
		"read_saved_artifact mode=json jsonPath=data.items",
		"narrow the target ref/filter or re-run browser_observe; for exact DOM inspection use explicit legacy/debug projection browser_observe mode=html",
	]);
	assert.deepEqual(normalizedNextActions({}, { empty: true }), ["narrow the target ref/filter or re-run browser_observe; for exact DOM inspection use explicit legacy/debug projection browser_observe mode=html"]);
	for (const summary of [{ truncated: true }, { bodyTruncated: true }, { truncatedCases: true }, { truncatedCandidates: 1 }]) {
		assert.deepEqual(normalizedNextActions({}, summary), ["increase maxChars/maxBodyBytes or inspect the saved artifact by jsonPath/offset"]);
	}
	for (const summary of [{ tabId: 1 }, { targetRef: "tab-1" }, { target: {} }]) {
		assert.deepEqual(normalizedNextActions({}, summary), ["pass explicit targetRef/browserSessionId for follow-up tab-scoped calls"]);
		assert.equal(normalizedNextActions({ browserSessionId: "session-1" }, summary), undefined);
	}
});

test("result next actions characterize hint filtering, dedupe, session fanout, and output cap", () => {
	assert.deepEqual(normalizedNextActions({}, {}, undefined, undefined, ["keep", "drop path=/tmp/file", "keep"]), ["keep"]);
	assert.deepEqual(normalizedNextActions({}, { delta: "session" }, undefined, undefined, [
		"use browser_execute with bp-ref://element/one",
		"verify bp-ref://element/one before another action",
		"use browser_execute with bp-ref://element/two",
		"use browser_execute with bp-ref://element/three",
		"use browser_execute with bp-ref://element/four",
		"plain recovery",
	]), [
		"use browser_execute with bp-ref://element/one",
		"verify bp-ref://element/one before another action",
		"use browser_execute with bp-ref://element/two",
		"use browser_execute with bp-ref://element/three",
		"plain recovery",
	]);
	assert.deepEqual(normalizedNextActions({}, {}, undefined, undefined, Array.from({ length: 9 }, (_, index) => `action-${index}`)), Array.from({ length: 7 }, (_, index) => `action-${index}`));
	assert.equal(normalizedNextActions({}, {}), undefined);
});
