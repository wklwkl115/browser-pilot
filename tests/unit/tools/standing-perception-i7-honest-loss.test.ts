/**
 * I7 contract test — "Honest loss"
 *
 * Invariant: No standing state survives a daemon restart as if continuous;
 * durable evidence lives only in artifacts. A fresh server/ledger instance must
 * behave exactly like a cold start: no prior frame is served, scan re-executes
 * (eval count increments), and stale snapshot handles do not resolve to
 * fabricated state.
 *
 * How this fails: if someone adds cross-instance persistent state (serialized
 * ledger, shared module-level map, etc.) the "fresh instance" lookups would
 * return data, and the assertions here would fire.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PerceptionLedger, factsFromEntities, type PerceptionLedgerFrame, type PerceptionLedgerKey } from "../../../src/abml/perceptionLedger.ts";
import type { Entity } from "../../../src/abml/entity.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeKey(tabId = 7, url = "https://example.test/app"): PerceptionLedgerKey {
	return { browserSessionId: "session-1", tabId, navigationEpoch: url };
}

function makeEntity(ref: string, name: string): Entity {
	return {
		ref,
		kind: "control",
		role: "button",
		name,
		state: {},
		structure: {},
	} as unknown as Entity;
}

function makeFrame(key: PerceptionLedgerKey, snapshotId: string): PerceptionLedgerFrame {
	return {
		key,
		snapshotId,
		capturedAt: Date.now(),
		facts: factsFromEntities([makeEntity("pi-ref://control/pay", "Pay now")], "full"),
		pageFingerprint: {
			changeSeq: 42,
			url: key.navigationEpoch,
			visibleCount: 10,
			interactiveCount: 3,
		},
		renderCache: {
			mode: "scan",
			detailLevel: "summary",
			maxChars: 12_000,
			paramsSignature: "sig-v1",
			renderedAt: Date.now(),
		},
	};
}

// ── Test 1: fresh ledger instance has no knowledge of prior ledger instance ──

test("I7: fresh PerceptionLedger instance returns no prior frame (cold start)", () => {
	const key = makeKey();

	// (a) Populate standing state in instance A
	const ledgerA = new PerceptionLedger();
	const frame = makeFrame(key, "snap-A-001");
	ledgerA.record(frame);

	// Verify instance A has the frame
	const gotFromA = ledgerA.get(key);
	assert.equal(gotFromA?.snapshotId, "snap-A-001", "instance A must have the recorded frame");

	// (b) Simulate restart: construct a FRESH instance
	const ledgerB = new PerceptionLedger();

	// (c) Assert: no frame is served from the new instance
	const gotFromB = ledgerB.get(key);
	assert.equal(gotFromB, undefined,
		"I7: fresh ledger instance must return undefined — no state may survive a restart");
});

// ── Test 2: fresh instance has no recent() history ────────────────────────────

test("I7: fresh PerceptionLedger instance exposes empty recent() history (cold start)", () => {
	const key = makeKey();

	// Populate instance A
	const ledgerA = new PerceptionLedger();
	ledgerA.record(makeFrame(key, "snap-A-002"));
	ledgerA.record(makeFrame({ ...key, navigationEpoch: "https://example.test/app#checkout" }, "snap-A-003"));

	assert.equal(ledgerA.recent(key).length >= 1, true, "instance A must have recent frames");

	// Fresh instance
	const ledgerB = new PerceptionLedger();
	const recentFromB = ledgerB.recent(key);
	assert.equal(recentFromB.length, 0,
		`I7: fresh ledger instance must have zero recent frames. Got: ${recentFromB.length}`);
});

// ── Test 3: fresh instance trace is empty ─────────────────────────────────────

test("I7: fresh PerceptionLedger instance has no trace terms (cold start)", () => {
	const ledgerA = new PerceptionLedger();
	// Record trace terms in instance A via the correct API
	ledgerA.recordTraceTerms("session-1", [{ term: "checkout", kind: "intent" }, { term: "payment", kind: "action" }]);
	const traceA = ledgerA.traceSnapshot("session-1");
	assert.equal(traceA.terms.length >= 1, true, "instance A must record trace terms");

	// Fresh instance
	const ledgerB = new PerceptionLedger();
	const traceB = ledgerB.traceSnapshot("session-1");
	assert.equal(traceB.terms.length, 0,
		`I7: fresh ledger instance must have zero trace terms. Got: ${traceB.terms.length}`);
	assert.equal(traceB.latestSeq, 0,
		"I7: fresh ledger instance must have latestSeq=0");
});

// ── Test 4: render cache on fresh instance is absent — forcing re-execution ───

test("I7: fresh instance returns no render-cache frame — forcing re-execution", () => {
	// renderCacheMatches in scanRunner.ts only proceeds if ledgerFrame is defined
	// and has a renderCache block. Assert that a fresh ledger instance always
	// returns undefined for such a frame, which means renderCacheMatches always
	// receives undefined and falls through to a live scan eval.

	const key = makeKey();
	const ledgerA = new PerceptionLedger();
	const frame = makeFrame(key, "snap-cache-001");
	ledgerA.record(frame);

	// Verify that instance A would return the cache frame
	const cached = ledgerA.get(key);
	assert.equal(cached?.snapshotId, "snap-cache-001", "instance A must have the cache entry");
	assert.notEqual(cached?.renderCache, undefined, "instance A must have render cache metadata");

	// Fresh instance: the same lookup must return nothing
	const ledgerB = new PerceptionLedger();
	const notCached = ledgerB.get(key);
	assert.equal(notCached, undefined,
		"I7: fresh ledger instance must not have any cached render entry — observe must re-execute");
	// Specifically: if notCached is undefined, then renderCacheMatches(undefined, ...)
	// returns false, forcing a full scan eval. Confirm that:
	assert.equal(notCached?.renderCache, undefined,
		"I7: undefined frame yields no render cache — scan must re-execute rather than serve stale content");
});

// ── Test 5: stale snapshot handle from old instance does not resolve on fresh instance ──

test("I7: snapshot handle from a prior instance does not resolve on a fresh instance", () => {
	const key = makeKey();

	// Populate instance A, record a snapshotId into the frame
	const ledgerA = new PerceptionLedger();
	const priorSnapshotId = "snap-prior-001";
	ledgerA.record(makeFrame(key, priorSnapshotId));

	// Get the snapshotId that was recorded
	const priorFrame = ledgerA.get(key);
	assert.equal(priorFrame?.snapshotId, priorSnapshotId, "instance A must have the snapshot id");

	// Fresh instance: looking up the same key must return undefined
	// (the priorSnapshotId is opaque to the fresh ledger)
	const ledgerB = new PerceptionLedger();
	const freshFrame = ledgerB.get(key);
	assert.equal(freshFrame, undefined,
		"I7: the prior snapshot handle must not be resolvable from a fresh ledger instance");

	// Looking up by a different key must also return nothing
	const differentKey = makeKey(99, "https://other.test/");
	const crossFrame = ledgerB.get(differentKey);
	assert.equal(crossFrame, undefined,
		"I7: no fabricated state should appear for any key on a fresh instance");
});

// ── Test 6: LRU cap survives within an instance but does not leak across ──────

test("I7: LRU eviction within a single instance does not carry state to a fresh instance", () => {
	const ledgerA = new PerceptionLedger();

	// Fill beyond LRU cap (8 frames per session×tab) with different navigation epochs
	for (let index = 0; index < 10; index++) {
		ledgerA.record(makeFrame(
			{ browserSessionId: "session-1", tabId: 7, navigationEpoch: `https://example.test/page/${index}` },
			`snap-lru-${index}`,
		));
	}

	// Oldest 2 should be evicted from instance A
	const oldest = ledgerA.get({ browserSessionId: "session-1", tabId: 7, navigationEpoch: "https://example.test/page/0" });
	// (may be evicted or present depending on LRU policy; either way...)
	// Fresh instance must have nothing
	const ledgerB = new PerceptionLedger();
	for (let index = 0; index < 10; index++) {
		const frameB = ledgerB.get({ browserSessionId: "session-1", tabId: 7, navigationEpoch: `https://example.test/page/${index}` });
		assert.equal(frameB, undefined,
			`I7: frame for page/${index} must not exist on fresh instance (prior instance state leaking). oldest in A: ${oldest?.snapshotId}`);
	}
});
