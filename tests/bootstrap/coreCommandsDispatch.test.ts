import test from "node:test";
import assert from "node:assert/strict";
import { executeProgram, type ProgramContext } from "../../src/browser-command-runtime/programEngine.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";
import type { BrowserBridgeExecutionResult } from "../../src/ports/BrowserRuntimeTypes.ts";

const sentRuntimeMessages: unknown[] = [];
const cspRuleUpdates: unknown[] = [];

const chromeStub = {
	runtime: {
		id: "browser-pilot-test",
		getManifest() {
			return { name: "Browser Pilot Test", version: "0.0.0" };
		},
		async sendMessage(message: unknown) {
			sentRuntimeMessages.push(message);
		},
	},
	storage: {
		local: {
			async get() { return {}; },
			async set() {},
			async remove() {},
		},
		session: {
			async get() { return {}; },
			async set() {},
		},
	},
	alarms: {
		create() {},
		async clear() { return true; },
		onAlarm: { addListener() {} },
	},
	declarativeNetRequest: {
		async updateSessionRules(update: unknown) {
			cspRuleUpdates.push(update);
		},
		async getSessionRules() {
			return [];
		},
	},
	debugger: {
		onDetach: { addListener() {} },
		onEvent: { addListener() {} },
	},
	tabs: {
		async query() {
			return [{ id: 7, url: "https://example.test/", title: "Example", active: true, windowId: 1 }];
		},
	},
};

Object.assign(globalThis, { chrome: chromeStub, self: globalThis });
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "browser-pilot-test" }, configurable: true });

const coreCommands = await import("../../src/bridge/extension/service_worker/core_commands.ts");
const router = await import("../../src/bridge/extension/service_worker/router.ts");
const runtime = await import("../../src/bridge/extension/service_worker/runtime.ts");

function sender(tabId = 7) {
	return { tab: { id: tabId, url: "https://example.test/" } };
}

function parseSocketMessages(socket: { sent: string[] }): Array<Record<string, unknown>> {
	return socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

function createProgramContext(server: Pick<BrowserCommandRuntimePort, "sendCommand" | "executeJavaScript">, signal = new AbortController().signal): ProgramContext {
	return {
		server: server as BrowserCommandRuntimePort,
		tabId: 7,
		browserSessionId: "session-1",
		targetRef: undefined,
		refRegistry: {},
		contextVars: new Map<string, unknown>(),
		lastEvalResult: undefined,
		signal,
		evalTimeoutMs: 250,
	};
}

test("core command direct and batch dispatch share supported command handlers", async () => {
	const direct = await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "tabs", method: "list" }, sender());
	const batch = await coreCommands.handleBatch({ cmd: "batch", commands: [{ cmd: "tabs", method: "list" }] }, sender());

	assert.equal(direct.ok, true);
	assert.equal(batch.ok, true);
	assert.deepEqual(batch.results, [direct]);
	assert.equal(typeof coreCommands.resolveBrowserPilotCoreCommandHandler("tabs"), "function");
});

test("core command unknown direct and batch dispatch return command errors", async () => {
	const direct = await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "not_real" }, sender());
	const batch = await coreCommands.handleBatch({ cmd: "batch", commands: [{ cmd: "not_real" }] }, sender());

	assert.equal(direct.ok, false);
	assert.equal(direct.error_code, "INVALID_RULE");
	assert.match(String(direct.error), /Unknown cmd: not_real/);
	assert.equal(batch.ok, true);
	assert.equal(Array.isArray(batch.results), true);
	const [item] = batch.results as Array<{ ok: boolean; error_code?: string; error?: unknown }>;
	assert.equal(item.ok, false);
	assert.equal(item.error_code, "INVALID_RULE");
	assert.match(String(item.error), /unknown cmd: not_real/);
});

test("core command batch validates native commands before dispatch", async () => {
	const result = await coreCommands.handleBatch({ cmd: "batch", commands: [{ cmd: "input.pointer" }] }, sender());

	assert.equal(result.ok, true);
	assert.equal(Array.isArray(result.results), true);
	const [item] = result.results as Array<{ ok: boolean; error_code?: string; error?: unknown; details?: { missing?: string[] } }>;
	assert.equal(item.ok, false);
	assert.equal(item.error_code, "INVALID_RULE");
	assert.match(String(item.error), /input\.pointer missing required fields: gesture, x, y/);
	assert.deepEqual(item.details?.missing, ["gesture", "x", "y"]);
});

test("core command batch cdp preserves result parameter substitution", async () => {
	const previousPersistentCdp = (globalThis as typeof globalThis & { BrowserPilotPersistentCdp?: unknown }).BrowserPilotPersistentCdp;
	const previousPersistentCdpBridge = (globalThis as typeof globalThis & { browserPilotPersistentCdpBridge?: unknown }).browserPilotPersistentCdpBridge;
	const calls: Array<{ tabId: number; method: string; params?: Record<string, unknown>; options?: Record<string, unknown> }> = [];
	Object.assign(globalThis, {
		BrowserPilotPersistentCdp: {
			async send(tabId: number, method: string, params?: Record<string, unknown>, options?: Record<string, unknown>) {
				calls.push({ tabId, method, params, options });
				return { ok: true, data: { result: { echoed: params, method } } };
			},
		},
		browserPilotPersistentCdpBridge: {
			async send(tabId: number, method: string, params?: Record<string, unknown>, options?: Record<string, unknown>) {
				calls.push({ tabId, method, params, options });
				return { ok: true, data: { result: { echoed: params, method } } };
			},
		},
	});

	try {
		const result = await coreCommands.handleBatch({
			cmd: "batch",
			tabId: 42,
			commands: [
				{ cmd: "cdp", method: "Runtime.evaluate", params: { expression: "location.href" } },
				{ cmd: "cdp", method: "Runtime.callFunctionOn", params: { argument: "$0.data.echoed.expression" } },
			],
		}, sender());

		assert.equal(result.ok, true);
		assert.deepEqual(calls.map((call) => call.params), [
			{ expression: "location.href" },
			{ argument: "location.href" },
		]);
		assert.deepEqual(result.results, [
			{ ok: true, data: { echoed: { expression: "location.href" }, method: "Runtime.evaluate" } },
			{ ok: true, data: { echoed: { argument: "location.href" }, method: "Runtime.callFunctionOn" } },
		]);
	} finally {
		(globalThis as typeof globalThis & { BrowserPilotPersistentCdp?: unknown }).BrowserPilotPersistentCdp = previousPersistentCdp;
		(globalThis as typeof globalThis & { browserPilotPersistentCdpBridge?: unknown }).browserPilotPersistentCdpBridge = previousPersistentCdpBridge;
	}
});

test("extension websocket router rejects malformed command envelopes without browser", async () => {
	cspRuleUpdates.length = 0;
	const socket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };

	await router.handleBrowserPilotBridgeWsMessage({ id: "empty-cmd", tabId: 7, code: { cmd: "   " } }, socket);
	await router.handleBrowserPilotBridgeWsMessage({ id: "bad-code", tabId: 7, code: 42 }, socket);
	await router.handleBrowserPilotBridgeWsMessage({ id: "missing-code", tabId: 7 }, socket);

	const messages = parseSocketMessages(socket);
	assert.deepEqual(messages, [
		{ type: "error", id: "empty-cmd", error: "Message object must contain a non-empty \"cmd\" field", details: { codeType: "object" } },
		{ type: "error", id: "bad-code", error: "Unsupported message code type: number", details: { codeType: "number" } },
	]);
	assert.equal(cspRuleUpdates.length, 0);
});

test("extension websocket router acknowledges and shapes native command validation errors", async () => {
	cspRuleUpdates.length = 0;
	const socket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };

	await router.handleBrowserPilotBridgeWsMessage({ id: "native-invalid", tabId: 7, code: JSON.stringify({ cmd: "input.pointer" }) }, socket);

	const messages = parseSocketMessages(socket);
	assert.equal(messages[0]?.type, "ack");
	assert.equal(messages[0]?.id, "native-invalid");
	assert.equal(messages[1]?.type, "error");
	assert.equal(messages[1]?.id, "native-invalid");
	assert.deepEqual(messages[1]?.result, {
		ok: false,
		error_code: "INVALID_RULE",
		error: "input.pointer missing required fields: gesture, x, y",
		details: { cmd: "input.pointer", missing: ["gesture", "x", "y"] },
	});
	assert.match(String(messages[1]?.error), /input\.pointer missing required fields/);
	assert.equal(cspRuleUpdates.length > 0, true);
});

test("extension runtime helpers redact and normalize malformed error responses", () => {
	const circular: Record<string, unknown> = { token: "fixture-secret" };
	circular.self = circular;

	assert.deepEqual(runtime.bridgeError(undefined, "fixture-secret", { password: "fixture-password", circular }), {
		ok: false,
		error_code: "INTERNAL_ERROR",
		error: "[REDACTED]",
		details: {
			password: "[REDACTED]",
			circular: { token: "[REDACTED]", self: "[REDACTED_CYCLE]" },
		},
	});

	assert.deepEqual(runtime.normalizeBridgeResponse({ ok: false, error: { code: "NO_SESSION", message: "missing session", details: { tabId: 7 } } }, "hook.read"), {
		ok: false,
		error_code: "NO_SESSION",
		error: "missing session",
		details: { tabId: 7, cmd: "hook.read" },
	});

	assert.deepEqual(runtime.normalizePersistentBrowserPilotResponse({ ok: false, error: { code: "CDP_TIMEOUT", message: "wait expired", details: { timeoutMs: 5 } } }), {
		ok: false,
		error_code: "CDP_TIMEOUT",
		error: "wait expired",
		details: { timeoutMs: 5 },
	});
});

test("browser command runtime program adapter covers success, failure, timeout, and malformed expand results", async () => {
	const calls: Array<{ name: string; payload: unknown }> = [];
	const successServer = {
		async executeJavaScript(script: string) {
			calls.push({ name: "executeJavaScript", payload: script });
			return { id: "exec", acknowledged: true, data: script === "location.href" ? "https://example.test/" : [1, 2, 3] } as BrowserBridgeExecutionResult;
		},
		async sendCommand(command: unknown) {
			calls.push({ name: "sendCommand", payload: command });
			return { id: "send", acknowledged: true, data: { sent: [{ type: "keyDown" }] } } as BrowserBridgeExecutionResult;
		},
	};
	const success = await executeProgram([{ eval: "[1,2,3]", as: "items" }, { text: "hello" }], createProgramContext(successServer));
	assert.equal(success.aborted, undefined);
	assert.equal(success.frames.length, 2);
	assert.deepEqual(success.result, [1, 2, 3]);
	assert.deepEqual(calls.map((call) => call.name), ["executeJavaScript", "executeJavaScript", "executeJavaScript", "sendCommand"]);

	const failure = await executeProgram([{ text: "hello" }], createProgramContext({
		async executeJavaScript() {
			return { id: "url", acknowledged: true, data: "https://example.test/" } as BrowserBridgeExecutionResult;
		},
		async sendCommand() {
			throw new Error("adapter failed");
		},
	}));
	assert.deepEqual(failure.aborted, { reason: "adapter failed", atStep: 0 });
	assert.equal(failure.frames[0]?.ok, false);

	const controller = new AbortController();
	controller.abort();
	const timeout = await executeProgram([{ wait: 1 }], createProgramContext({
		async executeJavaScript() {
			return { id: "url", acknowledged: true, data: "https://example.test/" } as BrowserBridgeExecutionResult;
		},
		async sendCommand() {
			throw new Error("unexpected send");
		},
	}, controller.signal));
	assert.deepEqual(timeout.aborted, { reason: "timeout", atStep: 0 });
	assert.deepEqual(timeout.frames, []);

	const malformed = await executeProgram([{ eval: "({not:'array'})", expand: true }], createProgramContext({
		async executeJavaScript(script: string) {
			return { id: "exec", acknowledged: true, data: script === "location.href" ? "https://example.test/" : { not: "array" } } as BrowserBridgeExecutionResult;
		},
		async sendCommand() {
			throw new Error("unexpected send");
		},
	}));
	assert.deepEqual(malformed.aborted, { reason: "Step 0: expand=true but eval result is not an array", atStep: 0 });
	assert.equal(malformed.frames[0]?.ok, true);
});
