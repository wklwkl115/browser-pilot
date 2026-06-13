import test from "node:test";
import assert from "node:assert/strict";
import { BrowserBridgeCommandService } from "../../../src/driver/BrowserBridgeCommandService.ts";
import { BrowserCommandQueueRegistry } from "../../../src/driver/BrowserCommandQueueRegistry.ts";
import type { BrowserAutomationSession, BrowserBridgeTargetInfo, BrowserTabSession } from "../../../src/driver/types.ts";

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
