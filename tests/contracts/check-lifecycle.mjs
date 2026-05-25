import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { executeBrowserWaitWithSupervisor } from "../../src/driver/BrowserWaitSupervisor.ts";

const HOST = "127.0.0.1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const failureArtifactPath = path.join(root, ".pi", "browser-artifacts", "lifecycle-fixture-failure.json");
const SECRET_KEY = /cookie|token|authorization|password|secret|body|postdata/i;

function sanitize(value, depth = 0) {
	if (depth > 8) return "[MaxDepth]";
	if (value instanceof Error) return { name: value.name, message: value.message, code: value.code, details: sanitize(value.details, depth + 1) };
	if (Array.isArray(value)) return value.slice(0, 80).map((item) => sanitize(item, depth + 1));
	if (value && typeof value === "object") {
		const out = {};
		for (const [key, item] of Object.entries(value)) out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitize(item, depth + 1);
		return out;
	}
	if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
	return value;
}

async function writeFailureArtifact(error, diagnostics) {
	await mkdir(path.dirname(failureArtifactPath), { recursive: true });
	await writeFile(failureArtifactPath, `${JSON.stringify({ ok: false, error: sanitize(error), diagnostics: sanitize(diagnostics) }, null, 2)}\n`, "utf8");
}

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

async function openFakeClient(port, label) {
	const ws = new WebSocket(`ws://${HOST}:${port}`);
	await withTimeout(new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	}), 1_000, `${label} open`);
	return ws;
}

function sendJson(ws, message) {
	ws.send(JSON.stringify(message));
}

async function nextJson(ws, label, diagnostics) {
	return await withTimeout(new Promise((resolve, reject) => {
		const onMessage = (data) => {
			cleanup();
			try {
				const parsed = JSON.parse(data.toString());
				diagnostics.outbounds.push({ label, message: parsed });
				resolve(parsed);
			} catch (error) { reject(error); }
		};
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

async function assertNoJson(ws, ms, label) {
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

async function waitUntil(predicate, label, diagnostics) {
	const deadline = Date.now() + 1_500;
	let last;
	while (Date.now() < deadline) {
		last = predicate();
		if (last) return last;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	diagnostics.snapshots.push({ label, last });
	throw new Error(`${label} not reached; last=${JSON.stringify(last)}`);
}

function readyMessage(extensionId, tabs, bridge = {}) {
	return {
		type: "ext_ready",
		bridge: { id: extensionId, name: `Lifecycle ${extensionId}`, version: "test", ...bridge },
		tabs,
	};
}

async function expectReject(promise, code) {
	await assert.rejects(promise, (error) => {
		assert.equal(error.code, code);
		return true;
	});
}

async function runLifecycleFixture() {
	const diagnostics = { events: [], outbounds: [], snapshots: [], resourceState: {} };
	const port = await freePort();
	const server = new BrowserBridgeServer({ host: HOST, port });
	let alpha;
	let beta;
	let gamma;
	try {
		await server.start();
		diagnostics.events.push({ event: "server.start", port });

		alpha = await openFakeClient(port, "alpha");
		sendJson(alpha, readyMessage("alpha-extension", [
			{ id: 11, url: "https://alpha.test/one", title: "Alpha One", active: true, windowId: 1 },
			{ id: 77, url: "https://alpha.test/seven", title: "Alpha Seven", active: false, windowId: 1 },
		]));
		await waitUntil(() => server.snapshot().extension?.extensionId === "alpha-extension" && server.getTabs().length === 2, "alpha registration", diagnostics);

		beta = await openFakeClient(port, "beta");
		sendJson(beta, readyMessage("beta-extension", [{ id: 11, url: "https://beta.test/one", title: "Beta One", active: true, windowId: 2 }]));
		await waitUntil(() => server.snapshot().extension?.extensionId === "beta-extension", "beta registration", diagnostics);
		const duplicateTabs = server.getTabs().filter((tab) => tab.tabId === 11 && !tab.disconnectedAt);
		assert.equal(duplicateTabs.length, 2, "duplicate numeric tabIds must coexist across browser clients");
		assert.equal(new Set(duplicateTabs.map((tab) => tab.browserId)).size, 2, "duplicate tabIds must retain browser-scoped session ids");

		server.selectBrowser("alpha-extension");
		const alphaCommand = server.executeJavaScript("return 'alpha'", { tabId: 11, timeoutMs: 1_000 });
		const alphaOutbound = await nextJson(alpha, "alpha duplicate tab dispatch", diagnostics);
		assert.equal(alphaOutbound.tabId, 11);
		await assertNoJson(beta, 50, "selected alpha duplicate command must not dispatch to beta");
		sendJson(alpha, { type: "ack", id: alphaOutbound.id });
		sendJson(alpha, { type: "result", id: alphaOutbound.id, result: "alpha" });
		assert.equal((await alphaCommand).data, "alpha");

		server.selectBrowser("beta-extension");
		const betaCommand = server.executeJavaScript("return 'beta'", { tabId: 11, timeoutMs: 1_000 });
		const betaOutbound = await nextJson(beta, "beta duplicate tab dispatch", diagnostics);
		assert.equal(betaOutbound.tabId, 11);
		await assertNoJson(alpha, 50, "selected beta duplicate command must not dispatch to alpha");
		sendJson(beta, { type: "ack", id: betaOutbound.id });
		sendJson(beta, { type: "result", id: betaOutbound.id, result: "beta" });
		assert.equal((await betaCommand).data, "beta");

		server.selectBrowser("alpha-extension");
		const beforeSwitch = server.snapshot();
		const switchCommand = server.switchTab(77, 1_000);
		const switchOutbound = await nextJson(alpha, "pending tab switch", diagnostics);
		assert.equal(switchOutbound.code.method, "switch");
		const implicitCommand = server.executeJavaScript("return 'old-default'", { timeoutMs: 1_000 });
		const implicitOutbound = await nextJson(alpha, "implicit command during pending switch", diagnostics);
		assert.equal(implicitOutbound.tabId, 11, "implicit command must use the default tab captured before switch resolves");
		sendJson(alpha, { type: "ack", id: switchOutbound.id });
		sendJson(alpha, { type: "result", id: switchOutbound.id, result: { ok: true } });
		const switchResult = await switchCommand;
		assert.equal(switchResult.data.selectedTabId, 77);
		assert.equal(server.snapshot().defaultTabId, 77);
		sendJson(alpha, { type: "ack", id: implicitOutbound.id });
		sendJson(alpha, { type: "result", id: implicitOutbound.id, result: "old-default" });
		const implicitResult = await implicitCommand;
		assert.equal(implicitResult.target.tabId, 11);
		assert.equal(implicitResult.target.selectionVersionAtDispatch, beforeSwitch.selectionVersion);
		assert.equal(implicitResult.target.selectionVersionAtResolve, switchResult.data.selectionVersion);

		const waitLong = server.sendCommand({ cmd: "wait.networkIdle", timeoutMs: 5_000 }, { tabId: 77, timeoutMs: 5_000 });
		const waitOutbound = await nextJson(alpha, "long wait command", diagnostics);
		sendJson(alpha, { type: "ack", id: waitOutbound.id });
		const networkLong = server.sendCommand({ cmd: "network.wait", timeoutMs: 5_000 }, { tabId: 77, timeoutMs: 5_000 });
		const networkOutbound = await nextJson(alpha, "long network command", diagnostics);
		sendJson(alpha, { type: "ack", id: networkOutbound.id });
		const hookLong = server.sendCommand({ cmd: "hook.collect", timeoutMs: 5_000 }, { tabId: 77, timeoutMs: 5_000 });
		const hookOutbound = await nextJson(alpha, "long hook command", diagnostics);
		sendJson(alpha, { type: "ack", id: hookOutbound.id });
		diagnostics.resourceState.longTasksBeforeDisconnect = {
			wait: { cmd: waitOutbound.code.cmd, target: waitOutbound.tabId },
			networkRecorderState: { cmd: networkOutbound.code.cmd, target: networkOutbound.tabId, pendingRequestId: networkOutbound.id },
			hookListenerState: { cmd: hookOutbound.code.cmd, target: hookOutbound.tabId, pendingRequestId: hookOutbound.id },
			cdpState: { waitUsesCdp: true, tabId: waitOutbound.tabId, pendingRequestId: waitOutbound.id },
			pending: server.snapshot().pending,
		};
		assert.equal(server.snapshot().pending.length, 3, "long wait/network/hook commands must be visible in pending diagnostics");
		const longTaskRejections = Promise.all([
			expectReject(waitLong, "BRIDGE_CLIENT_DISCONNECTED"),
			expectReject(networkLong, "BRIDGE_CLIENT_DISCONNECTED"),
			expectReject(hookLong, "BRIDGE_CLIENT_DISCONNECTED"),
		]);
		alpha.close();
		await longTaskRejections;
		await waitUntil(() => server.snapshot().pending.length === 0, "long task pending cleanup", diagnostics);
		diagnostics.resourceState.longTasksAfterDisconnect = { snapshot: server.snapshot(), listenerState: "client-disconnected", cdpState: "client-disconnected", networkRecorderState: "client-disconnected" };

		gamma = await openFakeClient(port, "gamma-a");
		sendJson(gamma, readyMessage("gamma-extension", [{ id: 33, url: "https://gamma.test/ready", title: "Gamma", active: true, windowId: 3 }], { workerBootId: "boot-a", workerStartedAt: 1_000 }));
		await waitUntil(() => server.snapshot().extension?.workerBootId === "boot-a", "gamma boot-a registration", diagnostics);
		const durableWait = executeBrowserWaitWithSupervisor(server, { cmd: "wait.selector", selector: "#ready", timeoutMs: 2_000 }, { tabId: 33, timeoutMs: 2_000 });
		const firstLease = await nextJson(gamma, "durable wait first lease", diagnostics);
		assert.equal(firstLease.code.cmd, "wait.selector");
		assert.ok(firstLease.code.waitId, "durable wait must allocate a stable waitId");
		gamma.close();
		await waitUntil(() => !server.snapshot().extensionConnected, "gamma disconnect", diagnostics);
		gamma = await openFakeClient(port, "gamma-b");
		sendJson(gamma, readyMessage("gamma-extension", [{ id: 33, url: "https://gamma.test/ready", title: "Gamma", active: true, windowId: 3 }], { workerBootId: "boot-b", workerStartedAt: 2_000 }));
		await waitUntil(() => server.snapshot().extension?.workerBootId === "boot-b", "gamma boot-b registration", diagnostics);
		const secondLease = await nextJson(gamma, "durable wait second lease", diagnostics);
		assert.equal(secondLease.code.waitId, firstLease.code.waitId, "durable wait retry must preserve waitId across service worker restart");
		sendJson(gamma, { type: "result", id: secondLease.id, result: { ok: true, selector: "#ready", bridge: { workerBootId: "boot-b", workerStartedAt: 2_000 } } });
		const durableWaitResult = await durableWait;
		assert.equal(durableWaitResult.data.selector, "#ready");
		assert.equal(durableWaitResult.data.supervisor.workerRestarts, 1);
		assert.equal(durableWaitResult.data.supervisor.historyLost, true);
		diagnostics.resourceState.waitSupervisor = durableWaitResult.data.supervisor;

		server.selectBrowser("beta-extension");
		const stoppedCommand = server.sendCommand({ cmd: "network.status" }, { tabId: 11, timeoutMs: 5_000 });
		const stoppedOutbound = await nextJson(beta, "pending command before server stop", diagnostics);
		sendJson(beta, { type: "ack", id: stoppedOutbound.id });
		assert.equal(server.snapshot().pending.length, 1, "server.stop fixture must start with one pending command");
		const stoppedRejection = expectReject(stoppedCommand, "BRIDGE_STOPPED");
		await server.stop();
		await stoppedRejection;
		assert.equal(server.running, false);
		assert.equal(server.snapshot().pending.length, 0);
	} catch (error) {
		diagnostics.snapshots.push({ label: "failure", snapshot: server.snapshot() });
		await writeFailureArtifact(error, diagnostics);
		throw error;
	} finally {
		try { alpha?.close(); } catch {}
		try { beta?.close(); } catch {}
		try { gamma?.close(); } catch {}
		if (server.running) await server.stop();
	}
}

await runLifecycleFixture();
console.log("lifecycle contract ok");
