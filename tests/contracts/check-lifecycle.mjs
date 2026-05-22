import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { executeBrowserWaitWithSupervisor } from "../../src/driver/BrowserWaitSupervisor.ts";

const HOST = "127.0.0.1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const failureArtifactPath = path.join(root, ".pi", "browser-artifacts", "lifecycle-fixture-failure.json");
const lifecycleStateDir = path.join(root, ".pi", "browser-artifacts", "lifecycle-orchestration-state");
const lifecycleStatePath = path.join(lifecycleStateDir, "state.v1.json");
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
	await rm(lifecycleStateDir, { recursive: true, force: true });
	await mkdir(lifecycleStateDir, { recursive: true });
	const now = Date.now();
	await writeFile(lifecycleStatePath, `${JSON.stringify({
		schemaVersion: "pi.browser.orchestration.state/v1",
		createdAt: now,
		updatedAt: now,
		driverRunId: "previous-lifecycle-run",
		piSessionId: "previous-lifecycle-session",
		mode: "diagnostic",
		privacy: { classification: "local_redacted_orchestration_state", localOnly: true, redaction: "required", cleanup: "rm -rf .pi/browser-artifacts/orchestration-state" },
		orchestrations: [{
			orchestrationId: "orch-lifecycle-persist",
			generation: "g-old",
			desiredHash: "h-old",
			createdAt: now,
			updatedAt: now,
			cleanupOnFailure: true,
			closeOwnedTabsOnDelete: true,
			redactedDesired: { apiVersion: "pi.browser/v1", orchestrationId: "orch-lifecycle-persist", sessions: [{ tag: "persist", tabs: [{ role: "main", url: "https://persist.lifecycle.test/" }] }] },
			bindings: [{ sessionTag: "persist", tabRole: "main", browserId: "previous-browser", tabId: 909, owned: true, createdByOrchestrator: true, desiredUrl: "https://persist.lifecycle.test/", createdAt: now, updatedAt: now, fingerprint: { sessionTag: "persist", tabRole: "main", browserId: "previous-browser", tabId: 909, url: "https://persist.lifecycle.test/", origin: "https://persist.lifecycle.test", owned: true, createdByOrchestrator: true } }],
			cookies: [],
			fingerprints: [{ sessionTag: "persist", tabRole: "main", browserId: "previous-browser", tabId: 909, url: "https://persist.lifecycle.test/", origin: "https://persist.lifecycle.test", owned: true, createdByOrchestrator: true }],
			status: "current",
			readOnly: false,
			adoptionRequired: false,
		}],
	}, null, 2)}\n`, "utf8");
	const server = new BrowserBridgeServer({ host: HOST, port, orchestrationStatePath: lifecycleStatePath, orchestrationDriverRunId: "current-lifecycle-run", piSessionId: "current-lifecycle-session" });
	let alpha;
	let beta;
	let gamma;
	try {
		await server.start();
		diagnostics.events.push({ event: "server.start", port });
		const persistentStatus = await server.orchestrator().status("orch-lifecycle-persist");
		assert.equal(persistentStatus.ok, true, "server.start must load persisted orchestration status");
		assert.equal(persistentStatus.state.persistence.readOnly, true, "server.start loaded persistent state must be read-only");
		assert.equal(persistentStatus.state.persistence.adoptionRequired, true, "server.start loaded persistent state must require adoption");
		const persistentDelete = await server.orchestrator().delete("orch-lifecycle-persist", { timeoutMs: 200 });
		assert.equal(persistentDelete.ok, false, "loaded read-only persistent state must reject delete before adoption");
		assert.equal(persistentDelete.failures[0].code, "ORCHESTRATION_TARGET_STALE", "read-only persistent delete must fail as stale target");
		diagnostics.resourceState.persistentOrchestration = { status: persistentStatus.state.persistence, deleteFailure: persistentDelete.failures[0] };

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

		const alphaOne = server.getTabs().find((tab) => tab.url === "https://alpha.test/one");
		const alphaSeven = server.getTabs().find((tab) => tab.url === "https://alpha.test/seven");
		const betaOne = server.getTabs().find((tab) => tab.url === "https://beta.test/one");
		assert.ok(alphaOne, "alpha duplicate target fixture tab must exist");
		assert.ok(alphaSeven, "alpha target fixture tab must exist");
		assert.ok(betaOne, "beta target fixture tab must exist");
		const targetStore = server.orchestrator().store;
		targetStore.upsertDesired({ apiVersion: "pi.browser/v1", orchestrationId: "orch-target", generation: "g1", desiredHash: "h1", browser: { requireSelected: false, crossBrowserFallback: false }, defaults: { timeoutMs: 1000, navigationTimeoutMs: 1000, tabRole: "main", cleanupOnFailure: true }, isolation: { scope: "logical", ownedTabsOnly: true, closeOwnedTabsOnDelete: true }, allowedOrigins: [], sessions: [] });
		targetStore.setBinding("orch-target", { sessionTag: "alpha", tabRole: "main", browserId: alphaSeven.browserId, tabId: alphaSeven.tabId, windowId: alphaSeven.windowId, owned: false, desiredUrl: alphaSeven.url, createdByOrchestrator: false, createdAt: Date.now(), updatedAt: Date.now() });
		const logicalCommand = server.executeJavaScript("return 'logical-alpha'", { target: { orchestrationId: "orch-target", sessionTag: "alpha", tabRole: "main" }, timeoutMs: 1_000 });
		const logicalOutbound = await nextJson(alpha, "logical orchestration target dispatch", diagnostics);
		assert.equal(logicalOutbound.tabId, alphaSeven.tabId, "logical target must dispatch to the bound orchestration tab");
		await assertNoJson(beta, 50, "logical orchestration target must not dispatch to selected beta browser");
		sendJson(alpha, { type: "ack", id: logicalOutbound.id });
		sendJson(alpha, { type: "result", id: logicalOutbound.id, result: "logical-alpha" });
		const logicalResult = await logicalCommand;
		assert.equal(logicalResult.data, "logical-alpha");
		assert.equal(logicalResult.target.source, "orchestration");
		assert.equal(logicalResult.target.orchestrationId, "orch-target");
		assert.equal(logicalResult.target.sessionTag, "alpha");
		assert.equal(logicalResult.target.tabRole, "main");
		assert.equal(logicalResult.target.browserId, alphaSeven.browserId);
		await expectReject(server.executeJavaScript("return 'conflict'", { tabId: betaOne.tabId, target: { orchestrationId: "orch-target", sessionTag: "alpha", tabRole: "main" }, timeoutMs: 1_000 }), "TARGET_CONFLICT");
		await expectReject(server.executeJavaScript("return 'browser-conflict'", { target: { orchestrationId: "orch-target", sessionTag: "alpha", tabRole: "main", browserId: betaOne.browserId }, timeoutMs: 1_000 }), "TARGET_BROWSER_CONFLICT");
		targetStore.setBinding("orch-target", { sessionTag: "stale", tabRole: "main", browserId: alphaSeven.browserId, tabId: 999_001, owned: false, desiredUrl: "https://alpha.test/stale", createdByOrchestrator: false, createdAt: Date.now(), updatedAt: Date.now() });
		await expectReject(server.executeJavaScript("return 'stale'", { target: { orchestrationId: "orch-target", sessionTag: "stale", tabRole: "main" }, timeoutMs: 1_000 }), "ORCHESTRATION_TARGET_STALE");
		targetStore.upsertDesired({ apiVersion: "pi.browser/v1", orchestrationId: "orch-target-2", generation: "g1", desiredHash: "h2", browser: { requireSelected: false, crossBrowserFallback: false }, defaults: { timeoutMs: 1000, navigationTimeoutMs: 1000, tabRole: "main", cleanupOnFailure: true }, isolation: { scope: "logical", ownedTabsOnly: true, closeOwnedTabsOnDelete: true }, allowedOrigins: [], sessions: [] });
		targetStore.setBinding("orch-target-2", { sessionTag: "alpha", tabRole: "main", browserId: betaOne.browserId, tabId: betaOne.tabId, windowId: betaOne.windowId, owned: false, desiredUrl: betaOne.url, createdByOrchestrator: false, createdAt: Date.now(), updatedAt: Date.now() });
		await expectReject(server.executeJavaScript("return 'ambiguous'", { target: { sessionTag: "alpha", tabRole: "main" }, timeoutMs: 1_000 }), "TARGET_AMBIGUOUS");
		const scopedSwitchCommand = server.switchTab(alphaOne.tabId, 1_000, { browserId: alphaOne.browserId });
		const scopedSwitchOutbound = await nextJson(alpha, "browser-scoped duplicate switch", diagnostics);
		assert.equal(scopedSwitchOutbound.tabId, alphaOne.tabId);
		await assertNoJson(beta, 50, "browser-scoped duplicate switch must not dispatch to selected beta browser");
		sendJson(alpha, { type: "ack", id: scopedSwitchOutbound.id });
		sendJson(alpha, { type: "result", id: scopedSwitchOutbound.id, result: { ok: true } });
		assert.equal((await scopedSwitchCommand).data.selectedTabId, alphaOne.tabId);

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
