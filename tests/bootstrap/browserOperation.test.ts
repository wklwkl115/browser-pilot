import assert from "node:assert/strict";
import test from "node:test";
import { SessionOperationRegistry } from "../../src/kernels/session/operationRegistry.ts";
import { classifyBrowserOperationLiveness } from "../../src/kernels/session/browserOperationState.ts";
import type { BrowserOperationOutcome } from "../../src/kernels/session/browserOperation.ts";

function outcome(operationId: string, status: BrowserOperationOutcome["status"] = "effect_observed"): BrowserOperationOutcome {
	return {
		version: "browser-operation/v1",
		operationId,
		commandName: "browser_execute",
		status,
		target: { browserSessionId: "session-1", tabId: 7, generation: 2 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 1, finishedAt: 2 },
		signals: {},
	};
}

test("operation liveness thresholds classify no-effect, stalled, download stalled, and deadline without producing completed", () => {
	const base = { deadlineAt: 20_000, dispatchFinishedAt: 1_000, lastProgressAt: 1_000, hasActivity: false, pending: false, downloadPending: false };
	assert.equal(classifyBrowserOperationLiveness({ ...base, now: 1_999 }), undefined);
	assert.equal(classifyBrowserOperationLiveness({ ...base, now: 2_000 }), "no_effect");
	assert.equal(classifyBrowserOperationLiveness({ ...base, now: 5_999, hasActivity: true, pending: true }), undefined);
	assert.equal(classifyBrowserOperationLiveness({ ...base, now: 6_000, hasActivity: true, pending: true }), "stalled");
	assert.equal(classifyBrowserOperationLiveness({ ...base, now: 10_999, hasActivity: true, pending: true, downloadPending: true }), undefined);
	assert.equal(classifyBrowserOperationLiveness({ ...base, now: 11_000, hasActivity: true, pending: true, downloadPending: true }), "stalled");
	assert.equal(classifyBrowserOperationLiveness({ ...base, now: 20_000, hasActivity: true }), "deadline");
});

test("operation registry keeps terminal records, caps sequenced events, and never rewrites terminal status for late effects", () => {
	let now = 1_000;
	const registry = new SessionOperationRegistry({ now: () => now, maxEvents: 3, passiveWindowMs: 30_000 });
	const operation = registry.begin({ commandName: "browser_execute", command: "javascript", browserSessionId: "session-1", tabId: 7, generation: 2, ownerId: "agent-a", phase: "arming" });
	for (let index = 0; index < 5; index += 1) {
		now += 10;
		registry.recordEvent(operation.operationId, { type: "mutation", data: { mutationCount: index + 1, authorization: "secret" } });
	}
	const active = registry.get(operation.operationId)!;
	assert.equal(active.sequence, 5);
	assert.deepEqual(active.events.map((event) => event.sequence), [3, 4, 5]);
	assert.equal(active.events.at(-1)?.data?.authorization, "[redacted]");
	registry.finish(operation.operationId, outcome(operation.operationId, "effect_observed"));
	assert.equal(registry.get(operation.operationId)?.state, "terminal");
	now += 100;
	registry.recordEvent(operation.operationId, { type: "navigation_completed", data: { url: "https://example.test/done" } });
	const terminal = registry.get(operation.operationId)!;
	assert.equal(terminal.terminalStatus, "effect_observed");
	assert.equal(terminal.outcome?.status, "effect_observed");
	assert.equal(terminal.lateEffects.length, 1);
	assert.equal(terminal.lateEffects[0]?.event.late, true);
});

test("late effects surface once only to the same owner and browser session, then terminal TTL removes the record", () => {
	let now = 5_000;
	const registry = new SessionOperationRegistry({ now: () => now, ttlMs: 5 * 60_000, passiveWindowMs: 30_000 });
	const operation = registry.begin({ commandName: "browser_execute", browserSessionId: "session-1", tabId: 7, ownerId: "agent-a", phase: "running" });
	registry.finish(operation.operationId, outcome(operation.operationId));
	now += 10;
	registry.recordEvent(operation.operationId, { type: "new_tab", data: { tabId: 8 } });
	assert.deepEqual(registry.surfaceLateEffects({ ownerId: "agent-b", browserSessionId: "session-1" }), []);
	assert.deepEqual(registry.surfaceLateEffects({ ownerId: "agent-a", browserSessionId: "session-2" }), []);
	assert.equal(registry.surfaceLateEffects({ ownerId: "agent-a", browserSessionId: "session-1" }).length, 1);
	assert.equal(registry.surfaceLateEffects({ ownerId: "agent-a", browserSessionId: "session-1" }).length, 0);
	now += 10;
	registry.recordEvent(operation.operationId, { type: "navigation_completed" });
	assert.equal(registry.surfaceLateEffects({ ownerId: "agent-a", browserSessionId: "session-1" }).length, 1);
	now += 5 * 60_000 + 1;
	assert.equal(registry.get(operation.operationId), undefined);
});

test("events outside the passive window are not attributed to a terminal operation", () => {
	let now = 1;
	const registry = new SessionOperationRegistry({ now: () => now, passiveWindowMs: 30_000 });
	const operation = registry.begin({ commandName: "browser_execute", ownerId: "agent-a", phase: "running" });
	registry.finish(operation.operationId, outcome(operation.operationId));
	now += 30_001;
	registry.recordEvent(operation.operationId, { type: "mutation" });
	assert.equal(registry.get(operation.operationId)?.lateEffects.length, 0);
});
