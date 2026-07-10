import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

type DebuggerEventListener = (source: { tabId?: number }, method: string, params?: Record<string, unknown>) => void;
type CdpCall = { tabId: number; method: string; params: Record<string, unknown>; options: Record<string, unknown> };

const debuggerEventListeners: DebuggerEventListener[] = [];
const chromeStub = {
	runtime: { id: "browser-pilot-wait-selector-test" },
	debugger: {
		onEvent: {
			addListener(listener: DebuggerEventListener) { debuggerEventListeners.push(listener); },
			removeListener(listener: DebuggerEventListener) {
				const index = debuggerEventListeners.indexOf(listener);
				if (index >= 0) debuggerEventListeners.splice(index, 1);
			},
		},
	},
};

Object.assign(globalThis, { chrome: chromeStub, self: globalThis });

const waitSelector = await import("../../src/bridge/extension/service_worker/wait_selector.ts");
const waitCoordinator = await import("../../src/bridge/extension/service_worker/wait_coordinator.ts");
const runtimeGlobal = globalThis as typeof globalThis & { browserPilotPersistentCdpBridge?: { send: (...args: unknown[]) => Promise<unknown> } };

function evalResponse(value: unknown) {
	return { ok: true, data: { result: { result: { value } } } };
}

function installPersistentCdp(evalValues: unknown[], options: { bindingError?: string } = {}): CdpCall[] {
	const calls: CdpCall[] = [];
	let evalIndex = 0;
	runtimeGlobal.browserPilotPersistentCdpBridge = {
		async send(...args: unknown[]) {
			const [tabId, method, rawParams, rawOptions] = args;
			const params = (rawParams || {}) as Record<string, unknown>;
			const callOptions = (rawOptions || {}) as Record<string, unknown>;
			calls.push({ tabId: Number(tabId), method: String(method), params, options: callOptions });
			if (callOptions.name === "eval") {
				const value = evalValues[Math.min(evalIndex, Math.max(0, evalValues.length - 1))];
				evalIndex += 1;
				return evalResponse(value);
			}
			if (callOptions.name === "selector_binding" && options.bindingError) return { ok: false, error: { message: options.bindingError } };
			if (callOptions.name === "selector_binding_install") return evalResponse({ ok: true, mutationTick: 1 });
			return { ok: true, data: {} };
		},
	};
	return calls;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("condition was not reached");
}

afterEach(() => {
	waitCoordinator.cleanupTabWaits(7, "test_cleanup");
	runtimeGlobal.browserPilotPersistentCdpBridge = undefined;
	debuggerEventListeners.length = 0;
});

test("selector wait rejects missing, framed, unsupported, and invalid selectors", async () => {
	assert.equal((await waitSelector.waitForSelector(7, {})).error_code, "INVALID_RULE");
	assert.equal((await waitSelector.waitForSelector(7, { selector: "#target", frameId: "child" })).error_code, "CROSS_ORIGIN_IFRAME");
	assert.equal((await waitSelector.waitForSelector(7, { selector: "#target", state: "shadow" })).error_code, "INVALID_RULE");
	installPersistentCdp([{ ok: false, error: "bad selector" }]);
	const syntax = await waitSelector.waitForSelector(7, { selector: "[", waitId: "syntax-wait" });
	assert.equal(syntax.error_code, "INVALID_RULE");
	assert.equal(waitCoordinator.browserPilotWaits.size, 0);
});

test("selector wait preserves immediate match and immediate timeout projections", async () => {
	installPersistentCdp([{ ok: true }, { matched: true, selector: "#ready" }]);
	const matched = await waitSelector.waitForSelector(7, { selector: "#ready", timeoutMs: 0, waitId: "immediate-match" });
	assert.equal(matched.ok, true);
	assert.equal(((matched.data as Record<string, unknown>).immediate), true);

	installPersistentCdp([{ ok: true }, { matched: false, selector: "#missing" }]);
	const timeout = await waitSelector.waitForSelector(7, { selector: "#missing", timeoutMs: 0, waitId: "immediate-timeout" });
	assert.equal(timeout.error_code, "TIMEOUT");
	assert.equal((timeout.details as Record<string, unknown>).timeout_ms, 0);
	assert.equal(waitCoordinator.browserPilotWaits.size, 0);
});

test("selector wait reacts to Runtime binding events and cleans observer state", async () => {
	const calls = installPersistentCdp([{ ok: true }, { matched: false }, { matched: false }, { matched: true, selector: "#bound" }]);
	const resultPromise = waitSelector.waitForSelector(7, { selector: "#bound", timeoutMs: 500, pollMs: 500, waitId: "binding-wait" });
	await waitUntil(() => debuggerEventListeners.length > 0 && calls.some((call) => call.options.name === "selector_binding"));
	const bindingName = String(calls.find((call) => call.options.name === "selector_binding")?.params.name);
	for (const listener of [...debuggerEventListeners]) listener({ tabId: 7 }, "Runtime.bindingCalled", { name: bindingName, payload: JSON.stringify({ reason: "binding", mutationTick: 2 }) });
	const result = await resultPromise;
	assert.equal(result.ok, true);
	assert.equal(waitCoordinator.browserPilotWaits.size, 0);
	assert.equal(debuggerEventListeners.length, 0);
	const terminal = waitCoordinator.browserPilotWaits.terminal("binding-wait", 7) as { cdpEvents?: unknown[] } | null;
	assert.equal(terminal?.cdpEvents?.some((event) => (event as Record<string, unknown>).kind === "selector_binding"), true);
});

test("selector wait falls back to polling when binding installation fails", async () => {
	installPersistentCdp([{ ok: true }, { matched: false }, { matched: false }, { matched: true, selector: "#polled" }], { bindingError: "binding unavailable" });
	const result = await waitSelector.waitForSelector(7, { selector: "#polled", timeoutMs: 500, pollMs: 10, waitId: "poll-wait" });
	assert.equal(result.ok, true);
	const terminal = waitCoordinator.browserPilotWaits.terminal("poll-wait", 7);
	assert.equal((terminal?.diagnostics as Array<Record<string, unknown>>).some((entry) => entry.warning === "runtime_binding_observer_unavailable_poll_fallback_active"), true);
});

test("selector wait cancellation and timeout both release registered resources", async () => {
	const controller = new AbortController();
	installPersistentCdp([{ ok: true }, { matched: false }], { bindingError: "binding unavailable" });
	controller.abort("cancel fixture");
	const cancelled = await waitSelector.waitForSelector(7, { selector: "#cancel", timeoutMs: 500, pollMs: 10, waitId: "cancel-wait", abortController: controller });
	assert.equal(cancelled.error_code, "CANCELLED");
	assert.equal(waitCoordinator.browserPilotWaits.size, 0);

	installPersistentCdp([{ ok: true }, { matched: false }], { bindingError: "binding unavailable" });
	const timedOut = await waitSelector.waitForSelector(7, { selector: "#timeout", timeoutMs: 50, pollMs: 10, waitId: "timeout-wait" });
	assert.equal(timedOut.error_code, "TIMEOUT");
	assert.equal(waitCoordinator.browserPilotWaits.size, 0);
});
