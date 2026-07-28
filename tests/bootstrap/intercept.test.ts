import assert from "node:assert/strict";
import test from "node:test";

const cdpCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
const debuggerListeners = new Set<(source: { tabId?: number }, method: string, params: Record<string, unknown>) => void>();
const storage: Record<string, unknown> = {};
const cdp = {
	async send(_tabId: number, method: string, params: Record<string, unknown>) {
		cdpCalls.push({ method, params });
		return { ok: true, data: { result: {} } };
	},
};

Object.assign(globalThis, {
	chrome: {
		runtime: { id: "intercept-test" },
		storage: { session: {
			async get(key: string) { return { [key]: storage[key] }; },
			async set(value: Record<string, unknown>) { Object.assign(storage, value); },
		} },
		tabs: { async get(tabId: number) { return { id: tabId }; } },
		debugger: { onEvent: {
			addListener(listener: (source: { tabId?: number }, method: string, params: Record<string, unknown>) => void) { debuggerListeners.add(listener); },
			removeListener(listener: (source: { tabId?: number }, method: string, params: Record<string, unknown>) => void) { debuggerListeners.delete(listener); },
		} },
	},
	browserPilotPersistentCdpBridge: cdp,
	BrowserPilotPersistentCdp: cdp,
});

const intercept = await import("../../src/bridge/extension/service_worker/intercept.ts");
const model = await import("../../src/bridge/extension/service_worker/intercept_model.ts");

test("intercept owns install, rules, paused request settlement, collection, and cleanup", async () => {
	const installed = await intercept.handleBrowserPilotInterceptCommand("intercept.install", 7, { cmd: "intercept.install", stages: ["request"] });
	assert.equal(installed.ok, true);
	assert.equal(cdpCalls[0]?.method, "Fetch.enable");
	assert.equal(debuggerListeners.size, 1);

	const added = await intercept.handleBrowserPilotInterceptCommand("intercept.addRule", 7, {
		cmd: "intercept.addRule",
		ruleId: "rewrite-api",
		action: "continue",
		matcher: { urlContains: "/api", method: "POST" },
		patch: { method: "PUT", headers: { "x-test": "yes" }, body: { ok: true } },
	});
	assert.equal(added.ok, true);

	const automatic = await intercept.handleBrowserPilotInterceptCommand("intercept.pause", 7, {
		cmd: "intercept.pause",
		params: { requestId: "request-auto", request: { url: "https://example.test/api", method: "POST" }, resourceType: "XHR" },
	});
	assert.equal((automatic.data as Record<string, unknown>).autoApplied, true);
	const continued = cdpCalls.find((call) => call.method === "Fetch.continueRequest");
	assert.equal(continued?.params.requestId, "request-auto");
	assert.equal(continued?.params.method, "PUT");
	assert.equal(typeof continued?.params.postData, "string");

	await intercept.handleBrowserPilotInterceptCommand("intercept.pause", 7, { cmd: "intercept.pause", autoApply: false, params: { requestId: "request-fulfill", request: { url: "https://example.test/other", method: "GET" } } });
	const fulfilled = await intercept.handleBrowserPilotInterceptCommand("intercept.fulfill", 7, { cmd: "intercept.fulfill", requestId: "request-fulfill", responseCode: 201, body: "created", responseHeaders: { "content-type": "text/plain" } });
	assert.equal((fulfilled.data as Record<string, unknown>).fulfilled, true);
	assert.equal(cdpCalls.find((call) => call.method === "Fetch.fulfillRequest")?.params.responseCode, 201);

	await intercept.handleBrowserPilotInterceptCommand("intercept.pause", 7, { cmd: "intercept.pause", autoApply: false, params: { requestId: "request-fail", request: { url: "https://example.test/fail" } } });
	const failed = await intercept.handleBrowserPilotInterceptCommand("intercept.fail", 7, { cmd: "intercept.fail", requestId: "request-fail", errorReason: "Aborted" });
	assert.equal((failed.data as Record<string, unknown>).failed, true);
	assert.equal(cdpCalls.find((call) => call.method === "Fetch.failRequest")?.params.errorReason, "Aborted");

	const collected = await intercept.handleBrowserPilotInterceptCommand("intercept.collect", 7, { cmd: "intercept.collect", limit: 20 });
	assert.ok(Number((collected.data as Record<string, unknown>).count) >= 5);
	const removed = await intercept.handleBrowserPilotInterceptCommand("intercept.removeRule", 7, { cmd: "intercept.removeRule", ruleId: "rewrite-api" });
	assert.equal((removed.data as Record<string, unknown>).removed, true);

	const uninstalled = await intercept.handleBrowserPilotInterceptCommand("intercept.uninstall", 7, { cmd: "intercept.uninstall" });
	assert.equal((uninstalled.data as Record<string, unknown>).uninstalled, true);
	assert.equal(cdpCalls.at(-1)?.method, "Fetch.disable");
	assert.equal(debuggerListeners.size, 0);
	assert.equal(model.browserPilotInterceptSessions.size, 0);
});
