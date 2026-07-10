import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defineArtifactCommand } from "../../src/commands/artifactCommand.ts";
import { CommandManifestIndex, type CommandDefinition } from "../../src/commands/commandManifestIndex.ts";
import { defineExecuteCommand } from "../../src/commands/executeCommand.ts";
import { defineMemoryCommand } from "../../src/commands/memoryCommand.ts";
import { defineNativeCommand } from "../../src/commands/nativeCommand.ts";
import { defineNetworkCommand } from "../../src/commands/nativeActionCommands.ts";
import { defineObserveCommand } from "../../src/commands/observeCommand.ts";
import { defineTabsCommand } from "../../src/commands/tabsCommand.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";
import type { BrowserBridgeExecutionResult } from "../../src/ports/BrowserRuntimeTypes.ts";
import { BrowserBridgeError } from "../../src/utils/errors.ts";

type RuntimeCall = { name: string; args: unknown[] };

type MockRuntime = BrowserCommandRuntimePort & { calls: RuntimeCall[] };

function parseResult(result: { content: Array<{ text: string }> }): Record<string, unknown> {
	return JSON.parse(result.content[0]?.text || "{}") as Record<string, unknown>;
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
			return { id: "cmd-1", acknowledged: true, tabId: 7, target: { tabId: 7 }, data: { echoed: command } } as BrowserBridgeExecutionResult;
		},
		async executeJavaScript(script, options) {
			calls.push({ name: "executeJavaScript", args: [script, options] });
			return { id: "exec-1", acknowledged: true, tabId: 7, target: { tabId: 7 }, data: { answer: 42, script } } as BrowserBridgeExecutionResult;
		},
		async switchTab(...args) {
			calls.push({ name: "switchTab", args });
			return { id: "switch-1", acknowledged: true, tabId: Number(args[0]), data: { active: true } } as BrowserBridgeExecutionResult;
		},
		async createTab(...args) {
			calls.push({ name: "createTab", args });
			return { id: "create-1", acknowledged: true, tabId: 8, target: { tabId: 8, tabHandle: "tab-8" }, data: { url: args[0] } } as BrowserBridgeExecutionResult;
		},
		async closeTab(...args) {
			calls.push({ name: "closeTab", args });
			return { id: "close-1", acknowledged: true, tabId: Number(args[0]), data: { closed: true } } as BrowserBridgeExecutionResult;
		},
		listBrowserSessions() { return []; },
		createBrowserSession(name) { return { browserSessionId: "session-new", name }; },
		selectBrowserSession(browserSessionId) { return { browserSessionId }; },
		closeBrowserSession(browserSessionId) { return { browserSessionId, closed: true }; },
		attachTabToBrowserSession(tabId) { return { tabId: Number(tabId), tabHandle: `tab-${tabId}` }; },
		detachTabFromBrowserSession(tabId) { return { tabId, detached: true }; },
		selectBrowser(browserId) { return { browserId }; },
		leaseTab(tabId) { return { id: "lease-secret", browserSessionId: "session-1", tabSessionId: "tab-session-1", browserId: "browser-1", tabId: Number(tabId), explicit: true, createdAt: 1, lastSeenAt: 1 }; },
		releaseTab(tabId) { return { id: "lease-secret", browserSessionId: "session-1", tabSessionId: "tab-session-1", browserId: "browser-1", tabId: Number(tabId), explicit: true, createdAt: 1, lastSeenAt: 1 }; },
		acquireUiLock(browserSessionId, commandName) { return { browserSessionId: browserSessionId || "session-1", commandName, createdAt: 1, lastSeenAt: 1, count: 1 }; },
		releaseUiLock(browserSessionId) { return { browserSessionId: browserSessionId || "session-1", commandName: "browser_execute", createdAt: 1, lastSeenAt: 1, count: 0 }; },
		queueDepth(...args) { calls.push({ name: "queueDepth", args }); return 0; },
		leaseOwnerHash(...args) { calls.push({ name: "leaseOwnerHash", args }); return undefined; },
		createObservationSnapshot(snapshot) { return { snapshotId: snapshot.snapshotId || "snap-1", ttlMs: snapshot.ttlMs || 1_000, expired: false, ...snapshot }; },
		getObservationSnapshot() { return undefined; },
		listObservationSnapshots() { return []; },
		beginOperation(operation) {
			operationSeq += 1;
			const active = { operationId: `op-${operationSeq}`, startedAt: 10, updatedAt: 10, ...operation };
			calls.push({ name: "beginOperation", args: [active] });
			return active;
		},
		updateOperation(operationId, patch) {
			const updated = { operationId, commandName: "browser_command", phase: "running", startedAt: 10, updatedAt: 20, ...patch };
			calls.push({ name: "updateOperation", args: [operationId, patch] });
			return updated;
		},
		finishOperation(operationId) {
			const finished = { operationId, commandName: "browser_command", phase: "completed", progress: 100, startedAt: 10, updatedAt: 20 };
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

test("commands execution: browser_tabs runtime failure is returned as structured error envelope", async () => {
	const runtime = createRuntime({
		async switchTab() {
			throw new BrowserBridgeError("NO_TAB", "tab vanished", { tabId: 99 });
		},
	});
	const command = defineCommand((context) => defineTabsCommand(context), runtime);
	const result = await command.execute("tool-1", { action: "switch", targetRef: 99 });
	const body = parseResult(result);
	const details = result.details?.error as Record<string, unknown>;
	assert.equal(body.code, "NO_TAB");
	assert.equal(body.message, "tab vanished");
	assert.equal(details.code, "NO_TAB");
	assert.deepEqual((details.diagnostics as Record<string, unknown>).target, { tabId: 99 });
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
		"browser-pilot artifact --path <saved.path> --mode json --json-path data --json",
		"browser-pilot observe --json",
	]);
});

test("commands execution: browser_command sends validated native command and emits distilled operation envelope", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const result = await command.execute("tool-1", { command: { cmd: "tabs", method: "list" }, maxChars: 20_000 }, undefined, undefined, { cwd: "project" });
	const envelope = parseResult(result);
	const send = runtime.calls.find((call) => call.name === "sendCommand");
	assert.deepEqual(send?.args[0], { cmd: "tabs", method: "list" });
	assert.equal((envelope.summary as Record<string, unknown>).type, "bridgeResult");
	assert.equal((envelope.operation as Record<string, unknown>).operationId, "op-1");
	assert.equal(envelope.activeContext, undefined);
	assert.equal(result.details?.mode, "command");
});

test("commands execution: browser_command attaches operation metadata to runtime failures", async () => {
	const runtime = createRuntime({
		async sendCommand() {
			throw new Error("bridge send failed");
		},
	});
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const result = await command.execute("tool-1", { command: { cmd: "tabs", method: "list" } });
	const body = parseResult(result);
	const details = result.details?.error as Record<string, unknown>;
	assert.equal(body.code, "INTERNAL_ERROR");
	assert.equal(body.message, "bridge send failed");
	assert.equal((details.details as Record<string, unknown>).operation && typeof (details.details as Record<string, unknown>).operation === "object" ? ((details.details as Record<string, unknown>).operation as Record<string, unknown>).operationId : undefined, "op-1");
	assert.deepEqual((details.diagnostics as Record<string, unknown>).scopes, ["operation"]);
});

test("commands execution: browser_execute summarizes successful JavaScript result and runtime target context", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const result = await command.execute("tool-1", { script: "return 42", targetRef: "tab-7", maxChars: 20_000 });
	const envelope = parseResult(result);
	const execute = runtime.calls.find((call) => call.name === "executeJavaScript");
	const summary = envelope.summary as Record<string, unknown>;
	assert.equal(execute?.args[0], "return 42");
	assert.deepEqual(execute?.args[1], { browserSessionId: undefined, tabId: "tab-7", timeoutMs: 15000 });
	assert.equal(summary.type, "bridgeResult");
	assert.deepEqual(summary.data, { answer: 42, script: "return 42" });
	assert.equal((envelope.operation as Record<string, unknown>).operationId, "op-1");
	assert.equal((envelope.activeContext as Record<string, unknown>).targetRef, "tab-7");
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
	const runtime = createRuntime({
		async sendCommand(command, options) {
			runtime.calls.push({ name: "sendCommand", args: [command, options] });
			return { id: "batch-1", acknowledged: true, tabId: 7, target: { tabId: 7, source: "explicit", implicit: false, selectionVersionAtDispatch: 1 }, diagnostics: { latency: { totalMs: 12, acked: true } }, data: { results: [
				{ ok: true, data: { sessionId: "s1" } },
				{ ok: true, data: { reloaded: true } },
				{ ok: true, data: { matched: true } },
				{ ok: true, data: { total: 1, items: [{ requestId: "r1", url: "https://example.test/app.js" }] } },
			] } } as BrowserBridgeExecutionResult;
		},
	});
	const command = defineCommand((context) => defineNetworkCommand(context), runtime);
	const result = await command.execute("tool-1", { action: "captureReload", targetRef: "tab-7", params: { sessionId: "s1", ignoreCache: true }, maxChars: 20_000 });
	const envelope = parseResult(result);
	const send = runtime.calls.find((call) => call.name === "sendCommand");
	const batch = send?.args[0] as Record<string, unknown>;
	const commands = batch.commands as Array<Record<string, unknown>>;
	assert.equal(batch.cmd, "batch");
	assert.deepEqual(commands.map((entry) => entry.cmd), ["network.start", "cdp", "network.wait", "network.list"]);
	assert.equal(((commands[1].params as Record<string, unknown>).ignoreCache), true);
	assert.equal((envelope.summary as Record<string, unknown>).startBeforeNavigation, true);
	assert.equal(((envelope.diagnostics as Record<string, unknown>).networkCaptureReload as Record<string, unknown>).oneShotBatch, true);
});

test("commands execution: browser_memory validate returns distilled success envelope without persisting fact", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-pilot-command-memory-"));
	const command = defineCommand((context) => defineMemoryCommand(context), createRuntime());
	const result = await command.execute("tool-1", {
		action: "validate",
		scopeKind: "origin",
		url: "https://example.test/path",
		title: "Checkout affordance",
		triggers: ["checkout button"],
		body: "Example.test checkout has a Pay button.",
		maxChars: 20_000,
	}, undefined, undefined, { cwd });
	const envelope = parseResult(result);
	const summary = envelope.summary as Record<string, unknown>;
	assert.equal(summary.action, "validate");
	assert.equal(summary.ok, true);
	assert.equal(summary.scopeKind, "origin");
	assert.equal(summary.scopeKey, "example.test");
	assert.equal(envelope.tool, "browser_memory");
});

test("commands execution: browser_memory validation failures use error envelope and recovery-capable diagnostics", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-pilot-command-memory-error-"));
	const command = defineCommand((context) => defineMemoryCommand(context), createRuntime());
	const result = await command.execute("tool-1", { action: "validate", scopeKind: "task", title: "Workflow", triggers: ["workflow"], body: "Step 1: click login\nStep 2: submit form" }, undefined, undefined, { cwd });
	const envelope = parseResult(result);
	const summary = envelope.summary as Record<string, unknown>;
	assert.equal(summary.action, "error");
	assert.equal(summary.ok, false);
	assert.match(String(summary.error_code), /MEMORY_/);
	assert.ok(Array.isArray(((summary.diagnostics as Record<string, unknown>)?.scopes as unknown[]) || []));
});
