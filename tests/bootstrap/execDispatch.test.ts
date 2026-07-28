import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserPilotChromeTab } from "../../src/bridge/extension/service_worker/types.ts";

type CreatedListener = (tab: BrowserPilotChromeTab) => void;

const createdListeners = new Set<CreatedListener>();
const updateCalls: Array<{ tabId: number; update: Record<string, unknown> }> = [];
const createCalls: Array<Record<string, unknown>> = [];
const cdpCalls: Array<{ method: string; params: Record<string, unknown>; options?: Record<string, unknown> }> = [];
let executeCalls = 0;
let backgroundTab = false;
let executeResult: unknown = [{ result: { ok: true, data: "main-result" } }];

const chromeStub = {
	tabs: {
		onCreated: {
			addListener(listener: CreatedListener) { createdListeners.add(listener); },
			removeListener(listener: CreatedListener) { createdListeners.delete(listener); },
		},
		async update(tabId: number, update: Record<string, unknown>) {
			updateCalls.push({ tabId, update });
			return { id: tabId, ...update };
		},
		async create(input: Record<string, unknown>) {
			createCalls.push(input);
			return { id: 8, url: input.url, title: "Opened" };
		},
		async get(tabId: number) {
			if (tabId === 9) return { id: 9, url: "https://new.example/", title: "New tab", active: true };
			return { id: tabId, url: "https://example.test/", title: "Example", active: !backgroundTab };
		},
	},
	scripting: {
		async executeScript() {
			executeCalls += 1;
			for (const listener of createdListeners) listener({ id: 9, url: "https://new.example/", title: "New tab" });
			return executeResult;
		},
	},
	alarms: {
		onAlarm: { addListener() {} },
		create() {},
		async clear() { return true; },
	},
	debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} } },
};

Object.assign(globalThis, { chrome: chromeStub, self: globalThis });

const { handleWsExec } = await import("../../src/bridge/extension/service_worker/exec.ts");

const cdpBridge = {
	async send(_tabId: number, method: string, params: Record<string, unknown>, options?: Record<string, unknown>) {
		cdpCalls.push({ method, params, options });
		if (method === "Runtime.evaluate") return { ok: true, data: { result: { result: { value: { ok: true, data: "cdp-result" } } } } };
		return { ok: true, data: { result: {} } };
	},
};
Object.assign(globalThis, { browserPilotPersistentCdpBridge: cdpBridge, BrowserPilotPersistentCdp: cdpBridge });

function resetState(): void {
	createdListeners.clear();
	updateCalls.length = 0;
	createCalls.length = 0;
	cdpCalls.length = 0;
	executeCalls = 0;
	backgroundTab = false;
	executeResult = [{ result: { ok: true, data: "main-result" } }];
}

function socket() {
	return {
		readyState: 1,
		sent: [] as string[],
		send(payload: string) { this.sent.push(payload); },
	};
}

function messages(value: ReturnType<typeof socket>): Array<Record<string, unknown>> {
	return value.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

test("exec dispatch rejects missing tabs before ACK and handles navigation shortcuts", async () => {
	resetState();
	const missing = socket();
	await handleWsExec({ id: "missing", code: "1 + 1" }, missing);
	assert.deepEqual(messages(missing), [{
		type: "error",
		id: "missing",
		error: {
			name: "InvalidRule",
			code: "INVALID_RULE",
			message: "No tabId provided",
			details: { dispatchStarted: false, acked: false },
		},
	}]);

	const navigate = socket();
	await handleWsExec({ id: "navigate", tabId: 7, code: "location.href = '/next'" }, navigate);
	assert.deepEqual(updateCalls, [{ tabId: 7, update: { url: "/next" } }]);
	assert.deepEqual(messages(navigate).at(-1), { type: "result", id: "navigate", result: { navigated: true, url: "/next" } });

	const blocked = socket();
	await handleWsExec({ id: "blocked", tabId: 7, code: "location = 'javascript:alert(1)'" }, blocked);
	assert.match(String((messages(blocked).at(-1)?.error as Record<string, unknown>).message), /Blocked navigation protocol/);
	assert.equal(executeCalls, 0);
});

test("exec dispatch handles GM_openInTab without entering the script executor", async () => {
	resetState();
	const value = socket();
	await handleWsExec({ id: "open", tabId: 7, code: "GM_openInTab('https://opened.example/')" }, value);
	assert.deepEqual(createCalls, [{ url: "https://opened.example/", active: true }]);
	assert.deepEqual(messages(value).at(-1), {
		type: "result",
		id: "open",
		result: { opened: true, tabId: 8, url: "https://opened.example/" },
		newTabs: [{ id: 8, tabId: 8, url: "https://opened.example/", title: "Opened" }],
	});
	assert.equal(executeCalls, 0);
});

test("exec dispatch returns MAIN-world results and collected new-tab metadata", async () => {
	resetState();
	const value = socket();
	await handleWsExec({ id: "main", tabId: 7, code: "window.open('https://new.example/'); 21 * 2", timeoutMs: 3_000 }, value);
	const result = messages(value).at(-1);
	assert.equal(executeCalls, 1);
	assert.equal(result?.type, "result");
	assert.equal(result?.result, "main-result");
	assert.deepEqual(result?.newTabs, [{ id: 9, url: "https://new.example/", title: "New tab" }]);
	assert.deepEqual(result?.diagnostics, { execute: { mayOpenNewTab: true, newTabObservationWaitTriggered: false, newTabObservationWaitMs: 0, totalMs: (result?.diagnostics as { execute: { totalMs: number } }).execute.totalMs } });
	assert.equal(createdListeners.size, 0);
});

test("exec dispatch routes background tabs directly through persistent CDP", async () => {
	resetState();
	backgroundTab = true;
	const value = socket();
	await handleWsExec({ id: "cdp", tabId: 7, code: "await Promise.resolve(42)", timeoutMs: 2_000 }, value);
	const result = messages(value).at(-1);
	assert.equal(executeCalls, 0);
	assert.deepEqual(cdpCalls.map((call) => call.method), ["Runtime.evaluate"]);
	assert.deepEqual(cdpCalls[0]?.options, { name: "default", persistent: true, focusEmulation: true, timeoutMs: 2_000 });
	assert.equal(result?.type, "result");
	assert.equal(result?.result, "cdp-result");
	assert.equal(createdListeners.size, 0);
});

test("exec dispatch never replays a timed-out MAIN-world script through CDP", async () => {
	resetState();
	executeResult = new Promise(() => {});
	const value = socket();
	await handleWsExec({ id: "unknown", tabId: 7, code: "submitPayment()", timeoutMs: 100 }, value);

	assert.equal(executeCalls, 1);
	assert.equal(cdpCalls.length, 0);
	assert.equal(messages(value).at(-1)?.type, "error");
	assert.equal(((messages(value).at(-1)?.error as Record<string, unknown>)?.name), "ExecuteScriptTimeout");

	resetState();
	executeResult = [];
	const unknown = socket();
	await handleWsExec({ id: "empty", tabId: 7, code: "submitPayment()" }, unknown);
	assert.equal(cdpCalls.length, 0);
	assert.match(String(((messages(unknown).at(-1)?.error as Record<string, unknown>)?.message)), /outcome is unknown/);

	resetState();
	executeResult = [{ result: { ok: false, error: { message: "unsafe-eval blocked" }, csp: true } }];
	const csp = socket();
	await handleWsExec({ id: "csp", tabId: 7, code: "21 * 2" }, csp);
	assert.deepEqual(cdpCalls.map((call) => call.method), ["Runtime.evaluate"]);
	assert.equal(messages(csp).at(-1)?.result, "cdp-result");
});
