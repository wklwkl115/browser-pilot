import test from "node:test";
import assert from "node:assert/strict";
import { executeProgram, type ProgramContext } from "../../src/browser-command-runtime/programEngine.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";
import type { BrowserBridgeExecutionResult } from "../../src/ports/BrowserRuntimeTypes.ts";

const sentRuntimeMessages: unknown[] = [];
const cspRuleUpdates: unknown[] = [];
type Debuggee = { tabId: number; sessionId?: string };
type DebuggerCommand = { debuggee: Debuggee; method: string; params?: Record<string, unknown> };
const debuggerAttachments: number[] = [];
const debuggerDetaches: number[] = [];
const debuggerCommands: DebuggerCommand[] = [];
const debuggerDetachListeners: Array<(source: Debuggee, reason: string) => void> = [];
const debuggerEventListeners: Array<(source: Debuggee, method: string, params?: Record<string, unknown>) => void> = [];
const tabCreatedListeners: Array<(tab: Record<string, unknown>) => void> = [];
const tabUpdatedListeners: Array<(tabId: number, changeInfo: Record<string, unknown>, tab: Record<string, unknown>) => void> = [];
const tabRemovedListeners: Array<(tabId: number) => void> = [];
const tabReplacedListeners: Array<(addedTabId: number, removedTabId: number) => void> = [];
const tabActivatedListeners: Array<(info: { tabId: number; windowId: number }) => void> = [];
const downloadCreatedListeners: Array<(item: Record<string, unknown>) => void> = [];
const downloadChangedListeners: Array<(delta: Record<string, unknown>) => void> = [];
const navigationListeners: Array<(details: Record<string, unknown> & { tabId?: number; url?: string }) => void> = [];
const runtimeMessageListeners: Array<(message: unknown, sender: Record<string, unknown>, sendResponse: (response: unknown) => void) => boolean> = [];
const sessionStorage: Record<string, unknown> = {};
const contentOperationStates = new Map<string, { mutationCount: number; deliveryFailures: number }>();
let failRunScriptOnce = false;
let failNotAttachedOnce = false;
let failAlreadyAttachedOnce = false;
let domainEnableConcurrency: { active: number; max: number } | undefined;

async function debuggerCommandResult(_debuggee: Debuggee, method: string): Promise<unknown> {
	if (domainEnableConcurrency && ["Page.enable", "Network.enable", "Runtime.enable"].includes(method)) {
		domainEnableConcurrency.active += 1;
		domainEnableConcurrency.max = Math.max(domainEnableConcurrency.max, domainEnableConcurrency.active);
		await new Promise<void>((resolve) => setImmediate(resolve));
		domainEnableConcurrency.active -= 1;
	}
	if (method === "Runtime.compileScript") return { scriptId: "compiled-script-1" };
	if (method === "Runtime.runScript") {
		if (failRunScriptOnce) {
			failRunScriptOnce = false;
			throw new Error("No script with given id");
		}
		return { result: { type: "number", value: 42 } };
	}
	if (method === "Runtime.evaluate") return { result: { type: "number", value: 42 } };
	if (method === "Network.enable" && failNotAttachedOnce) {
		failNotAttachedOnce = false;
		throw new Error("Debugger is not attached");
	}
	return {};
}

const chromeStub = {
	runtime: {
		id: "browser-pilot-test",
		onMessage: {
			addListener(listener: (message: unknown, sender: Record<string, unknown>, sendResponse: (response: unknown) => void) => boolean) {
				runtimeMessageListeners.push(listener);
			},
		},
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
			async get(key?: unknown) {
				if (typeof key === "string") return { [key]: sessionStorage[key] };
				return { ...sessionStorage };
			},
			async set(value: Record<string, unknown>) { Object.assign(sessionStorage, value); },
			async remove(key: string | string[]) { for (const item of Array.isArray(key) ? key : [key]) delete sessionStorage[item]; },
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
		async attach(debuggee: Debuggee) {
			debuggerAttachments.push(debuggee.tabId);
			if (failAlreadyAttachedOnce) {
				failAlreadyAttachedOnce = false;
				throw new Error("Another debugger is already attached to the tab");
			}
		},
		async detach(debuggee: Debuggee) {
			debuggerDetaches.push(debuggee.tabId);
		},
		async sendCommand(debuggee: Debuggee, method: string, params?: Record<string, unknown>) {
			debuggerCommands.push({ debuggee, method, params });
			return debuggerCommandResult(debuggee, method);
		},
		onDetach: {
			addListener(listener: (source: Debuggee, reason: string) => void) {
				debuggerDetachListeners.push(listener);
			},
		},
		onEvent: {
			addListener(listener: (source: Debuggee, method: string, params?: Record<string, unknown>) => void) {
				debuggerEventListeners.push(listener);
			},
			removeListener(listener: (source: Debuggee, method: string, params?: Record<string, unknown>) => void) {
				const index = debuggerEventListeners.indexOf(listener);
				if (index >= 0) debuggerEventListeners.splice(index, 1);
			},
		},
	},
	tabs: {
		async get(tabId: number) {
			return { id: tabId, url: "https://example.test/", title: "Example", active: true, windowId: 1 };
		},
		async query() {
			return [{ id: 7, url: "https://example.test/", title: "Example", active: true, windowId: 1 }];
		},
		async update(tabId: number) {
			return { id: tabId, active: true, windowId: 1 };
		},
		async sendMessage(_tabId: number, message: unknown) {
			const record = message && typeof message === "object" && !Array.isArray(message) ? message as Record<string, unknown> : {};
			const operationId = typeof record.operationId === "string" ? record.operationId : "";
			if (record.cmd === "browserPilot.contentFingerprint") return { ok: true, data: { changeSeq: 1, url: "https://example.test/", title: "Example", readyState: "complete", visibleCount: 1, interactiveCount: 1, capturedAt: Date.now() } };
			if (record.cmd === "browserPilot.operation.begin") {
				contentOperationStates.set(operationId, { mutationCount: 0, deliveryFailures: 0 });
				return { ok: true, operationId, observerArmed: true };
			}
			if (record.cmd === "browserPilot.operation.remove") return { ok: true, operationId, removed: contentOperationStates.delete(operationId) };
			if (record.cmd !== "browserPilot.operation.checkpoint") return undefined;
			const state = contentOperationStates.get(operationId);
			if (!state) return { ok: false, operationId, observerFound: false, deliveryFailures: 0, deliveryReliable: false };
			const response = operationCoordinator.handleBrowserPilotOperationCheckpointEvent({
				operationId,
				fenceId: record.fenceId,
				eventType: record.eventType,
				deliveryFailures: state.deliveryFailures,
			});
			return { ...response, mutationCount: state.mutationCount, batchCount: 0, observerFound: response.ok, deliveryReliable: response.deliveryReliable === true };
		},
		onCreated: { addListener(listener: (tab: Record<string, unknown>) => void) { tabCreatedListeners.push(listener); }, removeListener(listener: (tab: Record<string, unknown>) => void) { const index = tabCreatedListeners.indexOf(listener); if (index >= 0) tabCreatedListeners.splice(index, 1); } },
		onUpdated: { addListener(listener: (tabId: number, changeInfo: Record<string, unknown>, tab: Record<string, unknown>) => void) { tabUpdatedListeners.push(listener); }, removeListener(listener: (tabId: number, changeInfo: Record<string, unknown>, tab: Record<string, unknown>) => void) { const index = tabUpdatedListeners.indexOf(listener); if (index >= 0) tabUpdatedListeners.splice(index, 1); } },
		onRemoved: { addListener(listener: (tabId: number) => void) { tabRemovedListeners.push(listener); }, removeListener(listener: (tabId: number) => void) { const index = tabRemovedListeners.indexOf(listener); if (index >= 0) tabRemovedListeners.splice(index, 1); } },
		onReplaced: { addListener(listener: (addedTabId: number, removedTabId: number) => void) { tabReplacedListeners.push(listener); }, removeListener(listener: (addedTabId: number, removedTabId: number) => void) { const index = tabReplacedListeners.indexOf(listener); if (index >= 0) tabReplacedListeners.splice(index, 1); } },
		onActivated: { addListener(listener: (info: { tabId: number; windowId: number }) => void) { tabActivatedListeners.push(listener); }, removeListener(listener: (info: { tabId: number; windowId: number }) => void) { const index = tabActivatedListeners.indexOf(listener); if (index >= 0) tabActivatedListeners.splice(index, 1); } },
	},
	scripting: { async executeScript() { return []; } },
	downloads: {
		onCreated: { addListener(listener: (item: Record<string, unknown>) => void) { downloadCreatedListeners.push(listener); }, removeListener(listener: (item: Record<string, unknown>) => void) { const index = downloadCreatedListeners.indexOf(listener); if (index >= 0) downloadCreatedListeners.splice(index, 1); } },
		onChanged: { addListener(listener: (delta: Record<string, unknown>) => void) { downloadChangedListeners.push(listener); }, removeListener(listener: (delta: Record<string, unknown>) => void) { const index = downloadChangedListeners.indexOf(listener); if (index >= 0) downloadChangedListeners.splice(index, 1); } },
	},
	webNavigation: Object.fromEntries(["onCommitted", "onCompleted", "onHistoryStateUpdated", "onErrorOccurred"].map((name) => [name, { addListener(listener: (details: Record<string, unknown> & { tabId?: number; url?: string }) => void) { navigationListeners.push(listener); }, removeListener(listener: (details: Record<string, unknown> & { tabId?: number; url?: string }) => void) { const index = navigationListeners.indexOf(listener); if (index >= 0) navigationListeners.splice(index, 1); } }])),
};

Object.assign(globalThis, { chrome: chromeStub, self: globalThis });
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "browser-pilot-test" }, configurable: true });

const coreCommands = await import("../../src/bridge/extension/service_worker/core_commands.ts");
const router = await import("../../src/bridge/extension/service_worker/router.ts");
const runtimeSupport = await import("../../src/bridge/extension/service_worker/runtimeSupport.ts");
const stateStore = await import("../../src/bridge/extension/service_worker/state_store.ts");
const cdpCommands = await import("../../src/bridge/extension/service_worker/cdp.ts");
const waitCdp = await import("../../src/bridge/extension/service_worker/wait_cdp.ts");
const frameCommands = await import("../../src/bridge/extension/service_worker/frame.ts");
const operationCoordinator = await import("../../src/bridge/extension/service_worker/operation_coordinator.ts");
const operationTransport = await import("../../src/bridge/extension/service_worker/operation_event_transport.ts");
const tabSync = await import("../../src/bridge/extension/service_worker/tab_sync.ts");
const pageIdentity = await import("../../src/bridge/extension/service_worker/page_identity.ts");
const tabIdentity = await import("../../src/bridge/extension/service_worker/tab_identity.ts");

function resetCdpFixtures(): void {
	cdpCommands.browserPilotPersistentCdpBridge.sessions.clear();
	cdpCommands.browserPilotPersistentCdpBridge.childSessions.clear();
	cdpCommands.browserPilotPersistentCdpBridge.newDocumentScripts.clear();
	debuggerAttachments.length = 0;
	debuggerDetaches.length = 0;
	debuggerCommands.length = 0;
	failRunScriptOnce = false;
	failNotAttachedOnce = false;
	failAlreadyAttachedOnce = false;
	domainEnableConcurrency = undefined;
}

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

test("operation coordinator arms listeners before dispatch and keeps late events passive until cancel", async () => {
	const socket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
	const boundSocket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
	operationTransport.setBrowserPilotOperationEventSocketGetter(() => socket);
	operationTransport.bindBrowserPilotOperationEventSocket("operation-1", boundSocket);
	const begin = await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.begin", operationId: "operation-1", tabId: 7, generation: 3, targetRef: "tab-7" }, sender());
	operationTransport.bindBrowserPilotOperationEventSocket("operation-1", boundSocket);
	assert.equal(begin.ok, true);
	assert.equal((begin.data as Record<string, unknown>).armed, true);
	assert.equal((begin.data as Record<string, unknown>).mutationObserverArmed, true);
	assert.equal(tabUpdatedListeners.length > 0, true);
	assert.equal(downloadCreatedListeners.length > 0, true);
	assert.equal(debuggerEventListeners.length > 0, true);
	debuggerEventListeners.at(-1)?.({ tabId: 7 }, "Network.requestWillBeSent", { requestId: "r1", request: { url: "https://example.test/api" } });
	assert.equal(socket.sent.length, 0);
	assert.equal((JSON.parse(boundSocket.sent.at(-1) || "{}") as Record<string, unknown>).type, "operation_event");
	const finish = await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.finish", operationId: "operation-1" }, sender());
	assert.equal(finish.ok, true);
	tabUpdatedListeners.at(-1)?.(7, { status: "complete" }, { id: 7, url: "https://example.test/done" });
	assert.equal(boundSocket.sent.some((payload) => payload.includes("navigation")), true);
	const cancel = await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.cancel", operationId: "operation-1" }, sender());
	assert.equal(cancel.ok, true);
	assert.equal(tabUpdatedListeners.length, 0);
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
		{ type: "error", id: "empty-cmd", error: "Message object must contain a non-empty \"cmd\" field", details: { codeType: "object", dispatchStarted: false, acked: false } },
		{ type: "error", id: "bad-code", error: "Unsupported message code type: number", details: { codeType: "number", dispatchStarted: false, acked: false } },
	]);
	assert.equal(cspRuleUpdates.length, 0);
});

test("extension websocket router rejects native command validation errors before ACK", async () => {
	cspRuleUpdates.length = 0;
	const socket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };

	await router.handleBrowserPilotBridgeWsMessage({ id: "native-invalid", tabId: 7, code: JSON.stringify({ cmd: "input.pointer" }) }, socket);

	const messages = parseSocketMessages(socket);
	assert.equal(messages.length, 1);
	assert.equal(messages[0]?.type, "error");
	assert.equal(messages[0]?.id, "native-invalid");
	assert.deepEqual(messages[0]?.result, {
		ok: false,
		error_code: "INVALID_RULE",
		error: "input.pointer missing required fields: gesture, x, y",
		details: { cmd: "input.pointer", missing: ["gesture", "x", "y"], dispatchStarted: false, acked: false },
	});
	assert.match(String(messages[0]?.error), /input\.pointer missing required fields/);
	assert.equal(cspRuleUpdates.length, 0);
});

test("extension websocket router binds operation events to the socket that armed the operation", async () => {
	const fallback = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
	const commandSocket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
	operationTransport.setBrowserPilotOperationEventSocketGetter(() => fallback);

	await router.handleBrowserPilotBridgeWsMessage({ id: "operation-begin", tabId: 7, code: { cmd: "operation.begin", operationId: "operation-bound", tabId: 7, generation: 1 } }, commandSocket);
	debuggerEventListeners.at(-1)?.({ tabId: 7 }, "Page.lifecycleEvent", { name: "load", url: "https://example.test/after" });
	assert.equal(fallback.sent.length, 0);
	assert.equal(parseSocketMessages(commandSocket).some((message) => message.type === "operation_event" && (message.event as Record<string, unknown> | undefined)?.type === "navigation"), true);

	await router.handleBrowserPilotBridgeWsMessage({ id: "operation-cancel", code: { cmd: "operation.cancel", operationId: "operation-bound" } }, commandSocket);
});

test("actual native and JavaScript actions are preceded by one idempotent dispatch marker", async () => {
	const tabs = chromeStub.tabs as unknown as { update(tabId: number, update?: Record<string, unknown>): Promise<unknown> };
	const originalUpdate = tabs.update;
	const protocol = (globalThis as typeof globalThis & { BrowserPilotNativeProtocol?: { validateCommand?: (...args: unknown[]) => unknown } }).BrowserPilotNativeProtocol;
	const originalValidate = protocol?.validateCommand;
	const order: string[] = [];
	let actionLabel = "action";
	const socket = {
		readyState: 1,
			sent: [] as string[],
		send(payload: string) {
			this.sent.push(payload);
			const message = JSON.parse(payload) as Record<string, unknown>;
			const event = message.event as Record<string, unknown> | undefined;
			if (message.type === "operation_event" && event?.type === "dispatch") order.push("dispatch");
			if (message.type === "ack" && ["native-action", "js-action"].includes(String(message.id))) order.push("ack");
		},
	};
	if (protocol && originalValidate) {
		protocol.validateCommand = (...args: unknown[]) => {
			order.push("validation");
			return originalValidate.apply(protocol, args);
		};
	}
	tabs.update = async (tabId, update) => {
		order.push(actionLabel);
		return { id: tabId, active: true, windowId: 1, ...(update ?? {}) };
	};
	try {
		await router.handleBrowserPilotBridgeWsMessage({ id: "begin-native-marker", tabId: 7, code: { cmd: "operation.begin", operationId: "native-marker", tabId: 7, generation: 3 } }, socket);
		order.length = 0;
		actionLabel = "native-action";
		await router.handleBrowserPilotBridgeWsMessage({ id: "native-action", operationId: "native-marker", operationGeneration: 3, tabId: 7, code: { cmd: "tabs", method: "switch", tabId: 7 } }, socket);
		assert.deepEqual(order, ["validation", "dispatch", "ack", "native-action"]);
		const nativeDispatches = () => parseSocketMessages(socket).filter((message) => message.type === "operation_event"
			&& (message.event as Record<string, unknown> | undefined)?.type === "dispatch"
			&& String(((message.event as Record<string, unknown>).data as Record<string, unknown>).fenceId).includes("native-marker"));
		assert.equal(nativeDispatches().length, 1);
		const repeated = await operationCoordinator.markBrowserPilotOperationDispatch("native-marker", { tabId: 7, operationGeneration: 3, socket });
		assert.equal(repeated.ok, true);
		assert.equal(nativeDispatches().length, 1);
		assert.equal((repeated.data as Record<string, unknown>).sourceSequence, (nativeDispatches()[0]!.event as Record<string, unknown>).sequence);

		await router.handleBrowserPilotBridgeWsMessage({ id: "begin-js-marker", tabId: 7, code: { cmd: "operation.begin", operationId: "js-marker", tabId: 7, generation: 3 } }, socket);
		order.length = 0;
		actionLabel = "js-action";
		await router.handleBrowserPilotBridgeWsMessage({ id: "js-action", operationId: "js-marker", operationGeneration: 3, tabId: 7, code: "location.href = '/next'" }, socket);
		assert.deepEqual(order, ["dispatch", "ack", "js-action"]);
		const dispatchEvent = [...parseSocketMessages(socket)].reverse().find((message) => message.type === "operation_event"
			&& (message.event as Record<string, unknown> | undefined)?.type === "dispatch");
		assert.deepEqual(Object.keys(((dispatchEvent?.event as Record<string, unknown>).data as Record<string, unknown>)).sort(), [
			"checkedAt", "deliveryFailures", "deliveryReliable", "fenceId", "mutationObserverFound", "reliable",
		]);
	} finally {
		tabs.update = originalUpdate;
		if (protocol && originalValidate) protocol.validateCommand = originalValidate;
		await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.cancel", operationId: "native-marker" }, sender());
		await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.cancel", operationId: "js-marker" }, sender());
	}
});

test("strict dispatch marker rejects unreliable, invalidated, closed, mismatched, and wrong-owner actions before ACK", async () => {
	const tabs = chromeStub.tabs as unknown as {
		update(tabId: number, update?: Record<string, unknown>): Promise<unknown>;
		sendMessage(tabId: number, message: unknown, options?: Record<string, unknown>): Promise<unknown>;
	};
	const originalUpdate = tabs.update;
	const originalSendMessage = tabs.sendMessage;
	let actions = 0;
	let forceMarkerFailure = false;
	tabs.sendMessage = async (tabId, message, options) => {
		const record = message && typeof message === "object" && !Array.isArray(message) ? message as Record<string, unknown> : {};
		if (forceMarkerFailure && record.cmd === "browserPilot.operation.checkpoint" && record.eventType === "dispatch") {
			return { mutationCount: 0, batchCount: 0, observerFound: false, deliveryFailures: 1, deliveryReliable: false };
		}
		return await originalSendMessage(tabId, message, options);
	};
	tabs.update = async (tabId, update) => {
		actions += 1;
		return { id: tabId, ...(update ?? {}) };
	};
	const operationIds: string[] = [];
	const arm = async (operationId: string, socket: { readyState: number; sent: string[]; send(payload: string): void }) => {
		operationIds.push(operationId);
		await router.handleBrowserPilotBridgeWsMessage({ id: `begin-${operationId}`, tabId: 7, code: { cmd: "operation.begin", operationId, tabId: 7, generation: 3 } }, socket);
		socket.sent.length = 0;
	};
	const assertRejected = async (input: {
		label: string;
		operationId: string;
		armedSocket: { readyState: number; sent: string[]; send(payload: string): void };
		actionSocket?: { readyState: number; sent: string[]; send(payload: string): void };
		tabId?: number;
		generation?: number;
	}) => {
		const actionSocket = input.actionSocket ?? input.armedSocket;
		const beforeActions = actions;
		await router.handleBrowserPilotBridgeWsMessage({
			id: input.label,
			operationId: input.operationId,
			operationGeneration: input.generation ?? 3,
			tabId: input.tabId ?? 7,
			code: { cmd: "tabs", method: "switch", tabId: input.tabId ?? 7 },
		}, actionSocket);
		const messages = parseSocketMessages(actionSocket);
		assert.equal(messages.some((message) => message.type === "ack" && message.id === input.label), false);
		const failure = messages.find((message) => message.type === "error" && message.id === input.label);
		assert.ok(failure);
		const result = failure.result as Record<string, unknown>;
		const details = result.details as Record<string, unknown>;
		assert.equal(details.dispatchStarted, false);
		assert.equal(details.acked, false);
		assert.equal(actions, beforeActions);
	};
	try {
		const unreliableSocket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
		await arm("marker-unreliable", unreliableSocket);
		forceMarkerFailure = true;
		await assertRejected({ label: "marker-failed", operationId: "marker-unreliable", armedSocket: unreliableSocket });
		forceMarkerFailure = false;

		const closedSocket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
		await arm("marker-closed", closedSocket);
		closedSocket.readyState = 0;
		await assertRejected({ label: "closed-owner", operationId: "marker-closed", armedSocket: closedSocket });

		const tabSocket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
		await arm("marker-tab", tabSocket);
		await assertRejected({ label: "tab-mismatch", operationId: "marker-tab", armedSocket: tabSocket, tabId: 8 });

		const generationSocket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
		await arm("marker-generation", generationSocket);
		await assertRejected({ label: "generation-mismatch", operationId: "marker-generation", armedSocket: generationSocket, generation: 4 });

		const ownerSocket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
		const wrongSocket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
		await arm("marker-owner", ownerSocket);
		await assertRejected({ label: "wrong-socket", operationId: "marker-owner", armedSocket: ownerSocket, actionSocket: wrongSocket });

		const replacementSocket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
		await arm("marker-replaced", replacementSocket);
		const replacementListener = tabReplacedListeners.at(-1);
		assert.ok(replacementListener);
		replacementListener(8, 7);
		await assertRejected({ label: "target-replaced", operationId: "marker-replaced", armedSocket: replacementSocket });

		tabSync.setBrowserPilotTabSyncTransport({ getSocket: () => null, getSockets: () => [], probe() {} });
		router.installBrowserPilotBridgeRouter();
		const prerenderSocket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
		await arm("marker-prerender", prerenderSocket);
		const runtimeListener = runtimeMessageListeners.at(-1);
		assert.ok(runtimeListener);
		let prerenderResponse: unknown;
		runtimeListener({ type: "browser-pilot-prerender-activated" }, sender(), (response) => { prerenderResponse = response; });
		assert.deepEqual(prerenderResponse, { ok: true, tabId: 7 });
		await assertRejected({ label: "target-prerendered", operationId: "marker-prerender", armedSocket: prerenderSocket });
	} finally {
		tabs.update = originalUpdate;
		tabs.sendMessage = originalSendMessage;
		for (const operationId of operationIds) await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.cancel", operationId }, sender());
	}
});

test("operation events never fail over from a closed armed socket to another extension socket", () => {
	const fallback = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
	const closed = { readyState: 0, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
	operationTransport.setBrowserPilotOperationEventSocketGetter(() => fallback);
	operationTransport.bindBrowserPilotOperationEventSocket("operation-closed-owner", closed);
	try {
		operationTransport.emitBrowserPilotOperationEvent("operation-closed-owner", { type: "mutation" });
		assert.equal(closed.sent.length, 0);
		assert.equal(fallback.sent.length, 0);
	} finally {
		operationTransport.releaseBrowserPilotOperationEventSocket("operation-closed-owner");
	}
});

test("extension runtime helpers redact and normalize malformed error responses", () => {
	const circular: Record<string, unknown> = { token: "fixture-secret" };
	circular.self = circular;

	assert.deepEqual(runtimeSupport.bridgeError(undefined, "fixture-secret", { password: "fixture-password", circular }), {
		ok: false,
		error_code: "INTERNAL_ERROR",
		error: "[REDACTED]",
		details: {
			password: "[REDACTED]",
			circular: { token: "[REDACTED]", self: "[REDACTED_CYCLE]" },
		},
	});

	assert.deepEqual(runtimeSupport.normalizeBridgeResponse({ ok: false, error: { code: "NO_SESSION", message: "missing session", details: { tabId: 7 } } }, "hook.read"), {
		ok: false,
		error_code: "NO_SESSION",
		error: "missing session",
		details: { tabId: 7, cmd: "hook.read" },
	});

	assert.deepEqual(runtimeSupport.normalizePersistentBrowserPilotResponse({ ok: false, error: { code: "CDP_TIMEOUT", message: "wait expired", details: { timeoutMs: 5 } } }), {
		ok: false,
		error_code: "CDP_TIMEOUT",
		error: "wait expired",
		details: { timeoutMs: 5 },
	});
});

test("extension runtime state owner serializes tab queues and reports previous-boot state", async () => {
	stateStore.browserPilotTabQueues.clear();
	let releaseFirst!: () => void;
	let markStarted!: () => void;
	const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
	const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const order: string[] = [];
	const first = stateStore.enqueueBrowserPilotCommand(7, "first", async () => {
		order.push("first:start");
		markStarted();
		await firstReleased;
		order.push("first:end");
		return { ok: true };
	});
	const second = stateStore.enqueueBrowserPilotCommand(7, "second", async () => {
		order.push("second");
		return { ok: true };
	});
	await firstStarted;
	assert.deepEqual(stateStore.getBrowserPilotQueueStats(7), { pending: true, depth: 2, last_cmd: "second" });
	releaseFirst();
	await Promise.all([first, second]);
	assert.deepEqual(order, ["first:start", "first:end", "second"]);
	assert.deepEqual(stateStore.getBrowserPilotQueueStats(7), { pending: false, depth: 0, last_cmd: null });

	delete sessionStorage.browserPilotRuntimeStateV2;
	await stateStore.persist("ws", "7:lost", { url: "wss://example.test/socket" }, { tabId: 7, sessionId: "lost", recoveryPolicy: "diagnosticOnly" });
	const persisted = sessionStorage.browserPilotRuntimeStateV2 as Record<string, { workerBootId: string }>;
	persisted["ws:7:lost"]!.workerBootId = "previous-worker";
	const lost = await stateStore.findLostRuntimeSession("ws", 7, "lost");
	assert.deepEqual(stateStore.summarizeLostRuntimeSession(lost), {
		stateLost: true,
		previousWorkerBootId: "previous-worker",
		updatedAt: lost?.updatedAt,
		kind: "ws",
		tabId: 7,
		sessionId: "lost",
		details: { url: "wss://example.test/socket" },
	});
	await stateStore.forget("ws", "7:lost");
});

test("hook/session cleanup preserves page identity while actual tab removal forgets it", async () => {
	pageIdentity.resetBrowserPilotPageIdentitiesForTest();
	const initial = pageIdentity.ensureBrowserPilotPageIdentity(77, "https://example.test/");
	tabSync.cleanupBrowserPilotTab(77, "hook_uninstall");
	await new Promise((resolve) => setTimeout(resolve, 20));
	const retained = pageIdentity.ensureBrowserPilotPageIdentity(77, "https://example.test/spa");
	assert.equal(retained?.pageEpoch, initial?.pageEpoch);
	pageIdentity.forgetBrowserPilotPageIdentity(77);
	const replaced = pageIdentity.ensureBrowserPilotPageIdentity(77, "https://example.test/");
	assert.notEqual(replaced?.pageEpoch, initial?.pageEpoch);
	resetCdpFixtures();
});

test("extension tab identity persists and transfers across tab replacement", async () => {
	delete sessionStorage.browserPilotTabIdentitiesV1;
	tabIdentity.resetBrowserPilotTabIdentitiesForTest();
	const original = await tabIdentity.ensureBrowserPilotTabIdentity(77);
	assert.equal(await tabIdentity.ensureBrowserPilotTabIdentity(77), original);
	await tabIdentity.replaceBrowserPilotTabIdentity(77, 88);
	assert.equal(await tabIdentity.ensureBrowserPilotTabIdentity(88), original);
	const recycled = await tabIdentity.ensureBrowserPilotTabIdentity(77);
	assert.notEqual(recycled, original);
	await tabIdentity.forgetBrowserPilotTabIdentity(88);
	assert.notEqual(await tabIdentity.ensureBrowserPilotTabIdentity(88), original);
});

test("persistent CDP evaluates one-off scripts directly, then compiles hot scripts and falls back from stale cache entries", async () => {
	resetCdpFixtures();
	const options = { name: "compiled", persistent: true, precompile: true };
	const first = await cdpCommands.browserPilotPersistentCdpBridge.send(71, "Runtime.evaluate", { expression: "21 * 2", returnByValue: true }, options);
	const second = await cdpCommands.browserPilotPersistentCdpBridge.send(71, "Runtime.evaluate", { expression: "21 * 2", returnByValue: true }, options);

	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.deepEqual(debuggerAttachments, [71]);
	assert.deepEqual(debuggerCommands.map((call) => call.method), ["Runtime.evaluate", "Runtime.compileScript", "Runtime.runScript"]);
	assert.equal(debuggerCommands.filter((call) => call.method === "Runtime.compileScript").length, 1);
	assert.equal((first.data as Record<string, unknown>).precompiled, undefined);
	assert.equal((second.data as Record<string, unknown>).precompiled, true);

	failRunScriptOnce = true;
	const stale = await cdpCommands.browserPilotPersistentCdpBridge.send(71, "Runtime.evaluate", { expression: "21 * 2", returnByValue: true }, options);
	assert.equal(stale.ok, true);
	assert.deepEqual(debuggerCommands.slice(-2).map((call) => call.method), ["Runtime.runScript", "Runtime.evaluate"]);
	assert.equal((stale.data as Record<string, unknown>).precompiled, undefined);
});

test("persistent CDP coalesces concurrent compilation after a script becomes hot", async () => {
	resetCdpFixtures();
	const options = { name: "compile-race", persistent: true, precompile: true };
	await cdpCommands.browserPilotPersistentCdpBridge.send(70, "Runtime.evaluate", { expression: "40 + 2", returnByValue: true }, options);
	debuggerCommands.length = 0;

	const results = await Promise.all(Array.from({ length: 3 }, () => cdpCommands.browserPilotPersistentCdpBridge.send(70, "Runtime.evaluate", { expression: "40 + 2", returnByValue: true }, options)));

	assert.equal(results.every((result) => result.ok), true);
	assert.equal(debuggerCommands.filter((call) => call.method === "Runtime.compileScript").length, 1);
	assert.equal(debuggerCommands.filter((call) => call.method === "Runtime.runScript").length, 3);
});

test("persistent CDP coalesces concurrent tab attaches without eager domain round trips", async () => {
	resetCdpFixtures();
	const [first, second] = await Promise.all([
		cdpCommands.browserPilotPersistentCdpBridge.send(76, "Runtime.evaluate", { expression: "1" }, { name: "first", persistent: true }),
		cdpCommands.browserPilotPersistentCdpBridge.send(76, "Runtime.evaluate", { expression: "2" }, { name: "second", persistent: true }),
	]);

	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.deepEqual(debuggerAttachments, [76]);
	assert.deepEqual(debuggerCommands.map((call) => call.method), ["Runtime.evaluate", "Runtime.evaluate"]);
	assert.equal(cdpCommands.browserPilotPersistentCdpBridge.sessions.has("76:first"), true);
	assert.equal(cdpCommands.browserPilotPersistentCdpBridge.sessions.has("76:second"), true);
});

test("operation CDP domain arming runs independent domain round trips concurrently", async () => {
	resetCdpFixtures();
	const concurrency = { active: 0, max: 0 };
	domainEnableConcurrency = concurrency;
	const record = { key: "operation:parallel-domains", waitId: "parallel-domains", kind: "operation", tabId: 81, cdpDomains: new Set<string>(), cdpSubscriptions: [] } as never;
	await waitCdp.enableBrowserPilotCdpDomains(record, ["Page", "Network", "Runtime"]);

	assert.equal(concurrency.max, 3);
	waitCdp.releaseBrowserPilotCdpDomains(record, ["Page", "Network", "Runtime"], "test_cleanup");
	domainEnableConcurrency = undefined;
});

test("persistent CDP coalesces per-session focus setup for concurrent evaluation", async () => {
	resetCdpFixtures();
	const [first, second] = await Promise.all([
		cdpCommands.browserPilotPersistentCdpBridge.send(78, "Runtime.evaluate", { expression: "1" }, { name: "focused", persistent: true, focusEmulation: true }),
		cdpCommands.browserPilotPersistentCdpBridge.send(78, "Runtime.evaluate", { expression: "2" }, { name: "focused", persistent: true, focusEmulation: true }),
	]);

	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal(debuggerCommands.filter((call) => call.method === "Emulation.setFocusEmulationEnabled").length, 1);
	assert.equal(debuggerCommands.filter((call) => call.method === "Runtime.evaluate").length, 2);
});

test("persistent CDP keeps a concurrent temporary attachment until the final command settles", async () => {
	resetCdpFixtures();
	const [first, second] = await Promise.all([
		cdpCommands.browserPilotPersistentCdpBridge.send(79, "Runtime.evaluate", { expression: "1" }, { name: "temporary-a", persistent: false }),
		cdpCommands.browserPilotPersistentCdpBridge.send(79, "Runtime.evaluate", { expression: "2" }, { name: "temporary-b", persistent: false }),
	]);

	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.deepEqual(debuggerAttachments, [79]);
	assert.deepEqual(debuggerDetaches, [79]);
	assert.equal(cdpCommands.browserPilotPersistentCdpBridge.sessions.size, 0);
});

test("persistent CDP enables Page lazily once for repeated frame-tree reads", async () => {
	resetCdpFixtures();
	const first = await cdpCommands.browserPilotPersistentCdpBridge.frameTree(77, { name: "frames", persistent: true });
	const second = await cdpCommands.browserPilotPersistentCdpBridge.frameTree(77, { name: "frames", persistent: true });

	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.deepEqual(debuggerAttachments, [77]);
	assert.deepEqual(debuggerCommands.map((call) => call.method), ["Page.enable", "Page.getFrameTree", "Page.getFrameTree"]);
});

test("persistent CDP re-enables a required domain after an explicit disable", async () => {
	resetCdpFixtures();
	const options = { name: "domain-state", persistent: true };
	await cdpCommands.browserPilotPersistentCdpBridge.send(80, "Page.enable", {}, options);
	await cdpCommands.browserPilotPersistentCdpBridge.send(80, "Page.disable", {}, options);
	const tree = await cdpCommands.browserPilotPersistentCdpBridge.frameTree(80, options);

	assert.equal(tree.ok, true);
	assert.deepEqual(debuggerCommands.map((call) => call.method), ["Page.enable", "Page.disable", "Page.enable", "Page.getFrameTree"]);
});

test("persistent CDP send retries detached sessions and releases temporary attachments", async () => {
	resetCdpFixtures();
	failNotAttachedOnce = true;
	const retried = await cdpCommands.browserPilotPersistentCdpBridge.send(72, "Network.enable", {}, { name: "retry", persistent: true });

	assert.equal(retried.ok, true);
	assert.deepEqual(debuggerAttachments, [72, 72]);
	assert.equal(debuggerCommands.filter((call) => call.method === "Network.enable").length, 2);
	assert.equal(cdpCommands.browserPilotPersistentCdpBridge.sessions.size, 1);

	resetCdpFixtures();
	const temporary = await cdpCommands.browserPilotPersistentCdpBridge.send(73, "Network.enable", {}, { name: "temporary", persistent: false });
	assert.equal(temporary.ok, true);
	assert.deepEqual(debuggerAttachments, [73]);
	assert.deepEqual(debuggerDetaches, [73]);
	assert.equal(cdpCommands.browserPilotPersistentCdpBridge.sessions.size, 0);
});

test("persistent CDP aliases the default logical session when a named tab debugger is already attached", async () => {
	resetCdpFixtures();
	const recorder = await cdpCommands.browserPilotPersistentCdpBridge.send(75, "Network.enable", {}, { name: "network-recorder", persistent: true });
	assert.equal(recorder.ok, true);
	failAlreadyAttachedOnce = true;
	const reload = await cdpCommands.browserPilotPersistentCdpBridge.send(75, "Page.reload", {}, { name: "default", persistent: true });
	assert.equal(reload.ok, true);
	assert.equal(cdpCommands.browserPilotPersistentCdpBridge.sessions.has("75:network-recorder"), true);
	assert.equal(cdpCommands.browserPilotPersistentCdpBridge.sessions.has("75:default"), true);
	assert.equal(debuggerCommands.some((call) => call.method === "Page.reload"), true);
});

test("persistent CDP send preserves explicit child-session routing", async () => {
	resetCdpFixtures();
	const result = await cdpCommands.browserPilotPersistentCdpBridge.send(74, "Runtime.evaluate", { expression: "42" }, { name: "child", persistent: true, sessionId: "child-session-1" });

	assert.equal(result.ok, true);
	const evaluate = [...debuggerCommands].reverse().find((call) => call.method === "Runtime.evaluate");
	assert.deepEqual(evaluate?.debuggee, { tabId: 74, sessionId: "child-session-1" });
	assert.deepEqual((result.data as { cdpRoute?: unknown }).cdpRoute, {
		targetScoped: true,
		attachRouteUsed: false,
		sessionId: "child-session-1",
	});
});

test("frame command dispatch normalizes list, evaluate, and new-document script operations", async () => {
	const globalCdp = globalThis as typeof globalThis & { BrowserPilotPersistentCdp?: unknown; browserPilotPersistentCdpBridge?: unknown };
	const previousPrimary = globalCdp.BrowserPilotPersistentCdp;
	const previousBridge = globalCdp.browserPilotPersistentCdpBridge;
	const calls: Array<{ operation: string; args: unknown[] }> = [];
	const bridge = {
		async frameTree(...args: unknown[]) {
			calls.push({ operation: "frameTree", args });
			return { ok: true, data: { frameTree: { frameId: "main" }, frames: [{ frameId: "main" }, { frameId: "child" }] } };
		},
		async evaluateInFrame(...args: unknown[]) {
			calls.push({ operation: "evaluateInFrame", args });
			return { ok: true, data: { result: 42 } };
		},
		async addNewDocumentScript(...args: unknown[]) {
			calls.push({ operation: "addNewDocumentScript", args });
			return { ok: true, data: { identifier: "script-1" } };
		},
		async removeNewDocumentScript(...args: unknown[]) {
			calls.push({ operation: "removeNewDocumentScript", args });
			return { ok: true, data: { removed: true } };
		},
	};
	globalCdp.BrowserPilotPersistentCdp = bridge;
	globalCdp.browserPilotPersistentCdpBridge = bridge;
	try {
		const listed = await frameCommands.handleBrowserPilotFrameCommand("frame.list", 7, { cmd: "frame.list", options: { name: "frames" } });
		const evaluated = await frameCommands.handleBrowserPilotFrameCommand("frame.evaluate", 7, { cmd: "frame.evaluate", frameId: "child", expression: "21 * 2", awaitPromise: false, returnByValue: false, userGesture: true, worldName: "isolated" });
		const added = await frameCommands.handleBrowserPilotFrameCommand("frame.addNewDocumentScript", 7, { cmd: "frame.addNewDocumentScript", source: "globalThis.ready = true", runImmediately: true, includeCommandLineAPI: true, timeout_ms: 500 });
		const removed = await frameCommands.handleBrowserPilotFrameCommand("frame.removeNewDocumentScript", 7, { cmd: "frame.removeNewDocumentScript", identifier: "script-1", timeoutMs: 600 });

		assert.deepEqual(listed, { ok: true, data: { tabId: 7, frameTree: { frameId: "main" }, frames: [{ frameId: "main" }, { frameId: "child" }], count: 2 } });
		assert.deepEqual(evaluated, { ok: true, data: { tabId: 7, frameId: "child", result: 42 } });
		assert.deepEqual(added, { ok: true, data: { tabId: 7, identifier: "script-1" } });
		assert.deepEqual(removed, { ok: true, data: { tabId: 7, removed: true } });
		assert.deepEqual(calls.map((call) => call.operation), ["frameTree", "evaluateInFrame", "addNewDocumentScript", "removeNewDocumentScript"]);
		assert.deepEqual(calls[1]?.args[2], { frameId: "child", awaitPromise: false, returnByValue: false, userGesture: true, worldName: "isolated" });
		assert.deepEqual(calls[2]?.args[2], { persistent: true, name: "new_document", runImmediately: true, includeCommandLineAPI: true, timeoutMs: 500 });
		assert.deepEqual(calls[3]?.args[2], { persistent: true, name: "new_document", timeoutMs: 600 });
		assert.equal((await frameCommands.handleBrowserPilotFrameCommand("frame.evaluate", 7, { cmd: "frame.evaluate" })).error_code, "INVALID_RULE");
		assert.equal((await frameCommands.handleBrowserPilotFrameCommand("frame.unknown", 7, { cmd: "frame.unknown" })).error_code, "INVALID_RULE");
	} finally {
		globalCdp.BrowserPilotPersistentCdp = previousPrimary;
		globalCdp.browserPilotPersistentCdpBridge = previousBridge;
	}
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
	assert.equal(success.acknowledged, true);
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

	const duringDelay = new AbortController();
	let delayedDispatches = 0;
	const delayed = executeProgram([{ text: "must not dispatch", delay: 5_000 }], createProgramContext({
		async executeJavaScript() {
			return { id: "url", acknowledged: true, data: "https://example.test/" };
		},
		async sendCommand() {
			delayedDispatches += 1;
			return { id: "input", acknowledged: true, data: {} };
		},
	}, duringDelay.signal));
	setTimeout(() => duringDelay.abort(), 10);
	const delayedResult = await delayed;
	assert.deepEqual(delayedResult.aborted, { reason: "timeout", atStep: 0 });
	assert.equal(delayedDispatches, 0);

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

test("physical program carries frame acknowledgement and explicit final verification", async () => {
	const server = {
		async executeJavaScript(script: string) {
			const data = script === "location.href" ? "https://example.test/" : { verified: true, liked: true };
			return { id: "exec", acknowledged: true, data } as BrowserBridgeExecutionResult;
		},
		async sendCommand() {
			return { id: "input", acknowledged: true, data: { sent: [{ type: "mousePressed" }] } } as BrowserBridgeExecutionResult;
		},
	};
	const result = await executeProgram([
		{ mouse: "press", x: 10, y: 10 },
		{ mouse: "release", x: 10, y: 10 },
		{ eval: "({verified:true,liked:true})", verify: true },
	], createProgramContext(server));
	assert.equal(result.acknowledged, true);
	assert.equal(result.frames.filter((frame) => frame.kind.startsWith("mouse:")).every((frame) => frame.acknowledged === true), true);
	assert.deepEqual(result.verification, { step: 2, passed: true, result: { verified: true, liked: true } });
});

test("physical program retains acknowledgement when the transport loses the frame result", async () => {
	const result = await executeProgram([{ text: "one comment" }], createProgramContext({
		async executeJavaScript() {
			return { id: "url", acknowledged: true, data: "https://example.test/" } as BrowserBridgeExecutionResult;
		},
		async sendCommand() {
			throw Object.assign(new Error("result lost after acknowledgement"), { details: { acked: true, outcome: "inflight-unknown" } });
		},
	}));
	assert.equal(result.acknowledged, true);
	assert.equal(result.frames[0]?.ok, false);
	assert.equal(result.frames[0]?.acknowledged, true);
	assert.deepEqual(result.aborted, { reason: "result lost after acknowledgement", atStep: 0 });
});

test("expanded programs enforce final verifier ordering before trusted input dispatch", async () => {
	let inputDispatches = 0;
	const result = await executeProgram([{ eval: "dynamic frames", expand: true }], createProgramContext({
		async executeJavaScript(script: string) {
			return {
				id: "expand",
				acknowledged: true,
				data: script === "location.href"
					? "https://example.test/"
					: [{ eval: "({verified:true})", verify: true }, { text: "must not dispatch" }],
			} as BrowserBridgeExecutionResult;
		},
		async sendCommand() {
			inputDispatches += 1;
			return { id: "input", acknowledged: true, data: { sent: [{ type: "input" }] } } as BrowserBridgeExecutionResult;
		},
	}));
	assert.equal(inputDispatches, 0);
	assert.match(String(result.aborted?.reason), /verification frame must be the final program frame/);
});

test("operation checkpoints use the persistent top-frame content delivery chain", async () => {
	const operationId = "operation-checkpoint";
	const socket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
	const tabs = chromeStub.tabs as unknown as { sendMessage(tabId: number, message: unknown, options?: Record<string, unknown>): Promise<unknown> };
	const originalSendMessage = tabs.sendMessage;
	const deliveries: Array<{ tabId: number; message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
	tabs.sendMessage = async (tabId, message, options) => {
		deliveries.push({ tabId, message: message as Record<string, unknown>, options });
		return await originalSendMessage(tabId, message, options);
	};
	try {
		const begin = await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.begin", operationId, tabId: 7 }, sender());
		assert.equal(begin.ok, true);
		assert.equal((begin.data as Record<string, unknown>).mutationObserverArmed, true);
		operationTransport.bindBrowserPilotOperationEventSocket(operationId, socket);

		const checkpoint = await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.checkpoint", operationId, fenceId: "fence-1" }, sender());
		assert.equal(checkpoint.ok, true);
		const data = checkpoint.data as Record<string, unknown>;
		assert.equal(data.operationId, operationId);
		assert.equal(data.fenceId, "fence-1");
		assert.equal(data.sourceSequence, 1);
		assert.equal(typeof data.checkedAt, "number");
		assert.equal(data.deliveryFailures, 0);
		assert.equal(data.deliveryReliable, true);
		assert.deepEqual(deliveries.slice(0, 2).map((item) => item.message.cmd), ["browserPilot.operation.begin", "browserPilot.operation.checkpoint"]);
		assert.equal(deliveries.slice(0, 2).every((item) => item.tabId === 7 && item.options?.frameId === 0), true);

		const events = parseSocketMessages(socket).map((message) => message.event as Record<string, unknown>);
		assert.deepEqual(events.map((event) => event.type), ["checkpoint"]);
		assert.deepEqual(events[0]?.data, { fenceId: "fence-1", checkedAt: data.checkedAt, mutationObserverFound: true, deliveryFailures: 0, deliveryReliable: true, reliable: true });
		assert.equal(events[0]?.sequence, data.sourceSequence);
		assert.equal(events[0]?.progress, false);
	} finally {
		await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.cancel", operationId }, sender());
		tabs.sendMessage = originalSendMessage;
	}
});

test("targetless control-plane operations do not require a page content observer", async () => {
	const operationId = "operation-targetless-control";
	const tabs = chromeStub.tabs as unknown as { sendMessage(tabId: number, message: unknown, options?: Record<string, unknown>): Promise<unknown> };
	const originalSendMessage = tabs.sendMessage;
	let contentMessages = 0;
	tabs.sendMessage = async (tabId, message, options) => {
		contentMessages += 1;
		return await originalSendMessage(tabId, message, options);
	};
	try {
		const begin = await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.begin", operationId }, sender());
		assert.equal(begin.ok, true);
		assert.equal((begin.data as Record<string, unknown>).mutationObserverArmed, false);
		assert.equal(contentMessages, 0);
	} finally {
		await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.cancel", operationId }, sender());
		tabs.sendMessage = originalSendMessage;
	}
});

test("active operation watchdog cleans coordinator state when terminal lifecycle commands are lost", async () => {
	const operationId = "operation-active-watchdog";
	const tabs = chromeStub.tabs as unknown as { sendMessage(tabId: number, message: unknown, options?: Record<string, unknown>): Promise<unknown> };
	const originalSendMessage = tabs.sendMessage;
	const deliveries: Array<Record<string, unknown>> = [];
	tabs.sendMessage = async (tabId, message, options) => {
		deliveries.push(message as Record<string, unknown>);
		return await originalSendMessage(tabId, message, options);
	};
	try {
		const begin = await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.begin", operationId, tabId: 7, activeTtlMs: 30 }, sender());
		assert.equal(begin.ok, true);
		assert.equal(tabUpdatedListeners.length > 0, true);
		const deadlineAt = Date.now() + 1_000;
		while (tabUpdatedListeners.length > 0 && Date.now() < deadlineAt) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(tabUpdatedListeners.length, 0);
		const checkpoint = await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.checkpoint", operationId }, sender());
		assert.equal(checkpoint.ok, false);
		assert.match(String(checkpoint.error), /not found/);
		const install = deliveries.find((item) => item.cmd === "browserPilot.operation.begin");
		assert.equal(Number(install?.ttlMs) > 30, true);
		assert.equal(deliveries.some((item) => item.cmd === "browserPilot.operation.remove"), true);
	} finally {
		await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.cancel", operationId }, sender());
		tabs.sendMessage = originalSendMessage;
	}
});

test("operation finish replaces the active watchdog with the passive late-effect window", async () => {
	const operationId = "operation-watchdog-passive";
	const socket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
	try {
		const begin = await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.begin", operationId, tabId: 7, activeTtlMs: 25 }, sender());
		assert.equal(begin.ok, true);
		operationTransport.bindBrowserPilotOperationEventSocket(operationId, socket);
		const finish = await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.finish", operationId }, sender());
		assert.equal(finish.ok, true);
		await new Promise((resolve) => setTimeout(resolve, 40));
		tabUpdatedListeners.at(-1)?.(7, { status: "complete" }, { id: 7, url: "https://example.test/passive" });
		assert.equal(parseSocketMessages(socket).some((message) => (message.event as Record<string, unknown> | undefined)?.type === "navigation"), true);
	} finally {
		await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.cancel", operationId }, sender());
	}
});

test("parallel target operations do not share download ownership and new tabs follow their opener", async () => {
	const firstOperationId = "operation-parallel-first";
	const secondOperationId = "operation-parallel-second";
	const firstSocket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
	const secondSocket = { readyState: 1, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
	try {
		assert.equal((await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.begin", operationId: firstOperationId, tabId: 7 }, sender(7))).ok, true);
		assert.equal((await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.begin", operationId: secondOperationId, tabId: 8 }, sender(8))).ok, true);
		operationTransport.bindBrowserPilotOperationEventSocket(firstOperationId, firstSocket);
		operationTransport.bindBrowserPilotOperationEventSocket(secondOperationId, secondSocket);

		downloadCreatedListeners.at(-1)?.({ id: 91, url: "https://example.test/ambiguous.bin", state: "in_progress" });
		downloadChangedListeners.at(-1)?.({ id: 91, state: { current: "complete" } });
		assert.equal(firstSocket.sent.length, 0);
		assert.equal(secondSocket.sent.length, 0);

		tabCreatedListeners.at(-1)?.({ id: 9, openerTabId: 7, url: "https://example.test/child" });
		assert.deepEqual(parseSocketMessages(firstSocket).map((message) => (message.event as Record<string, unknown>).type), ["new_tab"]);
		assert.equal(secondSocket.sent.length, 0);

		assert.equal((await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.cancel", operationId: secondOperationId }, sender(8))).ok, true);
		downloadCreatedListeners.at(-1)?.({ id: 92, url: "https://example.test/owned.bin", state: "in_progress" });
		downloadChangedListeners.at(-1)?.({ id: 92, state: { current: "complete" } });
		downloadChangedListeners.at(-1)?.({ id: 91, state: { current: "complete" } });
		assert.deepEqual(parseSocketMessages(firstSocket).map((message) => (message.event as Record<string, unknown>).type), ["new_tab", "download_started", "download_completed"]);
		assert.equal(secondSocket.sent.length, 0);
	} finally {
		await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.cancel", operationId: firstOperationId }, sender(7));
		await coreCommands.dispatchBrowserPilotBridgeCommand({ cmd: "operation.cancel", operationId: secondOperationId }, sender(8));
	}
});
