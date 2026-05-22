import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserOrchestrationCoordinator, ORCHESTRATION_ERROR_CODES, PersistentOrchestrationStore, preNavigationHookRegistryHash } from "../../src/driver/orchestration/index.ts";

const fixtureEvidence = [];
const fixtureArtifactPath = path.resolve(".pi", "browser-artifacts", "orchestration-fixture-results.json");
function captureFixture(name, data) { fixtureEvidence.push({ name, data }); return data; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitUntil(predicate, label, timeoutMs = 1800) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await predicate();
		if (last) return last;
		await delay(25);
	}
	throw new Error(`${label} not reached; last=${JSON.stringify(last)}`);
}

class FakeOrchestrationServer {
	constructor(options = {}) {
		this.browser = { id: "browser-1", extensionId: "fake-extension", name: "Fake Browser", connectedAt: Date.now(), lastSeenAt: Date.now(), workerBootId: "boot-1" };
		this.tabs = options.tabs ? structuredClone(options.tabs).map((tab) => ({ ...tab, windowId: tab.windowId || 1, bridge: tab.bridge || this.browser })) : [];
		this.nextTabId = 1000;
		this.nextWindowId = 10;
		this.nextGroupId = 200;
		this.windows = new Map();
		this.groups = new Map();
		this.tabGroupsSupported = options.tabGroupsSupported !== false;
		this.tabGroupsFail = options.tabGroupsFail === true;
		this.commandLog = [];
		this.cookies = new Map();
		this.network = new Map();
		this.hooks = new Map();
		this.preNavigationScripts = new Map();
		this.preNavigationEffects = new Map();
		this.nextScriptId = 1;
		this.fail = options.fail || {};
		this.waitReady = options.waitReady !== false;
		this.immediateWaitFails = options.immediateWaitFails === true;
		this.ensureWindowsFromTabs();
	}

	snapshot() {
		return { host: "127.0.0.1", port: 1, running: true, connectedClients: 1, extensionConnected: true, extension: this.browser, clients: [this.browser], defaultTabId: this.tabs[0]?.tabId, latestTabId: this.tabs.at(-1)?.tabId, selectionVersion: 1, tabs: this.getTabs({ includeDisconnected: true }), pending: [] };
	}

	getTabs() {
		return structuredClone(this.tabs);
	}

	async refreshTabs() {
		return this.getTabs({ includeDisconnected: true }).filter((tab) => !tab.disconnectedAt);
	}

	selectBrowser(browserId) {
		if (browserId !== this.browser.id && browserId !== this.browser.extensionId) throw new Error(`unknown browser ${browserId}`);
		return this.browser;
	}

	ensureWindowsFromTabs() {
		if (!this.windows.size) this.windows.set(1, { id: 1, windowId: 1, focused: true, type: "normal", state: "normal" });
		for (const tab of this.tabs) {
			const windowId = tab.windowId || 1;
			if (!this.windows.has(windowId)) this.windows.set(windowId, { id: windowId, windowId, focused: false, type: "normal", state: "normal" });
		}
	}

	windowSummary(windowId) {
		const win = this.windows.get(windowId) || { id: windowId, windowId, focused: false, type: "normal", state: "normal" };
		const tabs = this.tabs.filter((tab) => tab.windowId === windowId && !tab.disconnectedAt).map((tab) => ({ id: tab.tabId, tabId: tab.tabId, url: tab.url, title: tab.title || "", active: tab.active, windowId: tab.windowId, groupId: tab.groupId }));
		return { id: windowId, windowId, focused: win.focused, incognito: false, type: win.type || "normal", state: win.state || "normal", left: win.left, top: win.top, width: win.width, height: win.height, tabs };
	}

	createTabInWindow(url, active = true, windowId = 1) {
		this.ensureWindowsFromTabs();
		if (!this.windows.has(windowId)) this.windows.set(windowId, { id: windowId, windowId, focused: false, type: "normal", state: "normal" });
		const tab = { id: `${this.browser.id}:${++this.nextTabId}`, browserId: this.browser.id, tabId: this.nextTabId, url, title: "", active, windowId, type: "ext_ws", connectedAt: Date.now(), bridge: this.browser };
		this.tabs.push(tab);
		return tab;
	}

	async createTab(url, active = true) {
		this.commandLog.push({ cmd: "tabs.create", url, active });
		const tab = this.createTabInWindow(url, active, 1);
		return { id: `create-${this.nextTabId}`, acknowledged: true, data: { tabId: tab.tabId, id: tab.tabId, windowId: tab.windowId, groupId: tab.groupId }, newTabs: [{ id: tab.tabId, tabId: tab.tabId, url, windowId: tab.windowId, groupId: tab.groupId }] };
	}

	async closeTab(tabId) {
		this.commandLog.push({ cmd: "tabs.close", tabId: Number(tabId) });
		this.tabs = this.tabs.filter((tab) => tab.tabId !== Number(tabId));
		return { id: `close-${tabId}`, acknowledged: true, data: { ok: true, closed: true } };
	}

	orchestrator() {
		if (!this.coordinator) this.coordinator = new BrowserOrchestrationCoordinator(this);
		return this.coordinator;
	}

	async sendCommand(command, options = {}) {
		this.commandLog.push({ ...command, tabId: options.tabId ?? command.tabId });
		if (this.fail[command.cmd]) return { id: `fail-${this.commandLog.length}`, acknowledged: true, tabId: Number(options.tabId || command.tabId || 0) || undefined, data: { ok: false, error_code: this.fail[command.cmd], error: `${command.cmd} failed`, details: { secret: "must-redact" } } };
		if (command.cmd === "cookies") return this.handleCookies(command);
		if (command.cmd === "network.status") return this.networkStatus(command, options);
		if (command.cmd === "network.start") return this.networkStart(command, options);
		if (command.cmd === "network.stop") return this.networkStop(command, options);
		if (command.cmd === "hook.status") return this.hookStatus(command, options);
		if (command.cmd === "hook.install") return this.hookInstall(command, options);
		if (command.cmd === "hook.uninstall") return this.hookUninstall(command, options);
		if (command.cmd === "frame.addNewDocumentScript") return this.addPreNavigationScript(command, options);
		if (command.cmd === "frame.removeNewDocumentScript") return this.removePreNavigationScript(command, options);
		if (command.cmd === "persistent_cdp") return this.handlePersistentCdp(command, options);
		if (command.cmd === "tabs") return this.handleTabs(command);
		if (command.cmd === "windows") return this.handleWindows(command);
		if (command.cmd === "tabGroups") return this.handleTabGroups(command);
		if (command.cmd === "wait.loadState" || command.cmd === "wait.networkIdle") {
			const state = command.state || "networkidle";
			if (this.immediateWaitFails && Number(command.timeoutMs || 0) === 0) return { id: `wait-${this.commandLog.length}`, acknowledged: true, tabId: Number(options.tabId), data: { ok: false, error_code: "WAIT_TIMEOUT", error: `${command.cmd} immediate check failed`, details: { state } } };
			return { id: `wait-${this.commandLog.length}`, acknowledged: true, tabId: Number(options.tabId), data: this.waitReady ? { state, ok: true } : { ok: false, error_code: "WAIT_TIMEOUT", error: "wait state not ready", details: { state } } };
		}
		if (command.cmd === "wait.navigate") {
			const tabId = Number(options.tabId);
			const tab = this.tabs.find((item) => item.tabId === tabId);
			if (tab) tab.url = command.url;
			if ((this.preNavigationScripts.get(tabId) || []).length) this.preNavigationEffects.set(tabId, true);
			return { id: `nav-${this.commandLog.length}`, acknowledged: true, tabId, data: { ok: true, url: command.url } };
		}
		return { id: `cmd-${this.commandLog.length}`, acknowledged: true, tabId: Number(options.tabId || command.tabId || 0) || undefined, data: { ok: true } };
	}

	handleTabs(command) {
		if (!command.method || command.method === "list") return { id: `tabs-${this.commandLog.length}`, acknowledged: true, data: this.getTabs().filter((tab) => !tab.disconnectedAt).map((tab) => ({ id: tab.tabId, tabId: tab.tabId, url: tab.url, title: tab.title || "", active: tab.active, windowId: tab.windowId, groupId: tab.groupId })) };
		if (command.method === "create") {
			const tab = this.createTabInWindow(command.url || "about:blank", command.active !== false, Number(command.windowId || 1));
			return { id: `tabs-${this.commandLog.length}`, acknowledged: true, data: { id: tab.tabId, tabId: tab.tabId, url: tab.url, title: tab.title || "", windowId: tab.windowId, groupId: tab.groupId }, newTabs: [{ id: tab.tabId, tabId: tab.tabId, url: tab.url, windowId: tab.windowId, groupId: tab.groupId }] };
		}
		if (command.method === "close") {
			const targetTabId = Number(command.targetTabId || command.closeTabId || command.tabId);
			this.tabs = this.tabs.filter((tab) => tab.tabId !== targetTabId);
			return { id: `tabs-${this.commandLog.length}`, acknowledged: true, data: { ok: true, tabId: targetTabId, closed: true } };
		}
		return { id: `tabs-${this.commandLog.length}`, acknowledged: true, data: { ok: true } };
	}

	handleWindows(command) {
		this.ensureWindowsFromTabs();
		if (!command.method || command.method === "list") return { id: `windows-${this.commandLog.length}`, acknowledged: true, data: Array.from(this.windows.keys()).map((windowId) => this.windowSummary(windowId)) };
		if (command.method === "create") {
			const windowId = ++this.nextWindowId;
			this.windows.set(windowId, { id: windowId, windowId, focused: command.focused !== false, type: command.type || "normal", state: command.state || "normal", left: command.left, top: command.top, width: command.width, height: command.height });
			const tab = this.createTabInWindow(command.url || "about:blank", true, windowId);
			return { id: `windows-${this.commandLog.length}`, acknowledged: true, data: { ...this.windowSummary(windowId), created: true, tabs: [{ id: tab.tabId, tabId: tab.tabId, url: tab.url, title: tab.title || "", active: tab.active, windowId, groupId: tab.groupId }] }, newTabs: [{ id: tab.tabId, tabId: tab.tabId, url: tab.url, windowId, groupId: tab.groupId }] };
		}
		if (command.method === "close") {
			const windowId = Number(command.windowId);
			this.windows.delete(windowId);
			this.tabs = this.tabs.filter((tab) => tab.windowId !== windowId);
			return { id: `windows-${this.commandLog.length}`, acknowledged: true, data: { windowId, closed: true } };
		}
		if (command.method === "get" || command.method === "update" || command.method === "focus") {
			const windowId = Number(command.windowId);
			const current = this.windows.get(windowId) || { id: windowId, windowId };
			this.windows.set(windowId, { ...current, focused: command.method === "focus" ? true : command.focused ?? current.focused, state: command.state || current.state, left: command.left ?? current.left, top: command.top ?? current.top, width: command.width ?? current.width, height: command.height ?? current.height });
			return { id: `windows-${this.commandLog.length}`, acknowledged: true, data: this.windowSummary(windowId) };
		}
		return { id: `windows-${this.commandLog.length}`, acknowledged: true, data: { ok: true } };
	}

	handleTabGroups(command) {
		if (!this.tabGroupsSupported) return { id: `tabGroups-${this.commandLog.length}`, acknowledged: true, data: { tabGroupsStatus: "degraded_not_supported", supported: false, reason: "fake_tabGroups_disabled" } };
		if (command.method === "status" || !command.method) return { id: `tabGroups-${this.commandLog.length}`, acknowledged: true, data: { tabGroupsStatus: "available", supported: true } };
		if (this.tabGroupsFail) return { id: `tabGroups-${this.commandLog.length}`, acknowledged: true, data: { tabGroupsStatus: "degraded_operation_failed", supported: true, method: command.method, error: "fake_tabGroups_failure" } };
		if (command.method === "group") {
			const tabIds = Array.isArray(command.tabIds) ? command.tabIds.map(Number) : [Number(command.tabId)].filter(Boolean);
			const groupId = Number(command.groupId || command.tabGroupId || ++this.nextGroupId);
			const windowId = Number(command.windowId || this.tabs.find((tab) => tabIds.includes(tab.tabId))?.windowId || 1);
			this.groups.set(groupId, { id: groupId, groupId, windowId, title: "", color: "grey", collapsed: false });
			for (const tab of this.tabs) if (tabIds.includes(tab.tabId)) tab.groupId = groupId;
			return { id: `tabGroups-${this.commandLog.length}`, acknowledged: true, data: { tabGroupsStatus: "available", supported: true, groupId, tabIds } };
		}
		if (command.method === "update") {
			const groupId = Number(command.tabGroupId || command.groupId);
			const current = this.groups.get(groupId) || { id: groupId, groupId, windowId: Number(command.windowId || 1) };
			const group = { ...current, title: command.title ?? current.title, color: command.color ?? current.color, collapsed: command.collapsed ?? current.collapsed };
			this.groups.set(groupId, group);
			return { id: `tabGroups-${this.commandLog.length}`, acknowledged: true, data: { tabGroupsStatus: "available", supported: true, group } };
		}
		if (command.method === "query") return { id: `tabGroups-${this.commandLog.length}`, acknowledged: true, data: { tabGroupsStatus: "available", supported: true, groups: Array.from(this.groups.values()) } };
		if (command.method === "ungroup") {
			const tabIds = Array.isArray(command.tabIds) ? command.tabIds.map(Number) : [Number(command.tabId)].filter(Boolean);
			for (const tab of this.tabs) if (tabIds.includes(tab.tabId)) delete tab.groupId;
			return { id: `tabGroups-${this.commandLog.length}`, acknowledged: true, data: { tabGroupsStatus: "available", supported: true, ungrouped: tabIds } };
		}
		return { id: `tabGroups-${this.commandLog.length}`, acknowledged: true, data: { tabGroupsStatus: "available", supported: true } };
	}

	handleCookies(command) {
		const key = `${command.url}\n${command.name}`;
		if (command.method === "get") return { id: `cookie-${this.commandLog.length}`, acknowledged: true, data: this.cookies.has(key) ? { name: command.name, value: this.cookies.get(key), url: command.url } : null };
		if (command.method === "set") {
			this.cookies.set(key, command.value);
			return { id: `cookie-${this.commandLog.length}`, acknowledged: true, data: { set: true, cookie: { name: command.name, valuePresent: true, valueLength: String(command.value).length }, details: { url: command.url, name: command.name } } };
		}
		if (command.method === "remove") {
			const removed = this.cookies.delete(key);
			return { id: `cookie-${this.commandLog.length}`, acknowledged: true, data: { removed, details: { url: command.url, name: command.name } } };
		}
		return { id: `cookie-${this.commandLog.length}`, acknowledged: true, data: [] };
	}

	networkKey(command, options) { return `${Number(options.tabId)}:${command.sessionId || "default"}`; }
	networkStatus(command, options) {
		const item = this.network.get(this.networkKey(command, options));
		return { id: `network-${this.commandLog.length}`, acknowledged: true, tabId: Number(options.tabId), data: item ? { tabId: Number(options.tabId), sessionId: command.sessionId, active: true, recorderId: item.recorderId, config: item.config } : { tabId: Number(options.tabId), sessionId: command.sessionId, active: false } };
	}
	networkStart(command, options) {
		const { cmd, sessionId, tabId, reconfigure, ...config } = command;
		const item = { recorderId: `rec-${this.network.size + 1}`, config };
		this.network.set(this.networkKey(command, options), item);
		return { id: `network-${this.commandLog.length}`, acknowledged: true, tabId: Number(options.tabId), data: { tabId: Number(options.tabId), sessionId: command.sessionId, active: true, recorderId: item.recorderId } };
	}
	networkStop(command, options) {
		this.network.delete(this.networkKey(command, options));
		return { id: `network-${this.commandLog.length}`, acknowledged: true, tabId: Number(options.tabId), data: { tabId: Number(options.tabId), sessionId: command.sessionId, stopped: true } };
	}

	hookKey(command, options) { return `${Number(options.tabId)}:${command.sessionId || "default"}`; }
	hookStatus(command, options) {
		const item = this.hooks.get(this.hookKey(command, options));
		return { id: `hook-${this.commandLog.length}`, acknowledged: true, tabId: Number(options.tabId), data: item ? { session_id: command.sessionId, state: "INSTALLED", install_fingerprint: item.installFingerprint } : { session_id: command.sessionId, state: "CLOSED" } };
	}
	hookInstall(command, options) {
		this.hooks.set(this.hookKey(command, options), { installFingerprint: command.installFingerprint });
		return { id: `hook-${this.commandLog.length}`, acknowledged: true, tabId: Number(options.tabId), data: { session_id: command.sessionId, state: "INSTALLED", install_fingerprint: command.installFingerprint } };
	}
	hookUninstall(command, options) {
		this.hooks.delete(this.hookKey(command, options));
		return { id: `hook-${this.commandLog.length}`, acknowledged: true, tabId: Number(options.tabId), data: { session_id: command.sessionId, state: "CLOSED" } };
	}

	addPreNavigationScript(command, options) {
		const tabId = Number(options.tabId);
		const identifier = `script-${this.nextScriptId++}`;
		const scripts = this.preNavigationScripts.get(tabId) || [];
		const item = { tabId, identifier, sessionKey: `${tabId}:new_document`, cdpSessionName: "new_document", method: "Page.addScriptToEvaluateOnNewDocument", createdAt: Date.now(), runImmediately: command.runImmediately === true, includeCommandLineAPI: command.includeCommandLineAPI === true };
		scripts.push(item);
		this.preNavigationScripts.set(tabId, scripts);
		return { id: `frame-${this.commandLog.length}`, acknowledged: true, tabId, data: { tabId, ...item, detached: false } };
	}

	removePreNavigationScript(command, options) {
		const tabId = Number(options.tabId);
		const scripts = this.preNavigationScripts.get(tabId) || [];
		const before = scripts.length;
		const next = scripts.filter((item) => item.identifier !== command.identifier);
		this.preNavigationScripts.set(tabId, next);
		if (!next.length) this.preNavigationEffects.delete(tabId);
		return { id: `frame-${this.commandLog.length}`, acknowledged: true, tabId, data: { tabId, identifier: command.identifier, removed: before !== next.length, alreadyRemoved: before === next.length, sessionKey: `${tabId}:new_document`, cdpSessionName: "new_document", method: "Page.removeScriptToEvaluateOnNewDocument" } };
	}

	handlePersistentCdp(command, options) {
		const tabId = Number(options.tabId || command.tabId);
		if (command.action === "listNewDocumentScripts") return { id: `pcdp-${this.commandLog.length}`, acknowledged: true, tabId, data: { tabId, cdpSessionName: "new_document", scripts: this.preNavigationScripts.get(tabId) || [] } };
		if (command.action === "send" && command.cdpMethod === "Runtime.evaluate") return { id: `pcdp-${this.commandLog.length}`, acknowledged: true, tabId, data: { result: { result: { type: "boolean", value: this.preNavigationEffects.get(tabId) === true } }, sessionKey: `${tabId}:new_document`, method: "Runtime.evaluate" } };
		return { id: `pcdp-${this.commandLog.length}`, acknowledged: true, tabId, data: { ok: true } };
	}
}

const desired = {
	apiVersion: "pi.browser/v1",
	orchestrationId: "orch-main",
	defaults: { timeoutMs: 5000, navigationTimeoutMs: 1000 },
	sessions: [{
		tag: "alpha",
		tabs: [{ role: "main", url: "https://example.test/app", waitUntil: "none" }],
		cookies: [{ name: "session", value: "secret-value", path: "/" }],
		networkRecorder: true,
		hookDispatcher: true,
	}],
};

{
	const server = new FakeOrchestrationServer();
	const coordinator = new BrowserOrchestrationCoordinator(server);
	const plan = captureFixture("plan", await coordinator.plan(desired));
	assert.equal(plan.plan.operations.some((op) => op.action === "createTab"), true, "plan must create missing desired tab");
	assert.equal(JSON.stringify(plan).includes("secret-value"), false, "plan must not leak raw cookie values");
	const applied = captureFixture("apply", await coordinator.apply(desired));
	assert.equal(applied.ok, true, "apply must converge happy path");
	assert.equal(applied.bindings.length, 1, "apply must bind the owned tab");
	assert.equal(JSON.stringify(applied).includes("secret-value"), false, "apply envelope must not leak raw cookie values");
	const firstCreateCount = server.commandLog.filter((item) => item.cmd === "tabs.create").length;
	const second = captureFixture("duplicateApply", await coordinator.apply(desired));
	assert.equal(second.ok, true, "duplicate apply must remain converged");
	assert.equal(server.commandLog.filter((item) => item.cmd === "tabs.create").length, firstCreateCount, "duplicate apply must not create another tab");
	const status = captureFixture("status", await coordinator.status("orch-main"));
	assert.equal(status.ok, true, "status must report converged state");
	assert.equal(status.plan.operationCount, 0, "status plan must be empty after convergence");
	const watched = await coordinator.watch(desired, { intervalMs: 1000, ttlMs: 2000, maxAttempts: 2, timeoutMs: 1000 });
	assert.equal(watched.action, "watch", "watch must return a watch action envelope");
	assert.equal(watched.watch.active, true, "watch must mark active watch metadata");
	const stopped = await coordinator.stop("orch-main");
	assert.equal(stopped.stopped, true, "stop must cancel the watch timer");
	const deleted = captureFixture("delete", await coordinator.delete("orch-main"));
	assert.equal(deleted.ok, true, "delete must clean owned resources");
	assert.equal(server.commandLog.some((item) => item.cmd === "network.stop"), true, "delete must stop owned recorder");
	assert.equal(server.commandLog.some((item) => item.cmd === "hook.uninstall"), true, "delete must uninstall owned hook");
	assert.equal(server.commandLog.some((item) => item.cmd === "tabs.close"), true, "delete must close owned tab");
	assert.equal((await coordinator.status("orch-main")).ok, false, "delete must remove runtime state");
}

{
	const server = new FakeOrchestrationServer({ immediateWaitFails: true });
	const coordinator = new BrowserOrchestrationCoordinator(server);
	const waitDesired = {
		apiVersion: "pi.browser/v1",
		orchestrationId: "orch-post-apply-observe",
		defaults: { timeoutMs: 1200, navigationTimeoutMs: 800 },
		sessions: [{ tag: "wait", tabs: [{ role: "main", url: "https://wait-ready.test/app", waitUntil: "complete" }] }],
	};
	const applied = captureFixture("applyPostObserveWait", await coordinator.apply(waitDesired));
	assert.equal(applied.ok, true, "apply must stay converged when post-observe loadState requires a positive timeout");
	assert.equal(applied.plan.operationCount, 0, "apply must not retain synthetic navigation drift after verify succeeds");
	assert.equal(server.commandLog.some((item) => item.cmd === "wait.loadState" && Number(item.timeoutMs || 0) > 0), true, "post-observe loadState checks must use a positive timeout");
	const deleted = await coordinator.delete("orch-post-apply-observe");
	assert.equal(deleted.ok, true, "wait-ready fixture cleanup must succeed");
}

{
	const stateDir = path.resolve(".pi", "browser-artifacts", "orchestration-persistence-fixture");
	const statePath = path.join(stateDir, "state.v1.json");
	await rm(stateDir, { recursive: true, force: true });
	const server = new FakeOrchestrationServer();
	const persistence = new PersistentOrchestrationStore({ statePath, driverRunId: "persist-run-a", piSessionId: "persist-session" });
	const coordinator = new BrowserOrchestrationCoordinator(server, { persistence });
	const persistDesired = {
		apiVersion: "pi.browser/v1",
		orchestrationId: "orch-persist",
		defaults: { timeoutMs: 3000, navigationTimeoutMs: 1000 },
		sessions: [{
			tag: "persist",
			tabs: [{ role: "main", url: "https://persist.test/app", waitUntil: "none" }],
			cookies: [{ name: "sid", value: "persist-secret", path: "/" }],
			networkRecorder: { sessionId: "persist-net" },
			hookDispatcher: { sessionId: "persist-hook", installFingerprint: "persist-fp" },
		}],
	};
	const applied = captureFixture("persistenceApply", await coordinator.apply(persistDesired));
	assert.equal(applied.ok, true, "persistence apply must converge before save/load");
	const savedText = await readFile(statePath, "utf8");
	assert.equal(savedText.includes("persist-secret"), false, "persisted state must not leak raw cookie values");
	for (const forbidden of ["HTTP/WebSocket raw body", "postData", "payloadData", "__PI_BROWSER_PRE_NAVIGATION_HOOKS__"]) assert.equal(savedText.includes(forbidden), false, `persisted state must not contain ${forbidden}`);
	const saved = JSON.parse(savedText);
	assert.equal(saved.schemaVersion, "pi.browser.orchestration.state/v1", "persisted state schema must be v1");
	assert.equal(saved.privacy.classification, "local_redacted_orchestration_state", "persisted state must carry local redacted privacy metadata");
	assert.equal(saved.orchestrations[0].cookies[0].valuePresent, true, "persisted cookie must retain presence metadata");
	assert.match(saved.orchestrations[0].cookies[0].valueHash, /^[a-f0-9]{64}$/, "persisted cookie must retain only a hash");
	assert.equal(saved.orchestrations[0].cookies[0].value, undefined, "persisted cookie must not expose raw value field");

	const reloaded = new BrowserOrchestrationCoordinator(server, { persistence: new PersistentOrchestrationStore({ statePath, driverRunId: "persist-run-b", piSessionId: "persist-session" }) });
	const load = captureFixture("persistenceLoad", await reloaded.loadPersistentState());
	assert.equal(load.loaded, 1, "persistent store must load one stale orchestration");
	const staleStatus = captureFixture("persistenceStaleStatus", await reloaded.status("orch-persist"));
	assert.equal(staleStatus.ok, true, "stale status must be visible");
	assert.equal(staleStatus.state.persistence.readOnly, true, "loaded persistent state must be read-only");
	assert.equal(staleStatus.state.persistence.adoptionRequired, true, "loaded persistent state must require adoption");
	const beforeSideEffects = server.commandLog.length;
	for (const result of [
		await reloaded.apply(persistDesired),
		await reloaded.watch(persistDesired, { intervalMs: 1000, ttlMs: 1000, maxAttempts: 1 }),
		await reloaded.stop("orch-persist"),
		await reloaded.delete("orch-persist"),
	]) {
		assert.equal(result.ok, false, "stale apply/watch/stop/delete must be rejected before adoption");
		assert.equal(result.failures[0].code, ORCHESTRATION_ERROR_CODES.TARGET_STALE, "stale mutation must return target-stale/adoption-required failure");
	}
	assert.equal(server.commandLog.length, beforeSideEffects, "stale mutation rejection must not execute browser side effects");

	const badAdoption = await reloaded.apply({ ...persistDesired, adoption: { enabled: true, orchestrationId: "orch-persist", resourceTypes: ["tab"], verifyOrigins: ["https://wrong.test"], verifyUrls: ["https://wrong.test/app"], requireOwnedFingerprint: true } });
	assert.equal(badAdoption.ok, false, "adoption must fail when verifyOrigins/verifyUrls do not match");
	assert.equal(server.commandLog.some((item) => item.cmd === "tabs.close"), false, "failed adoption must not close old tabs");
	const adopted = captureFixture("persistenceAdopt", await reloaded.apply({ ...persistDesired, adoption: { enabled: true, orchestrationId: "orch-persist", resourceTypes: ["tab", "networkRecorder", "hookDispatcher", "cookie"], verifyOrigins: ["https://persist.test"], verifyUrls: ["https://persist.test/app"], requireOwnedFingerprint: true } }));
	assert.equal(adopted.ok, true, "explicit adoption must allow normal reconcile after verification");
	const adoptedStatus = await reloaded.status("orch-persist");
	assert.equal(adoptedStatus.state.persistence.status, "adopted", "adopted state must clear read-only gate");
	assert.equal(adoptedStatus.state.persistence.readOnly, false, "adopted state must become mutable");
	const deleted = captureFixture("persistenceAdoptedDelete", await reloaded.delete("orch-persist"));
	assert.equal(deleted.ok, true, "delete after adoption must cleanup adopted resources");
	assert.equal(server.commandLog.some((item) => item.cmd === "network.stop"), true, "adopted delete must stop adopted network recorder");
	assert.equal(server.commandLog.some((item) => item.cmd === "hook.uninstall"), true, "adopted delete must uninstall adopted hook dispatcher");
	assert.equal(server.commandLog.some((item) => item.cmd === "tabs.close"), true, "adopted delete may close verified owned tab");
}

{
	const server = new FakeOrchestrationServer();
	const coordinator = new BrowserOrchestrationCoordinator(server);
	const selfHealDesired = {
		apiVersion: "pi.browser/v1",
		orchestrationId: "orch-watch",
		defaults: { timeoutMs: 1200, navigationTimeoutMs: 800 },
		sessions: [{
			tag: "watch",
			tabs: [{ role: "main", url: "https://watch.test/app", waitUntil: "complete", recreateOnMissing: true }],
			cookies: [{ name: "watch_sid", value: "watch-secret", path: "/" }],
			networkRecorder: { maxEntries: 7 },
			hookDispatcher: { installFingerprint: "fp-watch" },
		}],
	};
	const watched = await coordinator.watch(selfHealDesired, { intervalMs: 1000, ttlMs: 4500, maxAttempts: 3, timeoutMs: 1200 });
	assert.equal(watched.ok, true, "initial watch apply must converge");
	const firstTabId = watched.bindings[0].tabId;
	const createCount = server.commandLog.filter((item) => item.cmd === "tabs.create").length;
	server.tabs = [];
	server.network.clear();
	server.hooks.clear();
	server.cookies.set("https://watch.test/app\nwatch_sid", "drifted-secret");
	server.browser.workerBootId = "boot-2";
	await waitUntil(() => server.tabs.length === 1 && server.tabs[0].tabId !== firstTabId && server.commandLog.filter((item) => item.cmd === "tabs.create").length === createCount + 1, "watch tab recreate");
	await waitUntil(() => server.commandLog.some((item) => item.cmd === "network.start" && item.maxEntries === 7) && server.commandLog.some((item) => item.cmd === "hook.install" && item.installFingerprint === "fp-watch") && server.cookies.get("https://watch.test/app\nwatch_sid") === "watch-secret", "watch recorder/hook/cookie self-heal");
	const createCountAfterHeal = server.commandLog.filter((item) => item.cmd === "tabs.create").length;
	await delay(1200);
	assert.equal(server.commandLog.filter((item) => item.cmd === "tabs.create").length, createCountAfterHeal, "watch must not keep creating tabs after drift is healed");
	const status = captureFixture("watchSelfHealStatus", await coordinator.status("orch-watch"));
	assert.equal(status.ok, true, "status must converge after watch self-heal");
	assert.ok(status.state.watch.recoveries >= 1, "watch state must report recovery attempts");
	await coordinator.stop("orch-watch");
	const deleted = await coordinator.delete("orch-watch");
	assert.equal(deleted.ok, true, "delete after watch must clean resources");
	assert.equal(server.tabs.length, 0, "delete after watch must leave no owned zombie tabs");
}

{
	const server = new FakeOrchestrationServer({ waitReady: false });
	const coordinator = new BrowserOrchestrationCoordinator(server);
	const paused = await coordinator.watch({ apiVersion: "pi.browser/v1", orchestrationId: "orch-pause", defaults: { timeoutMs: 800, navigationTimeoutMs: 500 }, sessions: [{ tag: "s", tabs: [{ role: "main", url: "https://pause.test/", waitUntil: "complete" }] }] }, { intervalMs: 1000, ttlMs: 2000, maxAttempts: 1, timeoutMs: 800 });
	assert.equal(paused.ok, false, "watch initial reconcile failure must return failed envelope");
	assert.equal(paused.watch.active, false, "watch must pause when maxAttempts is reached");
	assert.equal(paused.watch.pauseReason, "max_attempts", "watch pause must expose pause reason");
	assert.ok(paused.watch.lastFailure, "watch pause must retain retry diagnostics");
}

{
	const server = new FakeOrchestrationServer({ tabs: [{ id: "browser-1:50", browserId: "browser-1", tabId: 50, url: "https://reuse.test/", title: "Reuse", active: true, windowId: 1, type: "ext_ws", connectedAt: Date.now(), bridge: { id: "browser-1", extensionId: "fake-extension" } }] });
	const coordinator = new BrowserOrchestrationCoordinator(server);
	const base = { apiVersion: "pi.browser/v1", sessions: [{ tag: "s", tabs: [{ role: "main", url: "https://reuse.test/", reuse: "matchingUrl", waitUntil: "none" }] }] };
	await coordinator.apply({ ...base, orchestrationId: "orch-a" });
	await assert.rejects(coordinator.apply({ ...base, orchestrationId: "orch-b" }), (error) => {
		assert.equal(error.code, ORCHESTRATION_ERROR_CODES.TARGET_CONFLICT);
		return true;
	});
}

{
	const server = new FakeOrchestrationServer({ tabs: [{ id: "browser-1:60", browserId: "browser-1", tabId: 60, url: "https://keep.test/", title: "Keep", active: true, windowId: 1, type: "ext_ws", connectedAt: Date.now(), bridge: { id: "browser-1", extensionId: "fake-extension" } }] });
	const coordinator = new BrowserOrchestrationCoordinator(server);
	const applied = await coordinator.apply({ apiVersion: "pi.browser/v1", orchestrationId: "orch-nonowned-delete", sessions: [{ tag: "s", tabs: [{ role: "main", url: "https://keep.test/", reuse: "matchingUrl", waitUntil: "none" }], networkRecorder: true, hookDispatcher: true }] });
	assert.equal(applied.ok, true, "reuse apply must bind non-owned tab");
	assert.equal(applied.bindings[0].owned, false, "matchingUrl reuse must remain non-owned");
	const deleted = captureFixture("deleteNonOwned", await coordinator.delete("orch-nonowned-delete"));
	assert.equal(deleted.ok, true, "delete must cleanup non-owned orchestration resources");
	assert.equal(server.commandLog.some((item) => item.cmd === "network.stop"), true, "delete must stop recorder attached to non-owned tab");
	assert.equal(server.commandLog.some((item) => item.cmd === "hook.uninstall"), true, "delete must uninstall hook attached to non-owned tab");
	assert.equal(server.commandLog.some((item) => item.cmd === "tabs.close"), false, "delete must not close non-owned reused tabs");
	assert.equal(server.tabs.some((tab) => tab.tabId === 60), true, "non-owned reused tab must remain open after delete");
}

{
	const server = new FakeOrchestrationServer();
	const coordinator = new BrowserOrchestrationCoordinator(server);
	const windowDesired = {
		apiVersion: "pi.browser/v1",
		orchestrationId: "orch-window-group",
		defaults: { timeoutMs: 3000, navigationTimeoutMs: 800 },
		sessions: [{
			tag: "win",
			ownedWindow: { focused: true, state: "normal", closeOnDelete: true },
			visualGrouping: { title: "Owned Window", color: "blue", collapsed: false },
			tabs: [
				{ role: "main", url: "https://window.test/main", waitUntil: "none" },
				{ role: "side", url: "https://window.test/side", waitUntil: "none", active: false },
			],
		}],
	};
	const plan = captureFixture("ownedWindowPlan", await coordinator.plan(windowDesired));
	assert.equal(plan.plan.operations.some((op) => op.action === "createWindow"), true, "owned window plan must create a window before tabs");
	assert.equal(plan.plan.operations.some((op) => op.action === "groupTabs"), true, "visual grouping plan must include groupTabs");
	const applied = captureFixture("ownedWindowApply", await coordinator.apply(windowDesired));
	assert.equal(applied.ok, true, "owned window apply must converge");
	assert.equal(applied.bindings.length, 2, "owned window apply must bind both tabs");
	assert.equal(new Set(applied.bindings.map((binding) => binding.windowId)).size, 1, "owned tabs must share the owned windowId");
	assert.equal(applied.bindings.every((binding) => binding.windowOwned === true && binding.windowCloseOnDelete === true), true, "bindings must mark owned window cleanup metadata");
	assert.equal(applied.bindings.every((binding) => binding.groupId && binding.tabGroupsStatus === "available"), true, "bindings must preserve tabGroups success metadata");
	assert.equal(server.commandLog.some((item) => item.cmd === "windows" && item.method === "create"), true, "apply must call windows.create");
	assert.equal(server.commandLog.some((item) => item.cmd === "tabs" && item.method === "create" && item.windowId === applied.bindings[0].windowId), true, "secondary tabs must be created inside the owned window");
	assert.equal(server.commandLog.some((item) => item.cmd === "tabGroups" && item.method === "group"), true, "apply must call tabGroups.group when visual grouping is enabled");
	const deleted = captureFixture("ownedWindowDelete", await coordinator.delete("orch-window-group"));
	assert.equal(deleted.ok, true, "delete must close owned window resources");
	assert.equal(deleted.operationResults.some((item) => item.action === "closeWindow"), true, "delete must use closeWindow for owned windows");
	assert.equal(server.commandLog.filter((item) => item.cmd === "windows" && item.method === "close").length, 1, "delete must close each owned window exactly once");
	assert.equal(server.tabs.some((tab) => tab.windowId === applied.bindings[0].windowId), false, "owned window delete must remove owned-window tabs");
}

{
	const server = new FakeOrchestrationServer({ tabGroupsSupported: false });
	const coordinator = new BrowserOrchestrationCoordinator(server);
	const degradedDesired = {
		apiVersion: "pi.browser/v1",
		orchestrationId: "orch-tabgroups-degraded",
		defaults: { timeoutMs: 3000, navigationTimeoutMs: 800 },
		sessions: [{
			tag: "degraded",
			ownedWindow: true,
			visualGrouping: { title: "Degraded Group" },
			tabs: [
				{ role: "main", url: "https://degraded.test/main", waitUntil: "none" },
				{ role: "side", url: "https://degraded.test/side", waitUntil: "none", active: false },
			],
		}],
	};
	const applied = captureFixture("tabGroupsDegradedApply", await coordinator.apply(degradedDesired));
	assert.equal(applied.ok, true, "tabGroups unsupported must not block core window/tab reconcile");
	assert.equal(applied.operationResults.some((item) => item.action === "groupTabs" && item.status === "degraded"), true, "groupTabs must be marked degraded instead of failed");
	assert.equal(applied.bindings.every((binding) => binding.tabGroupsStatus === "degraded_not_supported"), true, "bindings must preserve tabGroups degraded diagnostic");
	assert.equal(server.commandLog.some((item) => item.cmd === "windows" && item.method === "create"), true, "degraded visual grouping must still create owned window");
	assert.equal(server.commandLog.some((item) => item.cmd === "tabs" && item.method === "create"), true, "degraded visual grouping must still create owned tabs");
	const status = captureFixture("tabGroupsDegradedStatus", await coordinator.status("orch-tabgroups-degraded"));
	assert.equal(status.ok, true, "status must converge after tabGroups degraded diagnostic is recorded");
	assert.equal(status.actual.tabGroups.tabGroupsStatus, "degraded_not_supported", "actual must expose degraded tabGroupsStatus");
	const deleted = await coordinator.delete("orch-tabgroups-degraded");
	assert.equal(deleted.ok, true, "delete must cleanup owned window even after tabGroups degraded");
}

{
	const server = new FakeOrchestrationServer();
	const coordinator = new BrowserOrchestrationCoordinator(server);
	const hookHash = preNavigationHookRegistryHash();
	const hookDesired = {
		apiVersion: "pi.browser/v1",
		orchestrationId: "orch-pre-nav",
		defaults: { timeoutMs: 3000, navigationTimeoutMs: 800 },
		preNavigationHooks: [{ hookId: "pi.preNavigationMarker", version: "1", hash: hookHash, required: true }],
		sessions: [{ tag: "pre", tabs: [{ role: "main", url: "https://pre-nav.test/app", waitUntil: "none" }] }],
	};
	const plan = captureFixture("preNavigationPlan", await coordinator.plan(hookDesired));
	const actions = plan.plan.operations.map((item) => item.action);
	assert(actions.indexOf("installPreNavigationHook") > actions.indexOf("createTab"), "pre-navigation plan must install after tab creation");
	assert(actions.indexOf("navigate") > actions.indexOf("installPreNavigationHook"), "pre-navigation plan must navigate after hook install");
	const applied = captureFixture("preNavigationApply", await coordinator.apply(hookDesired));
	assert.equal(applied.ok, true, "pre-navigation hook apply must converge");
	assert.equal(applied.operationResults.some((item) => item.action === "installPreNavigationHook" && item.status === "succeeded"), true, "apply must install pre-navigation hook");
	assert.equal(applied.operationResults.some((item) => item.action === "navigate" && item.status === "succeeded"), true, "apply must navigate after hook install");
	assert.equal(applied.bindings[0].preNavigationHooks.length, 1, "binding must store pre-navigation hook registration metadata");
	assert.equal(server.commandLog.some((item) => item.cmd === "tabs.create" && item.url === "about:blank"), true, "tabs with pre-navigation hook must be created as about:blank first");
	assert.equal(server.commandLog.some((item) => item.cmd === "frame.addNewDocumentScript"), true, "runtime must call frame.addNewDocumentScript");
	assert.equal(server.preNavigationEffects.get(applied.bindings[0].tabId), true, "fake page must observe pre-navigation hook effect after navigate");
	server.browser.workerBootId = "boot-pre-nav-2";
	server.preNavigationScripts.clear();
	server.preNavigationEffects.clear();
	const recovered = captureFixture("preNavigationRecoverApply", await coordinator.apply(hookDesired));
	assert.equal(recovered.ok, true, "pre-navigation hook apply must recover after worker restart/lost registration");
	assert.equal(recovered.operationResults.some((item) => item.action === "installPreNavigationHook" && item.status === "succeeded"), true, "recovery must reinstall lost pre-navigation hook");
	const deleted = captureFixture("preNavigationDelete", await coordinator.delete("orch-pre-nav"));
	assert.equal(deleted.ok, true, "delete must cleanup pre-navigation hook resources");
	assert.equal(deleted.operationResults.some((item) => item.action === "uninstallPreNavigationHook" && item.status === "succeeded"), true, "delete must uninstall pre-navigation hooks before tab cleanup");
}

{
	const server = new FakeOrchestrationServer({ fail: { "hook.install": "INJECTION_FAILED" } });
	const coordinator = new BrowserOrchestrationCoordinator(server);
	const failed = captureFixture("partialFailure", await coordinator.apply({ apiVersion: "pi.browser/v1", orchestrationId: "orch-fail", sessions: [{ tag: "s", tabs: [{ role: "main", url: "https://failure.test/", waitUntil: "none" }], hookDispatcher: true }] }));
	assert.equal(failed.ok, false, "required operation failure must return partial failure envelope");
	assert.equal(failed.failures.some((failure) => failure.operationId && failure.message.includes("hook.install failed")), true, "failure envelope must include failed operation");
	assert.equal(server.commandLog.some((item) => item.cmd === "tabs.close"), true, "cleanup compensation must close tab created in the failed apply");
	assert.equal(server.tabs.length, 0, "cleanup compensation must remove created tab from fake browser");
	assert.equal(JSON.stringify(failed).includes("must-redact"), false, "failure details must be redacted");
}

const fixtureText = JSON.stringify({ ok: true, fixtureEvidence }, null, 2);
assert.equal(fixtureText.includes("secret-value"), false, "fixture artifact must not leak raw cookie values");
assert.equal(fixtureEvidence.some((item) => item.name === "partialFailure" && item.data.ok === false), true, "fixture artifact must include partial failure envelope");
assert.equal(fixtureEvidence.some((item) => item.name === "duplicateApply" && item.data.ok === true), true, "fixture artifact must include duplicate apply envelope");
assert.equal(fixtureEvidence.some((item) => item.name === "ownedWindowApply" && item.data.operationResults.some((op) => op.action === "createWindow") && item.data.bindings.every((binding) => binding.windowId && binding.groupId)), true, "fixture artifact must include owned window/group lifecycle evidence");
assert.equal(fixtureEvidence.some((item) => item.name === "tabGroupsDegradedApply" && item.data.operationResults.some((op) => op.status === "degraded") && item.data.bindings.every((binding) => binding.tabGroupsStatus === "degraded_not_supported")), true, "fixture artifact must include tabGroups degraded evidence");
assert.equal(fixtureEvidence.some((item) => item.name === "preNavigationApply" && item.data.operationResults.some((op) => op.action === "installPreNavigationHook") && item.data.bindings.every((binding) => binding.preNavigationHooks?.length === 1)), true, "fixture artifact must include pre-navigation hook registration evidence");
assert.equal(fixtureEvidence.some((item) => item.name === "preNavigationRecoverApply" && item.data.operationResults.some((op) => op.action === "installPreNavigationHook")), true, "fixture artifact must include pre-navigation recovery evidence");
assert.equal(fixtureText.includes("__PI_BROWSER_PRE_NAVIGATION_HOOKS__"), false, "fixture artifact must not include raw pre-navigation hook script bytes");
await mkdir(path.dirname(fixtureArtifactPath), { recursive: true });
await writeFile(fixtureArtifactPath, `${fixtureText}\n`, "utf8");

console.log("orchestration coordinator contract ok");
