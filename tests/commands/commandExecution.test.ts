import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CommandManifestIndex, type CommandDefinition } from "../../src/commands/commandManifestIndex.ts";
import { defineExecuteCommand } from "../../src/commands/executeCommand.ts";
import { defineNativeCommand } from "../../src/commands/nativeCommand.ts";
import { prepareAbmlVerification, readAbmlVerificationObservation } from "../../src/browser-command-runtime/abml/verification.ts";
import { jsonResult } from "../../src/utils/toolResult.ts";
import { defineScreenshotCommand } from "../../src/commands/screenshotCommand.ts";
import { defineTabsCommand } from "../../src/commands/tabsCommand.ts";
import type { BrowserCommandRuntimePort, CommandPerceptionLedgerFrame } from "../../src/ports/BrowserCommandRuntimePort.ts";
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
			selectBrowser(browserId, options) { calls.push({ name: "selectBrowser", args: [browserId, options] }); return { browserId }; },
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

test("commands execution: browser_tabs list hides runtime identity", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineTabsCommand(context), runtime);
	const controller = new AbortController();
	const result = await command.execute({ action: "list" }, controller.signal, { omitTransportDetails: true });
	const body = parseResult(result);
	assert.equal(body.tabCount, 1);
	assert.deepEqual(body.bridge, { running: true, connectedClients: 1, extensionConnected: true });
	assert.deepEqual(body.tabs, [{ id: "tab-7", targetRef: "tab-7", url: "https://example.test/", title: "Example", active: true }]);
	assert.deepEqual(result.details, {});
	assert.deepEqual(runtime.calls.find((call) => call.name === "refreshTabs")?.args, [5_000, { signal: controller.signal }]);
});

test("commands execution: browser_tabs runtime failure returns the bridge error", async () => {
	const runtime = createRuntime({
		async switchTab() {
			throw new BrowserBridgeError("NO_TAB", "tab vanished", { tabId: 99 });
		},
	});
	const command = defineCommand((context) => defineTabsCommand(context), runtime);
	const result = await command.execute({ action: "switch", targetRef: "tab-99" });
	const body = parseResult(result);
	assert.equal(body.code, "NO_TAB");
	assert.match(String(body.message), /tab vanished/);
	assert.equal(JSON.stringify(body).includes("tabId"), false);
});

test("commands execution: browser_tabs actions preserve runtime dispatch", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineTabsCommand(context), runtime);
	const create = parseResult(await command.execute({ action: "create", url: "https://example.test/new", active: false, incognito: true }));
	assert.deepEqual(create, { url: "https://example.test/new" });
	const createArgs = runtime.calls.find((call) => call.name === "createTab")?.args;
	assert.deepEqual(createArgs?.slice(0, 3), ["https://example.test/new", false, 5_000]);
	assert.deepEqual({ ...(createArgs?.[3] as Record<string, unknown>), signal: undefined }, { incognito: true, signal: undefined });
	assert.ok((createArgs?.[3] as { signal?: unknown }).signal instanceof AbortSignal);
	await command.execute({ action: "switch", targetRef: "tab-7" });
	await command.execute({ action: "close", targetRef: "tab-7" });
	for (const [name, prefix] of [["switchTab", ["tab-7", 5_000]], ["closeTab", ["tab-7", 5_000]]] as const) {
		const args = runtime.calls.find((call) => call.name === name)?.args;
		assert.deepEqual(args?.slice(0, 2), prefix);
		assert.ok((args?.[2] as { signal?: unknown }).signal instanceof AbortSignal);
	}
	const selected = parseResult(await command.execute({ action: "selectBrowser", browserId: "browser-1" }));
	assert.deepEqual(selected.selected, { browserId: "browser-1" });
});

test("commands execution: browser_tabs rejects invalid targets, URLs, and actions before dispatch", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineTabsCommand(context), runtime);
	for (const [params, code] of [
		[{ action: "close" }, "TAB_ID_REQUIRED"],
		[{ action: "create", url: "/relative" }, "INVALID_TAB_URL"],
		[{ action: "create", url: "javascript:alert(1)" }, "INVALID_TAB_URL"],
		[{ action: "listSessions" }, "INVALID_RULE"],
		[{ action: "unknown" }, "INVALID_RULE"],
	] as Array<[Record<string, unknown>, string]>) {
		assert.equal(parseResult(await command.execute(params)).code, code);
	}
	assert.equal(runtime.calls.some((call) => ["closeTab", "createTab"].includes(call.name)), false);
});

test("commands execution: browser_command read commands return immediately", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const result = await command.execute({ command: { cmd: "network.list", limit: 20 } }, undefined, { cwd: "project" });
	const envelope = parseResult(result);
	const send = runtime.calls.find((call) => (call.args[0] as Record<string, unknown>)?.cmd === "network.list");
	assert.deepEqual(send?.args[0], { cmd: "network.list", limit: 20 });
	assert.deepEqual(envelope.echoed, { cmd: "network.list", limit: 20 });
	assert.equal(result.details?.mode, "command");
});

test("commands execution: browser_command preserves large JSON results", async () => {
	const payload = "x".repeat(60_000);
	const runtime = createRuntime({
		async sendCommand() {
			return { id: "large", acknowledged: true, data: { largeText: payload } } as BrowserBridgeExecutionResult;
		},
	});
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const result = parseResult(await command.execute({ command: { cmd: "network.list", limit: 20 } }));
	assert.equal((result.largeText as string).length, payload.length);
});

test("tool results preserve complete metadata", () => {
	const diagnosticText = "x".repeat(60_000);
	assert.equal(jsonResult({}, { diagnosticText }).details?.diagnosticText, diagnosticText);
});

test("tool results redact sensitive values by default", () => {
	const result = jsonResult({
		cookies: [{ name: "session", value: "cookie-secret" }],
		body: "body-secret",
		headers: { Authorization: "Bearer authorization-secret" },
	});
	const raw = result.content[0]?.text || "";
	assert.doesNotMatch(raw, /cookie-secret|body-secret|authorization-secret/);
	assert.deepEqual(JSON.parse(raw), { body: "[redacted body]", cookies: "[redacted]", headers: { Authorization: "[redacted]" } });
});

test("commands execution: browser_command writes return domain data and effect", async () => {
	const runtime = createRuntime({
		async sendCommand(command, options) {
			runtime.calls.push({ name: "sendCommand", args: [command, options] });
			return { id: "network-start", acknowledged: true, data: { active: true } } as BrowserBridgeExecutionResult;
		},
	});
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const outcome = parseResult(await command.execute({ command: { cmd: "network.start" } }));
	assert.equal(outcome.active, true);
	assert.deepEqual({ ...(outcome.effect as Record<string, unknown>), elapsedMs: 0 }, { observed: false, changed: null, settled: false, elapsedMs: 0 });
});

test("commands execution: browser_command verifies a declared postcondition", async () => {
	const runtime = createRuntime({
		async sendCommand(command, options) {
			runtime.calls.push({ name: "sendCommand", args: [command, options] });
			return { id: "command", acknowledged: true, data: command.cmd === "content.fingerprint" ? undefined : { active: true } } as BrowserBridgeExecutionResult;
		},
		async executeJavaScript(script, options) {
			runtime.calls.push({ name: "executeJavaScript", args: [script, options] });
			return { id: "expect", acknowledged: true, data: true } as BrowserBridgeExecutionResult;
		},
	});
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const outcome = parseResult(await command.execute({ command: { cmd: "network.start" }, expect: "document.body.dataset.ready === '1'" }));
	assert.equal(outcome.active, true);
	assert.equal((outcome.verification as Record<string, unknown>).status, "verified");
	assert.equal(JSON.stringify(outcome).includes("dataset.ready"), false);
	assert.equal((outcome.effect as Record<string, unknown>).verification, undefined);
	assert.equal(runtime.calls.filter((call) => call.name === "executeJavaScript").length, 1);
});

test("commands execution: input.ref returns canonical ABML verification and diff", async () => {
	let dispatched = false;
	let ledgerFrame: CommandPerceptionLedgerFrame = {
		key: { browserSessionId: "session-1", tabId: 7, targetGeneration: 1, pageEpoch: "page-1" },
		snapshotId: "baseline-1",
		capturedAt: 1,
		facts: {},
	};
	const ref = registerOwnedRef();
	const runtime = createRuntime({
		getPerceptionLedgerFrame() { return ledgerFrame; },
		recordPerceptionLedgerFrame(frame) { ledgerFrame = frame; return frame; },
		async sendCommand(command, options) {
			runtime.calls.push({ name: "sendCommand", args: [command, options] });
			if (command.cmd === "content.fingerprint") return { id: "fingerprint", acknowledged: true, data: undefined } as BrowserBridgeExecutionResult;
			if (command.cmd === "persistent_cdp") {
				return { id: "partial-ax", acknowledged: true, data: { result: { nodes: [{ role: { value: "button" }, name: { value: "Like" }, value: { value: "secret" }, backendDOMNodeId: 41, properties: [{ name: "pressed", value: { value: String(dispatched) } }] }] } } } as BrowserBridgeExecutionResult;
			}
			dispatched = true;
			return { id: "input-ref", acknowledged: true, data: { input: { dispatchOnly: true, dispatched: 3 } } } as BrowserBridgeExecutionResult;
		},
		async executeJavaScript(script, options) {
			runtime.calls.push({ name: "executeJavaScript", args: [script, options] });
			return { id: "target-state", acknowledged: true, data: {
				tag: "button", role: "button", label: "Like", text: "Like", value: "secret", editable: false,
				disabled: false, focused: false, pressed: dispatched, visible: true, inViewport: true,
				rect: { x: 0, y: 0, width: 20, height: 20 }, point: { x: 10, y: 10 }, hitOk: true,
			} } as BrowserBridgeExecutionResult;
		},
	});
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const outcome = parseResult(await command.execute({ command: { cmd: "input.ref", action: "click", ref }, expect: { ref, state: { pressed: true } } }));
	assert.equal((outcome.input as Record<string, unknown>).dispatchOnly, true);
	assert.equal((outcome.verification as Record<string, unknown>).status, "verified");
	assert.deepEqual(((outcome.diff as Record<string, unknown>).changed as Array<Record<string, unknown>>)[0], {
		ref,
		kind: "state-changed",
		before: { pressed: false },
		after: { pressed: true },
	});
	assert.equal((outcome.effect as Record<string, unknown>).verification, undefined);
	assert.equal(JSON.stringify(outcome).includes("secret"), false);
	assert.deepEqual({ ...ledgerFrame.lastAction, at: 0 }, { ref, verb: "input.ref", at: 0 });
});

test("commands execution: structured postconditions may observe non-actionable ABML refs", async () => {
	const ref = registerOwnedRef({ liveActionsAllowed: false });
	const runtime = createRuntime({
		async sendCommand(command, options) {
			runtime.calls.push({ name: "sendCommand", args: [command, options] });
			if (command.cmd === "content.fingerprint") return { id: "fingerprint", acknowledged: true, data: undefined } as BrowserBridgeExecutionResult;
			if (command.cmd === "persistent_cdp") return { id: "partial-ax", acknowledged: true, data: { result: { nodes: [] } } } as BrowserBridgeExecutionResult;
			return { id: "network-start", acknowledged: true, data: { active: true } } as BrowserBridgeExecutionResult;
		},
		async executeJavaScript(script, options) {
			runtime.calls.push({ name: "executeJavaScript", args: [script, options] });
			return { id: "target-state", acknowledged: true, data: {
				tag: "div", role: "status", label: "Saved", editable: false,
				disabled: false, focused: false, visible: true, inViewport: true,
				rect: { x: 0, y: 0, width: 20, height: 20 }, point: { x: 10, y: 10 }, hitOk: true,
			} } as BrowserBridgeExecutionResult;
		},
	});
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const outcome = parseResult(await command.execute({ command: { cmd: "network.start" }, expect: { ref, state: { visible: true } } }));
	assert.equal((outcome.verification as Record<string, unknown>).status, "verified");
});

test("ABML verification refuses to sample a ref after page replacement", async () => {
	const ref = registerOwnedRef();
	const runtime = createRuntime({ snapshot() { return { ...baseSnapshot(), tabs: [{ ...baseSnapshot().tabs[0]!, pageEpoch: "page-2" }] }; } });
	const observation = await readAbmlVerificationObservation({ server: runtime, expectation: { ref, state: { visible: true } }, browserSessionId: "session-1", tabId: 7, rawTarget: "tab-7", timeoutMs: 1_000 });
	assert.match(observation.reason ?? "", /stale/);
	assert.equal(runtime.calls.some((call) => call.name === "executeJavaScript"), false);
});

test("ABML verification emits no diff before a post-action sample", async () => {
	let reads = 0;
	const ref = registerOwnedRef();
	const runtime = createRuntime({
		async executeJavaScript() {
			reads += 1;
			return { id: "target-state", acknowledged: true, data: {
				tag: "button", role: "button", editable: false, pressed: reads > 1,
				disabled: false, focused: false, visible: true, inViewport: true,
				rect: { x: 0, y: 0, width: 20, height: 20 }, point: { x: 10, y: 10 }, hitOk: true,
			} } as BrowserBridgeExecutionResult;
		},
	});
	const verification = await prepareAbmlVerification({ server: runtime, expectation: { ref, state: { pressed: true } }, verb: "input.ref", browserSessionId: "session-1", tabId: 7, rawTarget: "tab-7", timeoutMs: 1_000 });
	assert.equal(verification.diff(), undefined);
	await verification.verify();
	assert.deepEqual(verification.diff()?.changed, [{ ref, kind: "state-changed", before: { pressed: false }, after: { pressed: true } }]);
});

test("commands execution: browser-wide writes skip irrelevant page-effect sampling", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const outcome = parseResult(await command.execute({ command: { cmd: "management", method: "reload" } }));
	assert.equal(outcome.effect, undefined);
	assert.equal(runtime.calls.filter((call) => call.name === "sendCommand").length, 1);
	assert.equal((runtime.calls.find((call) => call.name === "sendCommand")?.args[0] as Record<string, unknown>).cmd, "management");
});

test("commands execution: browser_command rejects commands outside the public native catalog", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	for (const [cmd, owner] of [["tabs", "browser_tabs"], ["screenshot.capture", "browser_screenshot"]]) {
		const body = parseResult(await command.execute({ command: { cmd } }));
		assert.equal(body.code, "INVALID_RULE");
		assert.match(String(body.message), new RegExp(String(owner)));
	}
	const internal = parseResult(await command.execute({ command: { cmd: "batch", commands: [] } }));
	assert.equal(internal.code, "INVALID_RULE");
	assert.match(String(internal.message), /not a public native command/);
	assert.equal(runtime.calls.some((call) => call.name === "sendCommand"), false);
});

test("commands execution: browser_command rejects runtime-managed control fields and lifecycle commands", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	for (const input of [
		{ cmd: "cdp", method: "Page.reload", browserSessionId: "internal" },
		{ cmd: "cdp", method: "Page.reload", tabId: 7 },
		{ cmd: "cdp", method: "Page.reload", sessionId: "internal" },
		{ cmd: "cdp", method: "Page.reload", timeoutMs: 1_000 },
	] as Array<Record<string, unknown>>) {
		const body = parseResult(await command.execute({ command: input }));
		assert.equal(body.code, "INVALID_BROWSER_COMMAND");
		assert.match(String(body.message), /runtime-managed/);
	}
	for (const input of [
		{ cmd: "bridge_wake" },
		{ cmd: "persistent_cdp", action: "send", cdpMethod: "Page.reload" },
		{ cmd: "hook.list_sessions" },
		{ cmd: "hook.list_targets" },
		{ cmd: "hook.install_targets", targets: ["console"] },
	] as Array<Record<string, unknown>>) {
		const body = parseResult(await command.execute({ command: input }));
		assert.equal(body.code, "INVALID_RULE");
		assert.match(String(body.message), /not a public native command/);
	}
	assert.equal(runtime.calls.length, 0);
});

test("commands execution: raw CDP dispatch contains only the requested browser primitive", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	await command.execute({ command: { cmd: "cdp", method: "Page.reload", params: { ignoreCache: true } } });
	const send = runtime.calls.find((call) => call.name === "sendCommand" && (call.args[0] as Record<string, unknown>).cmd === "cdp");
	assert.deepEqual(send?.args[0], { cmd: "cdp", method: "Page.reload", params: { ignoreCache: true } });
});

test("commands execution: browser_command rejects command-specific schema errors before startup", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const body = parseResult(await command.execute({ command: { cmd: "network.list", typo: true } }));
	assert.equal(body.code, "INVALID_BROWSER_COMMAND");
	assert.match(String(body.message), /unknown parameter "typo"/);
	assert.equal(runtime.calls.length, 0);
});

test("commands execution: browser_command rejects postconditions on reads", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const body = parseResult(await command.execute({ command: { cmd: "network.list" }, expect: "true" }));
	assert.equal(body.code, "INVALID_RULE");
	assert.match(String(body.message), /only valid for writes/);
	assert.equal(runtime.calls.some((call) => call.name === "sendCommand"), false);
});

test("dedicated screenshot and browser_command dispatch their native commands", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "browser-pilot-owned-tools-"));
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
	const screenshotResult = parseResult(await screenshot.execute({ targetRef: "tab-7" }, undefined, { cwd: directory }));
	assert.match(String((screenshotResult.saved as Record<string, unknown>).path), /screenshot-\d+\.png$/);

	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	await command.execute({ targetRef: "tab-7", command: { cmd: "transfer.download", url: "https://example.test/file.txt" } });
	await command.execute({ targetRef: "tab-7", command: { cmd: "transfer.upload", selector: "input[type=file]", files: ["D:\\fixtures\\upload.txt"] } });

	assert.deepEqual(runtime.calls
		.filter((call) => call.name === "sendCommand" && (call.args[0] as Record<string, unknown>).cmd !== "content.fingerprint")
		.map((call) => (call.args[0] as Record<string, unknown>).cmd), ["screenshot.capture", "transfer.download", "transfer.upload"]);
});

test("commands execution: browser_command write failures return the error", async () => {
	const runtime = createRuntime({
		async sendCommand() {
			throw new Error("bridge send failed");
		},
	});
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const result = await command.execute({ command: { cmd: "cdp", method: "Page.reload" }, targetRef: "tab-7" });
	const body = parseResult(result);
	assert.equal(body.code, "INTERNAL_ERROR");
	assert.match(String(body.message), /bridge send failed/);
});

test("commands execution: browser_execute returns only script data and effect", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const result = await command.execute({ script: "return 42", targetRef: "tab-7" });
	const envelope = parseResult(result);
	const execute = runtime.calls.find((call) => call.name === "executeJavaScript");
	assert.equal(execute?.args[0], "return 42");
	assert.deepEqual({ ...(execute?.args[1] as Record<string, unknown>), signal: undefined }, { browserSessionId: "session-1", tabId: "tab-7", timeoutMs: 15000, accessMode: "write", signal: undefined });
	assert.ok((execute?.args[1] as { signal?: unknown }).signal instanceof AbortSignal);
	assert.equal(envelope.answer, 42);
	assert.equal(envelope.script, "return 42");
	assert.deepEqual({ ...(envelope.effect as Record<string, unknown>), elapsedMs: 0 }, { observed: false, changed: null, settled: false, elapsedMs: 0 });
});

test("commands execution: browser_execute preserves application-owned identity fields", async () => {
	const runtime = createRuntime({
		async executeJavaScript() { return { id: "exec", acknowledged: true, tabId: 7, data: { sessionId: "application-session", tabId: "application-tab" } } as BrowserBridgeExecutionResult; },
	});
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const result = parseResult(await command.execute({ script: "return app.state", readOnly: true }));
	assert.deepEqual(result, { sessionId: "application-session", tabId: "application-tab" });
});

test("commands execution: browser_execute keeps effect sampling inside the pinned target transaction", async () => {
	const order: string[] = [];
	const fingerprints = [
		{ changeSeq: 1, pageEpoch: "page-1", documentId: "document-1", url: "https://example.test/", readyState: "complete", visibleCount: 10, interactiveCount: 2 },
		{ changeSeq: 2, pageEpoch: "page-1", documentId: "document-1", url: "https://example.test/", readyState: "complete", visibleCount: 11, interactiveCount: 2 },
		{ changeSeq: 2, pageEpoch: "page-1", documentId: "document-1", url: "https://example.test/", readyState: "complete", visibleCount: 11, interactiveCount: 2 },
	];
	let fingerprintReads = 0;
	const runtime = createRuntime({
		async withTargetTransaction(input, run) {
			order.push(`lock:${input.tabId}`);
			const result = await run();
			order.push(`unlock:${input.tabId}`);
			return result;
		},
		async sendCommand() {
			order.push(`fingerprint:${fingerprintReads += 1}`);
			return { id: "fingerprint", acknowledged: true, data: fingerprints.shift() } as BrowserBridgeExecutionResult;
		},
		async executeJavaScript(script, _options) {
			order.push("dispatch");
			return { id: "exec-effect", acknowledged: true, tabId: 7, target: { tabId: 7 }, data: { script } } as BrowserBridgeExecutionResult;
		},
	});
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const envelope = parseResult(await command.execute({ script: "document.body.dataset.ready = '1'" }));
	assert.deepEqual(order, ["lock:7", "fingerprint:1", "dispatch", "fingerprint:2", "fingerprint:3", "unlock:7"]);
	assert.equal(envelope.script, "document.body.dataset.ready = '1'");
	assert.equal((envelope.effect as Record<string, unknown>).changed, true);
	assert.equal((envelope.effect as Record<string, unknown>).settled, true);
});

test("commands execution: browser_execute verifies a declared postcondition", async () => {
	let checks = 0;
	const runtime = createRuntime({
		async sendCommand() { return { id: "fingerprint", acknowledged: true, data: undefined } as BrowserBridgeExecutionResult; },
		async executeJavaScript(script, options) {
			runtime.calls.push({ name: "executeJavaScript", args: [script, options] });
			return { id: "exec", acknowledged: true, data: script.includes("Boolean(await") ? (checks += 1) === 2 : { submitted: true } } as BrowserBridgeExecutionResult;
		},
	});
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const result = parseResult(await command.execute({ script: "submit()", expect: "document.body.dataset.state === 'done'" }));
	assert.equal(result.submitted, true);
	assert.equal((result.verification as Record<string, unknown>).status, "verified");
	assert.equal((result.effect as Record<string, unknown>).verification, undefined);
	assert.equal(checks, 2);
});

test("commands execution: browser_execute rejects command-shaped scripts with recovery metadata", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const result = await command.execute({ script: "{\"cmd\":\"tabs\",\"method\":\"list\"}" });
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
	await command.execute({ script: "return browserPilot.refs.submit.id", refs: { submit: ref } });
	const execute = runtime.calls.find((call) => call.name === "executeJavaScript");
	assert.match(String(execute?.args[0]), /const __bindings = \{"submit":"bp-ref:\/\/control\//);
	assert.deepEqual({ ...(execute?.args[1] as Record<string, unknown>), signal: undefined }, { browserSessionId: "session-1", tabId: 7, timeoutMs: 15000, accessMode: "write", signal: undefined });
});

test("commands execution: read-only ref literals skip write lifecycle", async () => {
	let transactions = 0;
	const runtime = createRuntime({
		async withTargetTransaction(_input, run) {
			transactions += 1;
			return await run();
		},
	});
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const script = "return 'bp-ref://control/not-a-binding'";
	const result = parseResult(await command.execute({ script, readOnly: true, targetRef: "tab-7" }));
	const execute = runtime.calls.find((call) => call.name === "executeJavaScript");
	assert.equal(execute?.args[0], script);
	assert.deepEqual({ ...(execute?.args[1] as Record<string, unknown>), signal: undefined }, { browserSessionId: undefined, tabId: "tab-7", timeoutMs: 15000, accessMode: "read", signal: undefined });
	assert.equal(result.effect, undefined);
	assert.equal(runtime.calls.some((call) => call.name === "snapshot"), false);
	assert.equal(transactions, 0);
	assert.equal(runtime.calls.some((call) => (call.args[0] as Record<string, unknown>)?.cmd === "content.fingerprint"), false);
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
		assert.equal(parseResult(await command.execute(params)).code, code);
		assert.equal(runtime.calls.some((call) => call.name === "executeJavaScript"), false);
	}
});

test("commands execution: readOnly cannot bypass ref action policy", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineExecuteCommand(context), runtime);
	const result = parseResult(await command.execute({ script: "return browserPilot.refs.text.textContent", refs: { text: registerOwnedRef({ liveActionsAllowed: false }) }, readOnly: true }));
	assert.equal(result.code, "INVALID_RULE");
	assert.equal(runtime.calls.some((call) => call.name === "executeJavaScript"), false);
});

test("commands execution: replaced tabs and changed page epochs invalidate refs before dispatch", async () => {
	const replacedRuntime = createRuntime({
		resolveTargetTabId(value) { return Number(value) === 7 ? 8 : Number(value); },
		snapshot() { return { ...baseSnapshot(), defaultTabId: 8, tabs: [{ tabId: 8, targetGeneration: 2, pageEpoch: "page-2", url: "https://example.test/" }] }; },
	});
	const replaced = defineCommand((context) => defineExecuteCommand(context), replacedRuntime);
	assert.equal(parseResult(await replaced.execute({ script: "return browserPilot.refs.target", refs: { target: registerOwnedRef() } })).code, "REF_STALE");
	assert.equal(replacedRuntime.calls.some((call) => call.name === "executeJavaScript"), false);

	const navigatedRuntime = createRuntime({ snapshot() { return { ...baseSnapshot(), tabs: [{ ...baseSnapshot().tabs[0], pageEpoch: "page-2" }] }; } });
	const navigated = defineCommand((context) => defineExecuteCommand(context), navigatedRuntime);
	assert.equal(parseResult(await navigated.execute({ script: "return browserPilot.refs.target", refs: { target: registerOwnedRef() } })).code, "REF_STALE");
	assert.equal(navigatedRuntime.calls.some((call) => call.name === "executeJavaScript"), false);

	const unprovenRuntime = createRuntime();
	const unproven = defineCommand((context) => defineExecuteCommand(context), unprovenRuntime);
	assert.equal(parseResult(await unproven.execute({ script: "return browserPilot.refs.target", refs: { target: registerOwnedRef({ pageIdentity: false }) } })).code, "REF_STALE");
	assert.equal(unprovenRuntime.calls.some((call) => call.name === "executeJavaScript"), false);
});

test("commands execution: input.ref expands its private native target and routes from ref ownership", async () => {
	const runtime = createRuntime();
	const command = defineCommand((context) => defineNativeCommand(context), runtime);
	const ref = registerOwnedRef();
	await command.execute({ command: { cmd: "input.ref", action: "click", ref } });
	const send = runtime.calls.find((call) => call.name === "sendCommand" && (call.args[0] as Record<string, unknown>).cmd === "input.ref");
	const native = send?.args[0] as Record<string, unknown>;
	const target = native.target as Record<string, unknown>;
	assert.equal(native.ref, ref);
	assert.equal(target.refId, ref);
	assert.equal(target.backendNodeId, 41);
	assert.equal(target.targetId, "target-1");
	assert.deepEqual({ ...(send?.args[1] as Record<string, unknown>), signal: undefined }, { browserSessionId: "session-1", tabId: 7, timeoutMs: 15000, accessMode: "write", signal: undefined });
});
