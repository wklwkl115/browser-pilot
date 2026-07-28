import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import type { WebSocket } from "ws";
import { BrowserBridgePendingRequests } from "../../src/bridge/server/BrowserBridgePendingRequests.ts";
import { buildBridgeTimeoutDiagnostics } from "../../src/bridge/server/BrowserBridgeDiagnostics.ts";
import type { BrowserBridgeSnapshot } from "../../src/bridge/server/types.ts";

type SentMessage = Record<string, unknown>;
type FakeSocket = WebSocket & { sent: SentMessage[] };

function fakeSocket(): FakeSocket {
	const sent: SentMessage[] = [];
	const ws = {
		sent,
		readyState: 1,
		send(raw: string) {
			sent.push(JSON.parse(raw) as SentMessage);
		},
	};
	return ws as unknown as FakeSocket;
}

function newPending(): BrowserBridgePendingRequests {
	return new BrowserBridgePendingRequests(() => ({}), (target) => target);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lastId = (ws: FakeSocket): string => String(ws.sent[ws.sent.length - 1].id);

test("request timeout rejects and removes the pending snapshot entry", async () => {
	const pr = newPending();
	const ws = fakeSocket();
	const promise = pr.send(ws, "slow", { tabId: 9, timeoutMs: 100 });
	assert.equal(pr.snapshot().length, 1);
	assert.equal(pr.snapshot()[0].tabId, 9);

	await assert.rejects(promise, (error: Error & { code?: string; details?: Record<string, unknown> }) => {
		assert.equal(error.code, "BRIDGE_TIMEOUT");
		assert.equal(error.details?.debugCodePreview, "slow");
		return true;
	});
	assert.equal(pr.snapshot().length, 0);
});

test("request cancellation preserves whether browser dispatch was acknowledged", async () => {
	const pr = newPending();
	const ws = fakeSocket();
	const beforeSend = new AbortController();
	beforeSend.abort();
	await assert.rejects(pr.send(ws, "never-send", { tabId: 7, timeoutMs: 5_000, signal: beforeSend.signal }), (error: Error & { code?: string; details?: Record<string, unknown> }) => {
		assert.equal(error.code, "BRIDGE_TIMEOUT");
		assert.equal(error.details?.dispatchStarted, false);
		assert.equal(error.details?.acked, false);
		return true;
	});
	assert.equal(ws.sent.length, 0);

	const inFlight = new AbortController();
	const promise = pr.send(ws, "in-flight", { tabId: 7, timeoutMs: 5_000, signal: inFlight.signal });
	const id = lastId(ws);
	pr.ack(id, ws);
	inFlight.abort();
	await assert.rejects(promise, (error: Error & { code?: string; details?: Record<string, unknown> }) => {
		assert.equal(error.code, "BRIDGE_TIMEOUT");
		assert.equal(error.details?.dispatchStarted, true);
		assert.equal(error.details?.acked, true);
		return true;
	});
	assert.equal(pr.snapshot().length, 0);
});

test("extension-side rejection is lifted into the bridge error", async () => {
	const pr = newPending();
	const ws = fakeSocket();
	const promise = pr.send(ws, "blocked-action", { tabId: 7, timeoutMs: 5_000 });
	const id = lastId(ws);
	pr.rejectBrowserError(id, ws, {
		code: "INVALID_RULE",
		message: "dispatch marker failed",
		details: { dispatchStarted: false, acked: false },
	}, undefined);
	await assert.rejects(promise, (error: Error & { details?: Record<string, unknown> }) => {
		assert.equal(error.details?.dispatchStarted, false);
		assert.equal(error.details?.acked, false);
		return true;
	});

	const barePromise = pr.send(ws, "pre-ack-validation-error", { tabId: 7, timeoutMs: 5_000 });
	pr.rejectBrowserError(lastId(ws), ws, "invalid command", undefined);
	await assert.rejects(barePromise, (error: Error & { details?: Record<string, unknown> }) => {
		assert.equal(error.details?.dispatchStarted, false);
		assert.equal(error.details?.acked, false);
		return true;
	});
});

test("rejectAllStopped clears every pending request with a bridge stopped error", async () => {
	const pr = newPending();
	const ws = fakeSocket();
	const first = pr.send(ws, "first", { tabId: 1, timeoutMs: 5_000 });
	const second = pr.send(ws, "second", { tabId: 2, timeoutMs: 5_000 });
	assert.equal(pr.snapshot().length, 2);

	pr.rejectAllStopped();

	await assert.rejects(first, (error: Error & { code?: string }) => error.code === "BRIDGE_STOPPED");
	await assert.rejects(second, (error: Error & { code?: string }) => error.code === "BRIDGE_STOPPED");
	assert.equal(pr.snapshot().length, 0);
});

test("client disconnect immediately fails requests without replay and preserves their ACK outcome", async () => {
	const pr = newPending();
	const ws = fakeSocket();
	const controller = new AbortController();
	const notAcked = pr.send(ws, "not-acked", { tabId: 1, timeoutMs: 5_000, signal: controller.signal });
	const acked = pr.send(ws, "acked", { tabId: 2, timeoutMs: 5_000 });
	pr.ack(lastId(ws), ws);
	assert.equal(getEventListeners(controller.signal, "abort").length, 1);
	assert.equal(pr.rejectClient(ws), 2);
	await assert.rejects(notAcked, (error: Error & { code?: string; details?: Record<string, unknown> }) => {
		assert.equal(error.code, "BRIDGE_CLIENT_DISCONNECTED");
		assert.equal(error.details?.outcome, "delivery-unknown");
		assert.match(error.message, /retry may duplicate/);
		return true;
	});
	await assert.rejects(acked, (error: Error & { code?: string; details?: Record<string, unknown> }) => {
		assert.equal(error.code, "BRIDGE_CLIENT_DISCONNECTED");
		assert.equal(error.details?.outcome, "inflight-unknown");
		return true;
	});
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	assert.equal(pr.snapshot().length, 0);
	assert.equal(pr.rejectClient(ws), 0);
});

test("resolved requests include bounded latency diagnostics without payload preview", async () => {
	const pr = newPending();
	const ws = fakeSocket();
	const promise = pr.send(ws, { cmd: "network.list", url: "https://secret.test/?token=hidden" }, { tabId: 1, timeoutMs: 5_000 });
	const id = lastId(ws);
	pr.ack(id, ws);
	await delay(2);
	pr.resolve(id, ws, { ok: true }, []);
	const result = await promise;
	const latency = result.diagnostics?.latency as Record<string, unknown>;
	assert.equal(typeof latency.totalMs, "number");
	assert.equal(typeof latency.clientMs, "number");
	assert.equal(typeof latency.ackMs, "number");
	assert.equal(latency.deadlineMs, 5_000);
	assert.equal(latency.acked, true);
	assert.equal(JSON.stringify(result.diagnostics).includes("secret.test"), false);
});

test("only the socket that received a request can acknowledge or settle it", async () => {
	const pr = newPending();
	const owner = fakeSocket();
	const other = fakeSocket();
	const promise = pr.send(owner, "owned", { timeoutMs: 5_000 });
	const id = lastId(owner);

	pr.ack(id, other);
	pr.resolve(id, other, "forged", []);
	assert.equal(pr.snapshot()[0]?.acked, false);

	pr.ack(id, owner);
	pr.resolve(id, owner, "trusted", []);
	assert.equal((await promise).data, "trusted");
});

test("timeout diagnostics select queue depth by browser and tab", () => {
	const snapshot = {
		host: "127.0.0.1",
		port: 0,
		running: true,
		extensionConnected: true,
		connectedClients: 2,
		clients: [],
		selectionVersion: 1,
		tabs: [],
		pending: [],
		queues: [
			{ key: "browser-a:7", browserId: "browser-a", tabId: 7, depth: 1 },
			{ key: "browser-b:7", browserId: "browser-b", tabId: 7, depth: 3 },
		],
	} as BrowserBridgeSnapshot;
	const diagnostics = buildBridgeTimeoutDiagnostics(snapshot, 7, 1_000, false, { browserId: "browser-b", tabId: 7, browserSessionId: "default", source: "explicit", implicit: false, selectionVersionAtDispatch: 1 });
	assert.equal(diagnostics.queueDepth, 3);
});
