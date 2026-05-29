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
