import assert from "node:assert/strict";
import test from "node:test";
import { normalizedNextActions } from "../../src/commands/resultNextActions.ts";

test("result next actions characterize saved artifact reads and correlation paths", () => {
	const summary = {
		requestId: "request-1",
		waitId: "wait-1",
		listenerId: "listener-1",
		artifact_hints: {
			preferredReads: [
				{ jsonPath: "data.items[0]" },
				{ jsonPath: "" },
				{ jsonPath: "data.items[1]" },
				{ jsonPath: "data.items[0]" },
			],
		},
	};
	assert.deepEqual(normalizedNextActions({}, summary, { path: "artifact.json" }, { operationId: "operation-1" }, { snapshotId: "snapshot-1" }), [
		"read_saved_artifact mode=json jsonPath=data.items[0]",
		"read_saved_artifact mode=json jsonPath=data.items[1]",
		"read_saved_artifact mode=json jsonPath=operation.operationId",
		"read_saved_artifact mode=json jsonPath=snapshot.snapshotId",
		"read_saved_artifact mode=json jsonPath=data.requestId",
	]);
	assert.deepEqual(normalizedNextActions({}, { dataInline: true, artifact_hints: summary.artifact_hints }, { path: "artifact.json" }), [
		"read_saved_artifact mode=json jsonPath=data.items[0]",
		"read_saved_artifact mode=json jsonPath=data.items[1]",
	]);
	assert.deepEqual(normalizedNextActions({}, {}, { path: "artifact.json" }), ["read_saved_artifact mode=json", "read_saved_artifact mode=text"]);
});

test("result next actions characterize entity kind projections", () => {
	const cases: Array<{ kind?: string; expected: string[] }> = [
		{ kind: "control", expected: ["read(bp-ref://element/one)", "click(bp-ref://element/one)"] },
		{ kind: "element", expected: ["read(bp-ref://element/one)", "click(bp-ref://element/one)"] },
		{ kind: "region", expected: ["read(bp-ref://element/one)", "inspect(bp-ref://element/one)"] },
		{ kind: "frame", expected: ["read(bp-ref://element/one)", "frame(bp-ref://element/one)"] },
		{ kind: "unknown", expected: ["read(bp-ref://element/one)"] },
	];
	for (const { kind, expected } of cases) {
		assert.deepEqual(normalizedNextActions({}, {}, undefined, undefined, undefined, [], [{ kind: "ignored" }, { ref: "bp-ref://element/one", kind }]), expected);
	}
	assert.equal(normalizedNextActions({}, {}, undefined, undefined, undefined, [], [{ kind: "control" }]), undefined);
});

test("result next actions characterize pagination, failure, truncation, and target recovery", () => {
	assert.deepEqual(normalizedNextActions({}, { nextOffset: 10 }, { path: "artifact.json" }), [
		"read_saved_artifact mode=json",
		"read_saved_artifact mode=text",
		"read_saved_artifact offset=10",
	]);
	assert.deepEqual(normalizedNextActions({}, { bodyUnavailableReason: "expired" }), ["inspect network body with a fresh recorder entry or recapture with captureBodies enabled"]);
	assert.deepEqual(normalizedNextActions({}, { notFound: true, nearestPath: "data.items" }), [
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
	assert.deepEqual(normalizedNextActions({}, {}, undefined, undefined, undefined, ["keep", "drop path=/tmp/file", "keep"]), ["keep"]);
	assert.deepEqual(normalizedNextActions({}, { delta: "session" }, undefined, undefined, undefined, [
		"read(bp-ref://element/one)",
		"click(bp-ref://element/one)",
		"read(bp-ref://element/two)",
		"read(bp-ref://element/three)",
		"read(bp-ref://element/four)",
		"plain recovery",
	]), [
		"read(bp-ref://element/one)",
		"click(bp-ref://element/one)",
		"read(bp-ref://element/two)",
		"read(bp-ref://element/three)",
		"plain recovery",
	]);
	assert.deepEqual(normalizedNextActions({}, {}, undefined, undefined, undefined, Array.from({ length: 9 }, (_, index) => `action-${index}`)), Array.from({ length: 7 }, (_, index) => `action-${index}`));
	assert.equal(normalizedNextActions({}, {}), undefined);
});
