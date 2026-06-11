import test from "node:test";
import assert from "node:assert/strict";
import { buildExecutionJournal, compactExecutionEffect, executionJournalFromValue } from "../../../src/tools/executionJournal.ts";

test("compactExecutionEffect keeps factual nonzero fields only", () => {
	const compact = compactExecutionEffect({
		mutations: 1,
		settled: true,
		navigated: false,
		visibleDelta: 0,
		interactiveDelta: 2,
		requestsFired: 0,
		hookEventsFired: 3,
		anchor: { changeSeq: 9 },
	});
	assert.deepEqual(compact, {
		mutations: 1,
		settled: true,
		interactiveDelta: 2,
		requestsFired: 0,
		hookEventsFired: 3,
		anchor: { changeSeq: 9 },
	});
});

test("buildExecutionJournal records target dispatch effect and stdlib", () => {
	const journal = buildExecutionJournal({
		operationId: "op-1",
		target: {
			tabId: 7,
			browserSessionId: "session-1",
			source: "explicit",
			selectionVersionAtDispatch: 2,
			selectionVersionAtResolve: 3,
		},
		dispatch: { kind: "input", command: "input.keys", text: { redacted: true, charCount: 6 } },
		effect: { mutations: 1, settled: true, navigated: false, visibleDelta: 0, interactiveDelta: 0 },
		stdlib: { used: true, refsEmbedded: 1, resolveMisses: 0 },
	});

	assert.deepEqual(journal, {
		version: 1,
		operationId: "op-1",
		target: {
			tabId: 7,
			browserSessionId: "session-1",
			selectionVersionAtDispatch: 2,
			selectionVersionAtResolve: 3,
		},
		dispatch: { kind: "input", command: "input.keys", text: { redacted: true, charCount: 6 } },
		effect: { mutations: 1, settled: true, navigated: false, visibleDelta: 0, interactiveDelta: 0 },
		stdlib: { used: true, refsEmbedded: 1, resolveMisses: 0 },
	});
});

test("executionJournalFromValue extracts journal records only", () => {
	const journal = { version: 1, dispatch: { kind: "javascript", command: "javascript" } };
	assert.deepEqual(executionJournalFromValue({ execution: journal }), journal);
	assert.equal(executionJournalFromValue({ execution: null }), undefined);
	assert.equal(executionJournalFromValue(null), undefined);
});
