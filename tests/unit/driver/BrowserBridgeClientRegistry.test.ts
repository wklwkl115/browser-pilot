import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { BrowserBridgeClientRegistry } from "../../../src/driver/BrowserBridgeClientRegistry.ts";

function fakeSocket(readyState = WebSocket.OPEN): WebSocket {
	return { readyState, close() {} } as unknown as WebSocket;
}

test("BrowserBridgeClientRegistry tracks client liveness and stale clients", () => {
	const registry = new BrowserBridgeClientRegistry(18765);
	const ws = fakeSocket();
	const info = registry.register(ws);

	registry.updateClientInfo(ws, { id: "extension-1", name: "Pi Bridge", workerBootId: "boot-1" });
	registry.markSeen(ws);
	registry.markPingSent(ws);
	registry.markPong(ws);

	assert.equal(registry.connectedClientsCount(), 1);
	assert.equal(registry.browserIdForClient(ws), info.id);
	assert.equal(registry.findClient("extension-1")?.ws, ws);
	assert.equal(registry.connectedClientInfos()[0]?.lastPingAt !== undefined, true);
	assert.equal(registry.connectedClientInfos()[0]?.lastPongAt !== undefined, true);

	const stale = registry.staleClients(1, Date.now() + 10_000);
	assert.equal(stale.length, 1);
	assert.equal(stale[0].ws, ws);

	registry.unregister(ws);
	assert.equal(registry.connectedClientsCount(), 0);
});

test("BrowserBridgeClientRegistry remembers it ever connected and throws an actionable no-extension error", () => {
	const registry = new BrowserBridgeClientRegistry(18765);
	assert.equal(registry.hasEverConnected(), false, "cold start: never connected");
	assert.throws(() => registry.requireExtensionClient(), (err: unknown) => {
		const e = err as { code?: string; details?: Record<string, unknown> };
		assert.equal(e.code, "NO_BROWSER_EXTENSION");
		assert.equal(e.details?.everConnected, false);
		assert.ok(Array.isArray((e.details?.recovery as Record<string, unknown>)?.nextActions));
		return true;
	});

	const ws = fakeSocket();
	registry.register(ws);
	registry.unregister(ws);
	// "ever connected" is sticky across a disconnect so the recovery hint can tell a
	// dropped service worker apart from a never-installed extension.
	assert.equal(registry.hasEverConnected(), true);
	assert.throws(() => registry.requireExtensionClient(), (err: unknown) => {
		assert.equal((err as { details?: Record<string, unknown> }).details?.everConnected, true);
		return true;
	});
});
