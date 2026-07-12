import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";
import { BrowserBridgeServer } from "../../src/bridge/server/BrowserBridgeServer.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";
import { CONSENT_MESSAGE_TYPES } from "../../src/bridge/protocol/consentTypes.ts";

function bridgeUrl(server: BrowserBridgeServer): string {
	return `ws://${server.host}:${server.port}`;
}

async function withServer<T>(fn: (server: BrowserBridgeServer) => Promise<T>): Promise<T> {
	const server = new BrowserBridgeServer({ port: 0 });
	await server.start();
	try {
		return await fn(server);
	} finally {
		await server.stop();
	}
}

type PortBlocker = { port: number; close: () => Promise<void> };

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

async function connectExtension(server: BrowserBridgeServer, tabs: Array<Record<string, unknown>> = [{ id: 7, url: "https://example.test/", title: "Example", active: true }]): Promise<WebSocket> {
	const ws = new WebSocket(bridgeUrl(server));
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	ws.send(JSON.stringify({
		type: "ext_ready",
		bridge: { id: "bridge-1", extensionInstanceId: "instance-1", workerBootId: "worker-1", durableRequests: true },
		extension: { id: "extension-1" },
		tabs,
	}));
	await server.waitForExtensionReady(undefined, 1_000);
	return ws;
}

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
	const server = new BrowserBridgeServer({ port: 0, maxPayloadBytes });
	await server.start();
	try {
		const health = await fetch(`http://${server.host}:${server.port}/health`).then((res) => res.json() as Promise<Record<string, unknown>>);
		assert.equal(health.maxPayloadBytes, maxPayloadBytes);

		const ws = new WebSocket(bridgeUrl(server));
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

test("BrowserBridgeServer command runtime port exposes snapshot, tabs, sessions, leases, operations and perception state", async () => {
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

		const browserSession = port.createBrowserSession("secondary") as { id: string };
		port.selectBrowserSession(browserSession.id);
		port.attachTabToBrowserSession(7, { browserSessionId: browserSession.id });
		assert.equal((port.listBrowserSessions() as Array<{ id: string }>).some((session) => session.id === browserSession.id), true);

		const lease = port.leaseTab(7, { browserSessionId: browserSession.id });
		assert.equal(lease.tabId, 7);
		assert.equal(port.leaseOwnerHash(browserSession.id, 7), browserSession.id);
		assert.equal(port.releaseTab(7, { browserSessionId: browserSession.id })?.id, lease.id);

		const operation = port.beginOperation({ commandName: "browser_observe", browserSessionId: browserSession.id, tabId: 7, phase: "running" });
		assert.equal(port.updateOperation(operation.operationId, { progress: 0.5 })?.progress, 0.5);
		assert.equal(port.finishOperation(operation.operationId)?.operationId, operation.operationId);
		assert.equal(port.snapshot().operations?.find((item) => item.operationId === operation.operationId)?.state, "terminal");

		const observation = port.createObservationSnapshot({ browserSessionId: browserSession.id, tabId: 7, sourceMode: "scan", capturedAt: Date.now() });
		assert.equal(port.getObservationSnapshot(observation.snapshotId)?.sourceMode, "scan");
		assert.equal(port.listObservationSnapshots().some((item) => item.snapshotId === observation.snapshotId), true);

		port.recordPerceptionTraceTerms?.(browserSession.id, [{ term: "checkout", kind: "intent", weight: 1 }]);
		assert.equal(port.perceptionTraceSnapshot?.(browserSession.id).terms[0].term, "checkout");

		port.recordKnownRecorderState?.("network", browserSession.id, 7, { active: true, lastSeq: 9 });
		port.recordKnownRecorderState?.("hook", browserSession.id, 8, { active: true, lastSeq: 4 });
		ws.send(JSON.stringify({ type: "tabs_update", tabs: [{ id: 8, url: "https://example.test/replaced", active: true }], replaced: [{ from: 7, to: 8 }] }));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(port.getKnownRecorderState?.("network", browserSession.id, 7), undefined);
		assert.equal(port.getKnownRecorderState?.("hook", browserSession.id, 8), undefined);

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

test("BrowserBridgeServer consent port sends requests, resolves decisions and broadcasts agents", async () => {
	await withServer(async (server) => {
		const ws = await connectExtension(server);
		const messages: Array<Record<string, unknown>> = [];
		ws.on("message", (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
		assert.equal(server.hasConsentSurface(), true);

		const decisionPromise = server.sendConsentRequest({ pairingId: "pair-1", label: "agent", code: "123456", expiresAt: new Date(Date.now() + 1_000).toISOString(), timeoutMs: 1_000 });
		await new Promise<void>((resolve) => {
			const poll = () => messages.some((message) => message.type === CONSENT_MESSAGE_TYPES.request) ? resolve() : setImmediate(poll);
			poll();
		});
		assert.equal(messages.some((message) => message.type === CONSENT_MESSAGE_TYPES.request && message.pairingId === "pair-1"), true);

		ws.send(JSON.stringify({ type: CONSENT_MESSAGE_TYPES.response, pairingId: "pair-1", decision: "approve" }));
		assert.equal(await decisionPromise, "approve");

		server.broadcastPairedAgents([{ pairingId: "pair-1", label: "agent", status: "active", lastSeenAt: "now", leaseHeld: false }]);
		await new Promise<void>((resolve) => {
			const poll = () => messages.some((message) => message.type === CONSENT_MESSAGE_TYPES.pairedAgents) ? resolve() : setImmediate(poll);
			poll();
		});
		assert.equal(messages.some((message) => message.type === CONSENT_MESSAGE_TYPES.pairedAgents), true);

		ws.close();
	});
});
