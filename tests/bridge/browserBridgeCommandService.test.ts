import test from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import { BrowserBridgeCommandService } from "../../src/bridge/server/BrowserBridgeCommandService.ts";
import type {
	BrowserAutomationSession,
	BrowserBridgeExecutionResult,
	BrowserBridgeTargetInfo,
	BrowserTabSession,
} from "../../src/bridge/server/types.ts";

type CommandServiceDeps = ConstructorParameters<typeof BrowserBridgeCommandService>[0];

function commandServiceFixture() {
	const socket = { readyState: 1 } as unknown as WebSocket;
	const browserSession: BrowserAutomationSession = {
		id: "browser-session",
		selectionVersion: 1,
		createdAt: Date.now(),
		lastSeenAt: Date.now(),
	};
	const target = (tabId: number): BrowserBridgeTargetInfo => ({
		browserSessionId: browserSession.id,
		tabId,
		tabHandle: `tab-${tabId}`,
		targetRef: `tab-${tabId}`,
		browserId: "browser-1",
		source: "explicit",
		implicit: false,
		selectionVersionAtDispatch: browserSession.selectionVersion,
	});
	const tabSession = (tabId: number): BrowserTabSession => ({
		id: `session-${tabId}`,
		browserId: "browser-1",
		tabId,
		logicalTabId: `logical-${tabId}`,
		tabHandle: `tab-${tabId}`,
		generation: 1,
		url: "https://example.test/",
		title: "Example",
		type: "ext_ws",
		connectedAt: Date.now(),
		client: socket,
	});
	const sent: Array<{ code: unknown; options: Record<string, unknown> }> = [];
	let queuedWrites = 0;
	const deps = {
		clients: {
			hasEverConnected: () => true,
			info: () => undefined,
		},
		browserSessions: {
			defaultSession: () => browserSession,
			require: () => browserSession,
			selectedOpenClient: () => socket,
			selectedInfo: () => undefined,
			selectClient: () => undefined,
		},
		queues: {
			ownsCurrentTransaction: () => false,
			enqueue: async (_browserId: string, _tabId: number, run: () => Promise<BrowserBridgeExecutionResult>) => {
				queuedWrites += 1;
				return await run();
			},
		},
		tabs: {
			selectionVersion: 1,
			resolveTargetRef: (value: unknown) => {
				const tabId = typeof value === "number" ? value : Number(String(value).replace(/^tab-/, ""));
				return Number.isInteger(tabId) && tabId > 0 ? target(tabId) : undefined;
			},
			fallbackExecutionTarget: () => target(7),
			targetInfo: (source: BrowserBridgeTargetInfo["source"], tabId?: number) => ({
				...(tabId === undefined ? {} : target(tabId)),
				browserSessionId: browserSession.id,
				source,
				implicit: source === "default" || source === "latest",
				selectionVersionAtDispatch: browserSession.selectionVersion,
			}),
			liveSessionForTabId: (tabId: number) => tabSession(tabId),
			liveSessionForTarget: (resolved: BrowserBridgeTargetInfo) => tabSession(resolved.tabId!),
			replacementResolution: (tabId: number) => ({ tabId }),
			latestTabId: () => 7,
			previousDefaultTabId: () => undefined,
			updateTabs: () => undefined,
			selectTab: () => undefined,
			markTabDisconnected: () => undefined,
		},
		pendingRequests: {
			send: async (_client: WebSocket, code: unknown, options: Record<string, unknown>) => {
				sent.push({ code, options });
				return {
					id: String(sent.length),
					acknowledged: true,
					tabId: options.tabId as number,
					data: { ok: true },
				};
			},
		},
		isRunning: () => true,
		getPort: () => 18_765,
		getTabs: () => [],
		snapshot: () => ({ extensionConnected: true }),
		waitForExtensionReady: async () => true,
	} as unknown as CommandServiceDeps;
	return {
		service: new BrowserBridgeCommandService(deps),
		sent,
		queuedWrites: () => queuedWrites,
	};
}

test("BrowserBridgeCommandService queues writes while reads bypass the write queue", async () => {
	const fixture = commandServiceFixture();
	await fixture.service.sendCommand({ cmd: "html.get", tabId: 7, selector: "main" });
	assert.equal(fixture.queuedWrites(), 0);
	await fixture.service.sendCommand({ cmd: "input.ref", tabId: 7, action: "click", ref: "bp-ref://dom/button" });
	assert.equal(fixture.queuedWrites(), 1);
	assert.deepEqual(
		fixture.sent.map((entry) => entry.code),
		[
			{ cmd: "html.get", tabId: 7, selector: "main" },
			{ cmd: "input.ref", tabId: 7, action: "click", ref: "bp-ref://dom/button" },
		],
	);
});

test("BrowserBridgeCommandService rejects conflicting option and command targets before dispatch", async () => {
	const fixture = commandServiceFixture();
	await assert.rejects(
		fixture.service.sendCommand({ cmd: "html.get", tabId: 8 }, { tabId: 7 }),
		(error: unknown) =>
			error instanceof Error && "code" in error && (error as Error & { code: string }).code === "TAB_ID_CONFLICT",
	);
	assert.equal(fixture.sent.length, 0);
	assert.equal(fixture.queuedWrites(), 0);
});
