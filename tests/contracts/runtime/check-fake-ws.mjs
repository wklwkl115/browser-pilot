import assert from "node:assert/strict";
import net from "node:net";
import { WebSocket } from "ws";
import { BrowserBridgeServer } from "../../../src/driver/BrowserBridgeServer.ts";
import { executeBrowserWaitWithSupervisor } from "../../../src/driver/BrowserWaitSupervisor.ts";
import { BrowserBridgeError } from "../../../src/driver/errors.ts";

const HOST = "127.0.0.1";

async function freePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, HOST, resolve);
	});
	const address = server.address();
	assert(address && typeof address === "object", "expected tcp address");
	const port = address.port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function openFakeClient(port, origin) {
	const options = origin === undefined ? undefined : { headers: { Origin: origin } };
	const ws = new WebSocket(`ws://${HOST}:${port}`, options);
	await withTimeout(new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	}), 1_000, "fake ws open");
	return ws;
}

async function rejectedFakeClient(port, origin) {
	const ws = new WebSocket(`ws://${HOST}:${port}`, { headers: { Origin: origin } });
	return await withTimeout(new Promise((resolve, reject) => {
		ws.once("open", () => reject(new Error(`unexpected websocket open for origin ${origin}`)));
		ws.once("error", resolve);
		ws.once("close", () => resolve(new Error("websocket closed before open")));
	}), 1_000, "fake ws rejected");
}

function sendJson(ws, message) {
	ws.send(JSON.stringify(message));
}

async function nextJson(ws, label = "fake ws message") {
	return await withTimeout(new Promise((resolve, reject) => {
		const onMessage = (data) => { cleanup(); try { resolve(JSON.parse(data.toString())); } catch (error) { reject(error); } };
		const onError = (error) => { cleanup(); reject(error); };
		const onClose = () => { cleanup(); reject(new Error(`${label} closed before message`)); };
		const cleanup = () => {
			ws.off("message", onMessage);
			ws.off("error", onError);
			ws.off("close", onClose);
		};
		ws.once("message", onMessage);
		ws.once("error", onError);
		ws.once("close", onClose);
	}), 1_000, label);
}

async function assertNoJson(ws, ms, label = "unexpected fake ws message") {
	await new Promise((resolve, reject) => {
		const onMessage = (data) => { cleanup(); reject(new Error(`${label}: ${data.toString()}`)); };
		const onError = (error) => { cleanup(); reject(error); };
		const cleanup = () => {
			clearTimeout(timer);
			ws.off("message", onMessage);
			ws.off("error", onError);
		};
		const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
		ws.once("message", onMessage);
		ws.once("error", onError);
	});
}

async function waitUntil(predicate, label) {
	const deadline = Date.now() + 1_000;
	let last;
	while (Date.now() < deadline) {
		last = predicate();
		if (last) return last;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`${label} not reached; last=${JSON.stringify(last)}`);
}

function readyMessage(tabs, bridge = {}) {
	return {
		type: "ext_ready",
		bridge: { id: "fake-extension", name: "Pi Native Browser Bridge", version: "test", ...bridge },
		tabs,
	};
}

async function testWaitSupervisorInstantTimeoutBackoff() {
	let calls = 0;
	const fakeServer = {
		snapshot() { return { extension: { id: "fake-browser", workerBootId: "boot-timeout" } }; },
		async sendCommand(command) {
			calls += 1;
			throw new BrowserBridgeError("BROWSER_EXECUTION_ERROR", "instant lease timeout", {
				result: { ok: false, error_code: "TIMEOUT", error: "instant lease timeout", details: { timeoutMs: command.timeoutMs } },
			});
		},
		async waitForExtensionReconnect() { throw new Error("unexpected reconnect wait"); },
	};
	await assert.rejects(executeBrowserWaitWithSupervisor(fakeServer, { cmd: "wait.selector", selector: "#never", timeoutMs: 180 }, { tabId: 1, timeoutMs: 180 }), (error) => {
		assert.equal(error.code, "WAIT_TIMEOUT");
		assert.equal(error.details.supervisor.attempts, calls);
		assert.ok(calls <= 8, `instant lease timeouts must be throttled, got ${calls} attempts`);
		assert.ok(error.details.supervisor.leases.some((lease) => lease.retryDelayMs > 0), "lease_timeout retries must record throttle delay diagnostics");
		assert.equal(error.details.supervisor.selectorTimeout.selector, "#never", "selector timeouts must surface the selector being waited for");
		assert.ok(error.details.supervisor.selectorTimeout.recoveryCommands.some((cmd) => String(cmd).includes("browser_wait action=diagnose")), "selector timeout recovery must include a diagnose command");
		assert.ok(error.details.supervisor.selectorTimeout.recoveryCommands.some((cmd) => String(cmd).includes("browser_observe mode=scan")), "selector timeout recovery must include a re-observe command");
		return true;
	});
}

await testWaitSupervisorInstantTimeoutBackoff();

const port = await freePort();
const server = new BrowserBridgeServer({ host: HOST, port });
let ws;
let ws2;
try {
	await Promise.all([server.start(), server.start()]);
	assert.equal(server.running, true, "concurrent start calls must share one running bridge server");
	const rejectedOrigin = await rejectedFakeClient(port, "http://evil.example");
	assert.match(rejectedOrigin.message || String(rejectedOrigin), /403|closed|Unexpected server response/i, "bridge websocket must reject page origins");
	const extensionOriginWs = await openFakeClient(port, "chrome-extension://fixture-extension");
	extensionOriginWs.close();
	ws = await openFakeClient(port);
	sendJson(ws, readyMessage([{ id: 101, url: "https://example.test/one", title: "One", active: true, windowId: 1 }]));
	await waitUntil(() => server.snapshot().extensionConnected && server.getTabs().length === 1, "ext_ready tabs registration");
	assert.equal(server.snapshot().defaultTabId, 101);
	assert.equal(server.getTabs()[0]?.bridge?.name, "Pi Native Browser Bridge");
	assert.equal(server.snapshot().extension?.extensionStale, true, "missing ext_ready build field must mark the loaded extension stale");
	assert.ok(server.snapshot().extension?.expectedBuild, "stale extension diagnostics must expose the expected build id");

	const commandPromise = server.sendCommand({ cmd: "tabs", method: "list" }, { timeoutMs: 1_000 });
	const outbound = await nextJson(ws, "tabs command outbound");
	assert.equal(outbound.code.cmd, "tabs");
	assert.equal(outbound.code.method, "list");
	sendJson(ws, { type: "ack", id: outbound.id });
	sendJson(ws, { type: "result", id: outbound.id, result: [{ id: 101, active: true }], newTabs: [{ id: 102 }], diagnostics: { execute: { newTabObservationWaitTriggered: false, newTabObservationWaitMs: 0 } } });
	const commandResult = await commandPromise;
	assert.equal(commandResult.id, outbound.id);
	assert.equal(commandResult.acknowledged, true);
	assert.deepEqual(commandResult.data, [{ id: 101, active: true }]);
	assert.deepEqual(commandResult.newTabs, [{ id: 102 }]);
	assert.deepEqual(commandResult.diagnostics?.execute, { newTabObservationWaitTriggered: false, newTabObservationWaitMs: 0 });

	await assert.rejects(server.sendCommand({ cmd: "missing.command" }, { timeoutMs: 1_000 }), (error) => {
		assert.equal(error.code, "INVALID_BROWSER_COMMAND");
		assert.match(error.message, /Unknown bridge command/);
		return true;
	});
	await assert.rejects(server.sendCommand({ cmd: "tabs", method: "explode" }, { timeoutMs: 1_000 }), (error) => {
		assert.equal(error.code, "INVALID_BROWSER_COMMAND");
		assert.match(error.message, /Unsupported method/);
		return true;
	});
	await assert.rejects(server.sendCommand({ cmd: "content.fingerprint", tabId: 101 }, { tabId: 101, timeoutMs: 1_000 }), (error) => {
		assert.equal(error.code, "INVALID_BROWSER_COMMAND");
		assert.match(error.message, /internal-only/);
		return true;
	});
	const internalFingerprintPromise = server.sendCommand({ cmd: "content.fingerprint", tabId: 101 }, { tabId: 101, timeoutMs: 1_000, internal: true });
	const fingerprintOutbound = await nextJson(ws, "internal content fingerprint outbound");
	assert.equal(fingerprintOutbound.code.cmd, "content.fingerprint");
	assert.equal(fingerprintOutbound.code.tabId, 101);
	sendJson(ws, { type: "ack", id: fingerprintOutbound.id });
	sendJson(ws, { type: "result", id: fingerprintOutbound.id, result: { changeSeq: 4, url: "https://example.test/one" } });
	const internalFingerprintResult = await internalFingerprintPromise;
	assert.equal(internalFingerprintResult.data.changeSeq, 4);
	await assert.rejects(server.sendCommand({ cmd: "wait.selector", tabId: 101 }, { timeoutMs: 1_000 }), (error) => {
		assert.equal(error.code, "INVALID_BROWSER_COMMAND");
		assert.deepEqual(error.details.missing, ["selector"]);
		return true;
	});
	await assert.rejects(server.sendCommand({ cmd: "wait.selector", tabId: 101, selector: "body" }, { tabId: 202, timeoutMs: 1_000 }), (error) => {
		assert.equal(error.code, "TAB_ID_CONFLICT");
		assert.equal(error.details.tabId, 202);
		assert.equal(error.details.commandTabId, 101);
		return true;
	});
	await assert.rejects(server.sendCommand({ cmd: "wait.selector", tabId: "abc", selector: "body" }, { timeoutMs: 1_000 }), (error) => {
		assert.equal(error.code, "INVALID_TAB_ID");
		assert.equal(error.details.source, "command");
		assert.equal(error.details.tabId, "abc");
		return true;
	});
	await assert.rejects(server.sendCommand({ cmd: "wait.selector", selector: "body" }, { tabId: "abc", timeoutMs: 1_000 }), (error) => {
		assert.equal(error.code, "INVALID_TAB_ID");
		assert.equal(error.details.source, "options");
		assert.equal(error.details.tabId, "abc");
		return true;
	});
	const normalizedCommandPromise = server.sendCommand({ cmd: "wait.selector", tabId: "101", selector: "body", timeoutMs: 100 }, { tabId: 101, timeoutMs: 1_000 });
	const normalizedOutbound = await nextJson(ws, "normalized tab command outbound");
	assert.equal(normalizedOutbound.tabId, 101);
	assert.equal(normalizedOutbound.code.tabId, 101);
	assert.equal(normalizedOutbound.code.selector, "body");
	sendJson(ws, { type: "ack", id: normalizedOutbound.id });
	sendJson(ws, { type: "result", id: normalizedOutbound.id, result: { ok: true, tabId: 101 } });
	const normalizedResult = await normalizedCommandPromise;
	assert.equal(normalizedResult.data.tabId, 101);

	await assert.rejects(server.executeJavaScript("return 1", { tabId: "abc", timeoutMs: 1_000 }), (error) => {
		assert.equal(error.code, "INVALID_TAB_ID");
		assert.equal(error.details.source, "options");
		assert.equal(error.details.tabId, "abc");
		return true;
	});
	const timeoutPromise = server.executeJavaScript("return 1", { tabId: 101, timeoutMs: 120 });
	const rejection = assert.rejects(timeoutPromise, (error) => {
		assert.equal(error.code, "BRIDGE_TIMEOUT");
		assert.equal(error.details.acked, true);
		assert.equal(error.details.tabId, 101);
		return true;
	});
	const timeoutOutbound = await nextJson(ws, "timeout command outbound");
	assert.equal(timeoutOutbound.tabId, 101);
	sendJson(ws, { type: "ack", id: timeoutOutbound.id });
	await rejection;
	assert.equal(server.snapshot().pending.length, 0);

	const disconnectPromise = server.executeJavaScript("return 2", { tabId: 101, timeoutMs: 5_000 });
	const disconnectOutbound = await nextJson(ws, "disconnect command outbound");
	sendJson(ws, { type: "ack", id: disconnectOutbound.id });
	const disconnectStarted = Date.now();
	const disconnectRejection = assert.rejects(disconnectPromise, (error) => {
		assert.equal(error.code, "BRIDGE_CLIENT_DISCONNECTED");
		assert.equal(error.details.id, disconnectOutbound.id);
		assert.equal(error.details.tabId, 101);
		assert.equal(error.details.acked, true);
		assert.ok(Date.now() - disconnectStarted < 1_000, "pending request should reject immediately on websocket disconnect");
		return true;
	});
	ws.close();
	await disconnectRejection;
	await waitUntil(() => !server.snapshot().extensionConnected && server.snapshot().pending.length === 0, "pending cleanup after websocket disconnect");
	ws = await openFakeClient(port);
	sendJson(ws, readyMessage([{ id: 101, url: "https://example.test/one", title: "One", active: true, windowId: 1 }], { workerBootId: "boot-wait-a", workerStartedAt: 1000 }));
	await waitUntil(() => server.snapshot().extensionConnected && server.getTabs().some((tab) => tab.tabId === 101 && !tab.disconnectedAt), "reconnect after pending cleanup");
	assert.equal(server.snapshot().extension?.workerBootId, "boot-wait-a", "bridge snapshot must expose service worker boot identity");
	assert.equal(server.snapshot().extension?.extensionStale, true, "missing build on reconnect remains stale");

	const durableWaitPromise = executeBrowserWaitWithSupervisor(server, { cmd: "wait.selector", selector: "#ready", timeoutMs: 60_000 }, { tabId: 101, timeoutMs: 60_000 });
	const durableWaitFirstOutbound = await nextJson(ws, "durable wait first lease outbound");
	assert.equal(durableWaitFirstOutbound.code.cmd, "wait.selector");
	assert.equal(durableWaitFirstOutbound.code.waitId, durableWaitFirstOutbound.code.wait_id);
	assert.ok(durableWaitFirstOutbound.code.timeoutMs <= 25_000, "durable wait must use a short service-worker lease");
	ws.close();
	await waitUntil(() => !server.snapshot().extensionConnected, "durable wait disconnected first lease");
	ws = await openFakeClient(port);
	sendJson(ws, readyMessage([{ id: 101, url: "https://example.test/one", title: "One", active: true, windowId: 1 }], { workerBootId: "boot-wait-b", workerStartedAt: 2000 }));
	await waitUntil(() => server.snapshot().extension?.workerBootId === "boot-wait-b", "durable wait service worker reconnect");
	const durableWaitSecondOutbound = await nextJson(ws, "durable wait second lease outbound");
	assert.equal(durableWaitSecondOutbound.code.cmd, "wait.selector");
	assert.equal(durableWaitSecondOutbound.code.waitId, durableWaitFirstOutbound.code.waitId, "durable wait retries must preserve waitId for diagnosis");
	sendJson(ws, { type: "result", id: durableWaitSecondOutbound.id, result: { ok: true, selector: "#ready", bridge: { workerBootId: "boot-wait-b", workerStartedAt: 2000 } } });
	const durableWaitResult = await durableWaitPromise;
	assert.equal(durableWaitResult.data.selector, "#ready");
	assert.equal(durableWaitResult.data.supervisor.durable, true);
	assert.equal(durableWaitResult.data.supervisor.waitId, durableWaitFirstOutbound.code.waitId);
	assert.equal(durableWaitResult.data.supervisor.workerRestarts, 1);
	assert.equal(durableWaitResult.data.supervisor.historyLost, true);
	assert.equal(durableWaitResult.data.supervisor.leases[0].status, "disconnect");
	assert.equal(durableWaitResult.data.supervisor.leases.at(-1).status, "success");

	const zeroWaitPromise = executeBrowserWaitWithSupervisor(server, { cmd: "wait.selector", selector: "#instant" }, { tabId: 101, timeoutMs: 0 });
	const zeroWaitOutbound = await nextJson(ws, "zero-timeout wait outbound");
	assert.equal(zeroWaitOutbound.code.cmd, "wait.selector");
	assert.equal(zeroWaitOutbound.code.timeoutMs, 0, "timeoutMs=0 must reach the bridge as an immediate check");
	sendJson(ws, { type: "result", id: zeroWaitOutbound.id, result: { ok: true, selector: "#instant", immediate: true, bridge: { workerBootId: "boot-wait-b", workerStartedAt: 2000 } } });
	const zeroWaitResult = await zeroWaitPromise;
	assert.equal(zeroWaitResult.data.immediate, true);
	assert.equal(zeroWaitResult.data.supervisor.totalTimeoutMs, 0);
	assert.equal(zeroWaitResult.data.supervisor.leases[0].timeoutMs, 0);
	assert.equal(zeroWaitResult.data.supervisor.leases[0].status, "success");

	const lateSuccessPromise = executeBrowserWaitWithSupervisor(server, { cmd: "wait.selector", selector: "#late", timeoutMs: 90 }, { tabId: 101, timeoutMs: 90 });
	const lateSuccessOutbound = await nextJson(ws, "late wait success outbound");
	assert.equal(lateSuccessOutbound.code.cmd, "wait.selector");
	assert.ok(lateSuccessOutbound.code.timeoutMs > 0 && lateSuccessOutbound.code.timeoutMs <= 90, "first wait lease must stay within the total deadline");
	await new Promise((resolve) => setTimeout(resolve, 140));
	sendJson(ws, { type: "result", id: lateSuccessOutbound.id, result: { ok: true, selector: "#late", bridge: { workerBootId: "boot-wait-b", workerStartedAt: 2000 } } });
	await assert.rejects(lateSuccessPromise, (error) => {
		assert.equal(error.code, "WAIT_TIMEOUT");
		assert.equal(error.details.supervisor.command, "wait.selector");
		assert.equal(error.details.supervisor.totalTimeoutMs, 90);
		assert.equal(error.details.supervisor.leases.at(-1).status, "late_success");
		return true;
	});

	const lostWaitPromise = executeBrowserWaitWithSupervisor(server, { cmd: "wait.networkIdle", timeoutMs: 2_000 }, { tabId: 101, timeoutMs: 2_000 });
	const lostWaitOutbound = await nextJson(ws, "lost wait outbound");
	assert.equal(lostWaitOutbound.code.cmd, "wait.networkIdle");
	await assert.rejects(lostWaitPromise, (error) => {
		assert.equal(error.code, "WAIT_STATE_LOST");
		assert.equal(error.details.supervisor.leases.at(-1).status, "bridge_timeout");
		return true;
	});
	sendJson(ws, { type: "result", id: lostWaitOutbound.id, result: { ok: true, late: true } });

		// Node-side reroute: `wait.loadState {state:"networkidle"}` must be normalized to
		// `wait.networkIdle` BEFORE dispatch, so a STALE loaded extension cannot reintroduce
		// `INVALID_RULE: wait.loadState unsupported state` (real 2026-06-05 + 2026-06-09 sessions).
		const rerouteWaitPromise = executeBrowserWaitWithSupervisor(server, { cmd: "wait.loadState", state: "networkidle", timeoutMs: 2_000 }, { tabId: 101, timeoutMs: 2_000 });
		const rerouteWaitOutbound = await nextJson(ws, "loadState networkidle reroute outbound");
		assert.equal(rerouteWaitOutbound.code.cmd, "wait.networkIdle", "wait.loadState state:networkidle must reroute to wait.networkIdle on the Node side (robust to stale extension)");
		assert.equal(rerouteWaitOutbound.code.state, undefined, "rerouted networkIdle command must drop the loadState state key");
		sendJson(ws, { type: "result", id: rerouteWaitOutbound.id, result: { ok: true, networkIdle: true, bridge: { workerBootId: "boot-wait-b", workerStartedAt: 2000 } } });
		const rerouteWaitResult = await rerouteWaitPromise;
		assert.equal(rerouteWaitResult.data.networkIdle, true, "rerouted wait.networkIdle must resolve normally");

	const navigateBudgetPromise = executeBrowserWaitWithSupervisor(server, { cmd: "wait.navigateAndWait", url: "https://example.test/slow", state: "complete", timeoutMs: 120 }, { tabId: 101, timeoutMs: 120 });
	const navigateBudgetOutbound = await nextJson(ws, "navigateAndWait budget navigation outbound");
	assert.equal(navigateBudgetOutbound.code.cmd, "wait.navigate");
	assert.equal(navigateBudgetOutbound.code.timeoutMs, 120);
	await new Promise((resolve) => setTimeout(resolve, 160));
	sendJson(ws, { type: "result", id: navigateBudgetOutbound.id, result: { ok: true, navigated: true, bridge: { workerBootId: "boot-wait-b", workerStartedAt: 2000 } } });
	await assert.rejects(navigateBudgetPromise, (error) => {
		assert.equal(error.code, "WAIT_TIMEOUT");
		assert.equal(error.details.supervisor.command, "wait.navigateAndWait");
		assert.equal(error.details.supervisor.totalTimeoutMs, 120);
		assert.equal(error.details.supervisor.leases.length, 0);
		return true;
	});
	await assertNoJson(ws, 80, "navigateAndWait must not start wait phase after total budget is exhausted");

	sendJson(ws, {
		type: "tabs_update",
		bridge: { id: "fake-extension", name: "Pi Native Browser Bridge", version: "test-2" },
		tabs: [{ id: 202, url: "https://example.test/two", title: "Two", active: true, windowId: 1 }],
	});
	await waitUntil(() => server.snapshot().defaultTabId === 202, "tabs_update default tab switch");
	const allTabs = server.getTabs({ includeDisconnected: true });
	assert.equal(allTabs.find((tab) => tab.tabId === 202)?.active, true);
	assert.ok(allTabs.find((tab) => tab.tabId === 101)?.disconnectedAt, "missing tab should be marked disconnected");

	sendJson(ws, {
		type: "tabs_update",
		bridge: { id: "fake-extension", name: "Pi Native Browser Bridge", version: "test-2" },
		tabs: [
			{ id: 202, url: "https://example.test/two", title: "Two", active: true, windowId: 1 },
			{ id: 505, url: "https://example.test/five", title: "Five", active: false, windowId: 1 },
		],
	});
	await waitUntil(() => server.snapshot().defaultTabId === 202 && server.snapshot().latestTabId === 505, "latest tab tracks newest same-client tab");
	const beforeSwitchSnapshot = server.snapshot();
	const concurrentSwitchPromise = server.switchTab(505, 1_000);
	const switchOutbound = await nextJson(ws, "concurrent switch outbound");
	assert.equal(switchOutbound.tabId, 505);
	assert.equal(switchOutbound.code.method, "switch");
	const implicitExecutePromise = server.executeJavaScript("return 'old-default'", { timeoutMs: 1_000 });
	const implicitExecuteOutbound = await nextJson(ws, "implicit execute during switch outbound");
	assert.equal(implicitExecuteOutbound.tabId, 202, "implicit execute must use the selected-tab snapshot captured before switch resolves");
	sendJson(ws, { type: "ack", id: switchOutbound.id });
	sendJson(ws, { type: "result", id: switchOutbound.id, result: { ok: true } });
	const switchResult = await concurrentSwitchPromise;
	assert.equal(switchResult.data.selectedTabId, 505);
	assert.equal(switchResult.data.previousDefaultTabId, 202);
	assert.ok(switchResult.data.selectionVersion > beforeSwitchSnapshot.selectionVersion, "switch success must advance selectionVersion when default tab changes");
	assert.equal(server.snapshot().defaultTabId, 505);
	sendJson(ws, { type: "ack", id: implicitExecuteOutbound.id });
	sendJson(ws, { type: "result", id: implicitExecuteOutbound.id, result: "old-default" });
	const implicitExecuteResult = await implicitExecutePromise;
	assert.equal(implicitExecuteResult.data, "old-default");
	assert.equal(implicitExecuteResult.target.tabId, 202);
	assert.equal(implicitExecuteResult.target.source, "default");
	assert.equal(implicitExecuteResult.target.implicit, true);
	assert.equal(implicitExecuteResult.target.selectionVersionAtDispatch, beforeSwitchSnapshot.selectionVersion);
	assert.equal(implicitExecuteResult.target.selectionVersionAtResolve, switchResult.data.selectionVersion, "implicit execute result must expose current selectionVersion at resolve time");
	sendJson(ws, {
		type: "tabs_update",
		bridge: { id: "fake-extension", name: "Pi Native Browser Bridge", version: "test-2" },
		tabs: [{ id: 202, url: "https://example.test/two", title: "Two", active: true, windowId: 1 }],
	});
	await waitUntil(() => server.snapshot().latestTabId === 202, "tabs_update clears stale latest tab reference");
	assert.ok(server.getTabs({ includeDisconnected: true }).find((tab) => tab.tabId === 505)?.disconnectedAt, "missing latest tab should be marked disconnected");

	sendJson(ws, readyMessage([
		{ id: 611, url: "https://example.test/eleven", title: "Eleven", active: false, windowId: 1 },
		{ id: 613, url: "https://example.test/thirteen", title: "Thirteen", active: true, windowId: 2 },
		{ id: 612, url: "https://example.test/twelve", title: "Twelve", active: true, windowId: 1 },
	]));
	await waitUntil(() => server.snapshot().defaultTabId === 612 && server.snapshot().latestTabId === 612, "multi-window active tab seed");
	const disconnectedDefault = Array.from(server.sessions.values()).find((tab) => tab.tabId === 612 && !tab.disconnectedAt);
	assert.ok(disconnectedDefault, "default tab session must exist before refresh fallback test");
	disconnectedDefault.disconnectedAt = Date.now();
	assert.equal(server.snapshot().defaultTabId, 613, "refresh fallback must prefer a remaining active tab over an older inactive tab");
	assert.equal(server.snapshot().latestTabId, 613, "refresh fallback must move stale latest to the same active fallback");

	ws2 = await openFakeClient(port);
	sendJson(ws2, readyMessage([{ id: 606, url: "https://example.test/six", title: "Six", active: false, windowId: 2 }]));
	await waitUntil(() => server.snapshot().latestTabId === 606, "secondary inactive tab registration");
	ws.close();
	await waitUntil(() => server.snapshot().defaultTabId === 606 && server.snapshot().latestTabId === 606, "disconnect clears stale selected tab references");
	const fallbackPromise = server.executeJavaScript("return 606", { timeoutMs: 1_000 });
	const fallbackOutbound = await nextJson(ws2, "fallback after default disconnect outbound");
	assert.equal(fallbackOutbound.tabId, 606);
	sendJson(ws2, { type: "ack", id: fallbackOutbound.id });
	sendJson(ws2, { type: "result", id: fallbackOutbound.id, result: 606 });
	assert.equal((await fallbackPromise).data, 606);
	ws = ws2;
	ws2 = undefined;

	sendJson(ws, readyMessage([
		{ id: 606, url: "https://example.test/six", title: "Six", active: false, windowId: 2 },
		{ id: 607, url: "https://example.test/seven", title: "Seven", active: true, windowId: 2 },
	]));
	await waitUntil(() => server.snapshot().defaultTabId === 607 && server.snapshot().latestTabId === 607, "first browser active tab registration");
	const firstBrowserId = server.snapshot().extension?.id;
	ws2 = await openFakeClient(port);
	sendJson(ws2, readyMessage([{ id: 607, url: "https://duplicate.example.test/seven", title: "Second Seven", active: true, windowId: 3 }]));
	await waitUntil(() => server.snapshot().extension?.id && server.snapshot().extension?.id !== firstBrowserId, "second browser arbitration");
	const secondBrowserId = server.snapshot().extension?.id;
	await waitUntil(() => server.getTabs().filter((tab) => tab.tabId === 607 && !tab.disconnectedAt).length === 2, "duplicate tab ids retained across browsers");
	const duplicateTabs = server.getTabs().filter((tab) => tab.tabId === 607 && !tab.disconnectedAt);
	assert.equal(new Set(duplicateTabs.map((tab) => tab.browserId)).size, 2, "duplicate numeric tabIds must keep browser scope");
	assert.equal(new Set(duplicateTabs.map((tab) => tab.id)).size, 2, "duplicate numeric tabIds must have distinct session ids");
	const selected = server.selectBrowser(firstBrowserId);
	assert.equal(selected.id, firstBrowserId);
	assert.equal(server.snapshot().extension?.id, firstBrowserId);
	assert.equal(server.snapshot().defaultTabId, 607, "selectBrowser must prefer the selected browser active tab");
	const firstScopedDuplicatePromise = server.executeJavaScript("return 'first-607'", { tabId: 607, timeoutMs: 1_000 });
	const firstScopedDuplicateOutbound = await nextJson(ws, "first browser duplicate tab outbound");
	assert.equal(firstScopedDuplicateOutbound.tabId, 607);
	await assertNoJson(ws2, 50, "duplicate tabId selected for first browser must not dispatch to second browser");
	sendJson(ws, { type: "ack", id: firstScopedDuplicateOutbound.id });
	sendJson(ws, { type: "result", id: firstScopedDuplicateOutbound.id, result: "first-607" });
	assert.equal((await firstScopedDuplicatePromise).data, "first-607");
	const queuedFirst = server.executeJavaScript("return 'queued-first'", { tabId: 607, timeoutMs: 1_000 });
	const queuedSecond = server.executeJavaScript("return 'queued-second'", { tabId: 607, timeoutMs: 1_000 });
	const queuedFirstOutbound = await nextJson(ws, "queued first outbound");
	await assertNoJson(ws, 50, "same-session same-tab queue must serialize second command until first resolves");
	sendJson(ws, { type: "ack", id: queuedFirstOutbound.id });
	sendJson(ws, { type: "result", id: queuedFirstOutbound.id, result: "queued-first" });
	assert.equal((await queuedFirst).data, "queued-first");
	const queuedSecondOutbound = await nextJson(ws, "queued second outbound");
	sendJson(ws, { type: "ack", id: queuedSecondOutbound.id });
	sendJson(ws, { type: "result", id: queuedSecondOutbound.id, result: "queued-second" });
	assert.equal((await queuedSecond).data, "queued-second");
	server.selectBrowser(secondBrowserId);
	const secondScopedDuplicatePromise = server.executeJavaScript("return 'second-607'", { tabId: 607, timeoutMs: 1_000 });
	const secondScopedDuplicateOutbound = await nextJson(ws2, "second browser duplicate tab outbound");
	assert.equal(secondScopedDuplicateOutbound.tabId, 607);
	await assertNoJson(ws, 50, "duplicate tabId selected for second browser must not dispatch to first browser");
	sendJson(ws2, { type: "ack", id: secondScopedDuplicateOutbound.id });
	sendJson(ws2, { type: "result", id: secondScopedDuplicateOutbound.id, result: "second-607" });
	assert.equal((await secondScopedDuplicatePromise).data, "second-607");
	server.selectBrowser(firstBrowserId);
	const createdBrowserSession = server.createBrowserSession("secondary fixture");
	assert.equal(createdBrowserSession.defaultTabId, undefined, "new browser sessions must start without an implicit tab");
	await assert.rejects(server.executeJavaScript("return 'empty-session'", { browserSessionId: createdBrowserSession.id, timeoutMs: 1_000 }), (error) => {
		assert.equal(error.code, "NO_TAB");
		return true;
	});
	const attachedTab = server.attachTabToBrowserSession(607, { browserSessionId: createdBrowserSession.id, browserId: secondBrowserId });
	assert.equal(attachedTab.tabId, 607);
	assert.equal(server.snapshot({ browserSessionId: createdBrowserSession.id }).extension?.id, secondBrowserId);
	const attachedSessionPromise = server.executeJavaScript("return 'attached-session-607'", { browserSessionId: createdBrowserSession.id, tabId: 607, timeoutMs: 1_000 });
	const attachedSessionOutbound = await nextJson(ws2, "attached browser session duplicate tab outbound");
	assert.equal(attachedSessionOutbound.tabId, 607);
	sendJson(ws2, { type: "ack", id: attachedSessionOutbound.id });
	sendJson(ws2, { type: "result", id: attachedSessionOutbound.id, result: "attached-session-607" });
	assert.equal((await attachedSessionPromise).data, "attached-session-607");
	server.detachTabFromBrowserSession(607, { browserSessionId: createdBrowserSession.id });
	await assert.rejects(server.executeJavaScript("return 'detached-session'", { browserSessionId: createdBrowserSession.id, timeoutMs: 1_000 }), (error) => {
		assert.equal(error.code, "NO_TAB");
		return true;
	});
	const scopedSecondary = server.createBrowserSession("scoped-secondary");
	server.selectBrowser(secondBrowserId, { browserSessionId: scopedSecondary.id });
	assert.equal(server.snapshot().extension?.id, firstBrowserId, "scoped selectBrowser must not replace the default browser session selection");
	assert.equal(server.snapshot({ browserSessionId: scopedSecondary.id }).extension?.id, secondBrowserId, "scoped snapshot must expose scoped browser selection");
	const heldLease = server.leaseTab(607, { browserSessionId: scopedSecondary.id });
	assert.equal(heldLease.browserSessionId, scopedSecondary.id);
	const leaseContender = server.createBrowserSession("lease-contender");
	server.selectBrowser(secondBrowserId, { browserSessionId: leaseContender.id });
	await assert.rejects(server.executeJavaScript("return 'lease-conflict'", { browserSessionId: leaseContender.id, tabId: 607, timeoutMs: 1_000 }), (error) => {
		assert.equal(error.code, "TAB_LEASE_CONFLICT");
		return true;
	});
	server.releaseTab(607, { browserSessionId: scopedSecondary.id });
	server.acquireUiLock(scopedSecondary.id, "fixture");
	assert.throws(() => server.acquireUiLock(leaseContender.id, "fixture"), (error) => {
		assert.equal(error.code, "UI_LOCK_CONFLICT");
		return true;
	});
	server.releaseUiLock(scopedSecondary.id);
	const explicitSessionPromise = server.executeJavaScript("return 'scoped-secondary-607'", { browserSessionId: scopedSecondary.id, tabId: 607, timeoutMs: 1_000 });
	const explicitSessionOutbound = await nextJson(ws2, "explicit browser session duplicate tab outbound");
	assert.equal(explicitSessionOutbound.tabId, 607);
	await assertNoJson(ws, 50, "explicit browserSessionId dispatch must not use default browser selection");
	sendJson(ws2, { type: "ack", id: explicitSessionOutbound.id });
	sendJson(ws2, { type: "result", id: explicitSessionOutbound.id, result: "scoped-secondary-607" });
	const explicitSessionResult = await explicitSessionPromise;
	assert.equal(explicitSessionResult.data, "scoped-secondary-607");
	assert.equal(explicitSessionResult.target.browserSessionId, scopedSecondary.id);
	server.selectBrowser(firstBrowserId);
	ws2.close();
	ws2 = undefined;

	ws2 = await openFakeClient(port);
	sendJson(ws2, readyMessage([], { id: "empty-extension", name: "Empty Browser", version: "empty" }));
	await waitUntil(() => server.snapshot().extension?.extensionId === "empty-extension", "empty browser registration");
	server.selectBrowser(firstBrowserId);
	assert.equal(server.snapshot().defaultTabId, 607, "selecting the populated browser must restore its active implicit tab");
	assert.throws(() => server.selectBrowser("empty-extension"), (error) => {
		assert.equal(error.code, "NO_TAB");
		assert.equal(error.details.browserId, "empty-extension");
		return true;
	});
	assert.equal(server.snapshot().extension?.extensionId, "empty-extension", "empty selected browser remains the selected client");
	assert.equal(server.snapshot().defaultTabId, undefined, "selecting an empty browser must clear default tab instead of preserving another client's tab");
	assert.equal(server.snapshot().latestTabId, undefined, "selecting an empty browser must clear latest tab instead of preserving another client's tab");
	await assert.rejects(server.executeJavaScript("return 'must-not-dispatch'", { timeoutMs: 1_000 }), (error) => {
		assert.equal(error.code, "NO_TAB");
		return true;
	});
	await assert.rejects(server.sendCommand({ cmd: "wait.selector", selector: "body" }, { timeoutMs: 1_000 }), (error) => {
		assert.equal(error.code, "NO_TAB");
		return true;
	});
	await assertNoJson(ws, 80, "empty-browser implicit execute must not dispatch to previous browser");
	await assertNoJson(ws2, 80, "empty-browser implicit execute must not dispatch without a tab");
	ws2.close();
	ws2 = undefined;
	const reselected = server.selectBrowser(firstBrowserId);
	assert.equal(reselected.id, firstBrowserId);
	assert.equal(server.snapshot().defaultTabId, 607, "reselecting populated browser restores active implicit tab after empty selection");

	const previousClientId = server.snapshot().extension?.id;
	const reconnectPromise = server.waitForExtensionReconnect(previousClientId, 1_000);
	ws.close();
	await waitUntil(() => !server.snapshot().extensionConnected, "extension disconnect before reconnect");
	ws = await openFakeClient(port);
	sendJson(ws, readyMessage([{ id: 303, url: "https://example.test/three", title: "Three", active: true, windowId: 1 }]));
	const reconnect = await reconnectPromise;
	assert.notEqual(reconnect.extension?.id, previousClientId);
	assert.equal(reconnect.defaultTabId, 303);

	sendJson(ws, readyMessage([{ id: 7000, url: "https://example.test/prune/0", title: "Prune 0", active: true, windowId: 1 }]));
	await waitUntil(() => server.snapshot().defaultTabId === 7000, "session pruning seed");
	for (let i = 1; i <= 150; i += 1) {
		sendJson(ws, readyMessage([{ id: 7000 + i, url: `https://example.test/prune/${i}`, title: `Prune ${i}`, active: true, windowId: 1 }]));
	}
	await waitUntil(() => server.snapshot().defaultTabId === 7150, "bounded disconnected session pruning");
	assert.ok(server.getTabs({ includeDisconnected: true }).filter((tab) => tab.disconnectedAt).length <= 128, "disconnected session history should be bounded");
	for (const session of server.sessions.values()) {
		if (session.disconnectedAt) session.disconnectedAt = Date.now() - 301_000;
	}
	assert.equal(server.getTabs({ includeDisconnected: true }).filter((tab) => tab.disconnectedAt).length, 0, "expired disconnected sessions should be pruned");
	assert.equal(server.snapshot().defaultTabId, 7150, "session pruning must keep active tab selection");

	await assert.rejects(server.sendCommand({ cmd: "wait.selector", selector: "body" }, { tabId: 7999, timeoutMs: 1_000 }), (error) => {
		assert.equal(error.code, "TAB_NOT_FOUND");
		assert.equal(error.details.tabId, 7999);
		return true;
	});
	await assertNoJson(ws, 80, "explicit stale tabId must fail locally instead of dispatching to the selected browser");

	const failedSwitchPromise = server.switchTab(7150, 1_000);
	const failedSwitchOutbound = await nextJson(ws, "failed switch outbound");
	assert.equal(failedSwitchOutbound.code.cmd, "tabs");
	assert.equal(failedSwitchOutbound.code.method, "switch");
	assert.equal(failedSwitchOutbound.code.tabId, 7150);
	sendJson(ws, { type: "ack", id: failedSwitchOutbound.id });
	sendJson(ws, { type: "result", id: failedSwitchOutbound.id, result: { ok: false, error: "cannot switch tab", details: { tabId: 7150 } } });
	await assert.rejects(failedSwitchPromise, (error) => {
		assert.equal(error.code, "BROWSER_COMMAND_FAILED");
		assert.match(error.message, /cannot switch tab/);
		return true;
	});
	assert.equal(server.snapshot().defaultTabId, 7150, "failed switchTab result must not update default tab");

	const replaceSource = server.getTabs().find((tab) => tab.tabId === 7150 && !tab.disconnectedAt);
	assert.ok(replaceSource?.tabHandle, "replacement fixture source must expose a stable tabHandle");
	const heldReplacementLease = server.leaseTab(7150);
	assert.equal(heldReplacementLease.tabId, 7150);
	sendJson(ws, {
		type: "tabs_update",
		bridge: { id: "fake-extension", name: "Pi Native Browser Bridge", version: "test-2" },
		replaced: [{ from: 7150, to: 7151, at: Date.now() }],
		tabs: [{ id: 7151, url: "https://example.test/prune/replaced", title: "Prune Replaced", active: true, windowId: 1, openerTabId: 7000 }],
	});
	await waitUntil(() => server.snapshot().defaultTabId === 7151, "tabs_update replacement follows default tab");
	const replacedTab = server.getTabs().find((tab) => tab.tabId === 7151 && !tab.disconnectedAt);
	assert.equal(replacedTab?.tabHandle, replaceSource.tabHandle, "replacement must preserve stable tabHandle");
	assert.equal(replacedTab?.openerTabId, 7000, "replacement tab list must expose lineage openerTabId");
	assert.equal(server.snapshot().leases?.[0]?.tabId, 7151, "replacement must migrate held tab lease");
	const staleNumericFollowPromise = server.executeJavaScript("return 'followed-old-id'", { tabId: 7150, timeoutMs: 1_000 });
	const staleNumericFollowOutbound = await nextJson(ws, "replacement stale numeric follow outbound");
	assert.equal(staleNumericFollowOutbound.tabId, 7151);
	sendJson(ws, { type: "ack", id: staleNumericFollowOutbound.id });
	sendJson(ws, { type: "result", id: staleNumericFollowOutbound.id, result: "followed-old-id" });
	const staleNumericFollowResult = await staleNumericFollowPromise;
	assert.equal(staleNumericFollowResult.target.replacedFrom, 7150);
	assert.equal(staleNumericFollowResult.target.replacedByTabId, 7151);
	assert.equal(staleNumericFollowResult.target.tabHandle, replaceSource.tabHandle);
	const staleSwitchPromise = server.switchTab(7150, 1_000);
	const staleSwitchOutbound = await nextJson(ws, "replacement stale switch outbound");
	assert.equal(staleSwitchOutbound.code.cmd, "tabs");
	assert.equal(staleSwitchOutbound.code.method, "switch");
	assert.equal(staleSwitchOutbound.code.tabId, 7151);
	sendJson(ws, { type: "ack", id: staleSwitchOutbound.id });
	sendJson(ws, { type: "result", id: staleSwitchOutbound.id, result: { ok: true, id: 7151 } });
	const staleSwitchResult = await staleSwitchPromise;
	assert.equal(staleSwitchResult.target.replacedFrom, 7150);
	assert.equal(staleSwitchResult.target.replacedByTabId, 7151);
	const handleFollowPromise = server.executeJavaScript("return 'followed-handle'", { tabId: replaceSource.tabHandle, timeoutMs: 1_000 });
	const handleFollowOutbound = await nextJson(ws, "replacement handle follow outbound");
	assert.equal(handleFollowOutbound.tabId, 7151);
	sendJson(ws, { type: "ack", id: handleFollowOutbound.id });
	sendJson(ws, { type: "result", id: handleFollowOutbound.id, result: "followed-handle" });
	assert.equal((await handleFollowPromise).data, "followed-handle");
	server.releaseTab(replaceSource.tabHandle);

	// --- Reconnect rebinding contract ---
	// Establish a tab with a known handle, simulate MV3 service-worker idle/wake, and assert
	// that the old tabHandle survives because the reconnecting extension carries the same extensionId.
	sendJson(ws, readyMessage([{ id: 888, url: "https://example.test/rebind", title: "Rebind", active: true, windowId: 1 }], { id: "rebind-extension" }));
	await waitUntil(() => server.getTabs().some((t) => t.tabId === 888 && !t.disconnectedAt), "rebind seed tab registered");
	const rebindHandleBefore = server.getTabs().find((t) => t.tabId === 888 && !t.disconnectedAt)?.tabHandle;
	assert.ok(rebindHandleBefore, "rebind seed tab must have a tabHandle");

	// Disconnect the current client (SW went idle)
	ws.close();
	await waitUntil(() => !server.snapshot().extensionConnected, "rebind extension disconnect");

	// Reconnect with the SAME extensionId — SW woke up, new WebSocket connection
	ws = await openFakeClient(port);
	sendJson(ws, readyMessage([{ id: 888, url: "https://example.test/rebind", title: "Rebind", active: true, windowId: 1 }], { id: "rebind-extension" }));
	await waitUntil(() => server.getTabs().some((t) => t.tabId === 888 && !t.disconnectedAt), "rebind reconnected tab registered");
	const rebindHandleAfter = server.getTabs().find((t) => t.tabId === 888 && !t.disconnectedAt)?.tabHandle;
	assert.equal(rebindHandleAfter, rebindHandleBefore, "tabHandle must be rebound after SW reconnect with same extensionId");
	assert.equal(server.snapshot().defaultTabId, 888, "rebound tab must be the default after reconnect");

	// The handle must still resolve via executeJavaScript after rebind
	const rebindExecPromise = server.executeJavaScript("return 'rebind-ok'", { tabId: rebindHandleAfter, timeoutMs: 1_000 });
	const rebindExecOutbound = await nextJson(ws, "rebind exec outbound");
	assert.equal(rebindExecOutbound.tabId, 888, "rebound handle must dispatch to the live numeric tabId");
	sendJson(ws, { type: "ack", id: rebindExecOutbound.id });
	sendJson(ws, { type: "result", id: rebindExecOutbound.id, result: "rebind-ok" });
	assert.equal((await rebindExecPromise).data, "rebind-ok", "rebound handle execution must resolve normally");
	// --- end reconnect rebinding contract ---

	sendJson(ws, readyMessage([{ id: 909, url: "https://example.test/nine", title: "Nine", active: true, windowId: 1 }]));
	await waitUntil(() => server.snapshot().defaultTabId === 909 && server.snapshot().latestTabId === 909, "single-tab registration before close fallback test");
	const closeLastTabPromise = server.closeTab(909, 1_000);
	const closeLastTabOutbound = await nextJson(ws, "close last tab outbound");
	assert.equal(closeLastTabOutbound.code.cmd, "tabs");
	assert.equal(closeLastTabOutbound.code.method, "close");
	sendJson(ws, { type: "ack", id: closeLastTabOutbound.id });
	sendJson(ws, { type: "result", id: closeLastTabOutbound.id, result: { id: 909, closed: true } });
	await closeLastTabPromise;
	assert.equal(server.snapshot().defaultTabId, undefined, "closeTab should clear default tab when the last active tab closes");
	assert.equal(server.snapshot().latestTabId, undefined, "closeTab should clear latest tab when the last active tab closes");
	await assert.rejects(server.executeJavaScript("return 3", { timeoutMs: 1_000 }), (error) => {
		assert.equal(error.code, "NO_TAB");
		return true;
	});
} finally {
	try { ws?.close(); } catch {}
	try { ws2?.close(); } catch {}
	await new Promise((resolve) => setTimeout(resolve, 0));
	await server.stop();
}

console.log("fake ws bridge contract ok");
