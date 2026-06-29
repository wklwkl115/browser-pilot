import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrowserCommandRuntimePort, BrowserTabLike, CommandActiveOperationInfo, CommandObservationSnapshotInfo } from "../../src/ports/BrowserCommandRuntimePort.ts";
import type { BrowserBridgeExecutionResult, BrowserRuntimeCommand } from "../../src/ports/BrowserRuntimeTypes.ts";
import { runScanObservation } from "../../src/commands/observe/scanRunner.ts";
import type { ObserveToolParams } from "../../src/commands/observe/common.ts";

type MockOptions = {
	cwd?: string;
	refreshTabsFails?: boolean;
	tabId?: number;
	tabs?: BrowserTabLike[];
	tabFallback?: BrowserTabLike[];
	tabRefreshError?: unknown;
	tabUrl?: string;
	content?: string;
	tabTitle?: string;
	tabDefault?: number;
	noDefaultTab?: boolean;
};

function scanData(options: MockOptions): Record<string, unknown> {
	const tabId = options.tabId ?? 7;
	return {
		url: options.tabUrl ?? "https://example.test/checkout",
		title: options.tabTitle ?? "Checkout",
		content: options.content ?? "Checkout content",
		actionables: [
			{ kind: "button", label: "Pay now", text: "Pay now", selector: "#pay", rect: { x: 1, y: 2, width: 90, height: 30 } },
		],
		signals: { fingerprint: { changeSeq: 1, url: options.tabUrl ?? "https://example.test/checkout" } },
		tabId,
	};
}

function createMockServer(options: MockOptions = {}): BrowserCommandRuntimePort & { calls: { refreshTabs: number; getTabs: number; sendCommand: BrowserRuntimeCommand[] } } {
	const tabId = options.tabId ?? 7;
	const tabs = options.tabs ?? [{ id: tabId, tabId, url: options.tabUrl ?? "https://example.test/checkout", title: options.tabTitle ?? "Checkout", active: true }];
	const fallbackTabs = options.tabFallback ?? tabs;
	let operationSeq = 0;
	let snapshotSeq = 0;
	const operations = new Map<string, CommandActiveOperationInfo>();
	const snapshots = new Map<string, CommandObservationSnapshotInfo>();
	const calls = { refreshTabs: 0, getTabs: 0, sendCommand: [] as BrowserRuntimeCommand[] };
	const server = {
		calls,
		snapshot() {
			return {
				browserSessionId: "session-1",
				host: "127.0.0.1",
				port: 18765,
				running: true,
				connectedClients: 1,
				extensionConnected: true,
				clients: [],
				...(options.noDefaultTab ? {} : { defaultTabId: options.tabDefault ?? tabId }),
				selectionVersion: 1,
				tabs,
				pending: [],
			};
		},
		getTabs() {
			calls.getTabs += 1;
			return fallbackTabs;
		},
		async refreshTabs() {
			calls.refreshTabs += 1;
			if (options.refreshTabsFails) throw options.tabRefreshError ?? new Error("tabs refresh unavailable");
			return tabs;
		},
		async waitForExtensionReconnect() {
			return this.snapshot();
		},
		resolveTargetTabId(value: unknown) {
			return typeof value === "number" ? value : tabId;
		},
		async sendCommand(command: BrowserRuntimeCommand) {
			calls.sendCommand.push(command);
			if (command.cmd === "persistent_cdp" && command.action === "send" && command.cdpMethod === "Runtime.evaluate") {
				return { id: "eval", acknowledged: true, tabId, data: { result: { result: { value: scanData(options) } } } } as BrowserBridgeExecutionResult;
			}
			if (command.cmd === "network.list") return { id: "network", acknowledged: true, tabId, data: { items: [], active: false, lastSeq: 0 } } as BrowserBridgeExecutionResult;
			if (command.cmd === "hook.collect") return { id: "hook", acknowledged: true, tabId, data: { events: [], active: false, lastSeq: 0 } } as BrowserBridgeExecutionResult;
			return { id: "command", acknowledged: true, tabId, data: {} } as BrowserBridgeExecutionResult;
		},
		async executeJavaScript() {
			return { id: "js", acknowledged: true, tabId, data: {} } as BrowserBridgeExecutionResult;
		},
		async switchTab() {
			return { id: "switch", acknowledged: true, tabId, data: {} } as BrowserBridgeExecutionResult;
		},
		async createTab() {
			return { id: "create", acknowledged: true, tabId, data: {} } as BrowserBridgeExecutionResult;
		},
		async closeTab() {
			return { id: "close", acknowledged: true, tabId, data: {} } as BrowserBridgeExecutionResult;
		},
		listBrowserSessions() { return []; },
		createBrowserSession() { return {}; },
		selectBrowserSession() { return {}; },
		closeBrowserSession() { return {}; },
		attachTabToBrowserSession() { return tabs[0] ?? { tabId }; },
		detachTabFromBrowserSession() { return {}; },
		selectBrowser() { return {}; },
		leaseTab() { return { id: "lease-1", browserSessionId: "session-1", tabSessionId: "tab-session-1", browserId: "browser-1", tabId, explicit: true, createdAt: Date.now(), lastSeenAt: Date.now() }; },
		releaseTab() { return undefined; },
		acquireUiLock() { return { browserSessionId: "session-1", commandName: "browser_observe", createdAt: Date.now(), lastSeenAt: Date.now(), count: 1 }; },
		releaseUiLock() { return undefined; },
		queueDepth() { return 0; },
		leaseOwnerHash() { return undefined; },
		createObservationSnapshot(snapshot: Omit<CommandObservationSnapshotInfo, "snapshotId" | "expired" | "ttlMs"> & { snapshotId?: string; ttlMs?: number }) {
			const created: CommandObservationSnapshotInfo = { snapshotId: snapshot.snapshotId ?? `snap-${++snapshotSeq}`, ttlMs: snapshot.ttlMs ?? 60_000, expired: false, ...snapshot };
			snapshots.set(created.snapshotId, created);
			return created;
		},
		getObservationSnapshot(snapshotId: string) { return snapshots.get(snapshotId); },
		listObservationSnapshots() { return [...snapshots.values()]; },
		beginOperation(meta: Omit<CommandActiveOperationInfo, "operationId" | "startedAt" | "updatedAt"> & { operationId?: string }) {
			const now = Date.now();
			const operation: CommandActiveOperationInfo = { operationId: meta.operationId ?? `op-${++operationSeq}`, startedAt: now, updatedAt: now, ...meta };
			operations.set(operation.operationId, operation);
			return operation;
		},
		updateOperation(operationId: string, patch: Partial<Omit<CommandActiveOperationInfo, "operationId" | "startedAt">>) {
			const prior = operations.get(operationId);
			if (!prior) return undefined;
			const next = { ...prior, ...patch, updatedAt: Date.now() };
			operations.set(operationId, next);
			return next;
		},
		finishOperation(operationId: string) {
			const operation = operations.get(operationId);
			operations.delete(operationId);
			return operation;
		},
	} satisfies BrowserCommandRuntimePort & { calls: { refreshTabs: number; getTabs: number; sendCommand: BrowserRuntimeCommand[] } };
	return server;
}

async function runObserve(options: MockOptions = {}, params: Partial<ObserveToolParams> = {}) {
	const cwd = options.cwd ?? await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-runner-"));
	const server = createMockServer(options);
	const result = await runScanObservation(server, { maxChars: 80_000, fresh: true, ...params }, { cwd }, "scan");
	const envelope = JSON.parse(result.content[0]?.text || "{}") as Record<string, unknown>;
	const summary = envelope.summary as Record<string, unknown>;
	return { server, envelope, summary, pageObservation: summary.pageObservation as Record<string, unknown> };
}

test("observe scan runner diagnostics: ABML read failure binds structure failure while scan-backed providers remain truthful", async () => {
	const { pageObservation } = await runObserve({ noDefaultTab: true });
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	assert.deepEqual(diagnostics.providers, {
		structure: "failed",
		content: "scan-backed",
		text: "scan-backed",
		html: "scan-backed",
		evidence: "scan-backed",
		tabs: "executed",
	});
	const failures = diagnostics.providerFailures as Array<Record<string, unknown>>;
	assert.equal(failures.some((failure) => failure.provider === "abml-read"), true);
	assert.equal(diagnostics.abmlIntegrated, false);
});

test("observe scan runner diagnostics: tabs refresh fallback is degraded with structured reason", async () => {
	const { server, pageObservation } = await runObserve({ refreshTabsFails: true, tabRefreshError: Object.assign(new Error("tabs timeout"), { code: "TABS_TIMEOUT" }) });
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	assert.equal(server.calls.refreshTabs, 1);
	assert.equal(server.calls.getTabs, 1);
	assert.equal((diagnostics.providers as Record<string, unknown>).tabs, "degraded");
	const failures = diagnostics.providerFailures as Array<Record<string, unknown>>;
	assert.equal(failures.some((failure) => failure.provider === "tabs-refresh" && failure.code === "TABS_TIMEOUT"), true);
});

test("observe scan runner diagnostics: unavailable artifact marks html and evidence providers failed", async () => {
	const { pageObservation } = await runObserve({ cwd: undefined }, { outputPath: "" });
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	assert.equal((diagnostics.providers as Record<string, unknown>).html, "failed");
	assert.equal((diagnostics.providers as Record<string, unknown>).evidence, "failed");
	assert.equal(((pageObservation.content as Record<string, unknown>).artifact), undefined);
	const failures = diagnostics.providerFailures as Array<Record<string, unknown>>;
	assert.equal(failures.some((failure) => failure.provider === "artifact" && failure.code === "ARTIFACT_UNAVAILABLE"), true);
});
