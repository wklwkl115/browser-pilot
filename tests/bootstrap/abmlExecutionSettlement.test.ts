import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAbmlExecutionSettlementProvider } from "../../src/commands/abmlExecutionSettlement.ts";
import { withBrowserOperation } from "../../src/commands/browserOperation.ts";
import { browserOperationCommandResult } from "../../src/commands/browserOperationResult.ts";
import { buildAbmlActionOutcome } from "../../src/kernels/abml/actionOutcome.ts";
import { diffEntities } from "../../src/kernels/abml/diff.ts";
import type { Entity, EntityState } from "../../src/kernels/abml/entity.ts";
import { SessionOperationRegistry } from "../../src/kernels/session/operationRegistry.ts";
import { BROWSER_OPERATION_SCHEMA, classifyBrowserOperationStatus, type BrowserOperationOutcome, type BrowserOperationSemanticEvidence } from "../../src/kernels/session/browserOperation.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";
import { BrowserBridgeError } from "../../src/utils/errors.ts";

const DEFAULT_STATE: EntityState = {
	visible: true,
	occluded: false,
	disabled: false,
	focused: false,
	editable: false,
	inViewport: true,
};

function entity(ref: string, overrides: Partial<Entity> = {}): Entity {
	return { ref, kind: "control", role: "button", state: { ...DEFAULT_STATE, ...overrides.state }, source: "dom", ...overrides };
}

function fingerprint(changeSeq: number) {
	return { changeSeq, pageEpoch: "page-1", readyState: "complete" };
}

function providerFixture(readFingerprints: number[], models: Entity[][], options: {
	onWait?: (record: (type: string, timestamp?: number) => void) => void;
	beforeCheckpoint?: (fenceId: string, record: (type: string, timestamp?: number) => void) => void;
	afterCheckpoint?: (fenceId: string, sourceSequence: number, record: (type: string, timestamp?: number) => void) => void;
} = {}) {
	const registry = new SessionOperationRegistry();
	const operation = registry.begin({
		commandName: "browser_execute",
		command: "javascript",
		browserSessionId: "session-1",
		tabId: 7,
		targetRef: "tab-stable",
		generation: 1,
		phase: "arming",
		mutation: true,
	});
	let sourceSequence = 0;
	let modelIndex = 0;
	let fingerprintIndex = 0;
	const server = {
		getOperation: (operationId: string) => registry.get(operationId),
		finishOperationIfRevision: (operationId: string, revision: number) => registry.finishIfRevision(operationId, revision),
		async waitForOperationChange(operationId: string, _revision: number, timeoutMs: number) {
			if (options.onWait) {
				const onWait = options.onWait;
				options.onWait = undefined;
				onWait((type, timestamp) => {
					sourceSequence += 1;
					registry.recordEvent(operationId, { type, progress: true, sourceSequence, ...(timestamp ? { timestamp } : {}), data: { mutationCount: 1 } });
				});
				return registry.get(operationId);
			}
			await new Promise((resolve) => setTimeout(resolve, timeoutMs));
			return registry.get(operationId);
		},
		async sendCommand(command: Record<string, unknown>) {
			assert.equal(command.cmd, "operation.checkpoint");
			const fenceId = String(command.fenceId);
			const record = (type: string, timestamp?: number) => {
				sourceSequence += 1;
				registry.recordEvent(operation.operationId, { type, progress: true, sourceSequence, ...(timestamp ? { timestamp } : {}), data: { mutationCount: 1 } });
			};
			options.beforeCheckpoint?.(fenceId, record);
			sourceSequence += 1;
			const checkpointSequence = sourceSequence;
			registry.recordEvent(operation.operationId, {
				type: "checkpoint",
				progress: false,
				sourceSequence: checkpointSequence,
				data: { fenceId, mutationObserverFound: true },
			});
			options.afterCheckpoint?.(fenceId, checkpointSequence, record);
			return { id: `checkpoint-${checkpointSequence}`, acknowledged: true, data: { fenceId, sourceSequence: checkpointSequence, checkedAt: Date.now() } };
		},
	} as unknown as BrowserCommandRuntimePort;
	const provider = createAbmlExecutionSettlementProvider({
		server,
		target: { browserSessionId: "session-1", tabId: 7, targetRef: "tab-stable", generation: 1 },
		action: { verb: "execute-javascript" },
	}, {
		readFingerprint: async () => fingerprint(readFingerprints[fingerprintIndex++]!),
		readIdentity: () => ({ browserSessionId: "session-1", tabId: 7, targetGeneration: 1, pageEpoch: "page-1", url: "https://example.test/" }),
		readStructure: async ({ baseline }) => {
			const entities = models[modelIndex++]!;
			return { ok: true, entities, ...(baseline ? { diff: diffEntities(baseline, entities) } : {}) };
		},
	});
	assert.ok(provider);
	return {
		operation,
		provider,
		markDispatched() {
			sourceSequence += 1;
			registry.recordEvent(operation.operationId, {
				type: "dispatch",
				progress: false,
				sourceSequence,
				data: { fenceId: `actual-dispatch-${sourceSequence}`, checkedAt: Date.now(), mutationObserverFound: true },
			});
		},
		recordActionEvent(type = "mutation") {
			sourceSequence += 1;
			registry.recordEvent(operation.operationId, { type, progress: true, sourceSequence, data: { mutationCount: 1 } });
		},
		getOperation: () => registry.get(operation.operationId)!,
		tryCommit: (revision: number) => registry.finishIfRevision(operation.operationId, revision),
		getModelReads: () => modelIndex,
	};
}

async function runSyntheticSemanticOperation(input: {
	semantic: BrowserOperationSemanticEvidence;
	result: unknown;
	mode?: "javascript" | "program";
	physicalProgram?: boolean;
	postcondition?: boolean;
	recordAfterDispatch?: (registry: SessionOperationRegistry, operationId: string) => void;
}) {
	const registry = new SessionOperationRegistry();
	let settleCalls = 0;
	const terminalHints: string[] = [];
	const server = {
		snapshot: () => ({ browserSessionId: "session-1", defaultTabId: 7, tabs: [{ tabId: 7, targetRef: "tab-stable", generation: 1 }] }),
		queueDepth: () => 0,
		leaseOwnerHash: () => undefined,
		mutationReplayGuard: (value: never) => registry.mutationReplayGuard(value),
		beginOperation: (value: never) => registry.begin(value),
		updateOperation: (operationId: string, patch: never) => registry.update(operationId, patch),
		getOperation: (operationId: string) => registry.get(operationId),
		finishOperation: (operationId: string, value: never) => registry.finish(operationId, value),
		finishOperationIfRevision: (operationId: string, revision: number, value: never) => registry.finishIfRevision(operationId, revision, value),
		async sendCommand(command: Record<string, unknown>) {
			if (command.cmd === "operation.begin") return { acknowledged: true, data: { armed: true } };
			if (command.cmd === "operation.finish") return { acknowledged: true, data: { finished: true } };
			throw new Error(`unexpected command ${String(command.cmd)}`);
		},
	} as unknown as BrowserCommandRuntimePort;
	const provider = {
		async prepare() {},
		async beforeDispatch() {},
		actionEventBoundary: () => undefined,
		async settle(value: { operationId: string; terminalHint: string }) {
			settleCalls += 1;
			terminalHints.push(value.terminalHint);
			return { semantic: input.semantic, expectedRevision: registry.get(value.operationId)!.revision };
		},
	};
	const outcome = await withBrowserOperation({
		server,
		commandName: "browser_execute",
		command: input.mode === "program" ? "program" : "javascript",
		mode: input.mode ?? "javascript",
		physicalProgram: input.physicalProgram,
		postcondition: input.postcondition,
		semanticAction: { verb: "synthetic" },
		semanticExecution: () => provider,
		browserSessionId: "session-1",
		tabId: 7,
		targetRef: "tab-stable",
		timeoutMs: 2_000,
	}, async ({ operationId }) => {
		input.recordAfterDispatch?.(registry, operationId);
		return input.result;
	});
	return { outcome, settleCalls, terminalHints };
}

test("fenced ABML settlement returns a bounded semantic effect from a stable before/after model", async () => {
	const ref = "bp-ref://control/toggle";
	const before = [entity(ref, { state: { ...DEFAULT_STATE, pressed: false } })];
	const after = [entity(ref, { state: { ...DEFAULT_STATE, pressed: true } })];
	const fixture = providerFixture([1, 1, 1, 2, 2], [before, after]);
	const deadlineAt = Date.now() + 5_000;
	const controller = new AbortController();
	await fixture.provider.prepare({ operationId: fixture.operation.operationId, deadlineAt, signal: controller.signal });
	await fixture.provider.beforeDispatch({ operationId: fixture.operation.operationId, deadlineAt, signal: controller.signal });
	fixture.markDispatched();
	const settled = await fixture.provider.settle({
		operationId: fixture.operation.operationId,
		deadlineAt,
		dispatchFinishedAt: Date.now() - 1_000,
		signal: controller.signal,
		terminalHint: "unverified-mutation",
	});
	assert.equal(settled.semantic.stability, "stable");
	assert.equal(settled.semantic.effect?.summary.hasSemanticEffect, true);
	assert.equal(settled.semantic.verification?.status, "inconclusive");
	assert.equal(settled.semantic.baseline?.endSourceSequence, 2);
	assert.equal(settled.semantic.capture?.startSourceSequence, 5);
	assert.equal(settled.semantic.capture?.endSourceSequence, 6);
	assert.equal(settled.expectedRevision, fixture.operation.revision + 6);
});

test("a torn ABML capture is discarded and retried after changeSeq stabilizes", async () => {
	const ref = "bp-ref://control/toggle";
	const before = [entity(ref, { state: { ...DEFAULT_STATE, pressed: false } })];
	const transient = [entity(ref, { state: { ...DEFAULT_STATE, pressed: false } })];
	const after = [entity(ref, { state: { ...DEFAULT_STATE, pressed: true } })];
	const fixture = providerFixture([1, 1, 1, 2, 3, 4, 4], [before, transient, after]);
	const deadlineAt = Date.now() + 5_000;
	const controller = new AbortController();
	await fixture.provider.prepare({ operationId: fixture.operation.operationId, deadlineAt, signal: controller.signal });
	await fixture.provider.beforeDispatch({ operationId: fixture.operation.operationId, deadlineAt, signal: controller.signal });
	fixture.markDispatched();
	const settled = await fixture.provider.settle({
		operationId: fixture.operation.operationId,
		deadlineAt,
		dispatchFinishedAt: Date.now() - 1_000,
		signal: controller.signal,
		terminalHint: "unverified-mutation",
	});
	assert.equal(fixture.getModelReads(), 3);
	assert.equal(settled.semantic.capture?.attempts, 2);
	assert.equal(settled.semantic.effect?.summary.hasSemanticEffect, true);
	assert.match(JSON.stringify(settled.semantic.diagnostics), /page_changed_during_capture/);
});

test("the first stable no-effect model waits for a later revision and captures the asynchronous effect", async () => {
	const ref = "bp-ref://control/toggle";
	const before = [entity(ref, { state: { ...DEFAULT_STATE, pressed: false } })];
	const unchanged = [entity(ref, { state: { ...DEFAULT_STATE, pressed: false } })];
	const after = [entity(ref, { state: { ...DEFAULT_STATE, pressed: true } })];
	const fixture = providerFixture([1, 1, 1, 2, 2, 3, 3], [before, unchanged, after], {
		onWait: (record) => record("mutation", Date.now() - 1_000),
	});
	const deadlineAt = Date.now() + 5_000;
	const controller = new AbortController();
	await fixture.provider.prepare({ operationId: fixture.operation.operationId, deadlineAt, signal: controller.signal });
	await fixture.provider.beforeDispatch({ operationId: fixture.operation.operationId, deadlineAt, signal: controller.signal });
	fixture.markDispatched();
	const settled = await fixture.provider.settle({ operationId: fixture.operation.operationId, deadlineAt, dispatchFinishedAt: Date.now() - 1_000, signal: controller.signal, terminalHint: "unverified-mutation" });
	assert.equal(fixture.getModelReads(), 3);
	assert.equal(settled.semantic.effect?.summary.hasSemanticEffect, true);
	assert.equal(settled.deadlineReached, undefined);
});

test("an unverified mutation with no semantic effect remains open until its deadline", async () => {
	const before = [entity("bp-ref://control/noop", { name: "Noop" })];
	const fixture = providerFixture([1, 1, 1, 2, 2], [before, before]);
	const deadlineAt = Date.now() + 140;
	const controller = new AbortController();
	await fixture.provider.prepare({ operationId: fixture.operation.operationId, deadlineAt, signal: controller.signal });
	await fixture.provider.beforeDispatch({ operationId: fixture.operation.operationId, deadlineAt, signal: controller.signal });
	fixture.markDispatched();
	const startedAt = Date.now();
	const settled = await fixture.provider.settle({ operationId: fixture.operation.operationId, deadlineAt, dispatchFinishedAt: Date.now() - 1_000, signal: controller.signal, terminalHint: "unverified-mutation" });
	assert.equal(settled.semantic.effect?.summary.hasSemanticEffect, false);
	assert.equal(settled.deadlineReached, true);
	assert.equal(Date.now() - startedAt >= 70, true);
});

test("a declared verifier failure commits after one stable fenced capture without waiting for a later revision", async () => {
	const before = [entity("bp-ref://control/unverified", { name: "Unverified" })];
	const fixture = providerFixture([1, 1, 1, 1, 1], [before, before]);
	const deadlineAt = Date.now() + 250;
	const signal = new AbortController().signal;
	await fixture.provider.prepare({ operationId: fixture.operation.operationId, deadlineAt, signal });
	await fixture.provider.beforeDispatch({ operationId: fixture.operation.operationId, deadlineAt, signal });
	fixture.markDispatched();
	const settled = await fixture.provider.settle({
		operationId: fixture.operation.operationId,
		deadlineAt,
		dispatchFinishedAt: Date.now() - 1_000,
		signal,
		terminalHint: "declared-failure",
	});
	assert.equal(settled.semantic.effect?.summary.hasSemanticEffect, false);
	assert.equal(settled.deadlineReached, undefined);
	assert.equal(fixture.getModelReads(), 2);
});

test("a post-fence event cannot be absorbed into the semantic terminal CAS revision", async () => {
	const before = [entity("bp-ref://control/save", { name: "Save" })];
	const after = [entity("bp-ref://control/save", { name: "Saved" })];
	let endFences = 0;
	const fixture = providerFixture([1, 1, 1, 2, 2], [before, after], {
		afterCheckpoint: (fenceId, _sourceSequence, record) => {
			if (!fenceId.includes("-end-")) return;
			endFences += 1;
			if (endFences === 2) record("mutation", Date.now());
		},
	});
	const deadlineAt = Date.now() + 5_000;
	const signal = new AbortController().signal;
	await fixture.provider.prepare({ operationId: fixture.operation.operationId, deadlineAt, signal });
	await fixture.provider.beforeDispatch({ operationId: fixture.operation.operationId, deadlineAt, signal });
	fixture.markDispatched();
	const settled = await fixture.provider.settle({ operationId: fixture.operation.operationId, deadlineAt, dispatchFinishedAt: Date.now() - 1_000, signal, terminalHint: "unverified-mutation" });
	assert.equal(settled.semantic.stability, "stable");
	assert.equal(settled.expectedRevision + 1, fixture.getOperation().revision);
	assert.equal(fixture.tryCommit(settled.expectedRevision), undefined);
});

test("a page change before the dispatch fence forces a fresh baseline before action dispatch", async () => {
	const ref = "bp-ref://control/save";
	const oldBaseline = [entity(ref, { name: "Idle" }), entity("bp-ref://status/transient", { role: "status", name: "Transient" })];
	const dispatchBaseline = [entity(ref, { name: "Save" })];
	const after = [entity(ref, { name: "Saved" })];
	let injected = false;
	const fixture = providerFixture([1, 1, 1, 2, 2, 2, 3, 3], [oldBaseline, dispatchBaseline, after], {
		beforeCheckpoint: (fenceId, record) => {
			if (injected || !fenceId.includes("-dispatch-1-")) return;
			injected = true;
			record("mutation", Date.now());
		},
	});
	const deadlineAt = Date.now() + 5_000;
	const signal = new AbortController().signal;
	await fixture.provider.prepare({ operationId: fixture.operation.operationId, deadlineAt, signal });
	await fixture.provider.beforeDispatch({ operationId: fixture.operation.operationId, deadlineAt, signal });
	assert.equal(fixture.getModelReads(), 2);
	fixture.markDispatched();
	const settled = await fixture.provider.settle({ operationId: fixture.operation.operationId, deadlineAt, dispatchFinishedAt: Date.now() - 1_000, signal, terminalHint: "unverified-mutation" });
	assert.equal(settled.semantic.effect?.disappeared.count, 0);
	assert.equal(settled.semantic.effect?.changed.items[0]?.name, "Saved");
	assert.match(JSON.stringify(settled.semantic.diagnostics), /SEMANTIC_DISPATCH_FENCE_INVALID/);
});

test("progress between the pre-dispatch and actual-handler fences invalidates action attribution", async () => {
	const before = [entity("bp-ref://control/save", { name: "Save" })];
	const fixture = providerFixture([1, 1, 1], [before]);
	const deadlineAt = Date.now() + 160;
	const signal = new AbortController().signal;
	await fixture.provider.prepare({ operationId: fixture.operation.operationId, deadlineAt, signal });
	await fixture.provider.beforeDispatch({ operationId: fixture.operation.operationId, deadlineAt, signal });
	fixture.recordActionEvent();
	fixture.markDispatched();
	const settled = await fixture.provider.settle({ operationId: fixture.operation.operationId, deadlineAt, dispatchFinishedAt: Date.now() - 1_000, signal, terminalHint: "unverified-mutation" });
	assert.equal(fixture.getModelReads(), 1);
	assert.equal(settled.semantic.stability, "unknown");
	assert.equal(settled.deadlineReached, true);
	assert.match(JSON.stringify(settled.semantic.diagnostics), /progress_during_capture/);
});

test("withBrowserOperation semantically settles acknowledged result loss under the target lock and retries stale CAS", async () => {
	const registry = new SessionOperationRegistry();
	const order: string[] = [];
	let lockHeld = false;
	let casAttempts = 0;
	let settleAttempts = 0;
	const before = [entity("bp-ref://control/save", { name: "Save" })];
	const after = [entity("bp-ref://control/save", { name: "Saved" })];
	const semanticOutcome = buildAbmlActionOutcome({ action: { verb: "execute-javascript" }, beforeEntities: before, afterEntities: after, diff: diffEntities(before, after), stability: "stable" });
	const server = {
		snapshot: () => ({ browserSessionId: "session-1", defaultTabId: 7, tabs: [{ tabId: 7, targetRef: "tab-stable", generation: 1, pageEpoch: "page-1" }] }),
		queueDepth: () => 0,
		leaseOwnerHash: () => undefined,
		mutationReplayGuard: (input: never) => registry.mutationReplayGuard(input),
		beginOperation: (input: never) => registry.begin(input),
		updateOperation: (operationId: string, patch: never) => registry.update(operationId, patch),
		getOperation: (operationId: string) => registry.get(operationId),
		finishOperation: (operationId: string, outcome: never) => registry.finish(operationId, outcome),
		finishOperationIfRevision(operationId: string, revision: number, outcome: never) {
			assert.equal(lockHeld, true);
			casAttempts += 1;
			if (casAttempts === 1) {
				order.push("cas-stale");
				registry.recordEvent(operationId, { type: "mutation", progress: true, sourceSequence: 1, data: { mutationCount: 1 } });
				return undefined;
			}
			order.push("cas-commit");
			return registry.finishIfRevision(operationId, revision, outcome);
		},
		async withTargetTransaction(_input: unknown, run: () => Promise<unknown>) {
			order.push("lock");
			lockHeld = true;
			try { return await run(); } finally { lockHeld = false; order.push("unlock"); }
		},
		async sendCommand(command: Record<string, unknown>) {
			assert.equal(lockHeld, true);
			if (command.cmd === "operation.begin") { order.push("arm"); return { acknowledged: true, data: { armed: true } }; }
			if (command.cmd === "operation.finish") { order.push("extension-finish"); return { acknowledged: true, data: { finished: true } }; }
			throw new Error(`unexpected command ${String(command.cmd)}`);
		},
	} as unknown as BrowserCommandRuntimePort;
	const provider = {
		async prepare() { assert.equal(lockHeld, true); order.push("prepare"); },
		async beforeDispatch() { assert.equal(lockHeld, true); order.push("dispatch-fence"); },
		actionEventBoundary: () => undefined,
		async settle(input: { operationId: string }) {
			assert.equal(lockHeld, true);
			settleAttempts += 1;
			order.push(`settle-${settleAttempts}`);
			return {
				expectedRevision: registry.get(input.operationId)!.revision,
				semantic: { provider: "abml" as const, stability: "stable" as const, effect: semanticOutcome.effect, verification: semanticOutcome.verification },
			};
		},
	};
	const outcome = await withBrowserOperation({
		server,
		commandName: "browser_execute",
		command: "javascript",
		mode: "javascript",
		browserSessionId: "session-1",
		tabId: 7,
		targetRef: "tab-stable",
		timeoutMs: 2_000,
		semanticAction: { verb: "execute-javascript" },
		semanticExecution: () => provider,
	}, async () => {
		assert.equal(lockHeld, true);
		order.push("dispatch");
		throw new BrowserBridgeError("BRIDGE_CLIENT_DISCONNECTED", "dispatch result was lost after acknowledgement", { acked: true, dispatchStarted: true });
	});
	assert.equal(outcome.status, "effect_observed");
	assert.equal(outcome.business?.status, "inconclusive");
	assert.equal(outcome.dispatch.acknowledged, true);
	assert.equal(outcome.dispatch.finished, false);
	assert.match(JSON.stringify(outcome.diagnostics), /dispatch result was lost after acknowledgement/);
	assert.equal(settleAttempts, 2);
	assert.equal(casAttempts, 2);
	assert.deepEqual(order, ["lock", "arm", "prepare", "dispatch-fence", "dispatch", "settle-1", "cas-stale", "settle-2", "cas-commit", "extension-finish", "unlock"]);
});

test("extension cleanup uses a fresh signal, falls back to cancel, and stays inside the target lock", async () => {
	const registry = new SessionOperationRegistry();
	const caller = new AbortController();
	const order: string[] = [];
	let lockHeld = false;
	const server = {
		snapshot: () => ({ browserSessionId: "session-1", defaultTabId: 7, tabs: [{ tabId: 7, targetRef: "tab-stable", generation: 1 }] }),
		queueDepth: () => 0,
		leaseOwnerHash: () => undefined,
		mutationReplayGuard: (input: never) => registry.mutationReplayGuard(input),
		beginOperation: (input: never) => registry.begin(input),
		updateOperation: (operationId: string, patch: never) => registry.update(operationId, patch),
		getOperation: (operationId: string) => registry.get(operationId),
		finishOperation(operationId: string, outcome: never) { order.push("daemon-terminal"); return registry.finish(operationId, outcome); },
		async withTargetTransaction(_input: unknown, run: () => Promise<unknown>) {
			order.push("lock");
			lockHeld = true;
			try { return await run(); } finally { lockHeld = false; order.push("unlock"); }
		},
		async sendCommand(command: Record<string, unknown>, options: { signal?: AbortSignal; targetRef?: string; tabId?: number }) {
			assert.equal(lockHeld, true);
			if (command.cmd === "operation.begin") { order.push("arm"); return { acknowledged: true, data: { armed: true } }; }
			assert.equal(options.targetRef, undefined);
			assert.equal(options.tabId, undefined);
			assert.equal(options.signal?.aborted, false);
			if (command.cmd === "operation.finish") { order.push("extension-finish"); throw new Error("finish transport lost"); }
			if (command.cmd === "operation.cancel") { order.push("extension-cancel"); return { acknowledged: true, data: { cancelled: true } }; }
			throw new Error(`unexpected command ${String(command.cmd)}`);
		},
	} as unknown as BrowserCommandRuntimePort;
	const outcome = await withBrowserOperation({
		server,
		commandName: "browser_execute",
		command: "javascript",
		mode: "javascript",
		browserSessionId: "session-1",
		tabId: 7,
		targetRef: "tab-stable",
		timeoutMs: 2_000,
		signal: caller.signal,
	}, async () => {
		order.push("dispatch");
		caller.abort(new BrowserBridgeError("BRIDGE_TIMEOUT", "caller disconnected", { aborted: true }));
		throw new BrowserBridgeError("BRIDGE_TIMEOUT", "caller disconnected", { dispatchStarted: true, aborted: true });
	});
	assert.equal(outcome.status, "deadline");
	assert.deepEqual(order, ["lock", "arm", "dispatch", "daemon-terminal", "extension-finish", "extension-cancel", "unlock"]);
});

test("mechanical script resolution cannot complete when ABML semantic evidence is unavailable", async () => {
	const { outcome } = await runSyntheticSemanticOperation({
		semantic: { provider: "abml", stability: "unknown", diagnostics: [{ code: "SEMANTIC_EVIDENCE_UNAVAILABLE" }] },
		result: { acknowledged: true, data: 42 },
	});
	assert.equal(outcome.status, "ambiguous");
	assert.equal(outcome.completionVerified, false);
	assert.equal(outcome.business?.status, "inconclusive");
	assert.equal(outcome.completion?.source, "script-resolved");
});

test("stable no-effect ABML evidence preserves the read-only script query compatibility path", async () => {
	const page = [entity("bp-ref://control/query", { name: "Query" })];
	const semantic = buildAbmlActionOutcome({ action: { verb: "execute-javascript" }, beforeEntities: page, afterEntities: page, diff: diffEntities(page, page), stability: "stable" });
	const { outcome } = await runSyntheticSemanticOperation({
		semantic: { provider: "abml", stability: "stable", effect: semantic.effect, verification: semantic.verification },
		result: { acknowledged: true, data: 42 },
	});
	assert.equal(outcome.status, "completed");
	assert.equal(outcome.completion?.source, "script-resolved");
});

test("an observed ABML effect outranks a later mechanical program abort", async () => {
	const before = [entity("bp-ref://control/save", { name: "Save" })];
	const after = [entity("bp-ref://control/save", { name: "Saved" })];
	const semantic = buildAbmlActionOutcome({ action: { verb: "execute-program" }, beforeEntities: before, afterEntities: after, diff: diffEntities(before, after), stability: "stable" });
	const { outcome } = await runSyntheticSemanticOperation({
		mode: "program",
		semantic: { provider: "abml", stability: "stable", effect: semantic.effect, verification: semantic.verification },
		result: {
			acknowledged: true,
			frames: [{ step: 0, kind: "eval", ok: true, durationMs: 1 }],
			result: undefined,
			aborted: { reason: "later eval failed", atStep: 1 },
		},
	});
	assert.equal(outcome.status, "effect_observed");
	assert.equal(outcome.business?.status, "inconclusive");
	assert.match(JSON.stringify(outcome.diagnostics), /PROGRAM_ABORTED/);
});

test("a failed explicit program verifier is identified as a declared semantic terminal", async () => {
	const page = [entity("bp-ref://control/unverified", { name: "Unverified" })];
	const semantic = buildAbmlActionOutcome({ action: { verb: "execute-program" }, beforeEntities: page, afterEntities: page, diff: diffEntities(page, page), stability: "stable" });
	const { outcome, terminalHints } = await runSyntheticSemanticOperation({
		mode: "program",
		physicalProgram: true,
		semantic: { provider: "abml", stability: "stable", effect: semantic.effect, verification: semantic.verification },
		result: {
			acknowledged: true,
			frames: [{ step: 0, kind: "mouse:release", ok: true, acknowledged: true, durationMs: 1 }],
			result: false,
			verification: { step: 1, passed: false, result: false },
		},
	});
	assert.deepEqual(terminalHints, ["declared-failure"]);
	assert.equal(outcome.status, "ambiguous");
	assert.match(JSON.stringify(outcome.diagnostics), /PROGRAM_VERIFICATION_FAILED/);
});

test("a durable script postcondition proof survives observer loss without waiting for ABML", async () => {
	const { outcome, settleCalls } = await runSyntheticSemanticOperation({
		postcondition: true,
		semantic: { provider: "abml", stability: "unknown" },
		result: { acknowledged: true, data: "saved", businessVerification: { passed: true, result: true } },
		recordAfterDispatch: (registry, operationId) => {
			registry.recordEvent(operationId, { type: "observer_lost", sourceSequence: 1, data: { reason: "worker_restart" } });
		},
	});
	assert.equal(settleCalls, 0);
	assert.equal(outcome.status, "completed");
	assert.equal(outcome.completion?.source, "script-postcondition-verified");
	assert.equal(outcome.business?.status, "verified");
	assert.match(JSON.stringify(outcome.diagnostics), /OPERATION_OBSERVER_LOST/);
});

test("minimal browser-operation output preserves business status and the ABML settlement summary", async () => {
	const before = [entity("bp-ref://control/save", { name: "Save" })];
	const after = [entity("bp-ref://control/save", { name: "Saved" })];
	const semantic = buildAbmlActionOutcome({ action: { verb: "execute-javascript" }, beforeEntities: before, afterEntities: after, diff: diffEntities(before, after), stability: "stable" });
	const status = "effect_observed" as const;
	const outcome: BrowserOperationOutcome = {
		schema: BROWSER_OPERATION_SCHEMA,
		operationId: "operation-semantic-compact",
		commandName: "browser_execute",
		status,
		...classifyBrowserOperationStatus(status),
		target: { browserSessionId: "session-1", tabId: 7, targetRef: "tab-stable", generation: 1 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 1, finishedAt: 2, settledAt: 3 },
		signals: { mutationCount: 1 },
		business: { status: "inconclusive", source: "abml", reason: "semantic_effect_without_expectation" },
		semantic: { provider: "abml", stability: "stable", effect: semantic.effect, verification: semantic.verification },
		diagnostics: Array.from({ length: 20 }, (_, index) => ({ code: `DETAIL_${index}`, message: "x".repeat(200) })),
	};
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-pilot-semantic-result-"));
	const result = await browserOperationCommandResult(outcome, { budgetName: "browser_execute", maxChars: 1_000, ctx: { cwd }, details: {} });
	const value = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
	assert.equal((value.business as Record<string, unknown>).status, "inconclusive");
	assert.equal((value.semantic as Record<string, unknown>).provider, "abml");
	assert.equal(((value.semantic as Record<string, unknown>).effect as Record<string, unknown>).summary !== undefined, true);
	assert.equal(((value.dispatch as Record<string, unknown>).settledAt), 3);
	assert.equal((((value.artifact_hints as Record<string, unknown>).jsonPaths as Record<string, unknown>).semantic), "semantic");
});
