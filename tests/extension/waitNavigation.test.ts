import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

type DebuggerEventListener = (source: { tabId?: number }, method: string, params?: Record<string, unknown>) => void;

const debuggerEventListeners: DebuggerEventListener[] = [];
const chromeStub = {
	runtime: { id: "browser-pilot-wait-navigation-test" },
	tabs: {
		async get(tabId: number) {
			return { id: tabId, status: "loading", url: "https://example.test/" };
		},
		onUpdated: {
			addListener() {},
			removeListener() {},
		},
	},
	debugger: {
		onEvent: {
			addListener(listener: DebuggerEventListener) {
				debuggerEventListeners.push(listener);
			},
			removeListener(listener: DebuggerEventListener) {
				const index = debuggerEventListeners.indexOf(listener);
				if (index >= 0) debuggerEventListeners.splice(index, 1);
			},
		},
		async attach() {},
		async detach() {},
		async sendCommand() {
			return {};
		},
	},
};

Object.assign(globalThis, { chrome: chromeStub, self: globalThis });

const waitNavigation = await import("../../src/bridge/extension/service_worker/wait_navigation.ts");
const waitNetworkIdle = await import("../../src/bridge/extension/service_worker/wait_network_idle.ts");
const waitCoordinator = await import("../../src/bridge/extension/service_worker/wait_coordinator.ts");
const runtimeGlobal = globalThis as typeof globalThis & {
	browserPilotPersistentCdpBridge?: { send: (...args: unknown[]) => Promise<unknown> };
};

afterEach(() => {
	waitCoordinator.cleanupTabWaits(7, "test_cleanup");
	runtimeGlobal.browserPilotPersistentCdpBridge = undefined;
	debuggerEventListeners.length = 0;
});

test("load-state waits preserve load-metrics failures in terminal and response diagnostics", async () => {
	runtimeGlobal.browserPilotPersistentCdpBridge = {
		async send() {
			return { ok: false, error: { code: "PROBE_FAILED", message: "metrics probe unavailable" } };
		},
	};

	const response = await waitNavigation.waitForLoadState(7, {
		state: "complete",
		timeoutMs: 0,
		waitId: "load-metrics-failure",
	});
	assert.equal(response.error_code, "TIMEOUT");
	const responseDiagnostics = response.details?.diagnostics as Array<Record<string, unknown>>;
	assert.equal(responseDiagnostics[0]?.kind, "wait_error");
	assert.equal(responseDiagnostics[0]?.source, "initial:load_metrics");
	assert.match(String(responseDiagnostics[0]?.error), /metrics probe unavailable/);

	const terminal = waitCoordinator.browserPilotWaits.terminal("load-metrics-failure", 7);
	const terminalDiagnostics = terminal?.diagnostics as Array<Record<string, unknown>>;
	assert.equal(terminalDiagnostics[0]?.source, "initial:load_metrics");
	assert.equal(terminalDiagnostics[0]?.occurrences, 1);
});

test("network-idle fails explicitly when network observation cannot be enabled", async () => {
	runtimeGlobal.browserPilotPersistentCdpBridge = {
		async send(_tabId: unknown, method: unknown) {
			if (method === "Network.enable")
				return { ok: false, error: { code: "CDP_FAILED", message: "Network domain unavailable" } };
			return { ok: true, data: {} };
		},
	};

	const response = await waitNetworkIdle.waitForNetworkIdle(7, {
		timeoutMs: 500,
		idleMs: 100,
		waitId: "network-enable-failure",
	});
	assert.equal(response.error_code, "EVENT_SUBSCRIPTION_FAILED");
	assert.match(String(response.error), /could not observe network activity/);
	const diagnostics = response.details?.diagnostics as Array<Record<string, unknown>>;
	assert.equal(diagnostics[0]?.source, "Network.enable");
	assert.match(String(diagnostics[0]?.error), /Network domain unavailable/);
	assert.equal(waitCoordinator.browserPilotWaits.size, 0);
});
