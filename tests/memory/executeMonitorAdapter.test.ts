import assert from "node:assert/strict";
import test from "node:test";
import { buildExecuteMonitorMetadata, diffExecuteMonitorContent, readExecuteMonitorScan } from "../../src/commands/execute/monitorAdapter.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";
import type { BrowserBridgeExecutionResult } from "../../src/ports/BrowserRuntimeTypes.ts";

type MockServerOptions = {
	sendCommandResults?: unknown[];
	executeJavaScriptResults?: BrowserBridgeExecutionResult[];
};

function mockServer(options: MockServerOptions = {}): BrowserCommandRuntimePort & { calls: { sendCommand: unknown[]; executeJavaScript: unknown[] } } {
	const calls = { sendCommand: [] as unknown[], executeJavaScript: [] as unknown[] };
	const sendCommandResults = [...(options.sendCommandResults ?? [])];
	const executeJavaScriptResults = [...(options.executeJavaScriptResults ?? [])];
	let operationSeq = 0;
	return {
		calls,
		snapshot() {
			return { host: "127.0.0.1", port: 18765, running: true, connectedClients: 1, extensionConnected: true, clients: [], defaultTabId: 7, selectionVersion: 1, tabs: [], pending: [] };
		},
		getTabs() { return []; },
		async refreshTabs() { return []; },
		resolveTargetTabId(value) { return Number(value); },
		async sendCommand(command, sendOptions) {
			calls.sendCommand.push({ command, options: sendOptions });
			const next = sendCommandResults.shift();
			if (next instanceof Error) throw next;
			return (next ?? { id: "send-default", acknowledged: true, tabId: 7, data: {} }) as BrowserBridgeExecutionResult;
		},
		async executeJavaScript(script, execOptions) {
			calls.executeJavaScript.push({ script, options: execOptions });
			return executeJavaScriptResults.shift() ?? { id: "exec-default", acknowledged: true, tabId: 7, data: { content: "legacy" } };
		},
		async switchTab() { return { id: "switch", acknowledged: true }; },
		async createTab() { return { id: "create", acknowledged: true }; },
		async closeTab() { return { id: "close", acknowledged: true }; },
		async waitForExtensionReconnect() { return this.snapshot(); },
		listBrowserSessions() { return []; },
		createBrowserSession() { return {}; },
		selectBrowserSession() { return {}; },
		closeBrowserSession() { return {}; },
		attachTabToBrowserSession() { return {}; },
		detachTabFromBrowserSession() { return {}; },
		leaseTab() { return { id: "lease", browserSessionId: "session", tabSessionId: "tab", browserId: "browser", tabId: 7, explicit: true, createdAt: 1, lastSeenAt: 1 }; },
		releaseTab() { return undefined; },
		acquireUiLock() { return { browserSessionId: "session", commandName: "browser_execute", createdAt: 1, lastSeenAt: 1, count: 1 }; },
		releaseUiLock() { return undefined; },
		selectBrowser() { return {}; },
		createObservationSnapshot(snapshot) { return { snapshotId: snapshot.snapshotId ?? "snapshot-1", ttlMs: snapshot.ttlMs ?? 1, expired: false, ...snapshot }; },
		getObservationSnapshot() { return undefined; },
		listObservationSnapshots() { return []; },
		beginOperation(operation) {
			operationSeq += 1;
			return { operationId: operation.operationId ?? `operation-${operationSeq}`, startedAt: 10, updatedAt: 10, ...operation };
		},
		updateOperation(operationId, patch) { return { operationId, commandName: "browser_execute", phase: "running", startedAt: 10, updatedAt: 20, ...patch }; },
		finishOperation(operationId) { return { operationId, commandName: "browser_execute", phase: "completed", startedAt: 10, updatedAt: 20 }; },
		queueDepth() { return 0; },
		leaseOwnerHash() { return undefined; },
	};
}

test("browser_execute monitor characterization: diff metadata preserves program navigation warning", () => {
	const monitor = buildExecuteMonitorMetadata(
		{ ok: true, content: "Chapter 1\nContinue", url: "https://example.test/one", source: "abml-read" },
		{ ok: true, content: "Chapter 2\nContinue", url: "https://example.test/two", source: "legacy-scan" },
		{ navigationWarning: "program navigation warning" },
	);
	assert.deepEqual(monitor, {
		url: "https://example.test/two",
		beforeOk: true,
		afterOk: true,
		beforeChars: 18,
		afterChars: 18,
		changed: 1,
		top_change: "Chapter 2",
		navigated: true,
		changedReliable: false,
		warning: "program navigation warning",
		urlBefore: "https://example.test/one",
		urlAfter: "https://example.test/two",
		beforeError: undefined,
		afterError: undefined,
		beforeSource: "abml-read",
		afterSource: "legacy-scan",
	});
});

test("browser_execute monitor characterization: after scan failures are tolerated for script monitor", () => {
	const monitor = buildExecuteMonitorMetadata(
		{ ok: true, content: "ready", url: "https://example.test/", source: "abml-read" },
		{ ok: false, error: { code: "MONITOR_SCAN_FAILED", message: "after failed" } },
		{ includeAfterUnreliable: true },
	);
	assert.equal(monitor.changed, 0);
	assert.equal(monitor.afterUnreliable, true);
	assert.equal(monitor.beforeOk, true);
	assert.equal(monitor.afterOk, false);
	assert.deepEqual(monitor.afterError, { code: "MONITOR_SCAN_FAILED", message: "after failed" });
});

test("browser_execute monitor characterization: script and program without monitor do not scan", () => {
	assert.deepEqual(diffExecuteMonitorContent("alpha\nbeta", "alpha\nbeta"), { changed: 0, top_change: undefined });
});

test("browser_execute monitor characterization: ABML read success uses summary text preview", async () => {
	const server = mockServer({
		sendCommandResults: [
			{ id: "cdp-scan", acknowledged: true, tabId: 7, data: { result: { result: { value: { url: "https://example.test/", title: "Example", content: "ignored" } } } } },
			{ id: "ax", acknowledged: true, tabId: 7, data: { nodes: [] } },
			{ id: "listener", acknowledged: true, tabId: 7, data: { result: { result: { value: [] } } } },
		],
	});
	const scan = await readExecuteMonitorScan(server, { tabId: 7, timeoutMs: 500 });
	assert.equal(scan.ok, true);
	assert.equal(scan.source, "abml-read");
	assert.equal(scan.url, "https://example.test/");
	assert.equal(typeof scan.content, "string");
	assert.equal(server.calls.executeJavaScript.length, 0);
});

test("browser_execute monitor characterization: legacy scan fallback runs when ABML read is unavailable", async () => {
	const server = mockServer({
		sendCommandResults: [new Error("abml unavailable")],
		executeJavaScriptResults: [{ id: "legacy", acknowledged: true, tabId: 7, data: { content: "legacy page text" } }],
	});
	const scan = await readExecuteMonitorScan(server, { tabId: 7, timeoutMs: 500 });
	assert.equal(scan.ok, true);
	assert.equal(scan.source, "legacy-scan");
	assert.equal(scan.content, "legacy page text");
	assert.equal(server.calls.executeJavaScript.length, 1);
});
