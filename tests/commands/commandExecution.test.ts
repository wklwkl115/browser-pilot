import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defineArtifactCommand } from "../../src/commands/artifactCommand.ts";
import { CommandManifestIndex, type CommandDefinition } from "../../src/commands/commandManifestIndex.ts";
import { defineExecuteCommand } from "../../src/commands/executeCommand.ts";
import { defineNativeCommand } from "../../src/commands/nativeCommand.ts";
import { defineScreenshotCommand } from "../../src/commands/screenshotCommand.ts";
import { defineTabsCommand } from "../../src/commands/tabsCommand.ts";
import { publicCreateTabResult } from "../../src/commands/tabsProjection.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";
import type { BrowserBridgeExecutionResult } from "../../src/ports/BrowserRuntimeTypes.ts";
import { registerRefDescriptor } from "../../src/resources/resourceRefs.ts";
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
		tabs: [{ tabId: 7, tabHandle: "tab-7", targetRef: "tab-7", targetGeneration: 1, pageEpoch: "page-1", url: "https://example.test/", title: "Example", active: true }],
		pending: [],
	};
}

function createRuntime(overrides: Partial<BrowserCommandRuntimePort> = {}): MockRuntime {
	const calls: RuntimeCall[] = [];
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
			acquireUiLock(browserSessionId, commandName) { calls.push({ name: "acquireUiLock", args: [browserSessionId, commandName] }); return { browserSessionId: browserSessionId || "session-1", commandName, createdAt: 1, lastSeenAt: 1, count: 1 }; },
			releaseUiLock(browserSessionId) { calls.push({ name: "releaseUiLock", args: [browserSessionId] }); return { browserSessionId: browserSessionId || "session-1", commandName: "browser_execute", createdAt: 1, lastSeenAt: 1, count: 0 }; },
		queueDepth(...args) { calls.push({ name: "queueDepth", args }); return 0; },
		leaseOwnerHash(...args) { calls.push({ name: "leaseOwnerHash", args }); return undefined; },
		createObservationSnapshot(snapshot) { return { snapshotId: snapshot.snapshotId || "snap-1", ttlMs: snapshot.ttlMs || 1_000, expired: false, ...snapshot }; },
		getObservationSnapshot() { return undefined; },
		listObservationSnapshots() { return []; },
		...overrides,
	};
	return runtime;
}


let registeredTestRef = 0;

function registerOwnedRef(options: { tabId?: number; browserSessionId?: string; liveActionsAllowed?: boolean; targetGeneration?: number; pageEpoch?: string; pageIdentity?: false; createdAt?: number; ttlMs?: number } = {}): string {
	const kind = options.liveActionsAllowed === false ? "text" : "control";
	const createdAt = options.createdAt ?? Date.now();
	return registerRefDescriptor({
		descriptor: {
			refId: `bp-ref://${kind}/command-test-${registeredTestRef += 1}`,
			kind,
			locators: [{ by: "backendNodeId", value: 41, targetId: "target-1" }, { by: "css", value: "#submit" }],
			owner: { browserSessionId: options.browserSessionId ?? "session-1", tabId: options.tabId ?? 7, targetId: "target-1", topLevelOrigin: "https://example.test" },
			policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: options.liveActionsAllowed !== false },
			observationId: "observation-1",
			...(options.pageIdentity === false ? {} : { documentEpoch: { targetGeneration: options.targetGeneration ?? 1, pageEpoch: options.pageEpoch ?? "page-1", url: "https://example.test/", capturedAt: createdAt } }),
			createdAt,
			ttlMs: options.ttlMs ?? 60_000,
		},
	});
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

test("commands execution: browser_tabs runtime failure returns the bridge error", async () => {
	const runtime = createRuntime({
		async switchTab() {
			throw new BrowserBridgeError("NO_TAB", "tab vanished", { tabId: 99 });
		},
	});
	const command = defineCommand((context) => defineTabsCommand(context), runtime);
	const result = await command.execute("tool-1", { action: "switch", targetRef: "tab-99" });
	const body = parseResult(result);
	assert.equal(body.code, "NO_TAB");
	assert.match(String(body.message), /tab vanished/);
});

test("commands execution: stale browser_tabs snapshot recovery uses ordinary no-mode observe", async () => {
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
			"call browser_tabs with action=snapshot, allowExpired=true, and snapshotId=<snapshotId>",
			"call browser_artifact with mode=inspect and path=<saved.path>",
			"browser_observe",
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
		assert.equal(create.id, "create-1");
		assert.equal(create.acknowledged, true);
		assert.equal((create.target as Record<string, unknown>).tabId, 8);
	const createArgs = runtime.calls.find((call) => call.name === "createTab")?.args;
	assert.deepEqual(createArgs?.slice(0, 3), ["https://example.test/new", false, 5_000]);
	assert.deepEqual({ ...(createArgs?.[3] as Record<string, unknown>), signal: undefined }, { browserSessionId: "session-1", incognito: true, signal: undefined });
	assert.ok((createArgs?.[3] as { signal?: unknown }).signal instanceof AbortSignal);
	await command.execute("tool-2", { action: "switch", targetRef: "tab-7", browserSessionId: "session-1" });
	await command.execute("tool-3", { action: "close", targetRef: "tab-7", browserSessionId: "session-1" });
	for (const [name, prefix] of [["switchTab", ["tab-7", 5_000]], ["closeTab", ["tab-7", 5_000]]] as const) {
		const args = runtime.calls.find((call) => call.name === name)?.args;
		assert.deepEqual(args?.slice(0, 2), prefix);
		assert.equal((args?.[2] as Record<string, unknown>).browserSessionId, "session-1");
		assert.ok((args?.[2] as { signal?: unknown }).signal instanceof AbortSignal);
	}

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
	const projectedLease = parseResult(await command.execute("tool-lease", { action: "leaseTab", targetRef: "tab-7" })).lease as Record<string, unknown>;
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
	const result = await command.execute("tool-1", { command: { cmd: "network.list", limit: 20 }, maxChars: 20_000 }, undefined, undefined, { cwd: "project" });
	const envelope = parseResult(result);
	const send = runtime.calls.find((call) => (call.args[0] as Record<string, unknown>)?.cmd === "network.list");
	assert.deepEqual(send?.args[0], { cmd: "network.list", limit: 20 });
	assert.equal(envelope.id, "cmd-1");
	assert.equal(result.details?.mode, "command");
});

test("commands execution: browser_command writes return the raw bridge result", async () => {
	const runtime = createRuntime({
		async sendCommand(command, options) {
			runtime.calls.push({ name: "sendCommand", args: [command, options] });
			return { id: "network-start", acknowledged: true, data: { active: true } } as BrowserBridgeExecutionResult;
		},
	});
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const outcome = parseResult(await command.execute("tool-native-write", { command: { cmd: "network.start" } }));
		assert.equal(outcome.id, "network-start");
		assert.equal(outcome.acknowledged, true);
		assert.equal((outcome.data as Record<string, unknown>).active, true);
	});

test("commands execution: browser_command rejects commands owned by dedicated tools", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	for (const [cmd, owner] of [["tabs", "browser_tabs"], ["screenshot.capture", "browser_screenshot"]]) {
		const body = parseResult(await command.execute("tool-owned", { command: { cmd } }));
		assert.equal(body.code, "INVALID_RULE");
		assert.match(String(body.message), new RegExp(String(owner)));
	}
	assert.equal(runtime.calls.some((call) => call.name === "sendCommand"), false);
});

test("dedicated screenshot and browser_command dispatch their native commands", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "browser-pilot-owned-tools-"));
	const screenshotPath = path.join(directory, "screenshot.png");
	const runtime = createRuntime({
		async sendCommand(command, options) {
			runtime.calls.push({ name: "sendCommand", args: [command, options] });
			const data = command.cmd === "screenshot.capture"
				? { screenshot: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s6Nwl8AAAAASUVORK5CYII=", format: "png" }
				: { echoed: command };
			return { id: String(command.cmd), acknowledged: true, tabId: 7, data } as BrowserBridgeExecutionResult;
		},
	});

	const screenshot = defineCommand((context) => defineScreenshotCommand(context), runtime);
	const screenshotResult = parseResult(await screenshot.execute("screenshot", { targetRef: "tab-7", outputPath: screenshotPath }, undefined, undefined, { cwd: directory }));
	assert.equal((screenshotResult.saved as Record<string, unknown>).path, screenshotPath);

	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	await command.execute("download", { targetRef: "tab-7", command: { cmd: "transfer.download", url: "https://example.test/file.txt" } });
	await command.execute("upload", { targetRef: "tab-7", command: { cmd: "transfer.upload", selector: "input[type=file]", files: ["D:\\fixtures\\upload.txt"] } });

	assert.deepEqual(runtime.calls.filter((call) => call.name === "sendCommand").map((call) => (call.args[0] as Record<string, unknown>).cmd), ["screenshot.capture", "transfer.download", "transfer.upload"]);
});

test("commands execution: browser_command write failures return the error", async () => {
	const runtime = createRuntime({
		async sendCommand() {
			throw new Error("bridge send failed");
		},
	});
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const result = await command.execute("tool-1", { command: { cmd: "cdp", method: "Page.reload" }, targetRef: "tab-7" });
	const body = parseResult(result);
		assert.equal(body.code, "INTERNAL_ERROR");
		assert.match(String(body.message), /bridge send failed/);
	});

test("commands execution: browser_execute summarizes successful JavaScript result and runtime target context", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const result = await command.execute("tool-1", { script: "return 42", targetRef: "tab-7", maxChars: 20_000 });
	const envelope = parseResult(result);
	const execute = runtime.calls.find((call) => call.name === "executeJavaScript");
		assert.equal(execute?.args[0], "return 42");
		assert.deepEqual({ ...(execute?.args[1] as Record<string, unknown>), signal: undefined }, { browserSessionId: undefined, tabId: "tab-7", timeoutMs: 15000, accessMode: "write", signal: undefined });
		assert.ok((execute?.args[1] as { signal?: unknown }).signal instanceof AbortSignal);
		assert.equal(envelope.id, "exec-1");
		assert.equal(envelope.acknowledged, true);
		assert.deepEqual(envelope.data, { answer: 42, script: "return 42" });
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

test("commands execution: browser_execute binds refs and routes to their owner", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const ref = registerOwnedRef();
	await command.execute("tool-ref", { script: "return browserPilot.refs.submit.id", refs: { submit: ref } });
	const execute = runtime.calls.find((call) => call.name === "executeJavaScript");
	assert.match(String(execute?.args[0]), /const __bindings = \{"submit":"bp-ref:\/\/control\//);
	assert.deepEqual({ ...(execute?.args[1] as Record<string, unknown>), signal: undefined }, { browserSessionId: "session-1", tabId: 7, timeoutMs: 15000, accessMode: "write", signal: undefined });
});

test("commands execution: ref URIs inside JavaScript stay ordinary data", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const script = "return 'bp-ref://control/not-a-binding'";
	await command.execute("tool-ref-literal", { script, targetRef: "tab-7", readOnly: true });
	assert.equal(runtime.calls.find((call) => call.name === "executeJavaScript")?.args[0], script);
});

test("commands execution: ref ownership, freshness, and action policy fail before JavaScript dispatch", async () => {
	for (const [params, code] of [
		[{ script: "return browserPilot.refs.target", refs: { target: registerOwnedRef({ tabId: 8 }) }, targetRef: "tab-7" }, "REF_SCOPE_VIOLATION"],
		[{ script: "return [browserPilot.refs.first, browserPilot.refs.second]", refs: { first: registerOwnedRef(), second: registerOwnedRef({ tabId: 8 }) } }, "REF_SCOPE_VIOLATION"],
			[{ script: "return browserPilot.refs.target", refs: { target: registerOwnedRef({ liveActionsAllowed: false }) } }, "INVALID_RULE"],
			[{ script: "return browserPilot.refs.target", refs: { target: registerOwnedRef({ createdAt: 1, ttlMs: 1 }) } }, "REF_STALE"],
			[{ script: "return 1", refs: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`r${index}`, "bp-ref://control/overflow"])) }, "INVALID_RULE"],
	] as Array<[Record<string, unknown>, string]>) {
		const runtime = createRuntime();
		const command = defineCommand((context) => defineExecuteCommand(context), runtime);
		assert.equal(parseResult(await command.execute("tool-ref-invalid", params)).code, code);
		assert.equal(runtime.calls.some((call) => call.name === "executeJavaScript"), false);
	}
});

test("commands execution: readOnly cannot bypass ref action policy", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const result = parseResult(await command.execute("tool-ref-read", { script: "return browserPilot.refs.text.textContent", refs: { text: registerOwnedRef({ liveActionsAllowed: false }) }, readOnly: true }));
	assert.equal(result.code, "INVALID_RULE");
	assert.equal(runtime.calls.some((call) => call.name === "executeJavaScript"), false);
});

test("commands execution: replaced tabs and changed page epochs invalidate refs before dispatch", async () => {
	const replacedRuntime = createRuntime({
		resolveTargetTabId(value) { return Number(value) === 7 ? 8 : Number(value); },
		snapshot() { return { ...baseSnapshot(), defaultTabId: 8, tabs: [{ tabId: 8, targetGeneration: 2, pageEpoch: "page-2", url: "https://example.test/" }] }; },
	});
	const replaced = defineCommand((context) => defineExecuteCommand(context), replacedRuntime);
	assert.equal(parseResult(await replaced.execute("tool-ref-replaced", { script: "return browserPilot.refs.target", refs: { target: registerOwnedRef() } })).code, "REF_STALE");
	assert.equal(replacedRuntime.calls.some((call) => call.name === "executeJavaScript"), false);

	const navigatedRuntime = createRuntime({ snapshot() { return { ...baseSnapshot(), tabs: [{ ...baseSnapshot().tabs[0], pageEpoch: "page-2" }] }; } });
	const navigated = defineCommand((context) => defineExecuteCommand(context), navigatedRuntime);
	assert.equal(parseResult(await navigated.execute("tool-ref-navigated", { script: "return browserPilot.refs.target", refs: { target: registerOwnedRef() } })).code, "REF_STALE");
	assert.equal(navigatedRuntime.calls.some((call) => call.name === "executeJavaScript"), false);

	const unprovenRuntime = createRuntime();
	const unproven = defineCommand((context) => defineExecuteCommand(context), unprovenRuntime);
	assert.equal(parseResult(await unproven.execute("tool-ref-unproven", { script: "return browserPilot.refs.target", refs: { target: registerOwnedRef({ pageIdentity: false }) } })).code, "REF_STALE");
	assert.equal(unprovenRuntime.calls.some((call) => call.name === "executeJavaScript"), false);
});

test("commands execution: input.ref expands its private native target and routes from ref ownership", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const ref = registerOwnedRef();
	await command.execute("tool-input-ref", { command: { cmd: "input.ref", action: "click", ref, target: { backendNodeId: 999 } } });
	const send = runtime.calls.find((call) => call.name === "sendCommand");
	const native = send?.args[0] as Record<string, unknown>;
	const target = native.target as Record<string, unknown>;
	assert.equal(native.ref, ref);
	assert.equal(target.refId, ref);
	assert.equal(target.backendNodeId, 41);
	assert.equal(target.targetId, "target-1");
	assert.deepEqual({ ...(send?.args[1] as Record<string, unknown>), signal: undefined }, { browserSessionId: "session-1", tabId: 7, timeoutMs: 15000, accessMode: "write", signal: undefined });
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
