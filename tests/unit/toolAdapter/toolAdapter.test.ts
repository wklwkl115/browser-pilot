import test from "node:test";
import assert from "node:assert/strict";
import { BrowserBridgeError } from "../../../src/driver/errors.ts";
import { toolMaxChars, toolPositiveInt, toolTimeoutMs, withTrackedOperation } from "../../../src/tools/toolAdapter.ts";

test("toolAdapter uses tool budget as default max chars", () => {
	assert.equal(toolMaxChars({}, "browser_artifact"), 8000);
});

test("toolAdapter normalizes positive integers with fallback", () => {
	assert.equal(toolPositiveInt(123, 10), 123);
	assert.equal(toolPositiveInt(undefined, 10), 10);
	assert.equal(toolPositiveInt(-1, 10), 10);
});

test("toolAdapter supports allowZero timeout probes", () => {
	assert.equal(toolTimeoutMs(0, 15000, { allowZero: true }), 0);
	assert.equal(toolTimeoutMs(undefined, 15000), 15000);
});

test("withTrackedOperation preserves BrowserBridgeError and appends operation details", async () => {
	const operations = new Map<string, Record<string, unknown>>();
	const server = {
		beginOperation(meta: Record<string, unknown>) {
			const operation = { operationId: "op-1", startedAt: Date.now(), updatedAt: Date.now(), ...meta };
			operations.set("op-1", operation);
			return operation as any;
		},
		updateOperation(operationId: string, patch: Record<string, unknown>) {
			const current = operations.get(operationId);
			if (!current) return undefined;
			const next = { ...current, ...patch, updatedAt: Date.now() };
			operations.set(operationId, next);
			return next as any;
		},
		finishOperation(operationId: string) {
			return operations.get(operationId) as any;
		},
	} as any;
	await assert.rejects(
		() => withTrackedOperation(server, { toolName: "browser_wait", phase: "running" }, undefined, async () => {
			throw new BrowserBridgeError("WAIT_TIMEOUT", "timed out", { original: true });
		}),
		(error: unknown) => {
			assert.ok(error instanceof BrowserBridgeError);
			assert.equal(error.code, "WAIT_TIMEOUT");
			assert.equal((error as BrowserBridgeError).details.original, true);
			assert.equal(typeof (error as BrowserBridgeError).details.operation, "object");
			return true;
		},
	);
});

test("withTrackedOperation heartbeat does not keep the event loop alive", async () => {
	const operations = new Map<string, Record<string, unknown>>();
	const updates: Array<Record<string, unknown>> = [];
	const server = {
		beginOperation(meta: Record<string, unknown>) {
			const operation = { operationId: "op-1", startedAt: Date.now(), updatedAt: Date.now(), ...meta };
			operations.set("op-1", operation);
			return operation as any;
		},
		updateOperation(operationId: string, patch: Record<string, unknown>) {
			const current = operations.get(operationId);
			if (!current) return undefined;
			const next = { ...current, ...patch, updatedAt: Date.now() };
			operations.set(operationId, next);
			return next as any;
		},
		finishOperation(operationId: string) {
			const current = operations.get(operationId);
			operations.delete(operationId);
			return current as any;
		},
	} as any;
	const originalSetInterval = globalThis.setInterval;
	let unrefCalled = false;
	globalThis.setInterval = ((handler: any, timeout?: any, ...args: any[]) => {
		const timer = originalSetInterval(handler, timeout, ...args) as any;
		queueMicrotask(() => handler());
		const originalUnref = timer.unref?.bind(timer);
		timer.unref = () => {
			unrefCalled = true;
			return originalUnref?.() ?? timer;
		};
		return timer;
	}) as typeof setInterval;
	try {
		const run = await withTrackedOperation(server, { toolName: "browser_wait", phase: "running" }, (update) => {
			updates.push(update as Record<string, unknown>);
		}, async () => {
			await new Promise((resolve) => setImmediate(resolve));
			return { ok: true };
		});
		assert.equal(run.result.ok, true);
		assert.equal(unrefCalled, true);
		const heartbeat = updates.find((update) => JSON.stringify(update.details || {}).includes("heartbeatAt"));
		assert.ok(heartbeat, "heartbeat update must be emitted");
		assert.ok(Array.isArray(heartbeat.content) && heartbeat.content.length === 0, "heartbeat update must be liveness-only: empty content array (host render contract requires content to exist)");
		const milestone = updates.find((update) => Array.isArray(update.content) && update.content.length > 0);
		assert.ok(milestone, "milestone updates must still carry content");
	} finally {
		globalThis.setInterval = originalSetInterval;
	}
});
