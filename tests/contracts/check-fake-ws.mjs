import assert from "node:assert/strict";
import net from "node:net";
import { WebSocket } from "ws";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";

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

async function openFakeClient(port) {
	const ws = new WebSocket(`ws://${HOST}:${port}`);
	await withTimeout(new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	}), 1_000, "fake ws open");
	return ws;
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

function readyMessage(tabs) {
	return {
		type: "ext_ready",
		bridge: { id: "fake-extension", name: "Pi Native Browser Bridge", version: "test" },
		tabs,
	};
}

const port = await freePort();
const server = new BrowserBridgeServer({ host: HOST, port });
let ws;
let ws2;
try {
	await server.start();
	ws = await openFakeClient(port);
	sendJson(ws, readyMessage([{ id: 101, url: "https://example.test/one", title: "One", active: true, windowId: 1 }]));
	await waitUntil(() => server.snapshot().extensionConnected && server.getTabs().length === 1, "ext_ready tabs registration");
	assert.equal(server.snapshot().defaultTabId, 101);
	assert.equal(server.getTabs()[0]?.bridge?.name, "Pi Native Browser Bridge");

	const commandPromise = server.sendCommand({ cmd: "tabs", method: "list" }, { timeoutMs: 1_000 });
	const outbound = await nextJson(ws, "tabs command outbound");
	assert.equal(outbound.code.cmd, "tabs");
	assert.equal(outbound.code.method, "list");
	sendJson(ws, { type: "ack", id: outbound.id });
	sendJson(ws, { type: "result", id: outbound.id, result: [{ id: 101, active: true }], newTabs: [{ id: 102 }] });
	const commandResult = await commandPromise;
	assert.equal(commandResult.id, outbound.id);
	assert.equal(commandResult.acknowledged, true);
	assert.deepEqual(commandResult.data, [{ id: 101, active: true }]);
	assert.deepEqual(commandResult.newTabs, [{ id: 102 }]);

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

	sendJson(ws, {
		type: "tabs_update",
		bridge: { id: "fake-extension", name: "Pi Native Browser Bridge", version: "test-2" },
		tabs: [{ id: 202, url: "https://example.test/two", title: "Two", active: true, windowId: 1 }],
	});
	await waitUntil(() => server.snapshot().defaultTabId === 202, "tabs_update default tab switch");
	const allTabs = server.getTabs({ includeDisconnected: true });
	assert.equal(allTabs.find((tab) => tab.tabId === 202)?.active, true);
	assert.ok(allTabs.find((tab) => tab.tabId === 101)?.disconnectedAt, "missing tab should be marked disconnected");

	const firstBrowserId = server.snapshot().extension?.id;
	ws2 = await openFakeClient(port);
	sendJson(ws2, readyMessage([{ id: 404, url: "https://example.test/four", title: "Four", active: true, windowId: 2 }]));
	await waitUntil(() => server.snapshot().extension?.id && server.snapshot().extension?.id !== firstBrowserId, "second browser arbitration");
	const selected = server.selectBrowser(firstBrowserId);
	assert.equal(selected.id, firstBrowserId);
	assert.equal(server.snapshot().extension?.id, firstBrowserId);
	ws2.close();
	ws2 = undefined;

	const previousClientId = server.snapshot().extension?.id;
	const reconnectPromise = server.waitForExtensionReconnect(previousClientId, 1_000);
	ws.close();
	await waitUntil(() => !server.snapshot().extensionConnected, "extension disconnect before reconnect");
	ws = await openFakeClient(port);
	sendJson(ws, readyMessage([{ id: 303, url: "https://example.test/three", title: "Three", active: true, windowId: 1 }]));
	const reconnect = await reconnectPromise;
	assert.notEqual(reconnect.extension?.id, previousClientId);
	assert.equal(reconnect.defaultTabId, 303);
} finally {
	try { ws?.close(); } catch {}
	try { ws2?.close(); } catch {}
	await server.stop();
}

console.log("fake ws bridge contract ok");
