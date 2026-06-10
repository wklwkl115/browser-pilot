import test from "node:test";
import assert from "node:assert/strict";
import { PerceptionLedger } from "../../../src/abml/perceptionLedger.ts";

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
