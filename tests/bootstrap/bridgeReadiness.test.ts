import test from "node:test";
import assert from "node:assert/strict";
import { deriveBridgeReadiness, isAllowedBridgeOrigin } from "../../src/bridge/server/bridgeUtils.ts";

const NOW = 1_000_000;

test("bridge-down when the server is not listening", () => {
	assert.equal(deriveBridgeReadiness({ running: false, extensionConnected: false }), "bridge-down");
	// running:false dominates even if other fields look connected.
	assert.equal(deriveBridgeReadiness({ running: false, extensionConnected: true, connectedClients: 1 }), "bridge-down");
});

test("ready when an extension is connected and handshaken", () => {
	assert.equal(deriveBridgeReadiness({ running: true, extensionConnected: true }), "ready");
	// ready wins over a still-open socket count.
	assert.equal(deriveBridgeReadiness({ running: true, extensionConnected: true, connectedClients: 1 }), "ready");
});

test("connecting when a socket is open but ext_ready has not arrived", () => {
	assert.equal(deriveBridgeReadiness({ running: true, extensionConnected: false, connectedClients: 1 }), "connecting");
});

test("degraded when a recent disconnect is within the reconnect window", () => {
	assert.equal(
		deriveBridgeReadiness({ running: true, extensionConnected: false, connectedClients: 0, lastDisconnectAt: NOW - 5_000, now: NOW, reconnectWindowMs: 30_000 }),
		"degraded",
	);
});

test("bridge-up when listening with no extension and no recent disconnect", () => {
	assert.equal(deriveBridgeReadiness({ running: true, extensionConnected: false }), "bridge-up");
	// A disconnect older than the reconnect window is no longer "degraded".
	assert.equal(
		deriveBridgeReadiness({ running: true, extensionConnected: false, connectedClients: 0, lastDisconnectAt: NOW - 60_000, now: NOW, reconnectWindowMs: 30_000 }),
		"bridge-up",
	);
});

test("bridge origin validation accepts only extension, null, or absent origins", () => {
	assert.equal(isAllowedBridgeOrigin(undefined), true);
	assert.equal(isAllowedBridgeOrigin("null"), true);
	assert.equal(isAllowedBridgeOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop"), true);
	assert.equal(isAllowedBridgeOrigin("https://example.test"), false);
	assert.equal(isAllowedBridgeOrigin("chrome-extension://abcdefghijklmnop.evil.test"), false);
	assert.equal(isAllowedBridgeOrigin("not a url"), false);
});
