import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { BrowserBridgeClientHeartbeat } from "../../../src/driver/BrowserBridgeClientHeartbeat.ts";
import { BrowserBridgeClientRegistry } from "../../../src/driver/BrowserBridgeClientRegistry.ts";

function fakeSocket() {
	return {
		readyState: WebSocket.OPEN,
		pingCount: 0,
		terminated: false,
		ping() { this.pingCount += 1; },
		terminate() { this.terminated = true; this.readyState = WebSocket.CLOSED; },
	} as unknown as WebSocket & { pingCount: number; terminated: boolean; readyState: number };
}

test("BrowserBridgeClientHeartbeat pings live clients and terminates stale clients", () => {
	const registry = new BrowserBridgeClientRegistry(18765);
	const fresh = fakeSocket();
	const stale = fakeSocket();
	registry.register(fresh);
	const staleInfo = registry.register(stale);
	staleInfo.lastSeenAt = Date.now() - 90_000;
	const staleClients: WebSocket[] = [];
	const heartbeat = new BrowserBridgeClientHeartbeat(registry, (ws) => staleClients.push(ws));

	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		heartbeat.probe();
	} finally {
		console.warn = originalWarn;
	}

	assert.equal(fresh.pingCount, 1);
	assert.equal(registry.info(fresh)?.lastPingAt !== undefined, true);
	assert.equal(stale.terminated, true);
	assert.deepEqual(staleClients, [stale]);
});
