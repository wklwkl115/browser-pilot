import test from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import { BrowserBridgePendingRequests } from "../../src/bridge/server/BrowserBridgePendingRequests.ts";

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

const tick = () => new Promise((resolve) => setImmediate(resolve));
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
	pr.ack(id);
	inFlight.abort();
	await assert.rejects(promise, (error: Error & { code?: string; details?: Record<string, unknown> }) => {
		assert.equal(error.code, "BRIDGE_TIMEOUT");
		assert.equal(error.details?.dispatchStarted, true);
		assert.equal(error.details?.acked, true);
		return true;
	});
	assert.equal(pr.snapshot().length, 0);
});

test("extension-side dispatch prevention is lifted into the bridge error evidence", async () => {
	const pr = newPending();
	const ws = fakeSocket();
	const promise = pr.send(ws, "blocked-action", { tabId: 7, operationId: "operation-blocked", timeoutMs: 5_000 });
	const id = lastId(ws);
	pr.rejectBrowserError(id, {
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
	pr.rejectBrowserError(lastId(ws), "invalid command", undefined);
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

test("drainClient holds an in-flight request, then fails it after the grace window", async () => {
	const pr = newPending();
	const ws = fakeSocket();
	const promise = pr.send(ws, "code", { tabId: 1, timeoutMs: 5_000 });
	let settled: unknown = null;
	void promise.then((value) => (settled = { value }), (error) => (settled = error));

	pr.drainClient(ws, "inst-X", 30);
	await tick();
	assert.equal(settled, null, "request is held during the grace window, not failed immediately");

	await delay(60);
	assert.ok(Object(settled) instanceof Error, "request fails after grace expiry");
	assert.equal((settled as unknown as { code: string }).code, "BRIDGE_CLIENT_DISCONNECTED");
});

test("a result arriving during the grace window settles the request normally", async () => {
	const pr = newPending();
	const ws = fakeSocket();
	const promise = pr.send(ws, "code", { tabId: 1, timeoutMs: 5_000 });
	const id = lastId(ws);
	pr.drainClient(ws, "inst-X", 1_000);

	pr.resolve(id, { ok: true }, []);
	const result = await promise;
	assert.deepEqual(result.data, { ok: true });
});

test("resolved requests include bounded latency diagnostics without payload preview", async () => {
	const pr = newPending();
	const ws = fakeSocket();
	const promise = pr.send(ws, { cmd: "network.list", url: "https://secret.test/?token=hidden" }, { tabId: 1, timeoutMs: 5_000 });
	const id = lastId(ws);
	pr.ack(id);
	await delay(2);
	pr.resolve(id, { ok: true }, []);
	const result = await promise;
	const latency = result.diagnostics?.latency as Record<string, unknown>;
	assert.equal(typeof latency.totalMs, "number");
	assert.equal(typeof latency.clientMs, "number");
	assert.equal(typeof latency.ackMs, "number");
	assert.equal(latency.deadlineMs, 5_000);
	assert.equal(latency.acked, true);
	assert.equal(JSON.stringify(result.diagnostics).includes("secret.test"), false);
});

test("non-durable reconnect fails not-acked as not-delivered and acked as inflight-unknown", async () => {
	const pr = newPending();
	const ws = fakeSocket();
	const newWs = fakeSocket();

	const notAcked = pr.send(ws, "c1", { tabId: 1, timeoutMs: 5_000 });
	const acked = pr.send(ws, "c2", { tabId: 2, timeoutMs: 5_000 });
	pr.ack(lastId(ws)); // ack the second request (c2)
	pr.drainClient(ws, "inst-X", 1_000);

	const reconciled = pr.reconnectInstance("inst-X", newWs, { durable: false });
	assert.equal(reconciled, 2);

	await assert.rejects(notAcked, (error: Error & { code?: string; details?: Record<string, unknown> }) => {
		assert.equal(error.code, "BRIDGE_CLIENT_DISCONNECTED");
		assert.equal(error.details?.outcome, "not-delivered");
		return true;
	});
	await assert.rejects(acked, (error: Error & { code?: string; details?: Record<string, unknown> }) => {
		assert.equal(error.code, "BRIDGE_CLIENT_DISCONNECTED");
		assert.equal(error.details?.outcome, "inflight-unknown");
		return true;
	});
	assert.equal(newWs.sent.length, 0, "non-durable reconnect never redelivers");
});

test("durable reconnect redelivers the request to the new socket and settles on its result", async () => {
	const pr = newPending();
	const ws = fakeSocket();
	const newWs = fakeSocket();

	const promise = pr.send(ws, "click", { tabId: 7, operationId: "operation-click-7", operationGeneration: 3, timeoutMs: 5_000 });
	assert.equal(ws.sent[0]?.operationId, "operation-click-7");
	assert.equal(ws.sent[0]?.operationGeneration, 3);
	const id = lastId(ws);
	pr.drainClient(ws, "inst-X", 1_000);

	const reconciled = pr.reconnectInstance("inst-X", newWs, { durable: true });
	assert.equal(reconciled, 1);
	const redelivered = newWs.sent[0];
	assert.equal(redelivered.id, id);
	assert.equal(redelivered.redelivered, true);
	assert.equal(redelivered.priorAck, false);
	assert.equal(redelivered.code, "click");
	assert.equal(redelivered.operationId, "operation-click-7");
	assert.equal(redelivered.operationGeneration, 3);

	pr.resolve(id, { clicked: true }, []);
	const result = await promise;
	assert.deepEqual(result.data, { clicked: true });
});

test("reconnect with no instance id is a no-op; the request still fails at grace expiry", async () => {
	const pr = newPending();
	const ws = fakeSocket();
	const newWs = fakeSocket();
	const promise = pr.send(ws, "code", { tabId: 1, timeoutMs: 5_000 });
	pr.drainClient(ws, undefined, 30);

	assert.equal(pr.reconnectInstance(undefined, newWs, { durable: true }), 0, "cannot correlate without an instance id");
	assert.equal(newWs.sent.length, 0);

	await assert.rejects(promise, (error: Error & { code?: string }) => error.code === "BRIDGE_CLIENT_DISCONNECTED");
});

test("request metrics tally drained, reconciliation outcomes, and redelivery", async () => {
	const pr = newPending();
	const ws = fakeSocket();
	const newWs = fakeSocket();

	const notAcked = pr.send(ws, "c1", { tabId: 1, timeoutMs: 5_000 });
	const acked = pr.send(ws, "c2", { tabId: 2, timeoutMs: 5_000 });
	pr.ack(lastId(ws));
	pr.drainClient(ws, "inst-X", 1_000);
	pr.reconnectInstance("inst-X", newWs, { durable: false });
	await assert.rejects(notAcked);
	await assert.rejects(acked);

	const afterNonDurable = pr.metrics();
	assert.equal(afterNonDurable.drained, 2);
	assert.equal(afterNonDurable.reconciledNotDelivered, 1);
	assert.equal(afterNonDurable.reconciledInflightUnknown, 1);

	const promise = pr.send(ws, "c3", { tabId: 3, timeoutMs: 5_000 });
	const id = lastId(ws);
	pr.drainClient(ws, "inst-X", 1_000);
	pr.reconnectInstance("inst-X", newWs, { durable: true });
	assert.equal(pr.metrics().redelivered, 1);
	pr.resolve(id, { ok: true }, []);
	await promise;
});
