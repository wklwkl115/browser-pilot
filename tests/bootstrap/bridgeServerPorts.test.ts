import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { BrowserBridgeServer } from "../../src/bridge/server/BrowserBridgeServer.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";
import { readExpectedExtensionBuild } from "../../src/bridge/server/extensionBuild.ts";
import { BROWSER_PILOT_EXTENSION_ID } from "../../src/bridge/server/browserBridgeConfig.ts";

const EXTENSION_ORIGIN = `chrome-extension://${BROWSER_PILOT_EXTENSION_ID}`;

function bridgeUrl(server: BrowserBridgeServer): string {
	return `ws://${server.host}:${server.port}`;
}

async function withServer<T>(fn: (server: BrowserBridgeServer) => Promise<T>): Promise<T> {
	const server = await startIsolatedServer();
	try {
		return await fn(server);
	} finally {
		await server.stop();
	}
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
	return Promise.race([
		promise,
		delay(1_000, undefined, { ref: false }).then(() => { throw new Error(`${label} timed out`); }),
	]);
}

async function useExpectedExtensionBuild(t: TestContext, buildId = "current-build"): Promise<void> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "browser-pilot-extension-build-"));
	const manifestPath = path.join(directory, "build-manifest.json");
	await writeFile(manifestPath, JSON.stringify({ buildId }));
	const previousManifest = process.env.BROWSER_PILOT_EXPECTED_EXTENSION_BUILD_MANIFEST;
	process.env.BROWSER_PILOT_EXPECTED_EXTENSION_BUILD_MANIFEST = manifestPath;
	t.after(async () => {
		if (previousManifest === undefined) delete process.env.BROWSER_PILOT_EXPECTED_EXTENSION_BUILD_MANIFEST;
		else process.env.BROWSER_PILOT_EXPECTED_EXTENSION_BUILD_MANIFEST = previousManifest;
		await rm(directory, { recursive: true, force: true });
	});
}

type PortBlocker = { port: number; close: () => Promise<void> };
type BrowserBridgeServerOptions = NonNullable<ConstructorParameters<typeof BrowserBridgeServer>[0]>;

async function listenBlocker(host = "127.0.0.1", port = 0): Promise<PortBlocker> {
	const server = http.createServer((_req, res) => {
		res.writeHead(200);
		res.end("busy");
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected TCP listener address");
	return {
		port: address.port,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

async function startIsolatedServer(options: BrowserBridgeServerOptions = {}): Promise<BrowserBridgeServer> {
	const reservation = await listenBlocker();
	await reservation.close();
	const server = new BrowserBridgeServer({ ...options, port: reservation.port, portRangeEnd: reservation.port });
	await server.start();
	return server;
}

async function reserveConsecutivePorts(host = "127.0.0.1"): Promise<{ blocker: PortBlocker; successor: PortBlocker }> {
	const firstCandidate = 20_000 + (process.pid % 10_000);
	for (let offset = 0; offset < 512; offset += 2) {
		let blocker: PortBlocker | undefined;
		try {
			blocker = await listenBlocker(host, firstCandidate + offset);
			const successor = await listenBlocker(host, blocker.port + 1);
			return { blocker, successor };
		} catch (error) {
			if (blocker) await blocker.close();
			const code = error && typeof error === "object" ? String((error as { code?: unknown }).code || "") : "";
			if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
		}
	}
	throw new Error("could not reserve consecutive test ports");
}

async function openExtension(
	server: BrowserBridgeServer,
	tabs: Array<Record<string, unknown>> = [{ id: 7, url: "https://example.test/", title: "Example", active: true }],
	identity: { extensionId?: string; extensionInstanceId?: string; workerBootId?: string; buildId?: string } = {},
): Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }> }> {
	const ws = new WebSocket(bridgeUrl(server), { origin: EXTENSION_ORIGIN });
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
	ws.send(JSON.stringify({
		type: "ext_ready",
		bridge: {
			id: identity.extensionId ?? "bridge-1",
			extensionInstanceId: identity.extensionInstanceId ?? "instance-1",
			workerBootId: identity.workerBootId ?? "worker-1",
			build: { buildId: identity.buildId ?? readExpectedExtensionBuild().buildId },
		},
		extension: { id: identity.extensionId ?? "extension-1" },
		tabs,
	}));
	return { ws, closed };
}

async function connectExtension(
	server: BrowserBridgeServer,
	tabs: Array<Record<string, unknown>> = [{ id: 7, url: "https://example.test/", title: "Example", active: true }],
	identity: { extensionId?: string; extensionInstanceId?: string; workerBootId?: string; buildId?: string } = {},
): Promise<WebSocket> {
	const { ws } = await openExtension(server, tabs, identity);
	const expectedInstanceId = identity.extensionInstanceId ?? "instance-1";
	const expectedWorkerBootId = identity.workerBootId ?? "worker-1";
	const deadlineAt = Date.now() + 1_000;
	while (!server.snapshot().clients.some((client) => client.extensionInstanceId === expectedInstanceId && client.workerBootId === expectedWorkerBootId)) {
		if (Date.now() >= deadlineAt) throw new Error(`extension fixture did not become ready: ${expectedInstanceId}`);
		await new Promise((resolve) => setImmediate(resolve));
	}
	return ws;
}

test("current extension readiness waits past a stale peer and promotes the current build", async (t) => {
	await useExpectedExtensionBuild(t);
	await withServer(async (server) => {
		const stale = await connectExtension(server, [{ id: 7, url: "https://stale.test/", active: true }], { extensionInstanceId: "stale-instance", buildId: "stale-build" });
		const staleClosed = new Promise<number>((resolve) => stale.once("close", resolve));
		assert.equal(server.snapshot().extension?.extensionStale, true);
		let settled = false;
		const ready = server.waitForExtensionReady(undefined, 1_000).then((value) => { settled = true; return value; });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(settled, false);

		const current = await connectExtension(server, [{ id: 9, url: "https://current.test/", active: true }], { extensionInstanceId: "current-instance" });
		assert.equal(await ready, true);
		assert.equal(server.snapshot().extension?.extensionInstanceId, "current-instance");
		assert.equal(server.snapshot().extension?.extensionStale, false);
		assert.equal(await staleClosed, 1000);
		assert.equal(server.snapshot().connectedClients, 1);
		current.close();
	});
});

test("BrowserBridgeServer advances to the next configured port when the requested port is busy", async () => {
	const { blocker, successor } = await reserveConsecutivePorts();
	await successor.close();
	const server = new BrowserBridgeServer({ port: blocker.port, portRangeEnd: successor.port });
	try {
		await server.start();
		assert.equal(server.running, true);
		assert.equal(server.requestedPort, blocker.port);
		assert.equal(server.port, successor.port);
		const health = await fetch(`http://${server.host}:${server.port}/health`).then((res) => res.json() as Promise<Record<string, unknown>>);
		assert.equal(health.ok, true);
		assert.equal(health.port, successor.port);
	} finally {
		await server.stop();
		await blocker.close();
	}
});

test("BrowserBridgeServer reports and enforces the configured websocket payload limit", async () => {
	const maxPayloadBytes = 512;
	const server = await startIsolatedServer({ maxPayloadBytes });
	try {
		const health = await fetch(`http://${server.host}:${server.port}/health`).then((res) => res.json() as Promise<Record<string, unknown>>);
		assert.equal(health.maxPayloadBytes, maxPayloadBytes);

			const ws = new WebSocket(bridgeUrl(server), { origin: EXTENSION_ORIGIN });
		await new Promise<void>((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const closeCode = new Promise<number>((resolve) => ws.once("close", resolve));
		ws.send("x".repeat(maxPayloadBytes + 1));
		assert.equal(await closeCode, 1009);
	} finally {
		await server.stop();
	}
});

test("BrowserBridgeServer rejects websocket clients outside the packaged extension origin", async () => {
	await withServer(async (server) => {
		for (const options of [undefined, { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }]) {
			const ws = new WebSocket(bridgeUrl(server), options);
			const status = await new Promise<number | undefined>((resolve, reject) => {
				ws.once("unexpected-response", (_request, response) => resolve(response.statusCode));
				ws.once("open", () => reject(new Error("unauthorized websocket opened")));
				ws.once("error", () => {});
			});
			assert.equal(status, 403);
		}
	});
});

test("BrowserBridgeServer closes clients that do not complete ext_ready", async () => {
	const server = await startIsolatedServer({ handshakeTimeoutMs: 50 });
	try {
		const ws = new WebSocket(bridgeUrl(server), { origin: EXTENSION_ORIGIN });
		await new Promise<void>((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		assert.equal(server.snapshot().connectedClients, 1);
		await new Promise<void>((resolve) => ws.once("close", () => resolve()));
		const disconnectDeadline = Date.now() + 1_000;
		while (server.snapshot().connectedClients && Date.now() < disconnectDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(server.snapshot().connectedClients, 0);
	} finally {
		await server.stop();
	}
});

test("BrowserBridgeServer fails with diagnostics when the configured port range is exhausted", async () => {
	const blocker = await listenBlocker();
	const server = new BrowserBridgeServer({ port: blocker.port, portRangeEnd: blocker.port });
	try {
		await assert.rejects(server.start(), (error: Error & { code?: string; details?: Record<string, unknown> }) => {
			assert.equal(error.code, "BRIDGE_START_FAILED");
			assert.equal(error.details?.host, "127.0.0.1");
			assert.equal(error.details?.port, blocker.port);
			assert.equal(error.details?.portRangeEnd, blocker.port);
			assert.equal(error.details?.triedPortRange, String(blocker.port));
			assert.match(String(error.details?.hint), /Check if other processes are using port/);
			return true;
		});
		assert.equal(server.running, false);
	} finally {
		await server.stop();
		await blocker.close();
	}
});

test("BrowserBridgeServer command runtime port exposes snapshot, tabs and perception state", async () => {
	await withServer(async (server) => {
		const port: BrowserCommandRuntimePort = server;
		const ws = await connectExtension(server);

		const snapshot = port.snapshot();
		assert.equal(snapshot.running, true);
		assert.equal(snapshot.extensionConnected, true);
			assert.equal(snapshot.defaultTabId, 7);
			assert.equal(snapshot.tabs.length, 1);
			assert.equal(port.getTabs()[0].targetRef, snapshot.defaultTabHandle);
			assert.equal(port.resolveTargetTabId(snapshot.defaultTabHandle, snapshot.browserSessionId), 7);
			assert.ok(snapshot.browserSessionId);

			const observation = port.createObservationSnapshot({ browserSessionId: snapshot.browserSessionId, tabId: 7, sourceMode: "scan", capturedAt: Date.now() });
			assert.equal(port.getObservationSnapshot(observation.snapshotId)?.sourceMode, "scan");
			assert.equal(port.listObservationSnapshots().some((item) => item.snapshotId === observation.snapshotId), true);

			port.recordKnownRecorderState?.("network", snapshot.browserSessionId, 7, { active: true, lastSeq: 9 });
			port.recordKnownRecorderState?.("hook", snapshot.browserSessionId, 8, { active: true, lastSeq: 4 });
			ws.send(JSON.stringify({ type: "tabs_update", tabs: [{ id: 8, url: "https://example.test/replaced", active: true }], replaced: [{ from: 7, to: 8 }] }));
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(port.getKnownRecorderState?.("network", snapshot.browserSessionId, 7), undefined);
			assert.equal(port.getKnownRecorderState?.("hook", snapshot.browserSessionId, 8), undefined);

		ws.close();
	});
});

test("BrowserBridgeServer pending request surface records ack/result lifecycle in snapshots", async () => {
	await withServer(async (server) => {
		const ws = await connectExtension(server);
		const messages: Array<Record<string, unknown>> = [];
		ws.on("message", (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));

		const promise = server.sendCommand({ cmd: "tabs", method: "list" }, { timeoutMs: 1_000 });
		await new Promise<void>((resolve) => {
			const poll = () => messages.length ? resolve() : setImmediate(poll);
			poll();
		});
		const request = messages[0];
		assert.equal(server.snapshot().pending.length, 1);
		assert.equal(server.snapshot().pending[0].acked, false);

		ws.send(JSON.stringify({ type: "ack", id: request.id }));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(server.snapshot().pending[0].acked, true);

		ws.send(JSON.stringify({ type: "result", id: request.id, result: { ok: true, tabs: [] } }));
		const result = await promise;
		assert.deepEqual(result.data, { ok: true, tabs: [] });
		assert.equal(server.snapshot().pending.length, 0);

		ws.close();
	});
});

test("BrowserBridgeServer rejects a different browser instance after ownership is established", async () => {
	await withServer(async (server) => {
		const owner = await connectExtension(
			server,
			[{ id: 7, url: "https://owner.test/", active: true }],
			{ extensionInstanceId: "owner-instance", workerBootId: "owner-worker" },
		);
		const contender = await openExtension(
			server,
			[{ id: 9, url: "https://contender.test/", active: true }],
			{ extensionInstanceId: "contender-instance", workerBootId: "contender-worker" },
		);
		assert.deepEqual(await contender.closed, { code: 1008, reason: "Another browser is already connected" });
		assert.equal(server.snapshot().connectedClients, 1);
		assert.equal(server.snapshot().extension?.extensionInstanceId, "owner-instance");
		assert.equal(server.getTabs().some((tab) => tab.url === "https://contender.test/"), false);
			owner.close();
		});
	});

test("BrowserBridgeServer lets a new worker socket replace the same browser instance", { timeout: 7_000 }, async (t) => {
	await useExpectedExtensionBuild(t);
	await withServer(async (server) => {
		const first = await within(connectExtension(server, [{ id: 7, url: "https://before.test/", active: true }], { extensionInstanceId: "same-instance", workerBootId: "worker-1" }), "first extension connect");
		const firstClosed = new Promise<number>((resolve) => first.once("close", resolve));
		const replacement = await within(connectExtension(server, [{ id: 8, url: "https://after.test/", active: true }], { extensionInstanceId: "same-instance", workerBootId: "worker-2" }), "replacement extension connect");
		assert.equal(await within(firstClosed, "superseded extension close"), 1000);
		assert.equal(server.snapshot().connectedClients, 1);
		assert.equal(server.snapshot().extension?.workerBootId, "worker-2");
		assert.equal(server.getTabs().some((tab) => tab.url === "https://after.test/"), true);
		const stale = await within(openExtension(server, [], { extensionInstanceId: "same-instance", workerBootId: "worker-old", buildId: "stale-build" }), "stale extension connect");
		assert.equal((await within(stale.closed, "stale extension rejection")).code, 1008);
		assert.equal(server.snapshot().extension?.workerBootId, "worker-2");
		replacement.close();
	});
});
