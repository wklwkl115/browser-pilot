import test from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import { BrowserBridgeClientRegistry } from "../../src/bridge/server/BrowserBridgeClientRegistry.ts";
import { BrowserTabSessionRouter } from "../../src/bridge/server/BrowserTabSessionRouter.ts";
import { SessionRegistry } from "../../src/kernels/session/sessionRegistry.ts";

function fakeSocket(): WebSocket {
	const ws = {
		readyState: 1,
		close() {
			ws.readyState = 3;
		},
	};
	return ws as unknown as WebSocket;
}

function connect(clients: BrowserBridgeClientRegistry, extensionId = "extension-1"): WebSocket {
	const ws = fakeSocket();
	clients.register(ws);
	clients.updateClientInfo(ws, { id: extensionId, extensionInstanceId: extensionId });
	return ws;
}

function setup() {
	const clients = new BrowserBridgeClientRegistry(18765);
	const browserSessions = new SessionRegistry<WebSocket>({ isOpenClient: (client) => client.readyState === 1 });
	const router = new BrowserTabSessionRouter(clients, browserSessions);
	return { clients, browserSessions, router };
}

test("tab session sync normalizes tabs, preserves partial fields, and disconnects stale entries", () => {
	const { clients, browserSessions, router } = setup();
	const ws = connect(clients);
	browserSessions.selectClient(browserSessions.defaultSession(), ws);
	router.updateTabs([
		null,
		{ id: 0 },
		{ id: 7, url: "https://one.test/", title: "One", active: true, windowId: 1, incognito: false },
		{ tabId: 8, url: "https://two.test/", title: "Two", active: false, windowId: 1, openerTabId: 7 },
	], ws);

	assert.equal(router.defaultTabId(), 7);
	assert.equal(router.latestTabId(), 8);
	assert.equal(router.getTabs().length, 2);
	const firstHandle = router.getTabs().find((tab) => tab.tabId === 8)?.tabHandle;

	router.updateTabs([{ id: 8, active: true, windowId: 1 }], ws);
	const live = router.getTabs();
	assert.equal(live.length, 1);
	assert.equal(live[0]?.tabId, 8);
	assert.equal(live[0]?.url, "https://two.test/");
	assert.equal(live[0]?.title, "Two");
	assert.equal(live[0]?.tabHandle, firstHandle);
	assert.equal(router.defaultTabId(), 8);
	assert.equal(router.getTabs({ includeDisconnected: true }).find((tab) => tab.tabId === 7)?.disconnectedAt !== undefined, true);
});

test("tab replacement preserves stable handles, advances target generation, and resolves nested or numeric stale targets", () => {
	const { clients, browserSessions, router } = setup();
	const ws = connect(clients);
	browserSessions.selectClient(browserSessions.defaultSession(), ws);
	router.updateTabs([{ id: 7, url: "https://replace.test/", title: "Before", active: true, windowId: 1, pageEpoch: "page-before", documentId: "doc-before" }], ws);
	const handle = router.defaultTabHandle();
	assert.ok(handle);

	const replacements = router.applyTabReplacements([{ from: 7, to: 9 }, { from: 0, to: 2 }, { from: 9, to: 9 }], ws);
	assert.equal(replacements.length, 1);
	router.updateTabs([{ id: 9, url: "https://replace.test/after", title: "After", active: true, windowId: 1, pageEpoch: "page-after", documentId: "doc-after" }], ws);

	const current = router.getTabs()[0];
	assert.equal(current?.tabId, 9);
	assert.equal(current?.tabHandle, handle);
	assert.equal(current?.generation, 2);
	assert.equal(current?.targetGeneration, 2);
	assert.equal(current?.pageEpoch, "page-after");
	assert.equal(current?.documentId, "doc-after");
	assert.equal(current?.replacedFromTabId, 7);
	assert.equal(router.resolveTargetRef(7)?.tabId, 9);
	assert.equal(router.resolveTargetRef({ createdTarget: { targetRef: handle } })?.tabId, 9);
});

test("Prerender2 same-tab activation advances target generation exactly once", () => {
	const { clients, browserSessions, router } = setup();
	const ws = connect(clients);
	browserSessions.selectClient(browserSessions.defaultSession(), ws);
	router.updateTabs([{ id: 11, url: "https://prerender.test/host", title: "Host", active: true, pageEpoch: "page-host", documentId: "doc-host" }], ws);
	const before = router.getTabs()[0];
	assert.ok(before);

	assert.equal(router.applyTabReplacements([{ from: 11, to: 11 }], ws, 100).length, 0);
	assert.equal(router.applyTabReplacements([{ from: 11, to: 11, at: 101, kind: "prerender-activation" }], ws, 101).length, 1);
	assert.equal(router.applyTabReplacements([{ from: 11, to: 11, at: 101, kind: "prerender-activation" }], ws, 102).length, 0);
	router.updateTabs([{ id: 11, url: "https://prerender.test/target", title: "Target", active: true, pageEpoch: "page-target", documentId: "doc-target" }], ws);

	const after = router.getTabs()[0];
	assert.equal(after?.tabId, 11);
	assert.equal(after?.tabHandle, before.tabHandle);
	assert.equal(after?.generation, before.generation + 1);
	assert.equal(after?.pageEpoch, "page-target");
	assert.equal(after?.documentId, "doc-target");
	assert.equal(after?.replacedFromTabId, 11);
});

test("same-extension reconnect adopts identity and migrates secondary session selection", () => {
	const { clients, browserSessions, router } = setup();
	const previous = connect(clients);
	const defaultSession = browserSessions.defaultSession();
	browserSessions.selectClient(defaultSession, previous);
	router.updateTabs([{ id: 7, url: "https://reconnect.test/", title: "Page", active: true, windowId: 3, pageEpoch: "worker-1:page:1" }], previous);
	const previousTab = router.getTabs()[0];
	assert.ok(previousTab);

	const secondary = browserSessions.create("secondary");
	browserSessions.selectClient(secondary, previous);
	browserSessions.setDefaultTabSessionId(secondary, previousTab.id);
	browserSessions.setLatestTabSessionId(secondary, previousTab.id);

	const reconnected = connect(clients);
	browserSessions.selectClient(defaultSession, reconnected);
	router.updateTabs([{ id: 7, url: "https://reconnect.test/", title: "Page", active: true, windowId: 3, pageEpoch: "worker-2:page:1" }], reconnected);

	const adopted = Array.from(router.sessions.values()).find((session) => session.client === reconnected);
	assert.ok(adopted);
	assert.equal(adopted.tabHandle, previousTab.tabHandle);
	assert.equal(adopted.generation, previousTab.generation);
	assert.notEqual(adopted.pageEpoch, previousTab.pageEpoch);
	assert.equal(router.sessions.get(previousTab.id)?.client, reconnected);
	assert.equal(router.sessions.get(previousTab.id)?.disconnectedAt, undefined);
	assert.equal(secondary.selectedClient, reconnected);
	assert.equal(secondary.defaultSessionId, adopted.id);
	assert.equal(secondary.latestSessionId, adopted.id);
});

test("extension-owned tab identity changes invalidate the old handle immediately on reconnect", () => {
	const { clients, browserSessions, router } = setup();
	const previous = connect(clients);
	browserSessions.selectClient(browserSessions.defaultSession(), previous);
	router.updateTabs([{ id: 7, tabIdentity: "11111111111111111111111111111111", url: "https://reload.test/", active: true }], previous);
	const oldHandle = router.defaultTabHandle();
	assert.ok(oldHandle);

	const reloaded = connect(clients);
	browserSessions.selectClient(browserSessions.defaultSession(), reloaded);
	router.updateTabs([{ id: 7, tabIdentity: "22222222222222222222222222222222", url: "https://reload.test/", active: true }], reloaded);

	const current = router.getTabs()[0];
	assert.equal(current?.logicalTabId, "22222222222222222222222222222222");
	assert.notEqual(current?.tabHandle, oldHandle);
	assert.throws(() => router.resolveTargetRef(oldHandle), (error: Error & { code?: string; details?: Record<string, unknown> }) => {
		assert.equal(error.code, "TAB_NOT_FOUND");
		assert.doesNotMatch(JSON.stringify(error.details?.recovery), /tabId|tabHandle|sessionId/);
		return true;
	});
});

test("extension-owned tab identity preserves targetRef across daemon replacement", () => {
	const tabIdentity = "f4e722c76fbb4f4583915245b4880abc";
	const first = setup();
	const firstSocket = connect(first.clients, "extension-1");
	first.browserSessions.selectClient(first.browserSessions.defaultSession(), firstSocket);
	first.router.updateTabs([{ id: 7, tabIdentity, url: "https://stable.test/", active: true }], firstSocket);
	const originalHandle = first.router.defaultTabHandle();
	assert.ok(originalHandle);

	const replacement = setup();
	const replacementSocket = connect(replacement.clients, "extension-1");
	replacement.browserSessions.selectClient(replacement.browserSessions.defaultSession(), replacementSocket);
	replacement.router.updateTabs([{ id: 9, tabIdentity, url: "https://stable.test/after", active: true }], replacementSocket);

	assert.equal(replacement.router.defaultTabHandle(), originalHandle);
	assert.equal(replacement.router.resolveTargetRef(originalHandle)?.tabId, 9);
});
