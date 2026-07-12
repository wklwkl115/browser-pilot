import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_ARTIFACT_READ_BYTES } from "../../src/artifacts/artifactReaderShared.ts";
import { DEFAULT_BROWSER_BRIDGE_MAX_PAYLOAD_BYTES } from "../../src/bridge/server/BrowserBridgeHttpServer.ts";
import { defineArtifactCommand } from "../../src/commands/artifactCommand.ts";
import { CommandManifestIndex, type CommandDefinition } from "../../src/commands/commandManifestIndex.ts";
import { defineExecuteCommand } from "../../src/commands/executeCommand.ts";
import { defineNativeCommand } from "../../src/commands/nativeCommand.ts";
import { defineNetworkCommand } from "../../src/commands/nativeActionCommands.ts";
import { defineObserveCommand } from "../../src/commands/observeCommand.ts";
import { defineTabsCommand } from "../../src/commands/tabsCommand.ts";
import { browserOperationCommandResult } from "../../src/commands/browserOperationResult.ts";
import {
	BROWSER_OPERATION_SCHEMA,
	classifyBrowserOperationStatus,
	type BrowserOperationStatus,
} from "../../src/kernels/session/browserOperation.ts";
import { publicCreateTabResult } from "../../src/commands/tabsProjection.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";
import type { BrowserBridgeExecutionResult } from "../../src/ports/BrowserRuntimeTypes.ts";
import { BrowserBridgeError } from "../../src/utils/errors.ts";

type RuntimeCall = { name: string; args: unknown[] };

type MockRuntime = BrowserCommandRuntimePort & { calls: RuntimeCall[] };

function parseResult(result: { content: Array<{ text: string }> }): Record<string, unknown> {
	return JSON.parse(result.content[0]?.text || "{}") as Record<string, unknown>;
}

function operationContract(status: BrowserOperationStatus) {
	return { schema: BROWSER_OPERATION_SCHEMA, status, ...classifyBrowserOperationStatus(status) };
}

function defineCommand(register: (context: { commands: CommandManifestIndex; ensureStarted: () => Promise<BrowserCommandRuntimePort> }) => void, runtime: BrowserCommandRuntimePort): CommandDefinition {
	const commands = new CommandManifestIndex();
	register({ commands, ensureStarted: async () => runtime });
	const [command] = commands.getCommands();
	assert.ok(command);
	return command;
}

function baseSnapshot() {
	return {
		host: "127.0.0.1",
		port: 18765,
		running: true,
		connectedClients: 1,
		extensionConnected: true,
		clients: [],
		browserSessionId: "session-1",
		defaultTabId: 7,
		defaultTabHandle: "tab-7",
		selectionVersion: 3,
		tabs: [{ tabId: 7, tabHandle: "tab-7", targetRef: "tab-7", url: "https://example.test/", title: "Example", active: true }],
		pending: [],
	};
}

function createRuntime(overrides: Partial<BrowserCommandRuntimePort> = {}): MockRuntime {
	const calls: RuntimeCall[] = [];
	let operationSeq = 0;
	const runtime: MockRuntime = {
		calls,
		snapshot(...args) {
			calls.push({ name: "snapshot", args });
			return baseSnapshot();
		},
		getTabs(...args) {
			calls.push({ name: "getTabs", args });
			return baseSnapshot().tabs;
		},
		async refreshTabs(...args) {
			calls.push({ name: "refreshTabs", args });
			return baseSnapshot().tabs;
		},
		async waitForExtensionReconnect(...args) {
			calls.push({ name: "waitForExtensionReconnect", args });
			return baseSnapshot();
		},
		resolveTargetTabId(value) {
			calls.push({ name: "resolveTargetTabId", args: [value] });
			if (value === "tab-7") return 7;
			return typeof value === "number" ? value : Number(value);
		},
		async sendCommand(command, options) {
			calls.push({ name: "sendCommand", args: [command, options] });
			if (command.cmd === "operation.begin") return { id: "op-arm", acknowledged: true, tabId: typeof command.tabId === "number" ? command.tabId : undefined, data: { armed: true } } as BrowserBridgeExecutionResult;
			if (command.cmd === "operation.finish") return { id: "op-finish", acknowledged: true, data: { finished: true } } as BrowserBridgeExecutionResult;
			return { id: "cmd-1", acknowledged: true, tabId: 7, target: { tabId: 7 }, data: { echoed: command } } as BrowserBridgeExecutionResult;
		},
		async executeJavaScript(script, options) {
			calls.push({ name: "executeJavaScript", args: [script, options] });
			return { id: "exec-1", acknowledged: true, tabId: 7, target: { tabId: 7 }, data: { answer: 42, script } } as BrowserBridgeExecutionResult;
		},
		async switchTab(...args) {
			calls.push({ name: "switchTab", args });
			return { id: "switch-1", acknowledged: true, tabId: 7, data: { active: true, selectedTabId: 7, selectionVersion: 4 } } as BrowserBridgeExecutionResult;
		},
		async createTab(...args) {
			calls.push({ name: "createTab", args });
			return { id: "create-1", acknowledged: true, tabId: 8, target: { tabId: 8, tabHandle: "tab-8" }, data: { url: args[0] } } as BrowserBridgeExecutionResult;
		},
		async closeTab(...args) {
			calls.push({ name: "closeTab", args });
			return { id: "close-1", acknowledged: true, tabId: 7, data: { closed: true, tabId: 7 } } as BrowserBridgeExecutionResult;
		},
		listBrowserSessions() { calls.push({ name: "listBrowserSessions", args: [] }); return []; },
		createBrowserSession(name) { calls.push({ name: "createBrowserSession", args: [name] }); return { browserSessionId: "session-new", name }; },
		selectBrowserSession(browserSessionId) { calls.push({ name: "selectBrowserSession", args: [browserSessionId] }); return { browserSessionId }; },
		closeBrowserSession(browserSessionId) { calls.push({ name: "closeBrowserSession", args: [browserSessionId] }); return { browserSessionId, closed: true }; },
		attachTabToBrowserSession(tabId, options) { calls.push({ name: "attachTabToBrowserSession", args: [tabId, options] }); return { tabId: Number(tabId), tabHandle: `tab-${tabId}` }; },
		detachTabFromBrowserSession(tabId, options) { calls.push({ name: "detachTabFromBrowserSession", args: [tabId, options] }); return { tabId, detached: true }; },
		selectBrowser(browserId, options) { calls.push({ name: "selectBrowser", args: [browserId, options] }); return { browserId }; },
		leaseTab(tabId, options) { calls.push({ name: "leaseTab", args: [tabId, options] }); return { id: "lease-secret", browserSessionId: "session-1", tabSessionId: "tab-session-1", browserId: "browser-1", tabId: Number(tabId), explicit: true, createdAt: 1, lastSeenAt: 1 }; },
		releaseTab(tabId, options) { calls.push({ name: "releaseTab", args: [tabId, options] }); return { id: "lease-secret", browserSessionId: "session-1", tabSessionId: "tab-session-1", browserId: "browser-1", tabId: Number(tabId), explicit: true, createdAt: 1, lastSeenAt: 1 }; },
		acquireUiLock(browserSessionId, commandName) { return { browserSessionId: browserSessionId || "session-1", commandName, createdAt: 1, lastSeenAt: 1, count: 1 }; },
		releaseUiLock(browserSessionId) { return { browserSessionId: browserSessionId || "session-1", commandName: "browser_execute", createdAt: 1, lastSeenAt: 1, count: 0 }; },
		queueDepth(...args) { calls.push({ name: "queueDepth", args }); return 0; },
		leaseOwnerHash(...args) { calls.push({ name: "leaseOwnerHash", args }); return undefined; },
		createObservationSnapshot(snapshot) { return { snapshotId: snapshot.snapshotId || "snap-1", ttlMs: snapshot.ttlMs || 1_000, expired: false, ...snapshot }; },
		getObservationSnapshot() { return undefined; },
		listObservationSnapshots() { return []; },
		beginOperation(operation) {
			operationSeq += 1;
			const active = { operationId: `op-${operationSeq}`, startedAt: 10, updatedAt: 10, state: "active" as const, sequence: 0, revision: 1, lastProgressAt: 10, events: [], lateEffects: [], ...operation };
			calls.push({ name: "beginOperation", args: [active] });
			return active;
		},
		updateOperation(operationId, patch) {
			const updated = { operationId, commandName: "browser_command", phase: "running", startedAt: 10, updatedAt: 20, state: "active" as const, sequence: 0, lastProgressAt: 10, events: [], lateEffects: [], ...patch, revision: patch.revision ?? 2 };
			calls.push({ name: "updateOperation", args: [operationId, patch] });
			return updated;
		},
		finishOperation(operationId) {
			const finished = { operationId, commandName: "browser_command", phase: "completed", progress: 100, startedAt: 10, updatedAt: 20, state: "terminal" as const, sequence: 0, revision: 2, lastProgressAt: 10, events: [], lateEffects: [] };
			calls.push({ name: "finishOperation", args: [operationId] });
			return finished;
		},
		...overrides,
	};
	return runtime;
}

test("commands execution: browser_tabs list returns compact transport envelope from runtime port", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineTabsCommand(context), runtime);
	const result = await command.execute("tool-1", { action: "list", maxChars: 20_000 }, undefined, undefined, { omitTransportDetails: true });
	const body = parseResult(result);
	assert.equal(body.tabCount, 1);
	assert.deepEqual(body.bridge, { browserSessionId: "session-1", host: "127.0.0.1", port: 18765, running: true, connectedClients: 1, extensionConnected: true, defaultTabId: 7, defaultTabHandle: "tab-7", selectionVersion: 3 });
	assert.deepEqual(body.tabs, [{ id: "tab-7", tabId: 7, tabHandle: "tab-7", targetRef: "tab-7", url: "https://example.test/", title: "Example", active: true }]);
	assert.deepEqual(result.details, { truncated: false, originalLength: result.content[0]?.text.length });
	assert.equal(runtime.calls.some((call) => call.name === "refreshTabs"), true);
});

test("commands execution: browser_tabs runtime failure is returned as a terminal operation outcome", async () => {
	const runtime = createRuntime({
		async switchTab() {
			throw new BrowserBridgeError("NO_TAB", "tab vanished", { tabId: 99 });
		},
	});
	const command = defineCommand((context) => defineTabsCommand(context), runtime);
	const result = await command.execute("tool-1", { action: "switch", targetRef: 99 });
	const body = parseResult(result);
	assert.equal(body.schema, "browser-operation/v2");
	assert.equal(body.status, "target_lost");
	assert.equal((body.dispatch as Record<string, unknown>).finished, false);
	assert.match(JSON.stringify(body.diagnostics), /tab vanished/);
});

test("commands execution: missing browser_tabs snapshot recovery uses ordinary no-mode observe CLI", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineTabsCommand(context), runtime);
	const result = await command.execute("tool-1", { action: "snapshot", snapshotId: "missing-snap" });
	const body = parseResult(result);
	const details = result.details?.error as Record<string, unknown>;
	const nextActions = ((details.details as Record<string, unknown>).recovery as Record<string, unknown>).nextActions as string[];
	assert.equal(body.code, "INVALID_RULE");
	assert.deepEqual(nextActions, ["browser-pilot observe --json", "browser-pilot tabs --action snapshot --json"]);
});

test("commands execution: stale browser_tabs snapshot recovery uses ordinary no-mode observe CLI", async () => {
	const runtime = createRuntime({
		getObservationSnapshot() {
			return { snapshotId: "stale-snap", sourceMode: "scan", capturedAt: 1, ttlMs: 1_000, expired: true, invalidatedReason: "ttl", saved: { path: ".browser-pilot/artifacts/observe.json" } };
		},
	});
	const command = defineCommand((context) => defineTabsCommand(context), runtime);
	const result = await command.execute("tool-1", { action: "snapshot", snapshotId: "stale-snap" });
	const body = parseResult(result);
	const details = result.details?.error as Record<string, unknown>;
	const nextActions = ((details.details as Record<string, unknown>).recovery as Record<string, unknown>).nextActions as string[];
	assert.equal(body.code, "INVALID_RULE");
	assert.deepEqual(nextActions, [
		"browser-pilot tabs --action snapshot --allow-expired --snapshot-id <snapshotId> --json",
		"browser-pilot artifact --path <saved.path> --mode inspect --json",
		"browser-pilot observe --json",
	]);
	const allowed = parseResult(await command.execute("tool-1", { action: "snapshot", snapshotId: "stale-snap", allowExpired: true }));
	assert.equal((allowed.snapshot as Record<string, unknown>).snapshotId, "stale-snap");
	const inventory = parseResult(await command.execute("tool-1", { action: "snapshot" }));
	assert.equal((inventory.bridge as Record<string, unknown>).defaultTabHandle, "tab-7");
	assert.deepEqual(inventory.observationSnapshots, []);
});

test("commands execution: browser_tabs common and advanced actions preserve runtime dispatch", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineTabsCommand(context), runtime);
	const create = parseResult(await command.execute("tool-1", { action: "create", url: "https://example.test/new", active: false, incognito: true, browserSessionId: "session-1" }));
	assert.equal(create.schema, "browser-operation/v2");
	assert.equal(create.status, "completed");
	assert.equal((create.target as Record<string, unknown>).tabId, 8);
	assert.equal((create.completion as Record<string, unknown>).source, "tab-create");
	assert.deepEqual(runtime.calls.find((call) => call.name === "createTab")?.args, ["https://example.test/new", false, 5_000, { browserSessionId: "session-1", incognito: true }]);
	await command.execute("tool-2", { action: "switch", targetRef: "tab-7", browserSessionId: "session-1" });
	await command.execute("tool-3", { action: "close", tabId: 7, browserSessionId: "session-1" });
	assert.deepEqual(runtime.calls.find((call) => call.name === "switchTab")?.args, ["tab-7", 5_000, { browserSessionId: "session-1" }]);
	assert.deepEqual(runtime.calls.find((call) => call.name === "closeTab")?.args, [7, 5_000, { browserSessionId: "session-1" }]);

	for (const params of [
		{ action: "listSessions" },
		{ action: "createSession", name: "isolated" },
		{ action: "selectSession", browserSessionId: "session-1" },
		{ action: "closeSession", browserSessionId: "session-1" },
		{ action: "attachTab", targetRef: "tab-7", browserSessionId: "session-1", browserId: "browser-1" },
		{ action: "detachTab", targetRef: "tab-7", browserSessionId: "session-1" },
		{ action: "leaseTab", targetRef: "tab-7", browserSessionId: "session-1" },
		{ action: "releaseTab", targetRef: "tab-7", browserSessionId: "session-1" },
		{ action: "selectBrowser", browserId: "browser-1", browserSessionId: "session-1" },
	]) {
		const body = parseResult(await command.execute("tool-advanced", params));
		assert.equal(body.code, undefined, String(params.action));
	}
	assert.deepEqual(runtime.calls.find((call) => call.name === "attachTabToBrowserSession")?.args, ["tab-7", { browserSessionId: "session-1", browserId: "browser-1" }]);
	const projectedLease = parseResult(await command.execute("tool-lease", { action: "leaseTab", targetRef: 7 })).lease as Record<string, unknown>;
	assert.equal(projectedLease.id, "lease-secret");
	assert.equal("browserSessionId" in projectedLease, false);
	assert.equal("tabSessionId" in projectedLease, false);
});

test("commands execution: browser_tabs rejects invalid targets, URLs, and actions before dispatch", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineTabsCommand(context), runtime);
	for (const [params, code] of [
		[{ action: "close" }, "TAB_ID_REQUIRED"],
		[{ action: "create", url: "/relative" }, "INVALID_TAB_URL"],
		[{ action: "create", url: "javascript:alert(1)" }, "INVALID_TAB_URL"],
		[{ action: "unknown" }, "INVALID_RULE"],
	] as Array<[Record<string, unknown>, string]>) {
		assert.equal(parseResult(await command.execute("tool-invalid", params)).code, code);
	}
	assert.equal(runtime.calls.some((call) => ["closeTab", "createTab"].includes(call.name)), false);
});

test("tabs create projection keeps stable identity precedence and strips nested transport noise", () => {
	assert.deepEqual(publicCreateTabResult({
		id: "request-1",
		acknowledged: true,
		tabId: 9,
		createdTarget: { browserSessionId: "session-1", browserId: "browser-1", tabId: 9, tabHandle: "tab-9", targetRef: "tab-9", url: "https://target.test/", ignored: "target-noise" },
		createdTab: { id: "tab-session-9", tabId: 9, tabHandle: "tab-9", targetRef: "tab-9", url: "https://tab.test/", title: "Created", active: true, bridge: { token: "noise" } },
		data: { tabId: 10, tabHandle: "tab-data", url: "https://data.test/", title: "Data" },
		target: { tabId: 9 },
		newTabs: [{ tabId: 9 }],
		diagnostics: { latency: 1 },
	}), {
		id: "tab-9",
		targetRef: "tab-9",
		tabHandle: "tab-9",
		tabId: 9,
		browserSessionId: "session-1",
		browserId: "browser-1",
		url: "https://data.test/",
		title: "Data",
		requestId: "request-1",
		acknowledged: true,
		createdTarget: { browserSessionId: "session-1", browserId: "browser-1", tabId: 9, tabHandle: "tab-9", targetRef: "tab-9", url: "https://target.test/" },
		createdTab: { id: "tab-9", tabSessionId: "tab-session-9", tabId: 9, tabHandle: "tab-9", targetRef: "tab-9", url: "https://tab.test/", title: "Created", active: true },
		data: { tabId: 10, tabHandle: "tab-data", url: "https://data.test/", title: "Data" },
		target: { tabId: 9 },
		newTabs: [{ tabId: 9 }],
		diagnostics: { latency: 1 },
	});
});

test("commands execution: browser_command read commands return immediately", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const result = await command.execute("tool-1", { command: { cmd: "tabs", method: "list" }, maxChars: 20_000 }, undefined, undefined, { cwd: "project" });
	const envelope = parseResult(result);
	const send = runtime.calls.find((call) => (call.args[0] as Record<string, unknown>)?.cmd === "tabs");
	assert.deepEqual(send?.args[0], { cmd: "tabs", method: "list" });
	assert.equal(envelope.id, "cmd-1");
	assert.equal(runtime.calls.some((call) => call.name === "beginOperation"), false);
	assert.equal(result.details?.mode, "command");
});

test("commands execution: browser_command write failures return failed operation outcomes", async () => {
	const runtime = createRuntime({
		async sendCommand(command) {
			if (command.cmd === "operation.begin") return { id: "op-arm", acknowledged: true, data: { armed: true } } as BrowserBridgeExecutionResult;
			if (command.cmd === "operation.finish") return { id: "op-finish", acknowledged: true, data: { finished: true } } as BrowserBridgeExecutionResult;
			throw new Error("bridge send failed");
		},
	});
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const result = await command.execute("tool-1", { command: { cmd: "cdp", method: "Page.reload" }, targetRef: "tab-7" });
	const body = parseResult(result);
	assert.equal(body.schema, "browser-operation/v2");
	assert.equal(body.status, "failed");
	assert.equal(body.operationId, "op-1");
	assert.match(JSON.stringify(body.diagnostics), /bridge send failed/);
});

test("commands execution: browser_execute summarizes successful JavaScript result and runtime target context", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const result = await command.execute("tool-1", { script: "return 42", targetRef: "tab-7", maxChars: 20_000 });
	const envelope = parseResult(result);
	const execute = runtime.calls.find((call) => call.name === "executeJavaScript");
	const operationBegin = runtime.calls.find((call) => call.name === "sendCommand" && (call.args[0] as { cmd?: string }).cmd === "operation.begin");
	const operationFinish = runtime.calls.find((call) => call.name === "sendCommand" && (call.args[0] as { cmd?: string }).cmd === "operation.finish");
	assert.equal(execute?.args[0], "return 42");
	assert.deepEqual(execute?.args[1], { browserSessionId: undefined, tabId: "tab-7", timeoutMs: 15000 });
	assert.deepEqual(operationBegin?.args[1], { browserSessionId: "session-1", targetRef: "tab-7", timeoutMs: 5_000, accessMode: "read", internal: true });
	assert.deepEqual(operationFinish?.args[0], { cmd: "operation.finish", operationId: "op-1", tabId: 7, targetRef: "tab-7" });
	assert.deepEqual(operationFinish?.args[1], { browserSessionId: "session-1", targetRef: "tab-7", timeoutMs: 5_000, accessMode: "read", internal: true });
	assert.equal(envelope.schema, "browser-operation/v2");
	assert.equal(envelope.status, "completed");
	assert.equal((envelope.completion as Record<string, unknown>).source, "script-resolved");
	assert.deepEqual(((envelope.completion as Record<string, unknown>).evidence as Record<string, unknown>).result, { answer: 42, script: "return 42" });
	assert.equal(envelope.operationId, "op-1");
});

test("commands execution: undefined JavaScript with no browser events returns no_effect after the fixed liveness window", async () => {
	const runtime = createRuntime({
		async executeJavaScript() {
			return { id: "exec-noop", acknowledged: true, tabId: 7, data: "[undefined]" } as BrowserBridgeExecutionResult;
		},
	});
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const startedAt = Date.now();
	const outcome = parseResult(await command.execute("tool-noop", { script: "void 0", targetRef: "tab-7" }));
	assert.equal(outcome.status, "no_effect");
	assert.deepEqual(outcome.continuation, { next: "observe", reason: "no_effect", replay: "do_not_retry" });
	assert.equal(Date.now() - startedAt >= 900, true);
});

test("commands execution: a mutation event without command-specific completion evidence returns effect_observed", async () => {
	const runtime = createRuntime({
		async executeJavaScript() {
			return { id: "exec-modal", acknowledged: true, tabId: 7, data: undefined } as BrowserBridgeExecutionResult;
		},
		getOperation(operationId) {
			return {
				operationId,
				commandName: "browser_execute",
				command: "javascript",
				phase: "resolving",
				state: "active",
				sequence: 1,
				revision: 2,
				lastProgressAt: Date.now(),
				events: [{ operationId, sequence: 1, type: "mutation", timestamp: Date.now(), progress: true, data: { mutationCount: 2 } }],
				lateEffects: [],
				startedAt: Date.now(),
				updatedAt: Date.now(),
			};
		},
	});
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const outcome = parseResult(await command.execute("tool-modal", { script: "document.body.append(document.createElement('dialog'))", targetRef: "tab-7" }));
	assert.equal(outcome.status, "effect_observed");
	assert.equal((outcome.signals as Record<string, unknown>).mutationCount, 2);
	assert.equal(Array.isArray((outcome.pageEffect as Record<string, unknown>).changed), true);
	assert.deepEqual(outcome.continuation, { next: "observe", reason: "business_state_unverified", replay: "do_not_retry" });
});

test("commands execution: large JavaScript results preserve terminal proof and expand through a saved artifact", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-pilot-execute-operation-"));
	const items = Array.from({ length: 120 }, (_, index) => ({ id: index, label: `row-${index}`, detail: "payload".repeat(30) }));
	const runtime = createRuntime({
		async executeJavaScript() {
			return { id: "exec-large", acknowledged: true, tabId: 7, data: { items, total: items.length } } as BrowserBridgeExecutionResult;
		},
	});
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const result = await command.execute("tool-large", { script: "return window.__large", targetRef: "tab-7", maxChars: 1_200 }, undefined, undefined, { cwd });
	const outcome = parseResult(result);
	assert.equal(outcome.schema, "browser-operation/v2");
	assert.equal(outcome.status, "completed");
	assert.equal((outcome.completion as Record<string, unknown>).source, "script-resolved");
	assert.equal(typeof (outcome.dispatch as Record<string, unknown>).startedAt, "number");
	assert.equal(typeof (outcome.dispatch as Record<string, unknown>).finishedAt, "number");
	assert.equal((outcome.target as Record<string, unknown>).browserSessionId, "session-1");
	assert.equal(result.content[0]?.text.length <= 1_200, true);
	assert.deepEqual(outcome.continuation, { next: "inspect_artifact", reason: "result_compacted", replay: "not_needed" });
	const inlineResult = ((outcome.completion as Record<string, unknown>).evidence as Record<string, unknown>).result as Record<string, unknown>;
	assert.equal(inlineResult.type, "object");
	assert.equal(inlineResult.truncated, true);
	const saved = outcome.saved as Record<string, unknown>;
	assert.equal(typeof saved.path, "string");
	const hints = outcome.artifact_hints as Record<string, unknown>;
	assert.equal((hints.jsonPaths as Record<string, unknown>).completionResult, "completion.evidence.result");
	assert.equal(((outcome.limits as Record<string, unknown>).truncated), true);
	const artifact = JSON.parse(await readFile(String(saved.path), "utf8")) as Record<string, unknown>;
	const fullResult = ((artifact.completion as Record<string, unknown>).evidence as Record<string, unknown>).result as Record<string, unknown>;
	assert.equal((fullResult.items as unknown[]).length, items.length);
	const artifactCommand = defineCommand((context) => defineArtifactCommand(context), createRuntime());
	const inspected = parseResult(await artifactCommand.execute("tool-inspect", { path: String(saved.path), mode: "inspect", maxChars: 20_000 }));
	assert.equal((inspected.jsonPaths as Record<string, unknown>).completionResult, "completion.evidence.result");
});

test("commands execution: artifact write failure cannot erase a completed browser operation", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "browser-pilot-operation-artifact-failure-"));
	const invalidCwd = path.join(root, "not-a-directory");
	await writeFile(invalidCwd, "file blocks artifact directory creation", "utf8");
	const runtime = createRuntime({
		async executeJavaScript() {
			return { id: "exec-large", acknowledged: true, tabId: 7, data: { rows: Array.from({ length: 100 }, (_, index) => ({ index, value: "x".repeat(200) })) } } as BrowserBridgeExecutionResult;
		},
	});
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const result = await command.execute("tool-artifact-failure", { script: "return window.__large", targetRef: "tab-7", maxChars: 1_200 }, undefined, undefined, { cwd: invalidCwd });
	const outcome = parseResult(result);
	assert.equal(outcome.schema, "browser-operation/v2");
	assert.equal(outcome.status, "completed");
	assert.equal((outcome.completion as Record<string, unknown>).source, "script-resolved");
	assert.deepEqual(outcome.continuation, { next: "inspect_diagnostics", reason: "artifact_save_failed", replay: "do_not_retry" });
	assert.equal(outcome.saved, undefined);
	assert.match(JSON.stringify(outcome.diagnostics), /ARTIFACT_SAVE_FAILED/);
	const failedResult = ((outcome.completion as Record<string, unknown>).evidence as Record<string, unknown>).result as Record<string, unknown>;
	assert.equal(failedResult.artifactJsonPath, undefined);
	assert.equal(failedResult.evidenceUnavailable, true);
	assert.equal(result.content[0]?.text.length <= 1_200, true);
});

test("operation continuation verifies non-page state when no diagnostics exist", async () => {
	const result = await browserOperationCommandResult({
		...operationContract("no_effect"),
		operationId: "operation-network-no-effect",
		commandName: "browser_network",
		target: { targetRef: "tab-7", tabId: 7 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 10, finishedAt: 20 },
		signals: {},
	}, { budgetName: "browser_network", maxChars: 12_000, details: {} });
	const outcome = parseResult(result);
	assert.deepEqual(outcome.continuation, { next: "verify_command_state", reason: "no_effect", replay: "do_not_retry" });
});

test("operation continuation re-observes page-driven download uncertainty", async () => {
	const result = await browserOperationCommandResult({
		...operationContract("no_effect"),
		operationId: "operation-download-no-effect",
		commandName: "browser_download",
		target: { targetRef: "tab-7", tabId: 7 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 10, finishedAt: 20 },
		signals: {},
	}, { budgetName: "browser_download", maxChars: 12_000, details: {} });
	const outcome = parseResult(result);
	assert.deepEqual(outcome.continuation, { next: "observe", reason: "no_effect", replay: "do_not_retry" });
});

test("operation continuation only selects diagnostics when diagnostics exist", async () => {
	const result = await browserOperationCommandResult({
		...operationContract("stalled"),
		operationId: "operation-network-stalled",
		commandName: "browser_network",
		target: { targetRef: "tab-7", tabId: 7 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 10, finishedAt: 20 },
		signals: { networkPending: 1 },
		diagnostics: [{ code: "RECORDER_PENDING", message: "recorder has not flushed" }],
	}, { budgetName: "browser_network", maxChars: 12_000, details: {} });
	const outcome = parseResult(result);
	assert.deepEqual(outcome.continuation, { next: "inspect_diagnostics", reason: "stalled", replay: "do_not_retry" });
});

test("completed operations reacquire targets after close and new-tab completion", async () => {
	const close = parseResult(await browserOperationCommandResult({
		...operationContract("completed"),
		operationId: "operation-tab-close",
		commandName: "browser_tabs",
		target: { targetRef: "tab-7", tabId: 7 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 10, finishedAt: 20 },
		signals: {},
		completion: { source: "tab-close", evidence: { tabId: 7 } },
	}, { budgetName: "browser_tabs", maxChars: 12_000, details: {} }));
	assert.deepEqual(close.continuation, { next: "reacquire_target", reason: "target_no_longer_current", replay: "not_needed" });

	const newTab = parseResult(await browserOperationCommandResult({
		...operationContract("completed"),
		operationId: "operation-new-tab",
		commandName: "browser_execute",
		target: { targetRef: "tab-7", tabId: 7 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 10, finishedAt: 20 },
		signals: { newTabs: 1, navigation: "https://example.test/new" },
		completion: { source: "new-tab-ready", evidence: { event: { tabId: 8 } } },
	}, { budgetName: "browser_execute", maxChars: 12_000, details: {} }));
	assert.deepEqual(newTab.continuation, { next: "reacquire_target", reason: "target_no_longer_current", replay: "not_needed" });
});

test("minimal operation artifact hints follow the returned continuation", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-pilot-operation-diagnostics-"));
	const result = await browserOperationCommandResult({
		...operationContract("stalled"),
		operationId: "operation-diagnostics-large",
		commandName: "browser_network",
		target: { targetRef: "tab-7", tabId: 7 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 10, finishedAt: 20 },
		signals: { networkPending: 1 },
		diagnostics: Array.from({ length: 80 }, (_, index) => ({ code: `PENDING_${index}`, message: "x".repeat(300) })),
	}, { budgetName: "browser_network", maxChars: 1_200, ctx: { cwd }, details: {} });
	const outcome = parseResult(result);
	assert.deepEqual(outcome.continuation, { next: "inspect_diagnostics", reason: "stalled", replay: "do_not_retry" });
	assert.deepEqual((outcome.artifact_hints as Record<string, unknown>).jsonPaths, { diagnostics: "diagnostics" });
});

test("operation artifacts remain readable across the default bridge payload range", async () => {
	assert.equal(MAX_ARTIFACT_READ_BYTES > DEFAULT_BROWSER_BRIDGE_MAX_PAYLOAD_BYTES, true);
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-pilot-operation-too-large-"));
	const utf8Value = "界".repeat(Math.ceil((MAX_ARTIFACT_READ_BYTES + 4_096) / 3));
	const result = await browserOperationCommandResult({
		...operationContract("completed"),
		operationId: "operation-artifact-too-large",
		commandName: "browser_execute",
		target: { targetRef: "tab-7", tabId: 7 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 10, finishedAt: 20 },
		signals: {},
		completion: { source: "script-resolved", evidence: { result: utf8Value } },
	}, { budgetName: "browser_execute", maxChars: 1_200, ctx: { cwd }, details: {} });
	const outcome = parseResult(result);
	assert.equal(outcome.status, "completed");
	assert.equal(outcome.saved, undefined);
	assert.match(JSON.stringify(outcome.diagnostics), /ARTIFACT_TOO_LARGE/);
	const completionResult = ((outcome.completion as Record<string, unknown>).evidence as Record<string, unknown>).result as Record<string, unknown>;
	assert.equal(completionResult.artifactJsonPath, undefined);
	assert.equal(completionResult.evidenceUnavailable, true);
	assert.equal((outcome.continuation as Record<string, unknown>).replay, "do_not_retry");
});

test("operation compaction preserves completion with undefined evidence without publishing a missing JSON path", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-pilot-undefined-operation-result-"));
	const result = await browserOperationCommandResult({
		...operationContract("completed"),
		operationId: "operation-undefined-result",
		commandName: "browser_command",
		target: { targetRef: "tab-7", tabId: 7 },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 10, finishedAt: 20 },
		signals: { mutationCount: 100 },
		completion: { source: "native-command-result", evidence: { result: undefined } },
		pageEffect: { changed: Array.from({ length: 80 }, (_, index) => ({ index, detail: "x".repeat(200) })) },
	}, { budgetName: "browser_command", maxChars: 1_200, ctx: { cwd }, details: {} });
	const outcome = parseResult(result);
	assert.equal(outcome.schema, "browser-operation/v2");
	assert.equal(outcome.status, "completed");
	assert.equal((outcome.completion as Record<string, unknown>).source, "native-command-result");
	const paths = (outcome.artifact_hints as Record<string, unknown>).jsonPaths as Record<string, unknown>;
	assert.equal(paths.completionResult, undefined);
	assert.equal(result.content[0]?.text.length <= 1_200, true);
});

test("operation minimal response bounds navigation signals and records the omitted full value", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-pilot-long-operation-signal-"));
	const navigation = `https://example.test/?state=${"x".repeat(10_000)}`;
	const result = await browserOperationCommandResult({
		...operationContract("completed"),
		operationId: "operation-long-navigation",
		commandName: "browser_execute",
		target: { browserSessionId: "session-1", targetRef: "tab-7", tabId: 7, url: navigation },
		dispatch: { acknowledged: true, started: true, finished: true, startedAt: 10, finishedAt: 20 },
		signals: { navigation },
		completion: { source: "navigation-completed", evidence: { event: { url: navigation } } },
	}, { budgetName: "browser_execute", maxChars: 1_200, ctx: { cwd }, details: {} });
	const outcome = parseResult(result);
	assert.equal(result.content[0]?.text.length <= 1_200, true);
	assert.equal(String((outcome.signals as Record<string, unknown>).navigation).length <= 241, true);
	assert.equal(((outcome.limits as Record<string, unknown>).omitted as string[]).includes("signals.navigation"), true);
	const artifact = JSON.parse(await readFile(String((outcome.saved as Record<string, unknown>).path), "utf8")) as Record<string, unknown>;
	assert.equal((artifact.signals as Record<string, unknown>).navigation, navigation);
});

test("commands execution: browser_execute program path preserves operation and frame summaries", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const result = await command.execute("tool-program", { program: [{ eval: "return 7" }], targetRef: "tab-7", maxChars: 20_000 });
	const envelope = parseResult(result);
	const begin = runtime.calls.find((call) => call.name === "beginOperation")?.args[0] as Record<string, unknown>;
	assert.equal(begin.command, "program");
	assert.equal(begin.tabId, 7);
	assert.equal(result.details?.mode, "program");
	assert.equal(envelope.schema, "browser-operation/v2");
	assert.equal(envelope.status, "completed");
	assert.equal((envelope.completion as Record<string, unknown>).source, "program-resolved");
	assert.equal(envelope.operationId, "op-1");
	assert.equal(runtime.calls.some((call) => call.name === "executeJavaScript"), true);
});

test("commands execution: browser_execute rejects invalid program inputs before operation tracking", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const cases: Array<[Record<string, unknown>, RegExp]> = [
		[{}, /requires script or program/],
		[{ script: "return 1", program: [{ eval: "return 2" }] }, /either script or program/],
		[{ program: Array.from({ length: 61 }, () => ({ wait: 1 })) }, /exceeds 60 frame limit/],
		[{ program: [{ eval: "return 1", wait: 1 }] }, /exactly one required/],
	];
	for (const [params, message] of cases) {
		const body = parseResult(await command.execute("tool-invalid-program", params));
		assert.equal(body.code, "INVALID_RULE");
		assert.match(String(body.message), message);
	}
	assert.equal(runtime.calls.some((call) => call.name === "beginOperation"), false);
});

test("commands execution: browser_execute rejects command-shaped scripts with recovery metadata", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const result = await command.execute("tool-1", { script: "{\"cmd\":\"tabs\",\"method\":\"list\"}" });
	const body = parseResult(result);
	const details = result.details?.error as Record<string, unknown>;
	assert.equal(body.code, "INVALID_RULE");
	assert.match(String(body.message), /only accepts JavaScript/);
	assert.deepEqual(details.recovery, { useTool: "browser_command" });
	assert.equal(runtime.calls.some((call) => call.name === "executeJavaScript"), false);
});

test("commands execution: explicit observe mode=scan rejects canonical-only diff and skips baseline resolution", async () => {
	const runtime = createRuntime({
		listObservationSnapshots() {
			throw new Error("diff baseline lookup should not run for explicit mode=scan");
		},
	});
	const command = defineCommand((context) => defineObserveCommand(context), runtime);
	const result = await command.execute("tool-1", { mode: "scan", diff: true });
	const body = parseResult(result);
	assert.equal(body.code, "INVALID_RULE");
	assert.match(String(body.message), /mode=scan does not accept diff/);
	assert.equal(runtime.calls.some((call) => call.name === "sendCommand"), false);
});

test("commands execution: explicit observe mode=scan rejects by-reference baselines before mapping them onto canonical baseline", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineObserveCommand(context), runtime);
	const result = await command.execute("tool-1", { mode: "scan", baselineSnapshotId: "snap-1" });
	const body = parseResult(result);
	assert.equal(body.code, "INVALID_RULE");
	assert.match(String(body.message), /mode=scan does not accept baselineSnapshotId/);
	assert.equal(runtime.calls.some((call) => call.name === "sendCommand"), false);
});

test("commands execution: browser_artifact reads JSON path and returns bounded inline result", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-command-artifact-"));
	const artifactPath = path.join(dir, "result.json");
	await writeFile(artifactPath, JSON.stringify({ data: { items: [{ id: 1 }, { id: 2 }], token: "secret" } }), "utf8");
	const command = defineCommand((context) => defineArtifactCommand(context), createRuntime());
	const result = await command.execute("tool-1", { path: artifactPath, jsonPath: "data.items[1]", maxChars: 20_000 });
	const body = parseResult(result);
	assert.equal(body.mode, "json");
	assert.equal(body.jsonPath, "data.items[1]");
	assert.deepEqual(body.value, { id: 2 });
	assert.equal(result.details?.mode, "json");
	assert.equal(result.details?.path, artifactPath);
});

test("commands execution: browser_artifact inspect lists existing hinted paths without raw payload", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-command-artifact-inspect-"));
	const artifactPath = path.join(dir, "observe.json");
	await writeFile(artifactPath, JSON.stringify({
		data: { items: [{ id: 1, secret: "large raw body" }] },
		envelope: {
			summary: { type: "bridgeResult", requestCount: 1 },
			artifact_hints: {
				kind: "PageObservation",
				schemaVersion: 1,
				jsonPaths: { items: "data.items", missing: "data.missing" },
				preferredReads: [{ label: "items", jsonPath: "data.items", kind: "primary-items" }, { label: "missing", jsonPath: "data.missing" }],
				saved: { path: artifactPath, bytes: 123 },
			},
		},
	}), "utf8");
	const command = defineCommand((context) => defineArtifactCommand(context), createRuntime());
	const result = await command.execute("tool-1", { path: artifactPath, mode: "inspect", maxChars: 20_000 });
	const body = parseResult(result);
	assert.equal(body.mode, "inspect");
	assert.equal(body.kind, "PageObservation");
	assert.equal((body.jsonPaths as Record<string, unknown>).items, "data.items");
	assert.equal((body.jsonPaths as Record<string, unknown>).missing, undefined);
	assert.equal((body.preferredReads as Array<Record<string, unknown>>).some((read) => read.jsonPath === "data.missing"), false);
	assert.equal(JSON.stringify(body).includes("large raw body"), false);
});

test("commands execution: browser_network captureReload batches start before reload and summarizes guidance", async () => {
	let recorderState: { active: boolean; lastSeq?: number } | undefined;
	const runtime = createRuntime({
		recordKnownRecorderState(_kind, _browserSessionId, _tabId, state) {
			recorderState = state;
		},
		async sendCommand(command, options) {
			runtime.calls.push({ name: "sendCommand", args: [command, options] });
			if (command.cmd === "operation.begin") return { id: "op-arm", acknowledged: true, data: { armed: true } } as BrowserBridgeExecutionResult;
			if (command.cmd === "operation.finish") return { id: "op-finish", acknowledged: true, data: { finished: true } } as BrowserBridgeExecutionResult;
			return { id: "batch-1", acknowledged: true, tabId: 7, target: { tabId: 7, source: "explicit", implicit: false, selectionVersionAtDispatch: 1 }, diagnostics: { latency: { totalMs: 12, acked: true } }, data: { results: [
				{ ok: true, data: { sessionId: "s1" } },
				{ ok: true, data: { reloaded: true } },
				{ ok: true, data: { matched: true } },
				{ ok: true, data: { total: 1, lastSeq: 17, items: [{ requestId: "r1", seq: 17, url: "https://example.test/app.js" }] } },
			] } } as BrowserBridgeExecutionResult;
		},
	});
	const command = defineCommand((context) => defineNetworkCommand(context), runtime);
	const result = await command.execute("tool-1", { action: "captureReload", targetRef: "tab-7", params: { sessionId: "s1", ignoreCache: true }, maxChars: 20_000 });
	const envelope = parseResult(result);
	const send = runtime.calls.find((call) => (call.args[0] as Record<string, unknown>)?.cmd === "batch");
	const batch = send?.args[0] as Record<string, unknown>;
	const commands = batch.commands as Array<Record<string, unknown>>;
	assert.equal(batch.cmd, "batch");
	assert.deepEqual(commands.map((entry) => entry.cmd), ["network.start", "cdp", "network.wait", "network.list"]);
	assert.equal(((commands[1].params as Record<string, unknown>).ignoreCache), true);
	assert.equal(envelope.schema, "browser-operation/v2");
	assert.equal(envelope.status, "completed");
	assert.equal((envelope.completion as Record<string, unknown>).source, "network-capture-completed");
	assert.deepEqual(recorderState, { active: true, lastSeq: 17 });
});

test("commands execution: browser_network captureReload cannot report completed when reload fails inside the batch", async () => {
	const runtime = createRuntime({
		async sendCommand(command, options) {
			runtime.calls.push({ name: "sendCommand", args: [command, options] });
			if (command.cmd === "operation.begin") return { id: "op-arm", acknowledged: true, data: { armed: true } } as BrowserBridgeExecutionResult;
			if (command.cmd === "operation.finish") return { id: "op-finish", acknowledged: true, data: { finished: true } } as BrowserBridgeExecutionResult;
			return { id: "batch-failed", acknowledged: true, tabId: 7, data: { results: [
				{ ok: true, data: { sessionId: "s1" } },
				{ ok: false, error_code: "INTERNAL_ERROR", error: "reload failed" },
				{ ok: true, data: { matched: true } },
				{ ok: true, data: { total: 0, items: [] } },
			] } } as BrowserBridgeExecutionResult;
		},
	});
	const command = defineCommand((context) => defineNetworkCommand(context), runtime);
	const result = await command.execute("tool-1", { action: "captureReload", tabId: 7, params: { sessionId: "s1" }, maxChars: 20_000 });
	const envelope = parseResult(result);
	assert.equal(envelope.schema, "browser-operation/v2");
	assert.equal(envelope.status, "failed");
	assert.equal(envelope.classification, "failure");
	assert.equal(envelope.completionVerified, false);
	assert.equal(envelope.ok, false);
	assert.equal(envelope.code, "OPERATION_FAILED");
});
