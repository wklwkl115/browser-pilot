import assert from "node:assert/strict";
import test from "node:test";
import { SessionOperationRegistry } from "../../src/kernels/session/operationRegistry.ts";
import { resolveBrowserOperationCompletion, resolveBrowserOperationDispatchTerminal } from "../../src/commands/operationResolvers.ts";
import { classifyBrowserOperationLiveness, nextBrowserOperationLivenessBoundary } from "../../src/kernels/session/browserOperationState.ts";
import { BrowserBridgeServer } from "../../src/bridge/server/BrowserBridgeServer.ts";
import { BrowserCommandQueueRegistry } from "../../src/bridge/server/BrowserCommandQueueRegistry.ts";
import { readFile } from "node:fs/promises";
import {
	BROWSER_OPERATION_SCHEMA,
	classifyBrowserOperationStatus,
	type BrowserOperationOutcome,
} from "../../src/kernels/session/browserOperation.ts";

function outcome(operationId: string, status: BrowserOperationOutcome["status"] = "effect_observed"): BrowserOperationOutcome {
	return {
		schema: BROWSER_OPERATION_SCHEMA,
		operationId,
		commandName: "browser_execute",
		status,
		...classifyBrowserOperationStatus(status),
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

test("operation liveness exposes the exact next event-free classification boundary", () => {
	const base = { now: 1_100, deadlineAt: 20_000, dispatchFinishedAt: 1_000, lastProgressAt: 1_000, hasActivity: false, pending: false, downloadPending: false };
	assert.equal(nextBrowserOperationLivenessBoundary(base), 2_000);
	assert.equal(nextBrowserOperationLivenessBoundary({ ...base, hasActivity: true, pending: true }), 6_000);
	assert.equal(nextBrowserOperationLivenessBoundary({ ...base, hasActivity: true, pending: true, downloadPending: true }), 11_000);
	assert.equal(nextBrowserOperationLivenessBoundary({ ...base, now: 20_000 }), 20_000);
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
	assert.equal(registry.markMutationObserved({ ownerId: "agent-a", browserSessionId: "session-1", tabId: 7, commandName: "browser_execute" }), 1);
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

test("operation revisions advance monotonically for every settlement-visible mutation", () => {
	const registry = new SessionOperationRegistry();
	const started = registry.begin({ commandName: "browser_execute", phase: "arming" });
	const updated = registry.update(started.operationId, { phase: "dispatching" })!;
	const event = registry.recordEvent(started.operationId, { type: "mutation" })!;
	const finished = registry.finish(started.operationId, outcome(started.operationId))!;
	assert.deepEqual([started.revision, updated.revision, event.revision, finished.revision], [1, 2, 3, 4]);
});

test("operation waiters cannot miss changes before or after registration and release at scale", async () => {
	const server = new BrowserBridgeServer();
	const started = server.beginOperation({ commandName: "browser_execute", phase: "arming" });
	server.updateOperation(started.operationId, { phase: "dispatching" });
	const beforeRegistration = await server.waitForOperationChange(started.operationId, started.revision, 1_000);
	assert.equal(beforeRegistration?.revision, 2);

	const current = server.getOperation(started.operationId)!;
	const waiters = Array.from({ length: 1_000 }, () => server.waitForOperationChange(started.operationId, current.revision, 5_000));
	server.recordOperationEvent(started.operationId, { type: "mutation" });
	const released = await Promise.all(waiters);
	assert.equal(released.every((item) => item?.revision === current.revision + 1), true);

	const afterEvent = server.getOperation(started.operationId)!;
	const finishedWait = server.waitForOperationChange(started.operationId, afterEvent.revision, 5_000);
	server.finishOperation(started.operationId, outcome(started.operationId));
	assert.equal((await finishedWait)?.state, "terminal");
	await server.stop();
});

test("operation waiter abort removes its timer and listener", async () => {
	const server = new BrowserBridgeServer();
	const started = server.beginOperation({ commandName: "browser_execute", phase: "arming" });
	const controller = new AbortController();
	const waiting = server.waitForOperationChange(started.operationId, started.revision, 5_000, controller.signal);
	controller.abort();
	await assert.rejects(waiting, { name: "AbortError" });
	await server.stop();
});

test("aborted queued browser writes reject promptly and never dispatch later", async () => {
	const queues = new BrowserCommandQueueRegistry();
	let releaseFirst!: () => void;
	const first = queues.enqueue("session-1", 7, async () => await new Promise<void>((resolve) => { releaseFirst = resolve; }));
	let secondDispatches = 0;
	const controller = new AbortController();
	const second = queues.enqueue("session-1", 7, async () => { secondDispatches += 1; }, { signal: controller.signal });
	controller.abort();
	await assert.rejects(second, (error: Error & { code?: string; details?: Record<string, unknown> }) => {
		assert.equal(error.code, "BRIDGE_TIMEOUT");
		assert.equal(error.details?.dispatchStarted, false);
		return true;
	});
	assert.equal(queues.depth("session-1", 7), 1);
	releaseFirst();
	await first;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(secondDispatches, 0);
	assert.equal(queues.depth("session-1", 7), 0);
});

test("operation settlement source contains no fixed-interval registry polling", async () => {
	const source = await readFile(new URL("../../src/commands/browserOperation.ts", import.meta.url), "utf8");
	assert.equal(source.includes("setInterval"), false);
	assert.equal(/delay\(Math\.min\(25|setTimeout\([^)]*,\s*25\b/.test(source), false);
});

test("operation completion resolvers require tab and upload result markers beyond acknowledgement", () => {
	const base = { events: [] };
	assert.equal(resolveBrowserOperationCompletion({ ...base, commandName: "browser_tabs", action: "switch", result: { acknowledged: true } }), undefined);
	assert.equal(resolveBrowserOperationCompletion({ ...base, commandName: "browser_tabs", action: "close", result: { acknowledged: true, data: {} } }), undefined);
	assert.equal(resolveBrowserOperationCompletion({ ...base, commandName: "browser_upload", result: { acknowledged: true, data: { uploaded: false, files_count: 2 } } }), undefined);
	assert.equal(resolveBrowserOperationCompletion({ ...base, commandName: "browser_upload", result: { acknowledged: true, data: { uploaded: true, files_count: 0 } } }), undefined);
	assert.equal(resolveBrowserOperationCompletion({ ...base, commandName: "browser_tabs", action: "switch", result: { acknowledged: true, data: { active: true, selectedTabId: 7 } } })?.source, "tab-switch");
	assert.equal(resolveBrowserOperationCompletion({ ...base, commandName: "browser_command", command: "tabs", action: "switch", result: { acknowledged: true, data: { active: true, tabId: 8 } } })?.source, "tab-switch");
	assert.equal(resolveBrowserOperationCompletion({ ...base, commandName: "browser_tabs", action: "close", result: { acknowledged: true, data: { tabId: 7 } } })?.source, "tab-close");
	assert.equal(resolveBrowserOperationCompletion({ ...base, commandName: "browser_upload", result: { acknowledged: true, data: { uploaded: true, files_count: 2, selector: "#file" } } })?.source, "upload-applied");
	assert.equal(resolveBrowserOperationCompletion({ ...base, commandName: "browser_network", command: "network.captureReload", result: { data: { results: [{ ok: true }, { ok: false, error: "reload failed" }, { ok: true }] } } }), undefined);
	assert.equal(resolveBrowserOperationCompletion({ ...base, commandName: "browser_network", command: "network.captureReload", result: { data: { results: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }] } } })?.source, "network-capture-completed");
});

test("physical program completion requires an explicit passed verifier after acknowledged input", () => {
	const result = {
		acknowledged: true,
		frames: [
			{ step: 0, kind: "mouse:release", ok: true, acknowledged: true, durationMs: 2, eventCount: 1 },
			{ step: 1, kind: "eval", ok: true, acknowledged: true, durationMs: 1, result: { verified: true, liked: true }, verification: { passed: true } },
		],
		result: { verified: true, liked: true },
		verification: { step: 1, passed: true, result: { verified: true, liked: true } },
	};
	const completion = resolveBrowserOperationCompletion({ commandName: "browser_execute", mode: "program", physicalProgram: true, result, events: [] });
	assert.equal(completion?.source, "program-verified");
	assert.deepEqual(completion?.evidence.verification, result.verification);
	assert.equal(resolveBrowserOperationCompletion({ commandName: "browser_execute", mode: "program", physicalProgram: true, result: { ...result, verification: undefined }, events: [] }), undefined);
});

test("program aborts and failed explicit verification settle factually before generic liveness", () => {
	const partial = resolveBrowserOperationDispatchTerminal({
		commandName: "browser_execute",
		mode: "program",
		physicalProgram: true,
		result: { acknowledged: true, frames: [{ step: 0, kind: "text", ok: true, acknowledged: true, durationMs: 1 }], result: undefined, aborted: { reason: "submit frame failed", atStep: 1 } },
		events: [],
	});
	assert.equal(partial?.status, "ambiguous");
	assert.match(JSON.stringify(partial?.diagnostics), /PROGRAM_PARTIAL_DISPATCH/);

	const verificationFailed = resolveBrowserOperationDispatchTerminal({
		commandName: "browser_execute",
		mode: "program",
		physicalProgram: true,
		result: { acknowledged: true, frames: [], result: false, verification: { step: 2, passed: false, result: false } },
		events: [],
	});
	assert.equal(verificationFailed?.status, "ambiguous");
	assert.match(JSON.stringify(verificationFailed?.diagnostics), /PROGRAM_VERIFICATION_FAILED/);

	const preDispatch = resolveBrowserOperationDispatchTerminal({
		commandName: "browser_execute",
		mode: "program",
		physicalProgram: false,
		result: { acknowledged: false, frames: [], result: undefined, aborted: { reason: "ref precheck failed", atStep: -1 } },
		events: [],
	});
	assert.equal(preDispatch?.status, "failed");
});

test("operation registry blocks unobserved acknowledged mutations and permanently dedupes an explicit intent", () => {
	const registry = new SessionOperationRegistry();
	const operation = registry.begin({ commandName: "browser_execute", command: "program", browserSessionId: "session-1", tabId: 7, generation: 2, ownerId: "agent-a", intentId: "like-note-42", phase: "arming" });
	registry.finish(operation.operationId, {
		...outcome(operation.operationId, "effect_observed"),
		target: { browserSessionId: "session-1", tabId: 7, generation: 2 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 1, finishedAt: 2 },
	});
	const base = { ownerId: "agent-a", browserSessionId: "session-1", tabId: 7, generation: 2, commandName: "browser_execute" };
	assert.equal(registry.mutationReplayGuard({ ...base, intentId: "other-action" })?.kind, "observation_required");
	assert.equal(registry.markMutationObserved(base), 1);
	assert.equal(registry.mutationReplayGuard({ ...base, intentId: "other-action" }), undefined);
	assert.equal(registry.mutationReplayGuard({ ...base, intentId: "like-note-42" })?.kind, "intent_replay");
});

test("expanded trusted input is resolved as physical even when the source program was eval-only", () => {
	const result = {
		acknowledged: true,
		frames: [
			{ step: 0, kind: "eval", ok: true, acknowledged: true, durationMs: 1, result: [{ text: "comment" }] },
			{ step: 1, kind: "text", ok: true, acknowledged: true, durationMs: 1 },
		],
		result: [{ text: "comment" }],
	};
	assert.equal(resolveBrowserOperationCompletion({ commandName: "browser_execute", mode: "program", physicalProgram: false, result, events: [] }), undefined);
});

test("operation registry blocks concurrent and cross-command mutations on the same target", () => {
	const registry = new SessionOperationRegistry();
	const scope = { ownerId: "agent-a", browserSessionId: "session-1", tabId: 7, generation: 2 };
	const active = registry.begin({
		...scope,
		commandName: "browser_execute",
		command: "program",
		phase: "dispatching",
		mutation: true,
	} as Parameters<SessionOperationRegistry["begin"]>[0]);
	assert.equal(registry.mutationReplayGuard({ ...scope, commandName: "browser_command" })?.kind, "mutation_in_progress");
	registry.finish(active.operationId, {
		...outcome(active.operationId, "effect_observed"),
		target: { browserSessionId: "session-1", tabId: 7, generation: 2 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 1, finishedAt: 2 },
	});
	assert.equal(registry.mutationReplayGuard({ ...scope, commandName: "browser_command" })?.kind, "observation_required");
});

test("intent and unobserved mutation evidence survive ordinary operation TTL and capacity pruning", () => {
	let now = 1_000;
	const registry = new SessionOperationRegistry({ ttlMs: 1_000, maxOperations: 2, now: () => now });
	const scope = { ownerId: "agent-a", browserSessionId: "session-1", tabId: 7, generation: 2 };
	const original = registry.begin({ ...scope, commandName: "browser_execute", command: "program", intentId: "like-note-42", phase: "dispatching", mutation: true } as Parameters<SessionOperationRegistry["begin"]>[0]);
	registry.finish(original.operationId, {
		...outcome(original.operationId, "effect_observed"),
		target: { browserSessionId: "session-1", tabId: 7, generation: 2 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 1, finishedAt: 2 },
	});
	now += 2_000;
	for (let i = 0; i < 3; i++) {
		const disposable = registry.begin({ commandName: "browser_observe", browserSessionId: "session-1", tabId: 7, phase: "running" });
		registry.finish(disposable.operationId);
	}
	assert.equal(registry.mutationReplayGuard({ ...scope, commandName: "browser_execute", intentId: "like-note-42" })?.kind, "intent_replay");
	assert.equal(registry.mutationReplayGuard({ ...scope, commandName: "browser_command", intentId: "other" })?.kind, "observation_required");
});

test("intent replay binds the mutation payload and stable target across generation changes", () => {
	const registry = new SessionOperationRegistry();
	const operation = registry.begin({
		commandName: "browser_execute",
		browserSessionId: "session-1",
		tabId: 7,
		targetRef: "tabh_browser_logical_g1",
		generation: 1,
		ownerId: "agent-a",
		intentId: "comment-note-42",
		intentPayload: { mode: "program", program: [{ text: "first comment" }] },
		phase: "dispatching",
		mutation: true,
	});
	registry.finish(operation.operationId, {
		...outcome(operation.operationId, "completed"),
		target: { browserSessionId: "session-1", tabId: 7, generation: 1 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 1, finishedAt: 2 },
	});
	const nextScope = { ownerId: "agent-a", browserSessionId: "session-1", tabId: 8, targetRef: "tabh_browser_logical_g2", generation: 2, commandName: "browser_execute", intentId: "comment-note-42" };
	assert.equal(registry.mutationReplayGuard({ ...nextScope, intentPayload: { mode: "program", program: [{ text: "first comment" }] } })?.kind, "intent_replay");
	assert.equal(registry.mutationReplayGuard({ ...nextScope, intentPayload: { mode: "program", program: [{ text: "different comment" }] } })?.kind, "intent_conflict");
});

test("observation only clears a barrier when it began after settlement on the same generation", () => {
	const now = 2_000;
	const registry = new SessionOperationRegistry({ now: () => now });
	const operation = registry.begin({ commandName: "browser_execute", browserSessionId: "session-1", tabId: 7, targetRef: "tabh_browser_logical_g1", generation: 1, ownerId: "agent-a", phase: "dispatching", mutation: true });
	registry.finish(operation.operationId, {
		...outcome(operation.operationId, "effect_observed"),
		target: { browserSessionId: "session-1", tabId: 7, generation: 1 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 1, finishedAt: 2 },
	});
	const scope = { ownerId: "agent-a", browserSessionId: "session-1", tabId: 7, targetRef: "tabh_browser_logical_g1", commandName: "browser_execute" };
	assert.equal(registry.markMutationObserved({ ...scope, generation: 1, observationStartedAt: 1_999 }), 0);
	assert.equal(registry.markMutationObserved({ ...scope, generation: 2, observationStartedAt: 2_001 }), 0);
	assert.equal(registry.markMutationObserved({ ...scope, generation: 1, observationStartedAt: 2_001 }), 1);
});

test("protected mutation evidence survives bridge reset and ledger capacity fails closed", () => {
	const registry = new SessionOperationRegistry({ maxProtectedMutations: 1 });
	const operation = registry.begin({ commandName: "browser_execute", browserSessionId: "session-1", tabId: 7, ownerId: "agent-a", intentId: "like-note-42", phase: "dispatching", mutation: true });
	registry.finish(operation.operationId, {
		...outcome(operation.operationId, "completed"),
		target: { browserSessionId: "session-1", tabId: 7 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 1, finishedAt: 2 },
	});
	registry.clear({ preserveMutationEvidence: true });
	assert.equal(registry.mutationReplayGuard({ ownerId: "agent-a", browserSessionId: "session-1", tabId: 7, commandName: "browser_execute", intentId: "like-note-42" })?.kind, "intent_replay");
	assert.equal(registry.mutationReplayGuard({ ownerId: "agent-a", browserSessionId: "session-1", tabId: 8, commandName: "browser_execute", intentId: "new-intent" })?.kind, "ledger_capacity");
});

test("an intent is reusable when observer arming failed before mutation dispatch", () => {
	const registry = new SessionOperationRegistry();
	const operation = registry.begin({ commandName: "browser_execute", browserSessionId: "session-1", tabId: 7, ownerId: "agent-a", intentId: "like-note-42", phase: "arming", mutation: true });
	registry.finish(operation.operationId, {
		...outcome(operation.operationId, "failed"),
		target: { browserSessionId: "session-1", tabId: 7 },
		dispatch: { acknowledged: false, started: false, finished: false, startedAt: 1, finishedAt: 2 },
	});
	assert.equal(registry.mutationReplayGuard({ ownerId: "agent-a", browserSessionId: "session-1", tabId: 7, commandName: "browser_execute", intentId: "like-note-42" }), undefined);
});
