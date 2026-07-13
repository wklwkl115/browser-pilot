/**
 * Full remaining DoD: confirmation, recovery codes, select/drag/submit,
 * trace fail-open, owner deny, busy, identity reanchor stop, aborted fill, no replay.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandManifestIndex } from "../../src/commands/commandManifestIndex.js";
import { defineAgentFacadeCommands } from "../../src/commands/agent/defineAgentFacadeCommands.js";
import { setAgentObserveRunnerForTests, extractJsonPayload, agentContextPort } from "../../src/commands/agent/agentFacadeRuntime.js";
import {
	installAgentContextService,
	resetAgentContextServiceForTests,
	AgentContextService,
} from "../../src/apps/daemon/AgentContextService.js";
import {
	installActionConfirmationService,
	resetActionConfirmationServiceForTests,
	ActionConfirmationService,
} from "../../src/apps/daemon/ActionConfirmationService.js";
import {
	installAgentTraceStore,
	resetAgentTraceStoreForTests,
	AgentTraceStore,
	getAgentTraceStore,
} from "../../src/apps/daemon/AgentTraceStore.js";
import { registerRefDescriptor } from "../../src/resources/resourceStore.js";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.js";
import type { PageObservationV3 } from "../../src/kernels/abml/pageObservation.js";
import { PAGE_OBSERVATION_SCHEMA_V3 } from "../../src/kernels/abml/pageObservation.js";
import { AGENT_TURN_SCHEMA, AGENT_VIEW_SCHEMA } from "../../src/kernels/agent/agentTypes.js";
import { compileSemanticAction } from "../../src/browser-command-runtime/semanticActionCompiler.js";
import { validateProgram } from "../../src/browser-command-runtime/programDispatcher.js";
import { SEMANTIC_ACTION_COMPLETION_RESOLVER_REGISTRY } from "../../src/commands/operationResolvers.js";
import { AGENT_PUBLISHED_WRITE_KINDS } from "../../src/kernels/agent/agentTypes.js";
import { SEMANTIC_COMPLETION_RESOLVER_IDS } from "../../src/kernels/agent/semanticAction.js";
import { mayAutoReplayMutation } from "../../src/kernels/agent/recoveryPolicy.js";
import type { BrowserTextCommandResult } from "../../src/utils/toolResult.js";

function fixtureObservation(over: Partial<PageObservationV3> & { pageEpoch?: string } = {}): PageObservationV3 {
	const dir = mkdtempSync(path.join(tmpdir(), "agent-complete-"));
	const savedPath = path.join(dir, "obs.json");
	const epoch = over.pageEpoch ?? "epoch-1";
	const observation = {
		schema: PAGE_OBSERVATION_SCHEMA_V3,
		tool: "browser_observe",
		model: "PageObservation",
		canonical: true,
		target: {
			browserSessionId: "sess-1",
			tabId: 7,
			targetGeneration: 1,
			pageEpoch: epoch,
			url: "https://fixture.test/form",
		},
		snapshot: {
			snapshotId: "snap-1",
			browserSessionId: "sess-1",
			tabId: 7,
			targetGeneration: 1,
			pageEpoch: epoch,
			url: "https://fixture.test/form",
			sourceMode: "scan",
			capturedAt: Date.now(),
			ttlMs: 60_000,
		},
		actionables: [
			{ ref: "bp-ref://element/email", kind: "textbox", name: "Email" },
			{ ref: "bp-ref://element/submit", kind: "button", name: "Continue" },
			{ ref: "bp-ref://element/select", kind: "select", name: "Country" },
		],
		providers: {},
		frontier: { items: [], truncated: false },
		limits: { budgetChars: 35_000, cost: { chars: 100, bytes: 100, estimatedTokens: 25 } },
		gist: { title: "Form", text: "Sign in" },
		saved: { path: savedPath, chars: 10, bytes: 10 },
		...over,
	} as PageObservationV3;
	// re-apply epoch after spread
	observation.target.pageEpoch = epoch;
	observation.snapshot.pageEpoch = epoch;
	writeFileSync(savedPath, JSON.stringify(observation));
	return observation;
}

function createMockServer(): BrowserCommandRuntimePort {
	const operations = new Map<string, { operationId: string; revision: number; events: Array<Record<string, unknown>>; lastProgressAt?: number }>();
	let opSeq = 0;
	const server = {
		snapshot: () => ({
			browserSessionId: "sess-1",
			host: "127.0.0.1",
			port: 18765,
			running: true,
			connectedClients: 1,
			extensionConnected: true,
			clients: [],
			selectionVersion: 1,
			tabs: [{ tabId: 7, targetRef: "t7", tabHandle: "t7", url: "https://fixture.test/form", title: "Form", active: true, generation: 1 }],
			pending: [],
		}),
		getTabs: () => server.snapshot().tabs,
		refreshTabs: async () => server.snapshot().tabs,
		waitForExtensionReconnect: async () => server.snapshot(),
		resolveTargetTabId: (v: unknown) => (typeof v === "number" ? v : 7),
		sendCommand: async (command: { cmd?: string }) => {
			if (command.cmd === "operation.begin") return { acknowledged: true, data: { armed: true } };
			return { acknowledged: true, data: { ok: true, resolved: { x: 1, y: 1 }, eventCount: 1 } };
		},
		executeJavaScript: async () => ({ acknowledged: true, data: { result: "https://fixture.test/form" } }),
		createTab: async () => ({ acknowledged: true, data: { createdTarget: { targetRef: "tn", tabId: 8 } } }),
		switchTab: async () => ({ acknowledged: true, data: {} }),
		closeTab: async () => ({ acknowledged: true, data: {} }),
		listBrowserSessions: () => [],
		createBrowserSession: () => ({}),
		selectBrowserSession: () => ({}),
		closeBrowserSession: () => ({}),
		attachTabToBrowserSession: () => ({}),
		detachTabFromBrowserSession: () => ({}),
		selectBrowser: () => ({}),
		leaseTab: () => ({}),
		releaseTab: () => undefined,
		acquireUiLock: () => ({}),
		releaseUiLock: () => undefined,
		queueDepth: () => 0,
		leaseOwnerHash: () => "h",
		createObservationSnapshot: (s: Record<string, unknown>) => ({ snapshotId: "s", expired: false, ttlMs: 1, ...s }),
		getObservationSnapshot: () => undefined,
		listObservationSnapshots: () => [],
		beginOperation: (input: Record<string, unknown>) => {
			const operationId = `op-${++opSeq}`;
			const record = { operationId, revision: 1, events: [] as Array<Record<string, unknown>>, lastProgressAt: Date.now(), ...input };
			operations.set(operationId, record);
			return record as never;
		},
		updateOperation: (operationId: string, patch: Record<string, unknown>) => {
			const current = operations.get(operationId);
			if (!current) return undefined;
			Object.assign(current, patch, { revision: current.revision + 1 });
			return current as never;
		},
		finishOperation: (id: string) => operations.get(id) as never,
		getOperation: (id: string) => operations.get(id) as never,
		waitForOperationChange: async (id: string) => {
			const current = operations.get(id);
			if (current && current.events.length === 0) {
				current.events.push({ type: "mutation", operationId: id, sequence: 1, timestamp: Date.now(), progress: true, data: { mutationCount: 1 } });
				current.revision += 1;
			}
			return current as never;
		},
		surfaceLateEffects: () => [],
	};
	return server as unknown as BrowserCommandRuntimePort;
}

function registerRefs() {
	for (const [refId, sel] of [
		["bp-ref://element/email", "#email"],
		["bp-ref://element/submit", "#submit"],
		["bp-ref://element/select", "#country"],
		["bp-ref://element/from", "#from"],
		["bp-ref://element/to", "#to"],
	] as const) {
		registerRefDescriptor({
			descriptor: {
				refId,
				kind: "element",
				locators: [{ by: "css", value: sel }],
				owner: { browserSessionId: "sess-1", tabId: 7 },
				policy: { redaction: "none" },
				createdAt: Date.now(),
				ttlMs: 60_000,
				geometry: { box: { x: 1, y: 2, w: 10, h: 10 }, point: { x: 5, y: 5 } },
			},
			browserSessionId: "sess-1",
		});
	}
}

function errorCode(result: BrowserTextCommandResult): string | undefined {
	const details = result.details as { error?: { code?: string; details?: { code?: string; agentCode?: string } } } | undefined;
	return details?.error?.code
		?? details?.error?.details?.agentCode
		?? details?.error?.details?.code;
}

function asEnvelope(result: BrowserTextCommandResult): Record<string, unknown> {
	const payload = extractJsonPayload(result);
	assert.ok(payload && typeof payload === "object");
	return payload as Record<string, unknown>;
}

test("enum↔resolver coverage includes select/drag/submit", () => {
	for (const kind of AGENT_PUBLISHED_WRITE_KINDS) {
		const id = SEMANTIC_COMPLETION_RESOLVER_IDS[kind];
		assert.ok(id in SEMANTIC_ACTION_COMPLETION_RESOLVER_REGISTRY, `missing ${id}`);
	}
});

test("select/drag/submit compile to valid programOps frames", () => {
	const bindings = new Map([
		["a_01", {
			ref: "a_01",
			contextRevision: 1,
			pageIdentity: { browserSessionId: "s", tabId: 1, targetGeneration: 1, pageEpoch: "e", url: "https://x.test/" },
			resourceRef: "bp-ref://element/select",
			role: "select",
			allowedActions: ["select", "activate"] as const,
			createdAt: 1,
		}],
		["a_02", {
			ref: "a_02",
			contextRevision: 1,
			pageIdentity: { browserSessionId: "s", tabId: 1, targetGeneration: 1, pageEpoch: "e", url: "https://x.test/" },
			resourceRef: "bp-ref://element/from",
			role: "generic",
			allowedActions: ["drag", "activate"] as const,
			createdAt: 1,
		}],
		["a_03", {
			ref: "a_03",
			contextRevision: 1,
			pageIdentity: { browserSessionId: "s", tabId: 1, targetGeneration: 1, pageEpoch: "e", url: "https://x.test/" },
			resourceRef: "bp-ref://element/to",
			role: "generic",
			allowedActions: ["drag", "activate"] as const,
			createdAt: 1,
		}],
		["a_04", {
			ref: "a_04",
			contextRevision: 1,
			pageIdentity: { browserSessionId: "s", tabId: 1, targetGeneration: 1, pageEpoch: "e", url: "https://x.test/" },
			resourceRef: "bp-ref://element/submit",
			role: "button",
			allowedActions: ["submit", "activate"] as const,
			createdAt: 1,
		}],
	]);
	const select = compileSemanticAction({ kind: "select", ref: "a_01", value: "US" }, bindings as never);
	assert.ok("execution" in select);
	if (select.execution.kind === "program") assert.equal(validateProgram(select.execution.program).ok, true);
	const drag = compileSemanticAction({ kind: "drag", fromRef: "a_02", toRef: "a_03" }, bindings as never);
	assert.ok("execution" in drag);
	if (drag.execution.kind === "program") {
		assert.equal(validateProgram(drag.execution.program).ok, true);
		assert.equal(drag.execution.program[0]?.mouse, "drag");
	}
	const submit = compileSemanticAction({ kind: "submit", ref: "a_04" }, bindings as never);
	assert.ok("execution" in submit);
	assert.equal(submit.safety.requiresConfirmation, true);
});

test("handler: confirmation, owner deny, one-shot, busy, identity stop, stale, abort, replay deny, trace fail-open", async () => {
	resetAgentContextServiceForTests();
	resetActionConfirmationServiceForTests();
	resetAgentTraceStoreForTests();
	installAgentContextService(new AgentContextService());
	installActionConfirmationService(new ActionConfirmationService());
	installAgentTraceStore(new AgentTraceStore());
	registerRefs();

	let observeEpoch = "epoch-1";
	setAgentObserveRunnerForTests(async () => fixtureObservation({ pageEpoch: observeEpoch }));
	const server = createMockServer();
	const index = new CommandManifestIndex();
	defineAgentFacadeCommands({ commands: index, ensureStarted: async () => server });
	const viewCmd = index.getCommand("browser_view")!;
	const actCmd = index.getCommand("browser_act")!;

	const evidence: Record<string, unknown> = {};

	const view = asEnvelope(await viewCmd.execute("1", {}, undefined, undefined, { operationOwnerId: "owner-a" }));
	assert.equal(view.schema, AGENT_VIEW_SCHEMA);
	const contextRef = (view.context as { contextRef: string }).contextRef;
	const candidates = view.candidates as Array<{ ref: string; actions: string[] }>;
	evidence.view = view;

	// navigate without confirmation
	const needConfirm = asEnvelope(await actCmd.execute("2", {
		contextRef,
		action: { kind: "navigate", url: "https://example.test/pay" },
	}, undefined, undefined, { operationOwnerId: "owner-a" }));
	assert.equal(needConfirm.schema, AGENT_TURN_SCHEMA);
	assert.equal((needConfirm.decision as { kind: string }).kind, "confirm");
	assert.equal((needConfirm.outcome as { ok: boolean }).ok, false);
	assert.equal((needConfirm.outcome as { code?: string }).code, "CONFIRMATION_REQUIRED");
	const confirmRef = (needConfirm.decision as { confirmationRef: string }).confirmationRef;
	assert.ok(confirmRef);
	evidence.confirmationRequired = needConfirm;

	// foreign owner steal of confirmationRef → CONFIRMATION_MISMATCH (owner digest)
	const steal = await actCmd.execute("3", {
		contextRef,
		confirmationRef: confirmRef,
		action: { kind: "navigate", url: "https://example.test/pay" },
	}, undefined, undefined, { operationOwnerId: "owner-b" });
	// owner-b cannot get context either — may be CONTEXT_OWNER_MISMATCH first
	const stealCode = errorCode(steal);
	assert.ok(
		stealCode === "CONTEXT_OWNER_MISMATCH" || stealCode === "CONFIRMATION_MISMATCH",
		`expected owner/confirmation deny, got ${stealCode}`,
	);
	evidence.foreignOwnerDeny = { code: stealCode, details: steal.details };

	// correct confirmation allows dispatch
	const confirmed = asEnvelope(await actCmd.execute("4", {
		contextRef,
		confirmationRef: confirmRef,
		action: { kind: "navigate", url: "https://example.test/pay" },
	}, undefined, undefined, { operationOwnerId: "owner-a" }));
	assert.equal(confirmed.schema, AGENT_TURN_SCHEMA);
	evidence.confirmedNavigate = confirmed;

	// one-shot re-consume → CONFIRMATION_MISMATCH or CONSUMED / required again
	const again = await actCmd.execute("5", {
		contextRef,
		confirmationRef: confirmRef,
		action: { kind: "navigate", url: "https://example.test/pay" },
	}, undefined, undefined, { operationOwnerId: "owner-a" });
	const againCode = errorCode(again) ?? (extractJsonPayload(again) as { outcome?: { code?: string }; decision?: { kind?: string } })?.outcome?.code;
	const againBody = extractJsonPayload(again) as { decision?: { kind?: string }; outcome?: { code?: string } } | undefined;
	assert.ok(
		againCode === "CONFIRMATION_MISMATCH"
		|| againCode === "CONFIRMATION_CONSUMED"
		|| againBody?.decision?.kind === "confirm"
		|| againBody?.outcome?.code === "CONFIRMATION_REQUIRED",
		`expected one-shot failure, got code=${againCode} decision=${againBody?.decision?.kind}`,
	);
	evidence.oneShotReconsume = { code: againCode, body: againBody };

	// fill happy path + trace
	const fillRef = candidates.find((c) => c.actions.includes("fill"))?.ref ?? candidates[0]!.ref;
	const fillTurn = asEnvelope(await actCmd.execute("6", {
		contextRef,
		action: { kind: "fill", ref: fillRef, value: "a@b.c" },
	}, undefined, undefined, { operationOwnerId: "owner-a" }));
	assert.equal((fillTurn.trace as { available: boolean }).available, true);
	assert.ok(String((fillTurn.trace as { traceRef?: string }).traceRef).startsWith("tr_"));
	assert.equal((fillTurn.outcome as { status: string }).status, "completed");
	evidence.fill = fillTurn;

	// identical fill replay at same revision after ACK → MUTATION_REPLAY_DENIED / INVALID_AGENT_REQUEST
	const replay = await actCmd.execute("6b", {
		contextRef,
		action: { kind: "fill", ref: fillRef, value: "a@b.c" },
	}, undefined, undefined, { operationOwnerId: "owner-a" });
	const replayCode = errorCode(replay);
	assert.ok(
		replayCode === "INVALID_AGENT_REQUEST" || replayCode === "MUTATION_REPLAY_DENIED",
		`expected replay deny, got ${replayCode}`,
	);
	const replayDetails = (replay.details as { error?: { details?: { code?: string; replay?: string } } })?.error?.details;
	assert.ok(
		replayDetails?.code === "MUTATION_REPLAY_DENIED" || replayDetails?.replay === "do_not_retry" || /acknowledged|replay/i.test(JSON.stringify(replay.details)),
		`expected replay denial details, got ${JSON.stringify(replay.details)}`,
	);
	evidence.mutationReplayDenied = { code: replayCode, details: replay.details };
	assert.equal(mayAutoReplayMutation("acked"), false);

	// CONTEXT_BUSY with hard code assert (use an activate-capable candidate)
	const port = agentContextPort();
	const rec = port.get(contextRef, "owner-a");
	assert.ok(!("error" in rec));
	const activateRef = candidates.find((c) => c.actions.includes("activate"))?.ref
		?? candidates.find((c) => c.actions.includes("fill"))?.ref
		?? candidates[0]!.ref;
	const busyAction = candidates.find((c) => c.actions.includes("activate"))
		? { kind: "activate" as const, ref: activateRef }
		: { kind: "fill" as const, ref: activateRef, value: "busy-test" };
	if (!("error" in rec)) {
		port.beginMutation(rec, "hold-op");
		const busy = await actCmd.execute("7", {
			contextRef,
			action: busyAction,
		}, undefined, undefined, { operationOwnerId: "owner-a" });
		const busyCode = errorCode(busy);
		assert.equal(busyCode, "CONTEXT_BUSY", `expected CONTEXT_BUSY, got ${busyCode} ${JSON.stringify(busy.details)}`);
		evidence.contextBusy = { code: busyCode };
		port.endMutation(rec, "anchored");
	}

	// foreign owner on context
	const denied = port.get(contextRef, "owner-other");
	assert.deepEqual(denied, { error: "CONTEXT_OWNER_MISMATCH" });
	evidence.foreignOwnerContext = denied;

	// identity change pre-dispatch stop (document_changed) — no mutation
	observeEpoch = "epoch-2-document-changed";
	const identityStop = asEnvelope(await actCmd.execute("8", {
		contextRef,
		action: { kind: "activate", ref: candidates[0]!.ref },
	}, undefined, undefined, { operationOwnerId: "owner-a" }));
	assert.equal((identityStop.outcome as { code?: string }).code, "IDENTITY_CHANGED");
	assert.equal((identityStop.outcome as { ok: boolean }).ok, false);
	assert.notEqual((identityStop as { details?: { dispatched?: boolean } }).details?.dispatched, true);
	// details from inlineJsonCommandResult
	evidence.identityChanged = identityStop;
	// reset epoch for further steps
	observeEpoch = "epoch-2-document-changed";

	// re-view to rebind after identity change
	const view2 = asEnvelope(await viewCmd.execute("9", { contextRef }, undefined, undefined, { operationOwnerId: "owner-a" }));
	const candidates2 = view2.candidates as Array<{ ref: string; actions: string[] }>;
	const fillRef2 = candidates2.find((c) => c.actions.includes("fill"))?.ref ?? candidates2[0]!.ref;

	// stale ref (old a_01 from prior view) should fail REF_STALE
	const stale = await actCmd.execute("10", {
		contextRef,
		action: { kind: "fill", ref: "a_99_missing", value: "x" },
	}, undefined, undefined, { operationOwnerId: "owner-a" });
	const staleCode = errorCode(stale);
	assert.equal(staleCode, "REF_STALE", `expected REF_STALE, got ${staleCode}`);
	evidence.staleRef = { code: staleCode };

	// aborted program (unregistered ref in observation) never completed
	const deadObs = fixtureObservation({
		pageEpoch: observeEpoch,
		actionables: [{ ref: "bp-ref://element/unregistered-missing", kind: "textbox", name: "Ghost" }],
		saved: undefined,
	} as never);
	setAgentObserveRunnerForTests(async () => deadObs);
	const viewDead = asEnvelope(await viewCmd.execute("11", {}, undefined, undefined, { operationOwnerId: "owner-dead" }));
	const ctxDead = (viewDead.context as { contextRef: string }).contextRef;
	const deadFillRef = (viewDead.candidates as Array<{ ref: string }>)[0]!.ref;
	const failTurn = asEnvelope(await actCmd.execute("12", {
		contextRef: ctxDead,
		action: { kind: "fill", ref: deadFillRef, value: "should-fail" },
	}, undefined, undefined, { operationOwnerId: "owner-dead" }));
	assert.notEqual((failTurn.outcome as { status: string }).status, "completed");
	assert.equal((failTurn.outcome as { ok: boolean }).ok, false);
	evidence.abortedFill = failTurn;

	// trace store fail-open: outcome preserved when store fails
	setAgentObserveRunnerForTests(async () => fixtureObservation({ pageEpoch: "epoch-trace" }));
	const viewT = asEnvelope(await viewCmd.execute("13", {}, undefined, undefined, { operationOwnerId: "owner-trace" }));
	const ctxT = (viewT.context as { contextRef: string }).contextRef;
	const fillT = (viewT.candidates as Array<{ ref: string; actions: string[] }>).find((c) => c.actions.includes("fill"))?.ref
		?? (viewT.candidates as Array<{ ref: string }>)[0]!.ref;
	getAgentTraceStore().forceNextRecordFailure("forced_trace_failure");
	const fillWithTraceFail = asEnvelope(await actCmd.execute("14", {
		contextRef: ctxT,
		action: { kind: "fill", ref: fillT, value: "ok@example.test" },
	}, undefined, undefined, { operationOwnerId: "owner-trace" }));
	assert.equal((fillWithTraceFail.outcome as { status: string }).status, "completed");
	assert.equal((fillWithTraceFail.outcome as { ok: boolean }).ok, true);
	assert.equal((fillWithTraceFail.trace as { available: boolean }).available, false);
	assert.equal((fillWithTraceFail.trace as { unavailableReason?: string }).unavailableReason, "forced_trace_failure");
	evidence.traceFailOpen = fillWithTraceFail;

	// post-view fail-open: observe succeeds for preflight/dispatch path, fails only after settle
	let observeCalls = 0;
	setAgentObserveRunnerForTests(async () => {
		observeCalls += 1;
		// act preflight (1) + post-view (2+): fail post-view only
		if (observeCalls >= 2) throw new Error("post_view_forced_failure");
		return fixtureObservation({ pageEpoch: "epoch-postview" });
	});
	const viewPv = asEnvelope(await viewCmd.execute("15", {}, undefined, undefined, { operationOwnerId: "owner-pv" }));
	// view also calls observe once → reset counter after view
	observeCalls = 0;
	const ctxPv = (viewPv.context as { contextRef: string }).contextRef;
	const fillPv = (viewPv.candidates as Array<{ ref: string; actions: string[] }>).find((c) => c.actions.includes("fill"))?.ref
		?? (viewPv.candidates as Array<{ ref: string }>)[0]!.ref;
	const postViewFail = asEnvelope(await actCmd.execute("16", {
		contextRef: ctxPv,
		action: { kind: "fill", ref: fillPv, value: "postview@example.test" },
	}, undefined, undefined, { operationOwnerId: "owner-pv" }));
	assert.equal((postViewFail.outcome as { status: string }).status, "completed", "settled outcome must survive post-view failure");
	assert.equal((postViewFail.outcome as { ok: boolean }).ok, true);
	assert.equal(postViewFail.viewStatus, "unavailable");
	assert.match(String(postViewFail.viewUnavailableReason ?? ""), /post_view_forced_failure|VIEW_UNAVAILABLE/i);
	evidence.postViewFailOpen = postViewFail;

	// daemon restart expires contexts
	agentContextPort().expireAll();
	assert.deepEqual(agentContextPort().get(contextRef, "owner-a"), { error: "CONTEXT_EXPIRED" });
	evidence.daemonExpire = { error: "CONTEXT_EXPIRED" };

	// write evidence for verifier
	const scratch = process.env.AGENT_COMPLETE_SCRATCH ?? path.join(tmpdir(), "agent-complete-evidence");
	mkdirSync(scratch, { recursive: true });
	writeFileSync(path.join(scratch, "agent-complete-invoke.json"), JSON.stringify(evidence, null, 2));

	setAgentObserveRunnerForTests(undefined);
	resetAgentContextServiceForTests();
	resetActionConfirmationServiceForTests();
	resetAgentTraceStoreForTests();
});
