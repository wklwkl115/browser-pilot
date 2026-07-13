/**
 * Handler-driven agent façade envelopes (view/act/read) with a mocked runtime.
 * Exercises shipped command.execute paths — not pure re-implementations.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandManifestIndex } from "../../src/commands/commandManifestIndex.js";
import { defineAgentFacadeCommands } from "../../src/commands/agent/defineAgentFacadeCommands.js";
import {
	setAgentObserveRunnerForTests,
	extractJsonPayload,
} from "../../src/commands/agent/agentFacadeRuntime.js";
import {
	installAgentContextService,
	resetAgentContextServiceForTests,
	AgentContextService,
} from "../../src/apps/daemon/AgentContextService.js";
import { registerRefDescriptor } from "../../src/resources/resourceStore.js";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.js";
import type { PageObservationV3 } from "../../src/kernels/abml/pageObservation.js";
import { PAGE_OBSERVATION_SCHEMA_V3 } from "../../src/kernels/abml/pageObservation.js";
import { AGENT_VIEW_SCHEMA, AGENT_TURN_SCHEMA, AGENT_READ_SCHEMA } from "../../src/kernels/agent/agentTypes.js";
import { resolveSemanticActionCompletion } from "../../src/commands/operationResolvers.js";

function fixtureObservation(): PageObservationV3 {
	return {
		schema: PAGE_OBSERVATION_SCHEMA_V3,
		tool: "browser_observe",
		model: "PageObservation",
		canonical: true,
		target: {
			browserSessionId: "sess-1",
			tabId: 7,
			targetGeneration: 1,
			pageEpoch: "epoch-1",
			url: "https://fixture.test/form",
		},
		snapshot: {
			snapshotId: "snap-agent-1",
			browserSessionId: "sess-1",
			tabId: 7,
			targetGeneration: 1,
			pageEpoch: "epoch-1",
			url: "https://fixture.test/form",
			sourceMode: "scan",
			capturedAt: Date.now(),
			ttlMs: 60_000,
		},
		actionables: [
			{ ref: "bp-ref://element/email", kind: "textbox", name: "Email" },
			{ ref: "bp-ref://element/submit", kind: "button", name: "Continue" },
		],
		providers: {},
		frontier: { items: [], truncated: false },
		limits: { budgetChars: 35_000, cost: { chars: 200, bytes: 200, estimatedTokens: 50 } },
		gist: { title: "Agent Fixture Form", text: "Sign in" },
		saved: { path: path.join(mkdtempSync(path.join(tmpdir(), "agent-facade-")), "obs.json"), chars: 10, bytes: 10 },
	} as PageObservationV3;
}

function createMockServer(): BrowserCommandRuntimePort {
	const operations = new Map<string, {
		operationId: string;
		revision: number;
		events: Array<Record<string, unknown>>;
		generation?: number;
		lastProgressAt?: number;
	}>();
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
			defaultTabId: 7,
			latestTabId: 7,
			selectionVersion: 1,
			tabs: [{
				tabId: 7,
				targetRef: "tab-handle-7",
				tabHandle: "tab-handle-7",
				url: "https://fixture.test/form",
				title: "Agent Fixture Form",
				active: true,
				generation: 1,
			}],
			pending: [],
		}),
		getTabs: () => server.snapshot().tabs,
		refreshTabs: async () => server.snapshot().tabs,
		waitForExtensionReconnect: async () => server.snapshot(),
		resolveTargetTabId: (value: unknown) => (typeof value === "number" ? value : 7),
		sendCommand: async (command: { cmd?: string }) => {
			if (command.cmd === "operation.begin") {
				return { acknowledged: true, data: { armed: true } };
			}
			if (command.cmd === "operation.finish") {
				return { acknowledged: true, data: {} };
			}
			if (command.cmd === "input.pointer" || command.cmd === "input.keys" || command.cmd === "input.insertText") {
				return {
					acknowledged: true,
					data: { ok: true, resolved: { x: 10, y: 20 }, eventCount: 1 },
				};
			}
			return { acknowledged: true, data: {} };
		},
		executeJavaScript: async () => ({ acknowledged: true, data: { result: "https://fixture.test/form" } }),
		switchTab: async () => ({ acknowledged: true, data: { active: true, selectedTabId: 7 } }),
		createTab: async () => ({
			acknowledged: true,
			data: { createdTarget: { targetRef: "tab-new", tabId: 8, url: "https://fixture.test/" } },
		}),
		closeTab: async () => ({ acknowledged: true, data: { tabId: 7 } }),
		listBrowserSessions: () => [],
		createBrowserSession: () => ({}),
		selectBrowserSession: () => ({}),
		closeBrowserSession: () => ({}),
		attachTabToBrowserSession: () => ({}),
		detachTabFromBrowserSession: () => ({}),
		selectBrowser: () => ({}),
		leaseTab: () => ({ tabId: 7 }),
		releaseTab: () => undefined,
		acquireUiLock: () => ({}),
		releaseUiLock: () => undefined,
		queueDepth: () => 0,
		leaseOwnerHash: () => "lease",
		createObservationSnapshot: (snap: Record<string, unknown>) => ({ snapshotId: "s", expired: false, ttlMs: 1, ...snap }),
		getObservationSnapshot: () => undefined,
		listObservationSnapshots: () => [],
		beginOperation: (input: Record<string, unknown>) => {
			const operationId = `op-${++opSeq}`;
			const record = {
				operationId,
				revision: 1,
				events: [] as Array<Record<string, unknown>>,
				generation: 1,
				lastProgressAt: Date.now(),
				...input,
			};
			operations.set(operationId, record);
			return record as never;
		},
		updateOperation: (operationId: string, patch: Record<string, unknown>) => {
			const current = operations.get(operationId);
			if (!current) return undefined;
			Object.assign(current, patch, { revision: current.revision + 1 });
			return current as never;
		},
		finishOperation: (operationId: string) => operations.get(operationId) as never,
		getOperation: (operationId: string) => operations.get(operationId) as never,
		waitForOperationChange: async (operationId: string) => {
			const current = operations.get(operationId);
			// No progress events → pure liveness will classify no_effect/effect after wait.
			// Record a mutation progress event so physical programs can settle via semantic resolvers
			// when result is present (fill) or stay non-completed for activate without nav.
			if (current && current.events.length === 0) {
				current.events.push({
					type: "mutation",
					operationId,
					sequence: 1,
					timestamp: Date.now(),
					progress: true,
					data: { mutationCount: 1 },
				});
				current.revision += 1;
				current.lastProgressAt = Date.now();
			}
			return current as never;
		},
		surfaceLateEffects: () => [],
	};
	return server as unknown as BrowserCommandRuntimePort;
}

function registerFixtureRefs() {
	for (const refId of ["bp-ref://element/email", "bp-ref://element/submit"]) {
		registerRefDescriptor({
			descriptor: {
				refId,
				kind: "element",
				locators: [{ by: "css", value: refId.includes("email") ? "#email" : "#submit" }],
				owner: { browserSessionId: "sess-1", tabId: 7 },
				policy: { redaction: "none" },
				createdAt: Date.now(),
				ttlMs: 60_000,
				geometry: { box: { x: 10, y: 20, w: 100, h: 24 }, point: { x: 60, y: 32 } },
			},
			browserSessionId: "sess-1",
		});
	}
}

function parseEnvelope(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
	const payload = extractJsonPayload(result);
	assert.ok(payload && typeof payload === "object");
	return payload as Record<string, unknown>;
}

function assertNoMechanicalLeak(envelope: unknown) {
	const text = JSON.stringify(envelope);
	assert.doesNotMatch(text, /"tabId"\s*:/);
	assert.doesNotMatch(text, /pageEpoch/);
	assert.doesNotMatch(text, /browserSessionId/);
	assert.doesNotMatch(text, /backendNodeId/);
	// Windows absolute paths only (avoid matching https://)
	assert.doesNotMatch(text, /[A-Za-z]:\\/);
	assert.doesNotMatch(text, /obs\.json/);
	assert.doesNotMatch(text, /\.browser-pilot[\\/]artifacts/);
}

test("handler-driven browser_view/act/read produce AgentView/AgentTurn/AgentRead envelopes", async () => {
	resetAgentContextServiceForTests();
	installAgentContextService(new AgentContextService());
	registerFixtureRefs();

	const observation = fixtureObservation();
	writeFileSync(observation.saved!.path!, JSON.stringify(observation), "utf8");
	setAgentObserveRunnerForTests(async () => observation);

	const server = createMockServer();
	const index = new CommandManifestIndex();
	defineAgentFacadeCommands({
		commands: index,
		ensureStarted: async () => server,
	});

	const viewCmd = index.getCommand("browser_view");
	const actCmd = index.getCommand("browser_act");
	const readCmd = index.getCommand("browser_read");
	assert.ok(viewCmd && actCmd && readCmd);

	const viewResult = await viewCmd.execute("t1", { detail: "decision" }, undefined, undefined, {
		operationOwnerId: "owner-test",
	});
	const view = parseEnvelope(viewResult);
	assert.equal(view.schema, AGENT_VIEW_SCHEMA);
	assert.ok(view.context && typeof (view.context as { contextRef?: string }).contextRef === "string");
	const contextRef = (view.context as { contextRef: string }).contextRef;
	const candidates = view.candidates as Array<{ ref: string; actions: string[] }>;
	assert.ok(candidates.length >= 1);
	assert.ok(candidates[0]!.ref.startsWith("a_"));
	assertNoMechanicalLeak(view);

	const fillCandidate = candidates.find((c) => c.actions.includes("fill")) ?? candidates[0]!;
	const actResult = await actCmd.execute("t2", {
		contextRef,
		action: { kind: "fill", ref: fillCandidate.ref, value: "agent@example.test" },
	}, undefined, undefined, { operationOwnerId: "owner-test" });
	const turn = parseEnvelope(actResult);
	assert.equal(turn.schema, AGENT_TURN_SCHEMA);
	const outcome = turn.outcome as { status: string; ok: boolean; classification: string; replay: string; completionSource?: string };
	// Happy path: registered refs + successful frames → completed via semantic.fill
	assert.equal(outcome.status, "completed");
	assert.equal(outcome.ok, true);
	assert.equal(outcome.classification, "success");
	assert.equal(outcome.completionSource, "semantic-fill-applied");
	assert.ok(turn.viewStatus === "available" || turn.viewStatus === "unavailable");
	assertNoMechanicalLeak(turn);

	// Resolver gate: aborted / empty frames must not complete
	assert.equal(resolveSemanticActionCompletion("semantic.fill", {
		commandName: "browser_execute",
		mode: "program",
		physicalProgram: true,
		result: {
			frames: [{ step: 0, kind: "mouse:press", ok: false, durationMs: 1 }],
			aborted: { reason: "ref precheck failed — dead refs: bp-ref://missing", atStep: -1 },
		},
		events: [],
	}), undefined);
	assert.equal(resolveSemanticActionCompletion("semantic.fill", {
		commandName: "browser_execute",
		mode: "program",
		physicalProgram: true,
		result: { frames: [], result: { ok: true } },
		events: [],
	}), undefined);

	const reads = (turn.view as { reads?: Array<{ readRef: string }> } | undefined)?.reads
		?? (view.reads as Array<{ readRef: string }> | undefined);
	if (reads && reads[0]) {
		const readResult = await readCmd.execute("t3", {
			contextRef,
			readRef: reads[0].readRef,
		}, undefined, undefined, { operationOwnerId: "owner-test" });
		const read = parseEnvelope(readResult);
		assert.equal(read.schema, AGENT_READ_SCHEMA);
		assert.equal(read.readRef, reads[0].readRef);
		assertNoMechanicalLeak(read);
	} else {
		// Still exercise read path: re-view binds reads from observation.saved
		const view2 = parseEnvelope(await viewCmd.execute("t4", { contextRef }, undefined, undefined, { operationOwnerId: "owner-test" }));
		const readOptions = view2.reads as Array<{ readRef: string }> | undefined;
		assert.ok(readOptions && readOptions.length > 0, "expected readRef options from view");
		const readResult = await readCmd.execute("t5", {
			contextRef,
			readRef: readOptions![0]!.readRef,
		}, undefined, undefined, { operationOwnerId: "owner-test" });
		const read = parseEnvelope(readResult);
		assert.equal(read.schema, AGENT_READ_SCHEMA);
		assertNoMechanicalLeak(read);
	}

	// Activate turn (separate context) — pure click has no semantic completed without nav
	const viewB = parseEnvelope(await viewCmd.execute("t6", {}, undefined, undefined, { operationOwnerId: "owner-b" }));
	const ctxB = (viewB.context as { contextRef: string }).contextRef;
	const activateRef = (viewB.candidates as Array<{ ref: string; actions: string[] }>).find((c) => c.actions.includes("activate"))?.ref
		?? (viewB.candidates as Array<{ ref: string }>)[0]!.ref;
	const activateTurn = parseEnvelope(await actCmd.execute("t7", {
		contextRef: ctxB,
		action: { kind: "activate", ref: activateRef },
	}, undefined, undefined, { operationOwnerId: "owner-b" }));
	assert.equal(activateTurn.schema, AGENT_TURN_SCHEMA);
	const activateOutcome = activateTurn.outcome as { status: string; ok: boolean; classification: string };
	// Without navigation/download evidence, activate must not invent success via generic mutation.
	assert.notEqual(activateOutcome.status, "completed");
	assert.equal(activateOutcome.ok, false);
	assert.notEqual(activateOutcome.classification, "success");
	assertNoMechanicalLeak(activateTurn);

	// Failure path: fill against unregistered ref aborts program → must not promote to completed
	const deadObs = {
		...observation,
		actionables: [{ ref: "bp-ref://element/unregistered-missing", kind: "textbox", name: "Ghost" }],
		saved: undefined,
	} as PageObservationV3;
	setAgentObserveRunnerForTests(async () => deadObs);
	const viewDead = parseEnvelope(await viewCmd.execute("t8", {}, undefined, undefined, { operationOwnerId: "owner-dead" }));
	const ctxDead = (viewDead.context as { contextRef: string }).contextRef;
	const deadFill = (viewDead.candidates as Array<{ ref: string; actions: string[] }>)[0]!;
	const failTurn = parseEnvelope(await actCmd.execute("t9", {
		contextRef: ctxDead,
		action: { kind: "fill", ref: deadFill.ref, value: "should-fail" },
	}, undefined, undefined, { operationOwnerId: "owner-dead" }));
	assert.equal(failTurn.schema, AGENT_TURN_SCHEMA);
	const failOutcome = failTurn.outcome as { status: string; ok: boolean; classification: string; completionSource?: string };
	assert.notEqual(failOutcome.status, "completed");
	assert.equal(failOutcome.ok, false);
	assert.notEqual(failOutcome.classification, "success");
	assert.notEqual(failOutcome.completionSource, "semantic-fill-applied");

	setAgentObserveRunnerForTests(undefined);
	resetAgentContextServiceForTests();
});
