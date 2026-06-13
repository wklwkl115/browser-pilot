import test from "node:test";
import assert from "node:assert/strict";
import { BrowserBridgeCommandService } from "../../../src/driver/BrowserBridgeCommandService.ts";
import { BrowserCommandQueueRegistry } from "../../../src/driver/BrowserCommandQueueRegistry.ts";
import type { BrowserAutomationSession, BrowserBridgeTargetInfo, BrowserTabInfo, BrowserTabSession } from "../../../src/driver/types.ts";

test("BrowserBridgeCommandService records temporal queue delay diagnostics on queued writes", async () => {
	const queues = new BrowserCommandQueueRegistry();
	const browserSession: BrowserAutomationSession = { id: "session-1", selectionVersion: 1, createdAt: 1, lastSeenAt: 2 };
	const target: BrowserBridgeTargetInfo = { browserSessionId: "session-1", tabId: 7, tabHandle: "tab-handle-7", targetRef: "pi-tab://session-1/7", source: "explicit", implicit: false, selectionVersionAtDispatch: 1 };
	const tab = {
		id: "tab-session-1",
		browserId: "browser-1",
		tabId: 7,
		logicalTabId: "logical-7",
		tabHandle: "tab-handle-7",
		generation: 1,
		url: "https://example.test",
		title: "example",
		type: "ext_ws",
		connectedAt: 1,
		client: { send() {} },
	} as unknown as BrowserTabSession;
	const service = new BrowserBridgeCommandService({
		clients: {},
		browserSessions: {
			selectedSession: () => browserSession,
			require: () => browserSession,
		},
		queues,
		leases: {
			peekTabLease: () => undefined,
			describeTabLease: () => ({}),
			touchTabLease: () => undefined,
			withAutoTabLease: async (_browserSessionId: string, _tab: BrowserTabSession, run: () => Promise<unknown>) => await run(),
		},
		tabs: {
			resolveTargetRef: () => target,
			targetInfo: () => target,
			fallbackExecutionTarget: () => target,
			liveSessionForTabId: () => tab,
		},
		pendingRequests: {
			send: async (_client: unknown, _code: unknown, options: Record<string, unknown>) => ({
				id: "req-1",
				acknowledged: true,
				tabId: options.tabId as number,
				data: { ok: true },
				target: options.target as BrowserBridgeTargetInfo,
			}),
		},
		runtimeRecoveryArtifacts: { recordCommandResult() {} },
		isRunning: () => true,
		getPort: () => 1,
		getTabs: () => [],
		listBrowserSessions: () => [],
		snapshot: () => ({ browserSessionId: "session-1", host: "127.0.0.1", port: 1, running: true, connectedClients: 1, extensionConnected: true, clients: [], selectionVersion: 1, tabs: [], pending: [] }),
		waitForExtensionReady: async () => true,
	} as any);

	const result = await service.executeJavaScript("return 1", { browserSessionId: "session-1", tabId: 7, timeoutMs: 1_000 });
	const profile = result.diagnostics?.temporalProfile as Record<string, unknown> | undefined;
	assert.equal(profile?.command, "javascript");
	assert.equal(profile?.queueDepthAtEnqueue, 0);
	assert.equal(profile?.queueDepthAtStart, 1);
	assert.equal(typeof profile?.queueDelayMs, "number");
	assert.equal(typeof profile?.elapsedMs, "number");
});

function createTabsCreateService(options: { refreshFails?: boolean } = {}) {
	const browserSession: BrowserAutomationSession = { id: "default", selectionVersion: 1, createdAt: 1, lastSeenAt: 2 };
	const socket = { send() {} };
	const createdHandle = "tabh_browser1_created_g1";
	let refreshed = false;
	const createdTab: BrowserTabInfo = {
		id: "browser-1:9",
		browserId: "browser-1",
		tabId: 9,
		logicalTabId: "created",
		tabHandle: createdHandle,
		targetRef: createdHandle,
		generation: 1,
		url: "https://created.example/",
		title: "Created",
		active: true,
		type: "ext_ws",
		connectedAt: 1,
	};
	const fallbackTarget: BrowserBridgeTargetInfo = { browserSessionId: "default", tabId: 9, source: "explicit", implicit: false, selectionVersionAtDispatch: 1 };
	const createdTarget: BrowserBridgeTargetInfo = { ...fallbackTarget, tabHandle: createdHandle, targetRef: createdHandle, browserId: "browser-1", url: "https://created.example/" };
	const service = new BrowserBridgeCommandService({
		clients: {
			requireExtensionClient: () => socket,
		},
		browserSessions: {
			selectedSession: () => browserSession,
			require: () => browserSession,
			selectedOpenClient: () => socket,
		},
		queues: {},
		leases: {},
		tabs: {
			updateTabs: () => { refreshed = true; },
			resolveTargetRef: (value: unknown) => refreshed && (value === 9 || value === createdHandle) ? createdTarget : fallbackTarget,
			targetInfo: (source: BrowserBridgeTargetInfo["source"], tabId?: number) => ({ ...fallbackTarget, source, tabId, ...(refreshed && tabId === 9 ? { tabHandle: createdHandle, targetRef: createdHandle, browserId: "browser-1", url: "https://created.example/" } : {}) }),
		},
		pendingRequests: {
			send: async (_client: unknown, code: unknown, sendOptions: Record<string, unknown>) => {
				const command = code as { cmd?: string; method?: string };
				if (command.cmd === "tabs" && command.method === "create") {
					return { id: "create-1", acknowledged: true, data: { id: 9, tabId: 9, url: "https://created.example/" }, target: sendOptions.target as BrowserBridgeTargetInfo };
				}
				if (command.cmd === "tabs" && command.method === "list") {
					if (options.refreshFails) throw new Error("refresh failed");
					return { id: "list-1", acknowledged: true, data: [{ id: 9, tabId: 9, url: "https://created.example/", title: "Created", active: true }], target: sendOptions.target as BrowserBridgeTargetInfo };
				}
				throw new Error(`unexpected command ${JSON.stringify(code)}`);
			},
		},
		runtimeRecoveryArtifacts: { recordCommandResult() {} },
		isRunning: () => true,
		getPort: () => 1,
		getTabs: () => refreshed ? [createdTab] : [],
		listBrowserSessions: () => [],
		snapshot: () => ({ browserSessionId: "default", host: "127.0.0.1", port: 1, running: true, connectedClients: 1, extensionConnected: true, clients: [], selectionVersion: 1, tabs: refreshed ? [createdTab] : [], pending: [] }),
		waitForExtensionReady: async () => true,
	} as any);
	return { service, createdHandle };
}

test("BrowserBridgeCommandService tabs.create refreshes and returns created targetRef without changing dispatch target", async () => {
	const { service, createdHandle } = createTabsCreateService();

	const result = await service.sendCommand({ cmd: "tabs", method: "create", url: "https://created.example/" }, { timeoutMs: 1_000 });
	const data = result.data as Record<string, unknown>;

	assert.equal(result.target?.source, "none");
	assert.equal(result.createdTarget?.tabId, 9);
	assert.equal(result.createdTarget?.targetRef, createdHandle);
	assert.equal(result.createdTab?.targetRef, createdHandle);
	assert.equal(data.id, 9);
	assert.equal(data.tabId, 9);
	assert.equal(data.targetRef, createdHandle);
	assert.equal(data.tabHandle, createdHandle);
});

test("BrowserBridgeCommandService createTab keeps numeric tabId when post-create refresh fails", async () => {
	const { service } = createTabsCreateService({ refreshFails: true });

	const result = await service.createTab("https://created.example/", true, 1_000);
	const data = result.data as Record<string, unknown>;

	assert.equal(result.id, "create-1");
	assert.equal(data.id, 9);
	assert.equal(data.tabId, 9);
	assert.equal(data.targetRef, undefined);
	assert.equal(result.createdTarget?.tabId, 9);
	assert.equal(result.createdTarget?.targetRef, undefined);
});
