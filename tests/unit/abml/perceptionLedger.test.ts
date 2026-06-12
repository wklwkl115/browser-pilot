import test from "node:test";
import assert from "node:assert/strict";
import { factsFromEntities, PerceptionLedger, stableRefsFromFrames } from "../../../src/abml/perceptionLedger.ts";

function frame(n: number) {
	return { key: { browserSessionId: "s", tabId: 1, navigationEpoch: `https://example.test/${n}` }, snapshotId: `snap-${n}`, capturedAt: n, facts: {} };
}

test("PerceptionLedger keeps at most eight frames per session tab", () => {
	const ledger = new PerceptionLedger();
	for (let i = 0; i < 10; i += 1) ledger.record(frame(i));
	assert.equal(ledger.get(frame(0).key), undefined);
	assert.equal(ledger.get(frame(1).key), undefined);
	assert.equal(ledger.get(frame(2).key)?.snapshotId, "snap-2");
	assert.equal(ledger.get(frame(9).key)?.snapshotId, "snap-9");
});

test("PerceptionLedger stores allocation stats and returns recent frames by session tab", () => {
	const ledger = new PerceptionLedger();
	for (let i = 0; i < 4; i += 1) ledger.record({ ...frame(i), allocation: { budgetUsedRatio: i / 4, omittedCount: i } });
	const recent = ledger.recent(frame(3).key, 3);
	assert.deepEqual(recent.map((item) => item.snapshotId), ["snap-3", "snap-2", "snap-1"]);
	assert.deepEqual(recent.map((item) => item.allocation?.omittedCount), [3, 2, 1]);
});

test("PerceptionLedger shares objective substrate across browser sessions while keeping session views", () => {
	const ledger = new PerceptionLedger();
	const facts = { pay: { versionStamp: "v1", lastShownGranularity: "compact" as const } };
	const first = ledger.record({ ...frame(1), snapshotId: "snap-a", facts, pageFingerprint: { changeSeq: 4, url: "https://example.test/1" } });
	const second = ledger.record({ ...frame(1), key: { ...frame(1).key, browserSessionId: "other" }, snapshotId: "snap-b", facts, pageFingerprint: { changeSeq: 4, url: "https://example.test/1" } });

	assert.equal(ledger.objectiveFrameCount(), 1, "same tab/url/facts across two sessions must share one objective substrate");
	assert.equal(first.objective?.shared, false);
	assert.equal(second.objective?.shared, true);
	assert.equal(second.objective?.snapshotId, "snap-a", "second session view references the existing objective snapshot");
	assert.equal(ledger.get(frame(1).key)?.snapshotId, "snap-a", "first session frame remains addressable");
	assert.equal(ledger.get({ ...frame(1).key, browserSessionId: "other" })?.snapshotId, "snap-b", "second session view remains separate");
});

test("PerceptionLedger migrates frames across tab replacement", () => {
	const ledger = new PerceptionLedger();
	const first = { ...frame(1), facts: { a: { versionStamp: "v1", lastShownGranularity: "compact" as const } } };
	const second = { ...frame(2), facts: { b: { versionStamp: "v2", lastShownGranularity: "line" as const } }, allocation: { budgetUsedRatio: 0.5, omittedCount: 2 } };
	ledger.record(first);
	ledger.record(second);

	assert.equal(ledger.migrateTabId(1, 4), 2);
	assert.equal(ledger.get(first.key), undefined);
	assert.equal(ledger.get({ ...first.key, tabId: 4 })?.snapshotId, "snap-1");
	assert.equal(ledger.get({ ...second.key, tabId: 4 })?.allocation?.omittedCount, 2);
	assert.deepEqual(ledger.recent({ browserSessionId: "s", tabId: 4, navigationEpoch: "ignored" }, 2).map((item) => item.snapshotId), ["snap-2", "snap-1"]);
});

test("PerceptionLedger scopes tab replacement migration by browser session", () => {
	const ledger = new PerceptionLedger();
	const source = { ...frame(1), snapshotId: "source" };
	const other = { ...frame(2), key: { ...frame(2).key, browserSessionId: "other" }, snapshotId: "other" };
	ledger.record(source);
	ledger.record(other);

	assert.equal(ledger.migrateTabId(1, 4, { browserSessionIds: ["s"] }), 1);
	assert.equal(ledger.get(source.key), undefined);
	assert.equal(ledger.get({ ...source.key, tabId: 4 })?.snapshotId, "source");
	assert.equal(ledger.get(other.key)?.snapshotId, "other");
	assert.equal(ledger.get({ ...other.key, tabId: 4 }), undefined);
});

test("stableRefsFromFrames ignores relation-only changes", () => {
	const entity = {
		ref: "pi-ref://control/pay",
		kind: "control",
		role: "button",
		name: "Pay now",
		state: { disabled: false },
		structure: {},
		relations: [{ type: "labelledBy", targetRef: "pi-ref://text/a", source: "dom", confidence: "low" }],
	} as any;
	const current = { ...frame(1), facts: factsFromEntities([{ ...entity, relations: [{ type: "labelledBy", targetRef: "pi-ref://text/b", source: "ax", confidence: "medium" }] }]) };
	const prior = { ...frame(0), facts: factsFromEntities([entity]) };
	assert.deepEqual(Array.from(stableRefsFromFrames(current, prior)), ["pi-ref://control/pay"]);
});

test("PerceptionLedger trace ring is session keyed, deduped, and capped", () => {
	const ledger = new PerceptionLedger();
	ledger.recordTraceTerms("s", [{ term: "login", kind: "literal" }, { term: "login", kind: "literal" }], 1);
	for (let i = 0; i < 40; i += 1) ledger.recordTraceTerms("s", [{ term: `term-${i}`, kind: "literal" }], 2 + i);
	const snapshot = ledger.traceSnapshot("s");
	assert.equal(snapshot.terms.length, 32);
	assert.equal(snapshot.terms[0].term, "term-39");
	assert.equal(snapshot.terms.some((term) => term.term === "login"), false, "old deduped term falls out under cap");
	assert.equal(ledger.traceSnapshot("other").terms.length, 0);
});

test("PerceptionLedger clear removes frames and traces", () => {
	const ledger = new PerceptionLedger();
	ledger.record(frame(1));
	ledger.recordTraceTerms("s", [{ term: "checkout", kind: "literal" }]);
	ledger.clear();
	assert.equal(ledger.get(frame(1).key), undefined);
	assert.deepEqual(ledger.traceSnapshot("s").terms, []);
});
