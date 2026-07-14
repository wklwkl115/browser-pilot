import test from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import { BrowserBridgeClientRegistry } from "../../src/bridge/server/BrowserBridgeClientRegistry.ts";

// Minimal WebSocket stand-in: the registry only touches readyState + close().
function fakeSocket(): WebSocket {
	const ws = {
		readyState: 1, // WebSocket.OPEN
		close() {
			ws.readyState = 3; // WebSocket.CLOSED
		},
	};
	return ws as unknown as WebSocket;
}

function connect(registry: BrowserBridgeClientRegistry, instanceId: string, workerBootId: string): WebSocket {
	const ws = fakeSocket();
	registry.register(ws);
	registry.updateClientInfo(ws, { id: "ext-id", extensionInstanceId: instanceId, workerBootId });
	return ws;
}

test("classifyConnect labels the first handshake cold, later ones reconnect", () => {
	const registry = new BrowserBridgeClientRegistry(18765);
	const a = connect(registry, "X", "boot-1");
	assert.equal(registry.classifyConnect(a, "X", "boot-1"), "cold");
	registry.recordHandshake();
	const c = connect(registry, "Y", "boot-9");
	assert.equal(registry.classifyConnect(c, "Y", "boot-9"), "reconnect");
});

test("extension instance identity produces a stable browser id across daemon registries", () => {
	const first = new BrowserBridgeClientRegistry(18765);
	const firstSocket = connect(first, "stable-instance", "boot-1");
	const second = new BrowserBridgeClientRegistry(18765);
	const secondSocket = connect(second, "stable-instance", "boot-2");
	assert.equal(first.info(firstSocket)?.id, second.info(secondSocket)?.id);
	assert.match(String(first.info(firstSocket)?.id), /^browser_[a-f0-9]{16}$/);
});

test("classifyConnect distinguishes duplicate (same boot) from sw-restart (new boot)", () => {
	const registry = new BrowserBridgeClientRegistry(18765);
	connect(registry, "X", "boot-1"); // peer A stays open
	const b = connect(registry, "X", "boot-1");
	assert.equal(registry.classifyConnect(b, "X", "boot-1"), "duplicate");
	const c = connect(registry, "X", "boot-2");
	assert.equal(registry.classifyConnect(c, "X", "boot-2"), "sw-restart");
});

test("supersedeInstanceClients closes other sockets of the same instance, keeps the newest", () => {
	const registry = new BrowserBridgeClientRegistry(18765);
	const a = connect(registry, "X", "boot-1");
	const b = connect(registry, "X", "boot-2");
	const other = connect(registry, "Z", "boot-1");
	const superseded = registry.supersedeInstanceClients("X", b);
	assert.deepEqual(superseded, [a]);
	assert.equal((a as unknown as { readyState: number }).readyState, 3, "stale same-instance socket is closed");
	assert.equal((b as unknown as { readyState: number }).readyState, 1, "kept socket stays open");
	assert.equal((other as unknown as { readyState: number }).readyState, 1, "different-instance socket is untouched");
});

test("supersedeInstanceClients is a no-op without an instance id (older extension build)", () => {
	const registry = new BrowserBridgeClientRegistry(18765);
	const a = connect(registry, "X", "boot-1");
	const b = fakeSocket();
	registry.register(b);
	assert.deepEqual(registry.supersedeInstanceClients(undefined, b), []);
	assert.equal((a as unknown as { readyState: number }).readyState, 1);
});

test("connection metrics tally connects, disconnects, sw-restarts, and reconnect latency", () => {
	const registry = new BrowserBridgeClientRegistry(18765);
	const a = connect(registry, "X", "boot-1");
	registry.recordConnect(registry.classifyConnect(a, "X", "boot-1"), "X", "boot-1"); // cold
	registry.recordHandshake();
	registry.recordDisconnect("ws_close", "X");
	const b = connect(registry, "X", "boot-2"); // peer a still open, new boot → sw-restart
	registry.recordConnect(registry.classifyConnect(b, "X", "boot-2"), "X", "boot-2");
	const m = registry.metrics();
	assert.equal(m.connects, 2);
	assert.equal(m.disconnects, 1);
	assert.equal(m.swRestarts, 1);
	assert.equal(m.reconnects, 1);
	assert.equal(typeof m.lastReconnectLatencyMs, "number");
});

test("closed-socket worker reboot remains a sw-restart and same-socket restart does not reuse old latency", () => {
	const registry = new BrowserBridgeClientRegistry(18765);
	const first = connect(registry, "X", "boot-1");
	registry.recordConnect(registry.classifyConnect(first, "X", "boot-1"), "X", "boot-1");
	registry.recordHandshake();
	registry.recordDisconnect("ws_close", "X");
	first.close();
	registry.unregister(first);
	const second = connect(registry, "X", "boot-2");
	assert.equal(registry.classifyConnect(second, "X", "boot-2"), "sw-restart");
	registry.recordConnect("sw-restart", "X", "boot-2");
	const reconnectLatency = registry.metrics().lastReconnectLatencyMs;
	assert.equal(typeof reconnectLatency, "number");
	registry.recordConnect("sw-restart", "X", "boot-3");
	assert.equal(registry.metrics().lastReconnectLatencyMs, reconnectLatency);
});
