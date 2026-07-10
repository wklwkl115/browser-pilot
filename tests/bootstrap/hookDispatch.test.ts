import test from "node:test";
import assert from "node:assert/strict";
import type { JsonRecord } from "../../src/bridge/extension/service_worker/types.ts";

const chromeStub = {
	runtime: { id: "browser-pilot-hook-test", getURL: (path: string) => `chrome-extension://test/${path}`, getManifest: () => ({ version: "0.0.0" }) },
	storage: { local: { async get() { return {}; }, async set() {}, async remove() {} }, session: { async get() { return {}; }, async set() {} } },
	debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} } },
	scripting: { async executeScript() {} },
	tabs: { async query() { return []; } },
};

const dispatches: Array<{ command: string; args: JsonRecord }> = [];
const pageResponses = new Map<string, JsonRecord>();
const cdpBridge = {
		async send(_tabId: number, method: string, params: JsonRecord) {
			assert.equal(method, "Runtime.evaluate");
			const expression = String(params.expression || "");
			const match = expression.match(/\.dispatch\(("(?:[^"\\]|\\.)*"),\s*(\{.*\})\)\s*:/s);
			if (!match) return { ok: true, data: { result: { result: { value: expression === "1 + 1" ? 2 : true } } } };
			const command = JSON.parse(match[1]!) as string;
			const args = JSON.parse(match[2]!) as JsonRecord;
			dispatches.push({ command, args });
			const value = pageResponses.get(command) ?? { ok: true, data: { command } };
			return { ok: true, data: { result: { result: { value } } } };
		},
};
Object.assign(globalThis, { chrome: chromeStub, self: globalThis });

const hook = await import("../../src/bridge/extension/service_worker/hook.ts");
const runtime = await import("../../src/bridge/extension/service_worker/runtime.ts");
Object.assign(globalThis, { browserPilotPersistentCdpBridge: cdpBridge, BrowserPilotPersistentCdp: cdpBridge });

test("hook dispatch exposes static targets and tab-scoped session inventory", async () => {
	const targets = await hook.handleBrowserPilotHookCommand("hook.list_targets", 0, {});
	assert.equal(targets.ok, true);
	const targetData = targets.data as JsonRecord;
	assert.equal(targetData.count, 9);
	assert.equal(targetData.boundary, "static-explicit-targets");
	assert.deepEqual((targetData.targets as Array<JsonRecord>).map((item) => item.id), ["console", "error", "networkApi", "websocket", "storage", "crypto", "dom", "domSinks", "cookies"]);

	runtime.browserPilotSessions.clear();
	runtime.browserPilotSessions.set(7, { session_id: "session-7", state: "INSTALLED" });
	runtime.browserPilotSessions.set(8, { session_id: "session-8", state: "PAUSED" });
	const sessions = await hook.handleBrowserPilotHookCommand("hook.list_sessions", 7, { tabId: 7 });
	const sessionData = sessions.data as JsonRecord;
	assert.equal(sessionData.tabId, 7);
	assert.equal(sessionData.count, 1);
	assert.deepEqual((sessionData.sessions as Array<JsonRecord>).map((item) => item.session_id), ["session-7"]);
});

test("hook dispatch forwards page commands with canonical session arguments", async () => {
	dispatches.splice(0);
	pageResponses.set("hook.status", { ok: true, data: { state: "PAUSED" } });
	await hook.handleBrowserPilotHookCommand("hook.status", 7, { sessionId: "session-7", timeoutMs: 500 });
	await hook.handleBrowserPilotHookCommand("hook.collect", 7, { session_id: "session-7", since_seq: 4, limit: 12, event_types: ["console.*"], min_count: 2, timeout_ms: 600 });
	await hook.handleBrowserPilotHookCommand("hook.clear_buffer", 7, { sessionId: "session-7" });
	await hook.handleBrowserPilotHookCommand("hook.pause", 7, { sessionId: "session-7" });
	await hook.handleBrowserPilotHookCommand("hook.resume", 7, { sessionId: "session-7" });

	assert.deepEqual(dispatches.map((entry) => entry.command), ["hook.status", "hook.collect", "hook.clear_buffer", "hook.pause", "hook.resume"]);
	assert.deepEqual(dispatches[0]?.args, { session_id: "session-7" });
	assert.deepEqual(dispatches[1]?.args, { session_id: "session-7", since_seq: 4, limit: 12, event_types: ["console.*"], timeout_ms: 600, min_count: 2 });
	assert.equal(runtime.browserPilotSessions.get(7)?.state, "PAUSED");
});

test("hook dispatch keeps evaluate and unknown-command boundaries stable", async () => {
	const evaluated = await hook.handleBrowserPilotHookCommand("hook.evaluate", 7, { expression: "1 + 1", awaitPromise: true, timeoutMs: 500 });
	assert.deepEqual(evaluated, { ok: true, data: 2 });
	const unknown = await hook.handleBrowserPilotHookCommand("hook.unknown", 7, {});
	assert.equal(unknown.ok, false);
	assert.equal(unknown.error_code, "INVALID_RULE");
	assert.match(String(unknown.error), /Unknown Browser Pilot hook command/);
	assert.equal((await hook.handleBrowserPilotHookCommand("toString", 7, {})).error_code, "INVALID_RULE");
});

test("hook install_targets expands explicit targets and records reusable session metadata", async () => {
	dispatches.splice(0);
	pageResponses.set("hook.status", { ok: false, error_code: "NO_SESSION", error: "not installed" });
	pageResponses.set("hook.install", { ok: true, data: { session_id: "installed-7", state: "INSTALLED", idempotent: true, dispatcher_version: "1.0" } });
	const installed = await hook.handleBrowserPilotHookCommand("hook.install_targets", 7, { sessionId: "installed-7", targets: ["console", "ws"] });
	assert.equal(installed.ok, true);
	const data = installed.data as JsonRecord;
	assert.equal(data.reused, true);
	assert.equal(data.preinstall_status, "NO_SESSION");
	assert.equal(data.target_boundary, "static-explicit-targets");
	assert.deepEqual((data.expanded_targets as Array<JsonRecord>).map((item) => item.id), ["console", "websocket"]);
	assert.deepEqual(dispatches.at(-1), { command: "hook.install", args: { session_id: "installed-7", targets: { console: true, websocket: true }, force: false } });
	assert.equal(runtime.browserPilotSessions.get(7)?.session_id, "installed-7");

	const invalid = await hook.handleBrowserPilotHookCommand("hook.install_targets", 7, { targets: ["all"] });
	assert.equal(invalid.error_code, "INVALID_RULE");
	assert.match(String(invalid.error), /Unsupported hook target ids: all/);
});

test("hook uninstall rejects mismatched sessions and cleans matching local state", async () => {
	runtime.browserPilotSessions.set(7, { session_id: "installed-7", state: "INSTALLED" });
	const mismatch = await hook.handleBrowserPilotHookCommand("hook.uninstall", 7, { sessionId: "other" });
	assert.equal(mismatch.error_code, "INVALID_SESSION");
	assert.equal(runtime.browserPilotSessions.has(7), true);

	pageResponses.set("hook.uninstall", { ok: true, data: { state: "UNINSTALLED" } });
	const removed = await hook.handleBrowserPilotHookCommand("hook.uninstall", 7, { sessionId: "installed-7" });
	assert.equal(removed.ok, true);
	assert.equal(runtime.browserPilotSessions.has(7), false);
	assert.equal(typeof (removed.data as JsonRecord).listener_cleanup, "object");
});
