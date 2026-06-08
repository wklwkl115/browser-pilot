// Cold-start connection grace: a command waits a bounded window for a not-yet-
// connected extension to dial into the bridge before failing, instead of hard-
// failing instantly. waitForExtensionReady is the non-throwing primitive behind
// that grace (BrowserBridgeCommandService.ensureExtensionReady reuses it).
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { WebSocket } from "ws";
import { BrowserBridgeServer } from "../../../src/driver/BrowserBridgeServer.ts";

const HOST = "127.0.0.1";

async function freePort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, HOST, () => resolve());
	});
	const address = server.address();
	assert(address && typeof address === "object");
	const port = address.port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

async function openFakeExtension(port: number): Promise<WebSocket> {
	const ws = new WebSocket(`ws://${HOST}:${port}`, { headers: { Origin: "chrome-extension://fixture-extension" } });
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	return ws;
}

function sendReady(ws: WebSocket): void {
	ws.send(JSON.stringify({
		type: "ext_ready",
		bridge: { id: "fake-extension", name: "Pi Native Browser Bridge", version: "test" },
		tabs: [{ id: 1, tabId: 1, url: "https://example.test/", title: "Example", active: true, windowId: 1 }],
	}));
}

test("waitForExtensionReady resolves false within the bound when no extension connects", async () => {
	const server = new BrowserBridgeServer();
	const startedAt = Date.now();
	const ready = await server.waitForExtensionReady(undefined, 200);
	const elapsed = Date.now() - startedAt;
	assert.equal(ready, false, "no extension is connected, so the grace expires to false");
	assert.ok(elapsed >= 150, "honors the bounded wait instead of returning instantly");
	assert.ok(elapsed < 2_000, "never throws and returns near the deadline, not after a long hang");
});

test("waitForExtensionReady returns immediately with a zero bound", async () => {
	const server = new BrowserBridgeServer();
	const startedAt = Date.now();
	const ready = await server.waitForExtensionReady(undefined, 0);
	assert.equal(ready, false);
	assert.ok(Date.now() - startedAt < 150, "a zero/disabled grace must not block");
});

test("waitForExtensionReady resolves promptly when an extension registers", async () => {
	const port = await freePort();
	const server = new BrowserBridgeServer({ host: HOST, port });
	let ws: WebSocket | undefined;
	try {
		await server.start();
		const wait = server.waitForExtensionReady(undefined, 5_000);
		await new Promise((resolve) => setTimeout(resolve, 25));
		ws = await openFakeExtension(port);
		const startedAt = Date.now();
		sendReady(ws);
		const ready = await wait;
		assert.equal(ready, true);
		assert.ok(Date.now() - startedAt < 500, "ext_ready should wake waiters instead of waiting for a poll interval");
	} finally {
		ws?.close();
		await server.stop();
	}
});

test("sendCommand grace negative-cache avoids repeated no-extension waits", async () => {
	const previous = process.env.PI_BROWSER_EXTENSION_WAIT_MS;
	process.env.PI_BROWSER_EXTENSION_WAIT_MS = "120";
	const port = await freePort();
	const server = new BrowserBridgeServer({ host: HOST, port });
	try {
		await server.start();
		const firstStartedAt = Date.now();
		await assert.rejects(server.sendCommand({ cmd: "tabs", method: "list" }, { timeoutMs: 50 }), (error) => {
			assert.equal((error as { code?: unknown }).code, "NO_BROWSER_EXTENSION");
			return true;
		});
		const firstElapsed = Date.now() - firstStartedAt;
		assert.ok(firstElapsed >= 90, `first no-extension command should honor the grace window, got ${firstElapsed}ms`);

		const secondStartedAt = Date.now();
		await assert.rejects(server.sendCommand({ cmd: "tabs", method: "list" }, { timeoutMs: 50 }), (error) => {
			assert.equal((error as { code?: unknown }).code, "NO_BROWSER_EXTENSION");
			return true;
		});
		const secondElapsed = Date.now() - secondStartedAt;
		assert.ok(secondElapsed < 90, `second no-extension command should use the short negative cache, got ${secondElapsed}ms`);
	} finally {
		if (previous === undefined) delete process.env.PI_BROWSER_EXTENSION_WAIT_MS;
		else process.env.PI_BROWSER_EXTENSION_WAIT_MS = previous;
		await server.stop();
	}
});
