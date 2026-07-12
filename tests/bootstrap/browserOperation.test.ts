import assert from "node:assert/strict";
import test from "node:test";
import { SessionOperationRegistry } from "../../src/kernels/session/operationRegistry.ts";
import { resolveBrowserOperationCompletion } from "../../src/commands/operationResolvers.ts";
import { classifyBrowserOperationLiveness, nextBrowserOperationLivenessBoundary } from "../../src/kernels/session/browserOperationState.ts";
import { BrowserBridgeServer } from "../../src/bridge/server/BrowserBridgeServer.ts";
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
