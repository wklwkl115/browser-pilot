import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserOperationOutcome } from "../../src/kernels/session/browserOperation.ts";
import { SessionOperationRegistry } from "../../src/kernels/session/operationRegistry.ts";

function outcome(operationId: string): BrowserOperationOutcome {
	const now = Date.now();
	return {
		schema: "browser-operation/v2",
		operationId,
		commandName: "browser_execute",
		status: "completed",
		classification: "success",
		completionVerified: true,
		ok: true,
		target: { browserSessionId: "session-1", targetRef: "target-7", tabId: 7, generation: 1 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: now, finishedAt: now },
		signals: {},
		completion: { source: "abml-verified", evidence: { provider: "abml" } },
	};
}

test("semantic settlement terminal commit rejects a stale revision", () => {
	const registry = new SessionOperationRegistry();
	const active = registry.begin({
		commandName: "browser_execute",
		command: "javascript",
		browserSessionId: "session-1",
		tabId: 7,
		targetRef: "target-7",
		generation: 1,
		phase: "semantic_observing",
		mutation: true,
	});
	const capturedAtRevision = active.revision;
	const changed = registry.recordEvent(active.operationId, { type: "mutation", sourceSequence: 11, data: { mutationCount: 1 } });
	assert.ok(changed);
	assert.equal(registry.finishIfRevision(active.operationId, capturedAtRevision, outcome(active.operationId)), undefined);
	assert.equal(registry.get(active.operationId)?.state, "active");

	const committed = registry.finishIfRevision(active.operationId, changed.revision, outcome(active.operationId));
	assert.equal(committed?.state, "terminal");
});

test("operation events retain exact extension source sequence separately from ledger sequence", () => {
	const registry = new SessionOperationRegistry();
	const active = registry.begin({ commandName: "browser_execute", phase: "arming" });
	registry.recordEvent(active.operationId, { type: "checkpoint", sequence: 50, sourceSequence: 7, data: { fenceId: "fence-1" } });
	registry.recordEvent(active.operationId, { type: "mutation", sequence: 3, sourceSequence: 8, data: { mutationCount: 1 } });
	const current = registry.get(active.operationId)!;
	assert.deepEqual(current.events.map((event) => event.sourceSequence), [7, 8]);
	assert.deepEqual(current.events.map((event) => event.sequence), [1, 2]);
	assert.equal(current.sourceSequence, 8);
	assert.equal(current.events[1]!.sequence > current.events[0]!.sequence, true, "ledger ordering remains monotonic even when transport sequences arrive out of order");
});
