import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { transformSync } from "esbuild";
import { runCallbackOast } from "../../src/tools/webSecurity/browserNative/callbackOast.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const artifactDir = path.join(root, ".pi", "browser-artifacts", "fixtures");
const failureArtifact = path.join(artifactDir, "runtime-fixtures-failure.json");

function read(rel) {
	return readFileSync(path.join(root, rel), "utf8");
}

// Shared state_store stubs for VM sandboxes that load network/intercept/ws/hook modules
const stateStoreStubs = {
	registerRecovery: () => {},
	persistState: async () => ({ ok: true, generation: 0 }),
	forgetState: async () => ({ ok: true }),
	getState: async () => undefined,
	recoverState: async () => ({ kind: "", recovered: [], lost: [], diagnostics: [] }),
	RECOVERY_CODES: { RECOVERED: "RUNTIME_STATE_RECOVERED", RECOVERED_WITH_HISTORY_LOSS: "RUNTIME_STATE_RECOVERED_WITH_HISTORY_LOSS", LOST: "RUNTIME_STATE_LOST" },
	redactConfig: (value) => value,
};

async function flushMicrotasks(turns = 2) {
	for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function createSessionStorage(shared) {
	return {
		async get(key) {
			return { [key]: shared[key] };
		},
		async set(value) {
			Object.assign(shared, value);
		},
	};
}

function installRealStateStore(sandbox, storageState, bootId) {
	sandbox.chrome = sandbox.chrome || {};
	sandbox.chrome.storage = { session: createSessionStorage(storageState) };
	sandbox.PI_BROWSER_WORKER_BOOT_ID = bootId;
	vm.runInNewContext(`${stateStoreSource}\nglobalThis.persistState = persist; globalThis.forgetState = forget; globalThis.getState = get; globalThis.getAllState = getAll; globalThis.recoverState = recover; globalThis.runStartupRecovery = runStartupRecovery; globalThis.registerRecovery = registerRecovery; globalThis.redactConfig = redactConfig; globalThis.RECOVERY_CODES = RECOVERY_CODES; globalThis.__stateStoreFixture = { persist, forget, get, getAll, recover, diagnostics, runStartupRecovery, registerRecovery, getRuntimeRecoverySummary };`, sandbox, { filename: "runtime-fixture-state-store.js" });
}

function stripBridgeSource(text) {
	return text
		.replace(/^\/\/ @ts-nocheck\r?\n/, "")
		.replace(/^import\s+[^;]+;\r?\n/gm, "")
		.replace(/^export\s+\{[^}]+\};\r?\n/gm, "")
		.replace(/^export async function /gm, "async function ")
		.replace(/^export function /gm, "function ")
		.replace(/^export class /gm, "class ")
		.replace(/^export const (?!__piBridgeModule_)([A-Za-z0-9_$]+)\s*=/gm, "const $1 =")
		.replace(/\r?\n\/\/ ESM module (?:boundary marker(?: for TODO 189)?|metadata)\r?\nexport const __piBridgeModule_[\s\S]*?;\s*$/, "")
		.replace(/^export const __piBridgeModule_[\s\S]*?;\s*$/gm, "")
		.replace(/\r?\nexport \{\};\s*$/, "");
}

function transformBridgeSource(text, sourcefile) {
	return transformSync(stripBridgeSource(text), { loader: "ts", target: "chrome120", sourcefile }).code;
}

function readServiceWorkerSource(name) {
	return transformBridgeSource(read(`bridge_src/service_worker/${name}.ts`), `bridge_src/service_worker/${name}.ts`);
}

const patternsSource = readServiceWorkerSource("patterns");
const stateStoreSource = readServiceWorkerSource("state_store");
const cdpSource = readServiceWorkerSource("cdp");
const networkSource = `${patternsSource}\n${readServiceWorkerSource("network_model")}\n${readServiceWorkerSource("network_events")}\n${readServiceWorkerSource("network")}`;
const waitSource = `${patternsSource}\n${readServiceWorkerSource("wait_cdp")}\n${readServiceWorkerSource("wait_coordinator")}\n${readServiceWorkerSource("wait_navigation")}\n${readServiceWorkerSource("wait_network_idle")}\n${readServiceWorkerSource("wait_selector")}\n${readServiceWorkerSource("wait")}`;
const hookSource = readServiceWorkerSource("hook");
const wsSource = `${readServiceWorkerSource("ws_model")}\n${readServiceWorkerSource("ws")}`;
const interceptSource = `${readServiceWorkerSource("intercept_model")}\n${readServiceWorkerSource("intercept")}`;
const frameSource = readServiceWorkerSource("frame");
const screenshotSource = readServiceWorkerSource("screenshot");
const transferSource = readServiceWorkerSource("transfer");

function sanitize(value, depth = 0) {
	if (depth > 8) return "[MaxDepth]";
	if (value instanceof Error) return { name: value.name, message: value.message, code: value.code, details: sanitize(value.details, depth + 1) };
	if (Array.isArray(value)) return value.slice(0, 80).map((item) => sanitize(item, depth + 1));
	if (value && typeof value === "object") {
		const out = {};
		for (const [key, item] of Object.entries(value)) out[key] = /cookie|token|authorization|password|secret|body|postdata|payloaddata/i.test(key) ? "[REDACTED]" : sanitize(item, depth + 1);
		return out;
	}
	if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
	return value;
}

async function writeFailure(error, diagnostics) {
	await mkdir(artifactDir, { recursive: true });
	await writeFile(failureArtifact, `${JSON.stringify({ ok: false, error: sanitize(error), diagnostics: sanitize(diagnostics) }, null, 2)}\n`, "utf8");
}

async function startHttpFixture() {
	const requests = [];
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			requests.push({ method: req.method, url: req.url, headers: req.headers, body });
			if (req.url === "/api") {
				res.writeHead(200, { "Content-Type": "application/json", "X-Fixture": "runtime" });
				res.end(JSON.stringify({ ok: true, echoed: body }));
				return;
			}
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("runtime fixture\n");
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	return { server, port: address.port, requests, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function startWsFixture() {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	const messages = [];
	server.on("connection", (ws) => {
		ws.on("message", (data) => {
			const text = data.toString();
			messages.push(text);
			ws.send(`echo:${text}`);
		});
	});
	await new Promise((resolve) => server.once("listening", resolve));
	return { server, port: server.address().port, messages, url: `ws://127.0.0.1:${server.address().port}` };
}

function createNetworkRuntime() {
	const cdpCalls = [];
	const subscriptions = [];
	const bodies = new Map();
	const sandbox = {
		console,
		TextEncoder,
		AbortController,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		atob: globalThis.atob || ((text) => Buffer.from(String(text), "base64").toString("binary")),
		btoa: globalThis.btoa || ((text) => Buffer.from(String(text), "binary").toString("base64")),
		PI_BROWSER_ERROR_CODES: {
			INTERNAL_ERROR: "INTERNAL_ERROR",
			NETWORK_RECORDER_NOT_STARTED: "NETWORK_RECORDER_NOT_STARTED",
			NETWORK_RECORDER_TIMEOUT: "NETWORK_RECORDER_TIMEOUT",
			BODY_UNAVAILABLE: "BODY_UNAVAILABLE",
			REQUEST_NOT_FOUND: "REQUEST_NOT_FOUND",
			INVALID_RULE: "INVALID_RULE",
			ALREADY_INSTALLED: "ALREADY_INSTALLED",
			CANCELLED: "CANCELLED",
			TIMEOUT: "TIMEOUT",
		},
		piBrowserError: (code, message, details = {}) => ({ ok: false, error_code: code, error: message, details }),
		redactSensitive: (value) => value,
		makeWaitId: (_tabId, prefix) => `${prefix || "id"}-${Math.random().toString(36).slice(2)}`,
		normalizePiBrowserTimeoutMs: (msg, fallback) => Number(msg?.timeoutMs ?? msg?.timeout_ms ?? fallback),
		enablePiBrowserCdpDomains: async (record, domains) => { record.cdpDomains = new Set(domains); record.cdpAttached = true; return { mode: "fixture", domains }; },
		releasePiBrowserCdpDomains: () => ({ released: 0, disabled: 0 }),
		diagnosePiBrowserCdpDomainRefs: () => [],
		subscribePiBrowserCdp: (tabId, events, handler, record) => {
			const id = `net-sub-${subscriptions.length + 1}`;
			subscriptions.push({ id, tabId, events, handler });
			record.cdpSubscriptions.push(id);
			return id;
		},
		unsubscribePiBrowserCdp: (id) => {
			const index = subscriptions.findIndex((item) => item.id === id);
			if (index >= 0) subscriptions.splice(index, 1);
			return true;
		},
		piBrowserPersistentCdp: () => ({
			send: async (_tabId, method, params, options) => {
				cdpCalls.push({ method, params, options });
				if (method === "Network.getResponseBody") return { ok: true, data: { result: bodies.get(params.requestId) || { body: "", base64Encoded: false } } };
				return { ok: true, data: { result: {} } };
			},
		}),
		normalizePersistentPiBrowserResponse: (value) => value,
		piWithTimeout: async (promise) => await promise,
		chrome: { debugger: { sendCommand: async () => ({}) } },
		...stateStoreStubs,
	};
	vm.runInNewContext(networkSource, sandbox, { filename: "runtime-fixture-network.js" });
	function emit(method, params = {}) {
		for (const sub of subscriptions) {
			const events = Array.isArray(sub.events) ? sub.events : [sub.events];
			if (events.includes(method) || events.includes("*")) sub.handler({ tabId: sub.tabId }, method, params);
		}
	}
	return { sandbox, cdpCalls, subscriptions, bodies, emit };
}

async function testNetworkHttpWsHarFixture(diagnostics) {
	const httpFixture = await startHttpFixture();
	const wsFixture = await startWsFixture();
	try {
		const httpResponse = await fetch(`${httpFixture.baseUrl}/api`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fixture: "network" }) });
		const httpBody = await httpResponse.text();
		const wsClient = new WebSocket(wsFixture.url);
		await new Promise((resolve, reject) => { wsClient.once("open", resolve); wsClient.once("error", reject); });
		const wsReply = new Promise((resolve, reject) => { wsClient.once("message", (data) => resolve(data.toString())); wsClient.once("error", reject); });
		wsClient.send("runtime-frame");
		assert.equal(await wsReply, "echo:runtime-frame");
		wsClient.close();

		const runtime = createNetworkRuntime();
		await runtime.sandbox.handleNetworkRecorderCommand(9, "network.start", { sessionId: "fixture", resourceTypes: ["XHR", "WebSocket"], maxBodyBytes: 4096 });
		runtime.bodies.set("api-1", { body: httpBody, base64Encoded: false });
		runtime.emit("Network.requestWillBeSent", { requestId: "api-1", type: "XHR", request: { url: `${httpFixture.baseUrl}/api`, method: "POST", headers: { "Content-Type": "application/json" }, hasPostData: true, postData: JSON.stringify({ fixture: "network" }) } });
		runtime.emit("Network.responseReceived", { requestId: "api-1", type: "XHR", response: { url: `${httpFixture.baseUrl}/api`, status: httpResponse.status, statusText: "OK", mimeType: "application/json", headers: { "Content-Type": "application/json", "X-Fixture": "runtime" } } });
		runtime.emit("Network.loadingFinished", { requestId: "api-1", encodedDataLength: httpBody.length });
		await new Promise((resolve) => setTimeout(resolve, 0));
		runtime.emit("Network.webSocketCreated", { requestId: "ws-1", url: wsFixture.url });
		runtime.emit("Network.webSocketFrameSent", { requestId: "ws-1", timestamp: 1, response: { opcode: 1, payloadData: "runtime-frame" } });
		runtime.emit("Network.webSocketFrameReceived", { requestId: "ws-1", timestamp: 2, response: { opcode: 1, payloadData: "echo:runtime-frame" } });
		runtime.emit("Network.webSocketClosed", { requestId: "ws-1", timestamp: 3 });

		const listed = await runtime.sandbox.handleNetworkRecorderCommand(9, "network.list", { sessionId: "fixture", includeDetails: true });
		assert.equal(listed.ok, true);
		assert.equal(listed.data.total, 2, "runtime network fixture must replay HTTP and WebSocket records");
		const api = await runtime.sandbox.handleNetworkRecorderCommand(9, "network.get", { sessionId: "fixture", requestId: "api-1", includeBody: true });
		assert.equal(api.data.bodyAvailability, "captured");
		assert.equal(api.data.request.postData, JSON.stringify({ fixture: "network" }));
		const body = await runtime.sandbox.handleNetworkRecorderCommand(9, "network.body", { sessionId: "fixture", requestId: "api-1" });
		assert.match(body.data.body, /"ok":true/);
		const har = await runtime.sandbox.handleNetworkRecorderCommand(9, "network.exportHar", { sessionId: "fixture", includeBody: true });
		assert.equal(har.data.log.entries.length, 2);
		const harApi = har.data.log.entries.find((entry) => entry._requestId === "api-1");
		const harWs = har.data.log.entries.find((entry) => entry._requestId === "ws-1");
		assert.equal(harApi.request.postData.text, JSON.stringify({ fixture: "network" }), "HAR must preserve bounded request postData");
		assert.match(harApi.response.content.text, /"echoed"/, "HAR must include captured response body when requested");
		assert.equal(harWs._wsFrames.length, 2, "HAR must preserve replayed websocket frames");
		diagnostics.network = { requests: httpFixture.requests.length, wsMessages: wsFixture.messages.length, harEntries: har.data.log.entries.length, cdpCalls: runtime.cdpCalls.length };
	} finally {
		await new Promise((resolve) => httpFixture.server.close(resolve));
		await new Promise((resolve) => wsFixture.server.close(resolve));
	}
}

function createWaitHookRuntime() {
	const cdpCalls = [];
	const subscriptions = [];
	const pageListeners = new Map();
	const sandbox = {
		console,
		Date,
		Math,
		AbortController,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		PI_BROWSER_ERROR_CODES: {
			INVALID_RULE: "INVALID_RULE",
			TIMEOUT: "TIMEOUT",
			CANCELLED: "CANCELLED",
			NO_SESSION: "NO_SESSION",
			NOT_INSTALLED: "NOT_INSTALLED",
			INVALID_SESSION: "INVALID_SESSION",
			INTERNAL_ERROR: "INTERNAL_ERROR",
			EVENT_SUBSCRIPTION_FAILED: "EVENT_SUBSCRIPTION_FAILED",
		},
		PI_BROWSER_HOOK_DISPATCHER_FILE: "dist/hook_dispatcher.js",
		piBrowserError: (code, message, details = {}) => ({ ok: false, error_code: code, error: message, details }),
		piWithTimeout: async (value) => await value,
		normalizePersistentPiBrowserResponse: (value) => value,
		piBrowserPersistentCdp: () => ({
			send: async (_tabId, method, params, options) => {
				cdpCalls.push({ method, params, options });
				if (method === "Runtime.evaluate") {
					const expression = String(params.expression || "");
					const listenerMatch = expression.match(/const listenerId = "([^"]+)";/);
					if (expression.includes("const listenerIds = Object.keys(store)")) {
						const listenerIds = Array.from(pageListeners.keys());
						pageListeners.clear();
						return { ok: true, data: { result: { result: { value: { ok: true, removed: listenerIds.length, listenerIds, errors: [], reason: "fixture_cleanup" } } } } };
					}
					if (expression.includes("window.__piBrowserListeners") && expression.includes("target.addEventListener")) {
						const listenerId = listenerMatch?.[1] || "listener";
						pageListeners.set(listenerId, { listenerId, eventType: "click", eventCount: 0 });
						return { ok: true, data: { result: { result: { value: { ok: true, listenerId, eventType: "click", selector: "#submit", target: "#submit", replaced: false } } } } };
					}
					if (expression.includes("delete store[listenerId]")) {
						const listenerId = listenerMatch?.[1] || "listener";
						const existed = pageListeners.delete(listenerId);
						return { ok: true, data: { result: { result: { value: { removed: existed, listenerId, eventType: "click", selector: "#submit", eventCount: 1 } } } } };
					}
					if (expression.includes("performance.getEntriesByType")) return { ok: true, data: { result: { result: { value: [{ name: "https://fixture.test/app.js", entryType: "resource", startTime: 1, duration: 2, initiatorType: "script" }] } } } };
				}
				return { ok: true, data: { result: {} } };
			},
		}),
		chrome: {
			runtime: { getURL: (file) => `chrome-extension://fixture/${file}` },
			scripting: { async executeScript() { return [{ result: true }]; } },
			debugger: {
				async sendCommand() { return {}; },
				async getTargets() { return [{ tabId: 12, type: "page", attached: true }]; },
			},
			tabs: { async get(tabId) { return { id: tabId, url: "https://fixture.test", title: "Fixture" }; } },
		},
		piBrowserSessions: new Map(),
		piBrowserTabQueues: new Map(),
		getPiBrowserQueueStats: () => ({ pending: false, depth: 0, last_cmd: null }),
		callPagePiBrowser: async (_tabId, command, args) => {
			if (command === "hook.status") return { ok: true, data: { state: "INSTALLED", session_id: args?.session_id || "hook-fixture", dispatcher_version: "fixture", install_epoch: 1 } };
			return { ok: true, data: {} };
		},
		piBrowserEval: async (_tabId, expression) => {
			if (String(expression || "").includes("document.querySelector")) return { ok: true, data: { ok: true, matched: true, selector: "#ready" } };
			return { ok: true, data: { matched: true, selector: "#ready" } };
		},
		navigatePiBrowser: async () => ({ ok: true, data: {} }),
		waitForLoadState: async () => ({ ok: true, data: { state: "complete" } }),
		waitForNetworkIdle: async () => ({ ok: true, data: { idle: true } }),
		waitForNavigation: async () => ({ ok: true, data: { url: "https://fixture.test" } }),
		waitForSelector: async (_tabId, msg) => ({ ok: true, data: { selector: msg.selector || "#ready" } }),
		...stateStoreStubs,
	};
	vm.runInNewContext(`${waitSource}\nglobalThis.__waitFixture = { piBrowserWaits, dispatchPiBrowserWait, cleanupPiBrowserPageListenersForTab };`, sandbox, { filename: "runtime-fixture-wait.js" });
	sandbox.addEventListener = sandbox.addEventListener;
	sandbox.removeEventListener = sandbox.removeEventListener;
	sandbox.cleanupPiBrowserPageListenersForTab = sandbox.cleanupPiBrowserPageListenersForTab;
	sandbox.getPerformanceEntries = sandbox.getPerformanceEntries;
	vm.runInNewContext(`${hookSource}\nglobalThis.__hookFixture = { handlePiBrowserHookCommand };`, sandbox, { filename: "runtime-fixture-hook.js" });
	return { sandbox, cdpCalls, pageListeners, subscriptions };
}

async function testHookListenerAndWaitFixture(diagnostics) {
	const runtime = createWaitHookRuntime();
	const installed = await runtime.sandbox.__hookFixture.handlePiBrowserHookCommand("hook.install", 12, { sessionId: "hook-fixture", targets: { console: true } });
	diagnostics.hookInstall = installed;
	assert.equal(installed.ok, true);
	const added = await runtime.sandbox.__hookFixture.handlePiBrowserHookCommand("hook.addEventListener", 12, { listenerId: "click-fixture", eventType: "click", selector: "#submit", timeoutMs: 500 });
	assert.equal(added.ok, true);
	assert.equal(added.data.listenerId, "click-fixture");
	assert.ok(runtime.sandbox.__waitFixture.piBrowserWaits.eventSubscription("click-fixture", 12), "hook listener fixture must register tab-scoped listener state");
	const performance = await runtime.sandbox.__hookFixture.handlePiBrowserHookCommand("hook.getPerformanceEntries", 12, { entryType: "resource", nameContains: "app" });
	assert.equal(performance.data.count, 1);
	const removed = await runtime.sandbox.__hookFixture.handlePiBrowserHookCommand("hook.removeEventListener", 12, { listenerId: "click-fixture", timeoutMs: 500 });
	assert.equal(removed.data.removed, true);
	assert.equal(runtime.sandbox.__waitFixture.piBrowserWaits.eventSubscription("click-fixture", 12), null);
	await runtime.sandbox.__hookFixture.handlePiBrowserHookCommand("hook.addEventListener", 12, { listenerId: "cleanup-fixture", eventType: "click", selector: "#submit", timeoutMs: 500 });
	const cleanup = await runtime.sandbox.cleanupPiBrowserPageListenersForTab(12, "fixture_cleanup", 500);
	assert.equal(cleanup.data.removed, 1, "hook cleanup fixture must remove page listener state");
	const registryCleanup = runtime.sandbox.__waitFixture.piBrowserWaits.cleanupEventSubscriptionsForTab(12);
	assert.equal(registryCleanup, 1, "hook cleanup fixture must remove tab-scoped listener registry state");
	const immediateWait = await runtime.sandbox.__waitFixture.dispatchPiBrowserWait(12, { cmd: "wait.selector", selector: "#ready", timeoutMs: 0 }, "selector");
	assert.equal(immediateWait.ok, true);
	diagnostics.hookWait = { cdpCalls: runtime.cdpCalls.length, listenerRegistrySize: Array.from(runtime.sandbox.__waitFixture.piBrowserWaits.eventSubscriptionValues()).length, performanceCount: performance.data.count, immediateWait: immediateWait.data.selector };
}

function createFrameRuntime() {
	const calls = [];
	const sandbox = {
		PI_BROWSER_ERROR_CODES: { INTERNAL_ERROR: "INTERNAL_ERROR", INVALID_RULE: "INVALID_RULE" },
		piBrowserError: (code, message, details = {}) => ({ ok: false, error_code: code, error: message, details }),
		normalizePersistentPiBrowserResponse: (value) => value,
		piBrowserPersistentCdp: () => ({
			frameTree: async (tabId, options) => { calls.push({ method: "frameTree", tabId, options }); return { ok: true, data: { frameTree: { frame: { id: "root" } }, frames: [{ id: "root" }, { id: "child" }] } }; },
			evaluateInFrame: async (tabId, expression, options) => { calls.push({ method: "evaluateInFrame", tabId, expression, options }); return { ok: true, data: { result: { value: { text: "frame-ok" } } } }; },
		}),
	};
	vm.runInNewContext(`${frameSource}\nglobalThis.__frameFixture = { handlePiBrowserFrameCommand };`, sandbox, { filename: "runtime-fixture-frame.js" });
	return { sandbox, calls };
}

async function testFrameEvaluateFixture(diagnostics) {
	const runtime = createFrameRuntime();
	const listed = await runtime.sandbox.__frameFixture.handlePiBrowserFrameCommand("frame.list", 21, {});
	assert.equal(listed.data.count, 2);
	const evaluated = await runtime.sandbox.__frameFixture.handlePiBrowserFrameCommand("frame.evaluate", 21, { frameId: "child", expression: "document.body.innerText", worldName: "fixture", userGesture: true });
	assert.equal(evaluated.ok, true);
	assert.equal(evaluated.data.tabId, 21);
	assert.equal(evaluated.data.frameId, "child");
	const call = runtime.calls.find((item) => item.method === "evaluateInFrame");
	assert.equal(call.options.frameId, "child");
	assert.equal(call.options.worldName, "fixture");
	diagnostics.frame = { count: listed.data.count, evaluateOptions: call.options };
}

async function testScreenshotFallbackFixture(diagnostics) {
	const captureOptions = [];
	const sandbox = {
		console: { warn() {} },
		PI_BROWSER_ERROR_CODES: { TAB_NOT_FOUND: "TAB_NOT_FOUND", TIMEOUT: "TIMEOUT" },
		piBrowserError: (code, message, details = {}) => ({ ok: false, error_code: code, error: message, details }),
		piBrowserPersistentCdp: () => null,
		normalizePersistentPiBrowserResponse: (value) => value,
		piWithTimeout: async (value) => await value,
		piSleep: async () => {},
		chrome: {
			tabs: {
				async get(tabId) { return { id: tabId, windowId: 4 }; },
				async captureVisibleTab(_windowId, options) { captureOptions.push(options); return "data:image/png;base64,AA=="; },
			},
			debugger: { async attach() { throw new Error("debugger unavailable"); }, async sendCommand() {}, async detach() {} },
		},
	};
	vm.runInNewContext(`${screenshotSource}\nglobalThis.__screenshotFixture = { captureScreenshotWithRetry };`, sandbox, { filename: "runtime-fixture-screenshot.js" });
	const result = await sandbox.__screenshotFixture.captureScreenshotWithRetry(31, { cmd: "screenshot.capture", format: "webp", retries: 1, fallback: true });
	assert.equal(result.ok, true);
	assert.equal(result.data.fallback, "captureVisibleTab");
	assert.equal(result.data.format, "png");
	assert.equal(captureOptions[0].format, "png");
	diagnostics.screenshot = { fallback: result.data.fallback, format: result.data.format };
}

function createTransferRuntime() {
	const listeners = { created: new Set(), changed: new Set() };
	const subscriptions = new Map();
	const cdpCalls = [];
	const downloadItems = new Map();
	let nextDownloadId = 700;
	let nextSubscriptionId = 1;
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		URL,
		PI_BROWSER_ERROR_CODES: { INVALID_RULE: "INVALID_RULE", UNSUPPORTED_TARGET: "UNSUPPORTED_TARGET", INTERNAL_ERROR: "INTERNAL_ERROR", SAFETY_BLOCKED: "SAFETY_BLOCKED", AMBIGUOUS_DOWNLOAD: "AMBIGUOUS_DOWNLOAD" },
		piBrowserError: (code, message, details = {}) => ({ ok: false, error_code: code, error: { code, message, details }, details }),
		normalizePersistentPiBrowserResponse: (value) => value,
		piBrowserPersistentCdp: () => ({
			send: async (_tabId, method, params, options) => {
				cdpCalls.push({ method, params, options });
				if (method === "Page.enable" || method === "Page.setInterceptFileChooserDialog") return { ok: true, data: {} };
				if (method === "Runtime.evaluate") {
					if (String(params.expression || "").includes("sourceTag")) return { ok: true, data: { result: { result: { value: { href: "", selector: "#download" } } } } };
					setTimeout(() => {
						const item = { id: 701, url: "blob:https://fixture.test/download", finalUrl: "blob:https://fixture.test/download", filename: "C:/Downloads/runtime.txt", state: "in_progress", startTime: new Date().toISOString(), bytesReceived: 0, totalBytes: 7, danger: "safe", exists: false };
						downloadItems.set(701, item);
						emitCdpEvent("Page.downloadWillBegin", { guid: "g-701", url: item.url, suggestedFilename: "runtime.txt" });
						setTimeout(() => completeDownload(701, { bytesReceived: 7 }), 0);
					}, 0);
					return { ok: true, data: { result: { result: { value: { clicked: true, selector: "#download" } } } } };
				}
				if (method === "DOM.setFileInputFiles") return { ok: true, data: { files: params.files } };
				return { ok: true, data: {} };
			},
		}),
		subscribePiBrowserCdp(tabId, event, handler) {
			const id = `transfer-sub-${nextSubscriptionId++}`;
			subscriptions.set(id, { tabId, event, handler });
			return id;
		},
		unsubscribePiBrowserCdp(id) { subscriptions.delete(id); return true; },
		chrome: {
			runtime: { get lastError() { return null; } },
			downloads: {
				download(options, callback) {
					const id = nextDownloadId++;
					const item = { id, url: options.url, finalUrl: options.url, filename: `C:/Downloads/${options.filename || "direct.txt"}`, state: "in_progress", bytesReceived: 0, totalBytes: 3, danger: "safe", exists: false };
					downloadItems.set(id, item);
					callback(id);
					setTimeout(() => completeDownload(id, { bytesReceived: 3 }), 0);
				},
				search(query, callback) {
					let items = Array.from(downloadItems.values());
					if (query.id !== undefined) items = [downloadItems.get(Number(query.id))].filter(Boolean);
					if (query.url) items = items.filter((item) => item.url === query.url || item.finalUrl === query.url);
					callback(items);
				},
				onCreated: { addListener(listener) { listeners.created.add(listener); }, removeListener(listener) { listeners.created.delete(listener); } },
				onChanged: { addListener(listener) { listeners.changed.add(listener); }, removeListener(listener) { listeners.changed.delete(listener); } },
			},
		},
	};
	function completeDownload(id, patch = {}) {
		const item = downloadItems.get(Number(id));
		Object.assign(item, patch, { state: "complete", endTime: new Date().toISOString(), exists: true });
		for (const listener of Array.from(listeners.changed)) listener({ id: Number(id), state: { current: "complete" }, filename: { current: item.filename } });
	}
	function emitCdpEvent(method, params = {}) {
		for (const rec of Array.from(subscriptions.values())) {
			const events = Array.isArray(rec.event) ? rec.event : [rec.event];
			if (events.includes(method) || events.includes("*")) rec.handler({ tabId: rec.tabId }, method, params);
		}
	}
	vm.runInNewContext(`${transferSource}\nglobalThis.__transferFixture = { handlePiBrowserTransferCommand };`, sandbox, { filename: "runtime-fixture-transfer.js" });
	return { sandbox, cdpCalls, downloadItems, emitCdpEvent };
}

async function testTransferDownloadUploadFixture(diagnostics) {
	const runtime = createTransferRuntime();
	const direct = await runtime.sandbox.__transferFixture.handlePiBrowserTransferCommand("transfer.download", 41, { url: "https://fixture.test/direct.txt", filename: "direct.txt", timeoutMs: 1000 });
	assert.equal(direct.ok, true);
	assert.equal(direct.data.path, "C:/Downloads/direct.txt");
	const clicked = await runtime.sandbox.__transferFixture.handlePiBrowserTransferCommand("transfer.download", 41, { selector: "#download", timeoutMs: 1000 });
	assert.equal(clicked.ok, true);
	assert.equal(clicked.data.matchStrategy, "tab-cdp-download-event");
	const uploadPromise = runtime.sandbox.__transferFixture.handlePiBrowserTransferCommand("transfer.upload", 41, { selector: "#file", files: ["C:/tmp/runtime.txt"], timeoutMs: 1000 });
	setTimeout(() => runtime.emitCdpEvent("Page.fileChooserOpened", { backendNodeId: 91, mode: "selectSingle" }), 0);
	const upload = await uploadPromise;
	assert.equal(upload.ok, true);
	assert.equal(upload.data.uploaded, true);
	assert.ok(runtime.cdpCalls.some((call) => call.method === "DOM.setFileInputFiles" && call.params.backendNodeId === 91));
	diagnostics.transfer = { directPath: direct.data.path, clickStrategy: clicked.data.matchStrategy, uploadFiles: upload.data.files_count };
}

async function testCallbackWorkerStateFixture(diagnostics) {
	const sessionId = `runtime-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const started = await runCallbackOast({ action: "start", sessionId, correlationId: "runtime-fixture", maxEvents: 20, maxBodyBytes: 2048 });
	try {
		assert.equal(started.ok, true);
		const trigger = await runCallbackOast({ action: "trigger", sessionId, mode: "http", method: "POST", body: "runtime-fixture", timeoutMs: 5000 });
		assert.equal(trigger.count, 1);
		const stateRaw = JSON.parse(await readFile(started.statePath, "utf8"));
		assert.equal(stateRaw.eventCount, 1, "callback worker must persist event count in the state file");
		assert.equal(stateRaw.events[0].matchedCorrelation, true);
		await writeFile(`${started.statePath}.lock`, JSON.stringify({ pid: -1, acquiredAt: "1970-01-01T00:00:00.000Z", token: "runtime-stale-lock" }), "utf8");
		const cleared = await runCallbackOast({ action: "clear", sessionId });
		assert.equal(cleared.cleared, 1, "callback clear must update the state file through stale-lock recovery");
		await assert.rejects(() => readFile(`${started.statePath}.lock`, "utf8"), /ENOENT/, "callback fixture must recover stale state locks");
		const collected = await runCallbackOast({ action: "collect", sessionId });
		assert.equal(collected.count, 0, "callback collect must reflect the cleared worker state file");
		diagnostics.callback = { statePath: started.statePath, eventCount: stateRaw.eventCount, cleared: cleared.cleared, lockRecovered: true };
	} finally {
		await runCallbackOast({ action: "stop", sessionId }).catch(() => {});
		await rm(started.artifactRoot, { recursive: true, force: true }).catch(() => {});
	}
}

function createRecoveryNetworkRuntime(storageState, bootId, existingTabs = new Set([9])) {
	const cdpCalls = [];
	const subscriptions = [];
	const sandbox = {
		console,
		TextEncoder,
		AbortController,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		atob: globalThis.atob || ((text) => Buffer.from(String(text), "base64").toString("binary")),
		btoa: globalThis.btoa || ((text) => Buffer.from(String(text), "binary").toString("base64")),
		PI_BROWSER_ERROR_CODES: {
			INTERNAL_ERROR: "INTERNAL_ERROR",
			NETWORK_RECORDER_NOT_STARTED: "NETWORK_RECORDER_NOT_STARTED",
			NETWORK_RECORDER_TIMEOUT: "NETWORK_RECORDER_TIMEOUT",
			BODY_UNAVAILABLE: "BODY_UNAVAILABLE",
			REQUEST_NOT_FOUND: "REQUEST_NOT_FOUND",
			INVALID_RULE: "INVALID_RULE",
			ALREADY_INSTALLED: "ALREADY_INSTALLED",
			CANCELLED: "CANCELLED",
			TIMEOUT: "TIMEOUT",
		},
		piBrowserError: (code, message, details = {}) => ({ ok: false, error_code: code, error: message, details }),
		redactSensitive: (value) => value,
		makeWaitId: (_tabId, prefix) => `${prefix || "id"}-${Math.random().toString(36).slice(2)}`,
		normalizePiBrowserTimeoutMs: (msg, fallback) => Number(msg?.timeoutMs ?? msg?.timeout_ms ?? fallback),
		enablePiBrowserCdpDomains: async (record, domains) => { record.cdpDomains = new Set(domains); record.cdpAttached = true; return { mode: "fixture", domains }; },
		releasePiBrowserCdpDomains: () => ({ released: 0, disabled: 0 }),
		diagnosePiBrowserCdpDomainRefs: () => [],
		subscribePiBrowserCdp: (tabId, events, handler, record) => {
			const id = `net-sub-${subscriptions.length + 1}`;
			subscriptions.push({ id, tabId, events, handler });
			record.cdpSubscriptions.push(id);
			return id;
		},
		unsubscribePiBrowserCdp: (id) => {
			const index = subscriptions.findIndex((item) => item.id === id);
			if (index >= 0) subscriptions.splice(index, 1);
			return true;
		},
		piBrowserPersistentCdp: () => ({
			send: async (_tabId, method, params, options) => {
				cdpCalls.push({ method, params, options });
				return { ok: true, data: { result: {} } };
			},
		}),
		normalizePersistentPiBrowserResponse: (value) => value,
		piWithTimeout: async (promise) => await promise,
		chrome: {
			debugger: { sendCommand: async () => ({}) },
			tabs: { get: async (tabId) => existingTabs.has(Number(tabId)) ? { id: Number(tabId), url: "https://fixture.test" } : (() => { throw new Error("missing tab"); })() },
		},
		rememberRuntimeSession: async () => {},
		forgetRuntimeSession: async () => {},
		findLostRuntimeSession: async () => undefined,
		summarizeLostRuntimeSession: () => undefined,
	};
	installRealStateStore(sandbox, storageState, bootId);
	vm.runInNewContext(`${networkSource}\nglobalThis.__networkRecoveryFixture = { handleNetworkRecorderCommand, piBrowserNetworkRecorders, ensureNetworkEntry };`, sandbox, { filename: `runtime-recovery-network-${bootId}.js` });
	return { sandbox, cdpCalls, subscriptions };
}

function createRecoveryInterceptRuntime(storageState, bootId, existingTabs = new Set([41])) {
	const cdpCalls = [];
	const subscriptions = [];
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		PI_BROWSER_ERROR_CODES: {
			SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
			INVALID_RULE: "INVALID_RULE",
			REQUEST_NOT_FOUND: "REQUEST_NOT_FOUND",
			INTERNAL_ERROR: "INTERNAL_ERROR",
		},
		piBrowserError: (code, message, details = {}) => ({ ok: false, error_code: code, error: message, details }),
		redactSensitive: (value) => value,
		piBrowserPersistentCdp: () => ({
			send: async (_tabId, method, params, options) => {
				cdpCalls.push({ method, params, options });
				return { ok: true, data: { result: {} } };
			},
		}),
		normalizePersistentPiBrowserResponse: (value) => value,
		subscribePiBrowserCdp: (tabId, event, handler) => {
			const id = `int-sub-${subscriptions.length + 1}`;
			subscriptions.push({ id, tabId, event, handler });
			return id;
		},
		unsubscribePiBrowserCdp: () => true,
		chrome: {
			tabs: { get: async (tabId) => existingTabs.has(Number(tabId)) ? { id: Number(tabId), url: "https://fixture.test" } : (() => { throw new Error("missing tab"); })() },
		},
		rememberRuntimeSession: async () => {},
		forgetRuntimeSession: async () => {},
		findLostRuntimeSession: async () => undefined,
		summarizeLostRuntimeSession: () => undefined,
	};
	installRealStateStore(sandbox, storageState, bootId);
	vm.runInNewContext(`${interceptSource}\nglobalThis.__interceptRecoveryFixture = { handlePiBrowserInterceptCommand, piBrowserInterceptSessions };`, sandbox, { filename: `runtime-recovery-intercept-${bootId}.js` });
	return { sandbox, cdpCalls, subscriptions };
}

function createRecoveryHookRuntime(storageState, bootId, hookStatusOk = true, existingTabs = new Set([12])) {
	const sandbox = {
		console,
		Date,
		Math,
		AbortController,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		PI_BROWSER_ERROR_CODES: {
			INVALID_RULE: "INVALID_RULE",
			TIMEOUT: "TIMEOUT",
			CANCELLED: "CANCELLED",
			NO_SESSION: "NO_SESSION",
			NOT_INSTALLED: "NOT_INSTALLED",
			INVALID_SESSION: "INVALID_SESSION",
			INTERNAL_ERROR: "INTERNAL_ERROR",
			EVENT_SUBSCRIPTION_FAILED: "EVENT_SUBSCRIPTION_FAILED",
		},
		PI_BROWSER_HOOK_DISPATCHER_FILE: "dist/hook_dispatcher.js",
		piBrowserError: (code, message, details = {}) => ({ ok: false, error_code: code, error: message, details }),
		piWithTimeout: async (value) => await value,
		normalizePersistentPiBrowserResponse: (value) => value,
		piBrowserPersistentCdp: () => ({ send: async () => ({ ok: true, data: { result: {} } }) }),
		chrome: {
			runtime: { getURL: (file) => `chrome-extension://fixture/${file}` },
			scripting: { async executeScript() { return [{ result: true }]; } },
			debugger: { async sendCommand() { return {}; }, async getTargets() { return []; } },
			tabs: { get: async (tabId) => existingTabs.has(Number(tabId)) ? { id: Number(tabId), url: "https://fixture.test", title: "Fixture" } : (() => { throw new Error("missing tab"); })() },
		},
		piBrowserSessions: new Map(),
		piBrowserTabQueues: new Map(),
		getPiBrowserQueueStats: () => ({ pending: false, depth: 0, last_cmd: null }),
		callPagePiBrowser: async (_tabId, command, args) => {
			if (command === "hook.status") return hookStatusOk
				? { ok: true, data: { state: "INSTALLED", session_id: args?.session_id || "hook-fixture", dispatcher_version: "fixture", install_epoch: 1 } }
				: { ok: false, error_code: "NO_SESSION", error: "missing" };
			return { ok: true, data: {} };
		},
		piBrowserEval: async () => ({ ok: true, data: { matched: true } }),
		collectNodeListeners: async () => ({ ok: true, data: {} }),
		collectNodeListenerChain: async () => ({ ok: true, data: {} }),
		collectNodeSinkHints: async () => ({ ok: true, data: {} }),
		addEventListener: async () => ({ ok: true, data: {} }),
		removeEventListener: async () => ({ ok: true, data: {} }),
		getPerformanceEntries: async () => ({ ok: true, data: {} }),
		cleanupPiBrowserPageListenersForTab: async () => ({ ok: true, data: {} }),
		cleanupWaitsForUninstall: () => {},
		cleanupPiBrowserTab: () => {},
	};
	installRealStateStore(sandbox, storageState, bootId);
	vm.runInNewContext(`${hookSource}\nglobalThis.__hookRecoveryFixture = { handlePiBrowserHookCommand, piBrowserSessions };`, sandbox, { filename: `runtime-recovery-hook-${bootId}.js` });
	return { sandbox };
}

function createRecoveryWsRuntime(storageState, runtimeState, bootId, existingTabs = new Set([51])) {
	class FixtureWebSocket {
		constructor(url) {
			this.url = url;
			this.readyState = 0;
			this.listeners = new Map();
			setTimeout(() => {
				this.readyState = 1;
				this.dispatch("open", { type: "open" });
			}, 0);
		}
		addEventListener(type, listener, options = {}) {
			const list = this.listeners.get(type) || [];
			list.push({ listener, once: options.once === true });
			this.listeners.set(type, list);
		}
		removeEventListener(type, listener) {
			const list = this.listeners.get(type) || [];
			this.listeners.set(type, list.filter((entry) => entry.listener !== listener));
		}
		dispatch(type, event) {
			const list = [...(this.listeners.get(type) || [])];
			for (const entry of list) {
				entry.listener(event);
				if (entry.once) this.removeEventListener(type, entry.listener);
			}
		}
		send() {}
		close(code = 1000, reason = "") {
			this.readyState = 3;
			this.dispatch("close", { code, reason, wasClean: true, type: "close" });
		}
	}
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		TextEncoder,
		TextDecoder,
		WebSocket: FixtureWebSocket,
		PI_BROWSER_ERROR_CODES: {
			WEBSOCKET_INVALID_INPUT: "WEBSOCKET_INVALID_INPUT",
			WEBSOCKET_SESSION_ALREADY_OPEN: "WEBSOCKET_SESSION_ALREADY_OPEN",
			WEBSOCKET_SESSION_NOT_FOUND: "WEBSOCKET_SESSION_NOT_FOUND",
			WEBSOCKET_SESSION_NOT_OPEN: "WEBSOCKET_SESSION_NOT_OPEN",
			WEBSOCKET_OPEN_FAILED: "WEBSOCKET_OPEN_FAILED",
			WEBSOCKET_OPEN_TIMEOUT: "WEBSOCKET_OPEN_TIMEOUT",
			WEBSOCKET_SEND_FAILED: "WEBSOCKET_SEND_FAILED",
			WEBSOCKET_WAIT_ABORTED: "WEBSOCKET_WAIT_ABORTED",
			WEBSOCKET_WAIT_TIMEOUT: "WEBSOCKET_WAIT_TIMEOUT",
			WEBSOCKET_INVALID_MATCHER: "WEBSOCKET_INVALID_MATCHER",
		},
		piBrowserError: (code, message, details = {}) => ({ ok: false, error_code: code, error: message, details }),
		redactSensitive: (value) => value,
		chrome: { tabs: { get: async (tabId) => existingTabs.has(Number(tabId)) ? { id: Number(tabId), url: "https://fixture.test" } : (() => { throw new Error("missing tab"); })() } },
		rememberRuntimeSession: async (kind, tabId, sessionId, details = {}) => {
			runtimeState[`${kind}:${Number(tabId)}:${String(sessionId || "default")}`] = { kind, tabId: Number(tabId), sessionId: String(sessionId || "default"), active: true, workerBootId: bootId, updatedAt: Date.now(), details };
		},
		forgetRuntimeSession: async (kind, tabId, sessionId) => { delete runtimeState[`${kind}:${Number(tabId)}:${String(sessionId || "default")}`]; },
		findLostRuntimeSession: async (kind, tabId, sessionId) => {
			const record = runtimeState[`${kind}:${Number(tabId)}:${String(sessionId || "default")}`];
			return record && record.workerBootId !== bootId ? record : undefined;
		},
		summarizeLostRuntimeSession: (record) => record ? { stateLost: true, previousWorkerBootId: record.workerBootId, updatedAt: record.updatedAt, sessionId: record.sessionId, tabId: record.tabId, details: record.details } : undefined,
	};
	installRealStateStore(sandbox, storageState, bootId);
	vm.runInNewContext(`${wsSource}\nglobalThis.__wsRecoveryFixture = { handlePiBrowserWsCommand, runStartupRecovery };`, sandbox, { filename: `runtime-recovery-ws-${bootId}.js` });
	return { sandbox };
}

function createRecoveryCdpRuntime(storageState, bootId, existingTabs = new Set([66])) {
	const debuggerCalls = [];
	const sandbox = {
		console,
		self: null,
		setTimeout,
		clearTimeout,
		chrome: {
			tabs: { get: async (tabId) => existingTabs.has(Number(tabId)) ? { id: Number(tabId), url: "https://fixture.test" } : (() => { throw new Error("missing tab"); })() },
			debugger: {
				attach: async () => {},
				detach: async () => {},
				sendCommand: async (_target, method) => {
					debuggerCalls.push(method);
					if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "script-1" };
					if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", url: "https://fixture.test" } } };
					return {};
				},
				onDetach: { addListener() {} },
			},
		},
		normalizePersistentPiBrowserResponse: (value) => value,
	};
	sandbox.self = sandbox;
	installRealStateStore(sandbox, storageState, bootId);
	vm.runInNewContext(`${cdpSource}\nglobalThis.__cdpRecoveryFixture = { piPersistentCdpAddNewDocumentScript, piPersistentCdpRemoveNewDocumentScript, runStartupRecovery };`, sandbox, { filename: `runtime-recovery-cdp-${bootId}.js` });
	return { sandbox, debuggerCalls };
}

async function testRuntimeRecoveryContracts(diagnostics) {
	const storageState = {};
	const netBootA = createRecoveryNetworkRuntime(storageState, "boot-a", new Set([9]));
	const startedEmpty = await netBootA.sandbox.__networkRecoveryFixture.handleNetworkRecorderCommand(9, "network.start", { sessionId: "recovery-empty", captureBodies: true, storePostData: true, maxPostDataBytes: 321 });
	assert.equal(startedEmpty.ok, true);
	const startedCaptured = await netBootA.sandbox.__networkRecoveryFixture.handleNetworkRecorderCommand(9, "network.start", { sessionId: "recovery-captured", captureBodies: true, storePostData: true, maxPostDataBytes: 654 });
	assert.equal(startedCaptured.ok, true);
	const capturedRecorder = netBootA.sandbox.__networkRecoveryFixture.piBrowserNetworkRecorders.get("9:recovery-captured");
	assert(capturedRecorder, "network recovery fixture must create captured recorder");
	const capturedEntry = netBootA.sandbox.__networkRecoveryFixture.ensureNetworkEntry(capturedRecorder, "req-1");
	capturedEntry.request = { url: "https://fixture.test/api", method: "POST", headers: {}, hasPostData: true };
	capturedEntry.phase = "finished";
	capturedEntry.finishedAt = Date.now();
	capturedRecorder.entries.push(capturedEntry);
	const stateRecord = await netBootA.sandbox.getState("network", "9:recovery-captured");
	assert.equal(stateRecord.config.storePostData, true, "network persisted config must preserve raw recorder fields for recovery");
	const netBootB = createRecoveryNetworkRuntime(storageState, "boot-b", new Set([9]));
	const networkRecovery = await netBootB.sandbox.runStartupRecovery();
	assert.equal(networkRecovery.totals.recoveredWithHistoryLoss >= 2, true, "network recovery must report history loss for recovered recorders");
	const recoveredEmpty = await netBootB.sandbox.__networkRecoveryFixture.handleNetworkRecorderCommand(9, "network.status", { sessionId: "recovery-empty" });
	assert.equal(recoveredEmpty.data.historyLost, true);
	assert.equal(recoveredEmpty.data.recoveredAt !== undefined, true);
	assert.equal(recoveredEmpty.data.generation !== undefined, true);
	assert(netBootB.cdpCalls.some((call) => call.method === "Network.enable" && call.params?.maxPostDataSize === 321), "network recovery must restore Network.enable maxPostDataSize for persisted config");
	assert(netBootB.cdpCalls.some((call) => call.method === "Page.setLifecycleEventsEnabled"), "network recovery must restore lifecycle events");
	assert.equal(netBootB.sandbox.__networkRecoveryFixture.piBrowserNetworkRecorders.get("9:recovery-captured").entries.length, 0, "network recovery must not preserve old volatile entries");

	const interceptBootA = createRecoveryInterceptRuntime(storageState, "boot-a", new Set([41]));
	const installedIntercept = await interceptBootA.sandbox.__interceptRecoveryFixture.handlePiBrowserInterceptCommand("intercept.install", 41, { cmd: "intercept.install", sessionId: "contract", stages: ["request", "response"] });
	assert.equal(installedIntercept.ok, true);
	await interceptBootA.sandbox.__interceptRecoveryFixture.handlePiBrowserInterceptCommand("intercept.addRule", 41, { cmd: "intercept.addRule", sessionId: "contract", matcher: { urlContains: "/api" }, action: "continue" });
	const interceptBootB = createRecoveryInterceptRuntime(storageState, "boot-b", new Set([41]));
	const interceptRecovery = await interceptBootB.sandbox.runStartupRecovery();
	assert.equal(interceptRecovery.totals.recoveredWithHistoryLoss >= 1, true, "intercept recovery must report history loss");
	assert(interceptBootB.cdpCalls.some((call) => call.method === "Fetch.disable"), "intercept recovery must disable Fetch before re-enable");
	const recoveredIntercept = await interceptBootB.sandbox.__interceptRecoveryFixture.handlePiBrowserInterceptCommand("intercept.status", 41, { cmd: "intercept.status", sessionId: "contract" });
	assert.equal(recoveredIntercept.data.pausedLost, true);
	assert.equal(recoveredIntercept.data.historyLost, true);
	const lostPaused = await interceptBootB.sandbox.__interceptRecoveryFixture.handlePiBrowserInterceptCommand("intercept.continue", 41, { cmd: "intercept.continue", sessionId: "contract", requestId: "stale-1" });
	assert.equal(lostPaused.ok, false);
	assert.equal(lostPaused.error_code, "RUNTIME_STATE_LOST", "stale paused intercept requests must fail with runtime state lost");
	assert.equal(lostPaused.details.pausedLost, true);

	const hookBootA = createRecoveryHookRuntime(storageState, "boot-a", true, new Set([12]));
	const hookInstalled = await hookBootA.sandbox.__hookRecoveryFixture.handlePiBrowserHookCommand("hook.install", 12, { sessionId: "hook-fixture", targets: { console: true } });
	assert.equal(hookInstalled.ok, true);
	const hookBootB = createRecoveryHookRuntime(storageState, "boot-b", true, new Set([12]));
	const hookRecovered = await hookBootB.sandbox.runStartupRecovery();
	assert.equal(hookRecovered.totals.recovered >= 1, true, "hook recovery must rebuild metadata only when dispatcher still exists");
	const hookBootC = createRecoveryHookRuntime(storageState, "boot-c", false, new Set([12]));
	const hookLost = await hookBootC.sandbox.runStartupRecovery();
	assert.equal(hookLost.totals.lost >= 1, true, "hook recovery must mark missing dispatcher as lost without reinstall");

	const wsRuntimeState = {};
	const wsBootA = createRecoveryWsRuntime(storageState, wsRuntimeState, "boot-a", new Set([51]));
	const wsOpened = await wsBootA.sandbox.__wsRecoveryFixture.handlePiBrowserWsCommand("ws.open", 51, { cmd: "ws.open", tabId: 51, sessionId: "ws-contract", url: "ws://fixture/ws", timeoutMs: 1000 });
	assert.equal(wsOpened.ok, true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const wsBootB = createRecoveryWsRuntime(storageState, wsRuntimeState, "boot-b", new Set([51]));
	const wsRecovery = await wsBootB.sandbox.runStartupRecovery();
	assert.equal(wsRecovery.totals.lost >= 1, true, "ws recovery must report diagnostic-only lost sessions");
	const wsStatus = await wsBootB.sandbox.__wsRecoveryFixture.handlePiBrowserWsCommand("ws.status", 51, { cmd: "ws.status", tabId: 51, sessionId: "ws-contract" });
	assert.equal(wsStatus.data.stateLost, true, "ws.status after restart must expose explicit lost diagnostics");

	const cdpBootA = createRecoveryCdpRuntime(storageState, "boot-a", new Set([66]));
	const added = await cdpBootA.sandbox.__cdpRecoveryFixture.piPersistentCdpAddNewDocumentScript(66, "window.__piNds = 1;", { persistent: true, name: "new_document", runImmediately: true });
	assert.equal(added.ok, true);
	const cdpBootB = createRecoveryCdpRuntime(storageState, "boot-b", new Set([66]));
	const cdpRecovery = await cdpBootB.sandbox.runStartupRecovery();
	assert.equal(cdpRecovery.totals.lost >= 1, true, "cdp recovery must mark raw new-document scripts as lost");
	const removeLost = await cdpBootB.sandbox.__cdpRecoveryFixture.piPersistentCdpRemoveNewDocumentScript(66, "script-1", { persistent: true, name: "new_document" });
	assert.equal(removeLost.ok, false);
	assert.equal(removeLost.error?.code || removeLost.error_code, "RUNTIME_STATE_LOST", "new-document script removal after restart must return runtime state lost");

	diagnostics.runtimeRecovery = {
		networkRecovered: networkRecovery.totals.recoveredWithHistoryLoss,
		interceptRecovered: interceptRecovery.totals.recoveredWithHistoryLoss,
		hookRecovered: hookRecovered.totals.recovered,
		hookLost: hookLost.totals.lost,
		wsLost: wsRecovery.totals.lost,
		cdpLost: cdpRecovery.totals.lost,
	};
}

async function testStateStoreSerializesConcurrentWrites(diagnostics) {
	const storageState = {};
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		chrome: {
			storage: {
				session: {
					async get(key) { await new Promise((resolve) => setTimeout(resolve, 0)); return { [key]: storageState[key] }; },
					async set(value) { await new Promise((resolve) => setTimeout(resolve, 0)); Object.assign(storageState, value); },
				},
			},
			tabs: { async get(tabId) { return { id: tabId }; } },
		},
		PI_BROWSER_WORKER_BOOT_ID: 'state-store-fixture',
	};
	vm.runInNewContext(`${stateStoreSource}
globalThis.__stateStoreFixture = { persist, getAll };`, sandbox, { filename: 'runtime-fixture-state-store-serialize.js' });
	await Promise.all([
		sandbox.__stateStoreFixture.persist('network', 'one', { sessionId: 'one' }, { tabId: 1 }),
		sandbox.__stateStoreFixture.persist('network', 'two', { sessionId: 'two' }, { tabId: 2 }),
	]);
	await flushMicrotasks();
	const records = await sandbox.__stateStoreFixture.getAll('network');
	assert.equal(records.length, 2, 'state_store must preserve concurrent writes for the same kind');
	diagnostics.stateStore = { networkRecords: records.length };
}

async function main() {
	const diagnostics = { startedAt: new Date().toISOString() };
	const temp = await mkdtemp(path.join(os.tmpdir(), "pi-runtime-fixtures-"));
	try {
		diagnostics.temp = temp;
		await testNetworkHttpWsHarFixture(diagnostics);
		await testHookListenerAndWaitFixture(diagnostics);
		await testFrameEvaluateFixture(diagnostics);
		await testScreenshotFallbackFixture(diagnostics);
		await testTransferDownloadUploadFixture(diagnostics);
		await testCallbackWorkerStateFixture(diagnostics);
		await testStateStoreSerializesConcurrentWrites(diagnostics);
		await testRuntimeRecoveryContracts(diagnostics);
		await mkdir(artifactDir, { recursive: true });
		await rm(failureArtifact, { force: true });
		await writeFile(path.join(artifactDir, "runtime-fixtures-summary.json"), `${JSON.stringify({ ok: true, ...sanitize(diagnostics), finishedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
	} catch (error) {
		await writeFailure(error, diagnostics);
		throw error;
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}

await main();
console.log("runtime fixtures contract ok");
