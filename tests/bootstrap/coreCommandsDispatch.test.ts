import test from "node:test";
import assert from "node:assert/strict";

const chromeStub = {
	runtime: { id: "browser-pilot-test" },
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

const coreCommands = await import("../../src/bridge/extension/service_worker/core_commands.ts");

function sender(tabId = 7) {
	return { tab: { id: tabId, url: "https://example.test/" } };
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
});
