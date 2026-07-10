import assert from "node:assert/strict";
import test from "node:test";
import { buildEffect, commandCollectsExecutionEffect, type ExecutionSignalSnapshot } from "../../src/commands/executionEffect.ts";
import { compactExecutionEffect } from "../../src/commands/executionJournal.ts";

function snapshot(overrides: Partial<ExecutionSignalSnapshot> = {}): ExecutionSignalSnapshot {
	return {
		network: { active: false },
		hook: { active: false },
		...overrides,
	};
}

test("execution effects combine settled fingerprint, recorder, target, anchor, and temporal evidence", () => {
	const before = snapshot({
		fingerprint: { changeSeq: 10, url: "https://example.test/before", visibleCount: 5, interactiveCount: 2, dirty: { roots: ["#app"], overflow: false } },
		network: { active: true, lastSeq: 3 },
		hook: { active: true, lastSeq: 8 },
		selectionVersion: 1,
		defaultTabId: 7,
	});
	const after = snapshot({
		fingerprint: { changeSeq: 12, url: "https://example.test/after", visibleCount: 8, interactiveCount: 4, dirty: { roots: ["#app > button"], overflow: false } },
		network: { active: true, lastSeq: 6 },
		hook: { active: true, lastSeq: 9 },
		selectionVersion: 2,
		defaultTabId: 8,
	});
	const quiet = snapshot({ fingerprint: { changeSeq: 12, url: "https://example.test/after", visibleCount: 8, interactiveCount: 4, dirty: { roots: ["#app > button"], overflow: false } }, network: after.network, hook: after.hook });
	const effect = buildEffect(before, after, quiet, {
		targetRefs: [{ refId: "bp-ref://element/save", observedAt: 100, observationId: "obs-1", cssRoots: ["#app"], locators: [{ by: "backendNodeId", value: 42 }] }],
	});

	assert.deepEqual({
		url: effect.url,
		mutations: effect.mutations,
		settled: effect.settled,
		navigated: effect.navigated,
		visibleDelta: effect.visibleDelta,
		interactiveDelta: effect.interactiveDelta,
		requestsFired: effect.requestsFired,
		hookEventsFired: effect.hookEventsFired,
		targetDelta: effect.targetDelta,
		anchor: effect.anchor,
		targetRef: effect.targetRef,
		targetDirtyRoots: effect.targetDirtyRoots,
	}, {
		url: "https://example.test/after",
		mutations: 2,
		settled: true,
		navigated: true,
		visibleDelta: 3,
		interactiveDelta: 2,
		requestsFired: 3,
		hookEventsFired: 1,
		targetDelta: { selectionVersionBefore: 1, selectionVersionAfter: 2, tabIdBefore: 7, tabIdAfter: 8 },
		anchor: { changeSeq: 12, networkSeq: 6, hookSeq: 9 },
		targetRef: "bp-ref://element/save",
		targetDirtyRoots: ["#app > button"],
	});
	assert.equal(effect.targetRegionDirty, true);
	assert.equal(effect.targetObservedAt, 100);
	assert.equal(effect.targetObservationId, "obs-1");
	assert.equal(effect.temporal?.verdict.status, "stale");
});

test("execution effects preserve partial and overflow semantics without empty compact fields", () => {
	assert.deepEqual(buildEffect(snapshot(), snapshot(), undefined), { signals: "partial", navigated: false });
	const overflow = buildEffect(
		snapshot({ fingerprint: { changeSeq: 1, url: "https://example.test/", dirty: { roots: [], overflow: false } } }),
		snapshot({ fingerprint: { changeSeq: 2, url: "https://example.test/", dirty: { roots: [], overflow: true, sinceSeq: 1 } } }),
		undefined,
	);
	assert.equal(overflow.signals, "partial");
	assert.equal(overflow.coverage, "overflow");
	assert.deepEqual(overflow.dirty, { roots: [], overflow: true, sinceSeq: 1 });

	assert.deepEqual(compactExecutionEffect({
		navigated: false,
		mutations: 0,
		settled: false,
		dirty: { roots: [], overflow: false },
		targetDelta: {},
		anchor: {},
		targetObservationId: "",
		targetRef: "",
		targetRegionDirty: false,
		targetDirtyRoots: [],
	}), { mutations: 0, settled: false, anchor: {} });
});

test("native command effect collection follows protocol write access", () => {
	assert.equal(commandCollectsExecutionEffect({ cmd: "tabs", method: "list" }), false);
	assert.equal(commandCollectsExecutionEffect({ cmd: "frame.list" }), false);
	assert.equal(commandCollectsExecutionEffect({ cmd: "frame.evaluate", frameId: "main", expression: "42" }), true);
});
