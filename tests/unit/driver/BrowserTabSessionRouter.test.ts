import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { BrowserBridgeClientRegistry } from "../../../src/driver/BrowserBridgeClientRegistry.ts";
import { BrowserSessionRegistry } from "../../../src/driver/BrowserSessionRegistry.ts";
import { BrowserTabSessionRouter } from "../../../src/driver/BrowserTabSessionRouter.ts";
import { BrowserBridgeError } from "../../../src/driver/errors.ts";

function fakeSocket(): WebSocket {
	return { readyState: WebSocket.OPEN, close() {} } as unknown as WebSocket;
}

test("BrowserTabSessionRouter reports ambiguous duplicate tab ids until a browser is selected", () => {
	const clients = new BrowserBridgeClientRegistry(18765);
	const browserSessions = new BrowserSessionRegistry();
	const router = new BrowserTabSessionRouter(clients, browserSessions);
	const a = fakeSocket();
	const b = fakeSocket();
	clients.register(a);
	clients.updateClientInfo(a, { id: "browser-a" });
	clients.register(b);
	clients.updateClientInfo(b, { id: "browser-b" });

	router.updateTabs([{ id: 7, active: true, url: "https://a.example" }], a);
	router.updateTabs([{ id: 7, active: true, url: "https://b.example" }], b);

	assert.throws(() => router.liveSessionForTabId(7), (error) => error instanceof BrowserBridgeError && error.code === "AMBIGUOUS_TAB_ID");
	router.selectBrowser(a);
	assert.equal(router.liveSessionForTabId(7)?.browserId, clients.browserIdForClient(a));
});

test("BrowserTabSessionRouter prunes stale disconnected tab sessions", () => {
	const clients = new BrowserBridgeClientRegistry(18765);
	const browserSessions = new BrowserSessionRegistry();
	const router = new BrowserTabSessionRouter(clients, browserSessions);
	const ws = fakeSocket();
	clients.register(ws);
	router.updateTabs([{ id: 3, active: true, url: "https://example.test" }], ws);
	router.markClientDisconnected(ws);

	router.refreshSelectedSessionRefs(Date.now() + 6 * 60_000);

	assert.equal(router.getTabs({ includeDisconnected: true }).length, 0);
});

test("BrowserTabSessionRouter preserves tabHandle across replacement and follows stale numeric ids", () => {
	const clients = new BrowserBridgeClientRegistry(18765);
	const browserSessions = new BrowserSessionRegistry();
	const router = new BrowserTabSessionRouter(clients, browserSessions);
	const ws = fakeSocket();
	clients.register(ws);
	clients.updateClientInfo(ws, { id: "browser-a" });
	router.updateTabs([{ id: 3, active: true, url: "https://example.test/old" }], ws);
	const before = router.getTabs()[0]!;
	assert.match(before.tabHandle, /^tabh_/);

	router.applyTabReplacements([{ from: 3, to: 4, at: 1000 }], ws, 1000);
	router.updateTabs([{ id: 4, active: true, url: "https://example.test/old" }], ws);
	const after = router.getTabs()[0]!;
	assert.equal(after.tabId, 4);
	assert.equal(after.tabHandle, before.tabHandle);
	assert.equal(after.replacedFromTabId, 3);
	assert.equal(router.defaultTabId(), 4);

	const resolved = router.resolveTargetRef(3, undefined, "explicit");
	assert.equal(resolved?.tabId, 4);
	assert.equal(resolved?.replacedFrom, 3);
	assert.equal(resolved?.replacedByTabId, 4);
	assert.equal(resolved?.tabHandle, before.tabHandle);
	assert.equal(router.resolveTargetRef(before.tabHandle, undefined, "explicit")?.tabId, 4);
});

test("BrowserTabSessionRouter tracks manual activation as the implicit target", () => {
	const clients = new BrowserBridgeClientRegistry(18765);
	const browserSessions = new BrowserSessionRegistry();
	const router = new BrowserTabSessionRouter(clients, browserSessions);
	const ws = fakeSocket();
	clients.register(ws);
	clients.updateClientInfo(ws, { id: "browser-a" });
	router.updateTabs([
		{ id: 10, active: true, url: "https://example.test/a", windowId: 1 },
		{ id: 11, active: false, url: "https://example.test/b", windowId: 1 },
	], ws);
	assert.equal(router.defaultTabId(), 10);

	router.recordTabActivation({ tabId: 11, windowId: 1, at: 1234 }, ws);
	assert.equal(router.defaultTabId(), 11);
	assert.equal(router.fallbackExecutionTarget()?.tabId, 11);
});
