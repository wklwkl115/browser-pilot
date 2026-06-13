import test from "node:test";
import assert from "node:assert/strict";
import { startTrackedOperation, withTrackedOperation } from "../../../src/tools/toolAdapter.ts";
import type { BrowserBridgeServer } from "../../../src/driver/BrowserBridgeServer.ts";
import type { BrowserActiveOperationInfo } from "../../../src/driver/types.ts";
import type { PiTextToolResult } from "../../../src/utils/toolResult.ts";

function makeOperation(patch: Partial<BrowserActiveOperationInfo> = {}): BrowserActiveOperationInfo {
	return {
		operationId: "op-1",
		toolName: "browser_test",
		phase: "running",
		startedAt: Date.now(),
		updatedAt: Date.now(),
		...patch,
	};
}

function fakeServer(op: BrowserActiveOperationInfo): BrowserBridgeServer {
	let current = op;
	return {
		beginOperation(_meta: unknown) { return current; },
		updateOperation(_id: string, patch: Partial<BrowserActiveOperationInfo>) {
			current = { ...current, ...patch, updatedAt: Date.now() };
			return current;
		},
		finishOperation(_id: string) { return current; },
	} as unknown as BrowserBridgeServer;
}

// Every object passed to onUpdate must have Array.isArray(result.content) === true.
// This is the Pi-host contract: host calls result.content.filter(...) on every partial update.

test("emitTrackedProgress default branch (content not false) emits content array", async () => {
	const updates: PiTextToolResult[] = [];
	const server = fakeServer(makeOperation());
	const handle = await startTrackedOperation(server, { toolName: "browser_test", phase: "running", startedAt: Date.now(), updatedAt: Date.now() }, (r) => { updates.push(r); });
	await handle.update({ phase: "running", progress: 50 });
	handle.finish();

	assert.ok(updates.length >= 2, "expected at least 2 updates (start + progress)");
	for (const u of updates) {
		assert.ok(Array.isArray(u.content), `content must be an array; got ${JSON.stringify(u.content)}`);
	}
});

test("emitTrackedProgress content:false branch (heartbeat shape) emits empty content array", async () => {
	const updates: PiTextToolResult[] = [];
	const server = fakeServer(makeOperation());
	const handle = await startTrackedOperation(server, { toolName: "browser_test", phase: "running", startedAt: Date.now(), updatedAt: Date.now() }, (r) => { updates.push(r); });
	// Directly invoke the heartbeat path via handle.update with content:false
	await handle.update({ details: { heartbeatAt: Date.now() } }, { content: false });
	handle.finish();

	const heartbeatUpdate = updates[updates.length - 1]!;
	assert.ok(Array.isArray(heartbeatUpdate.content), `heartbeat update content must be an array; got ${JSON.stringify(heartbeatUpdate.content)}`);
	assert.equal(heartbeatUpdate.content.length, 0, "heartbeat update content must be empty (no text noise)");
	assert.ok(typeof heartbeatUpdate.details?.progress === "object", "heartbeat update must carry details.progress");
});

test("withTrackedOperation: all onUpdate calls have Array.isArray(content) === true", async () => {
	const updates: PiTextToolResult[] = [];
	const server = fakeServer(makeOperation());

	await withTrackedOperation(
		server,
		{ toolName: "browser_test", phase: "running", startedAt: Date.now(), updatedAt: Date.now() },
		(r) => { updates.push(r); },
		async (handle) => {
			// Simulate the heartbeat path directly (same as setInterval callback does)
			await handle.update({ details: { heartbeatAt: Date.now() } }, { content: false });
			// Simulate a normal progress update
			await handle.update({ phase: "running", progress: 75 });
			return "done";
		},
	);

	assert.ok(updates.length >= 3, "expected start + heartbeat + progress + completed updates");
	for (const u of updates) {
		assert.ok(Array.isArray(u.content), `every onUpdate call must have Array.isArray(content); got ${JSON.stringify(u)}`);
	}

	// Specifically identify the heartbeat update (content:false path) — it has empty content
	const heartbeatUpdates = updates.filter((u) => u.content.length === 0);
	assert.ok(heartbeatUpdates.length >= 1, "expected at least one heartbeat (empty-content) update");
	for (const h of heartbeatUpdates) {
		assert.ok(typeof h.details?.progress === "object", "heartbeat update must have details.progress");
	}
});
