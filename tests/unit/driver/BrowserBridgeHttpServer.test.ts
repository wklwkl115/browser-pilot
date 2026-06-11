import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { BrowserBridgeHttpServer } from "../../../src/driver/BrowserBridgeHttpServer.ts";
import { DEFAULT_BROWSER_BRIDGE_PORT } from "../../../src/driver/browserBridgeConfig.ts";

const HOST = "127.0.0.1";

async function onceOpen(ws: WebSocket): Promise<void> {
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
}

test("BrowserBridgeHttpServer enforces max websocket connections", async () => {
	const accepted: WebSocket[] = [];
	const server = new BrowserBridgeHttpServer(HOST, DEFAULT_BROWSER_BRIDGE_PORT + 200, (ws) => accepted.push(ws), { maxConnections: 1, portRangeEnd: DEFAULT_BROWSER_BRIDGE_PORT + 220 });
	await server.start();
	const url = `ws://${HOST}:${server.port}`;
	const first = new WebSocket(url, { headers: { origin: "chrome-extension://fixture" } });
	await onceOpen(first);
	assert.equal(accepted.length, 1);
	const secondResult = await new Promise<{ closeCode?: number; error?: Error }>((resolve) => {
		const second = new WebSocket(url, { headers: { origin: "chrome-extension://fixture" } });
		second.once("open", () => resolve({}));
		second.once("close", (code) => resolve({ closeCode: code }));
		second.once("error", (error) => resolve({ error: error as Error }));
	});
	assert.ok(secondResult.closeCode !== undefined || secondResult.error, "second connection must be rejected");
	first.close();
	await server.stop();
});

test("BrowserBridgeHttpServer stop closes active websocket clients", async () => {
	const accepted: WebSocket[] = [];
	const server = new BrowserBridgeHttpServer(HOST, DEFAULT_BROWSER_BRIDGE_PORT + 240, (ws) => accepted.push(ws), { portRangeEnd: DEFAULT_BROWSER_BRIDGE_PORT + 260 });
	await server.start();
	const ws = new WebSocket(`ws://${HOST}:${server.port}`, { headers: { origin: "chrome-extension://fixture" } });
	try {
		await onceOpen(ws);
		assert.equal(accepted.length, 1);
		const stopped = await Promise.race([
			server.stop().then(() => "stopped"),
			new Promise((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
		]);
		assert.equal(stopped, "stopped");
		assert.notEqual(ws.readyState, WebSocket.OPEN, "server stop must close accepted websocket clients");
	} finally {
		ws.terminate();
		await server.stop();
	}
});
