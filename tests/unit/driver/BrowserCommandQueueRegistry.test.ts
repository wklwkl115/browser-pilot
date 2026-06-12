import test from "node:test";
import assert from "node:assert/strict";
import { BrowserCommandQueueRegistry } from "../../../src/driver/BrowserCommandQueueRegistry.ts";
import { BrowserBridgeError } from "../../../src/driver/errors.ts";

test("BrowserCommandQueueRegistry serializes commands per session/tab", async () => {
	const queue = new BrowserCommandQueueRegistry();
	const events: string[] = [];
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

	const first = queue.enqueue("s1", 1, async () => {
		events.push("first:start");
		await firstGate;
		events.push("first:end");
		return "first";
	});
	const second = queue.enqueue("s1", 1, async () => {
		events.push("second:start");
		events.push("second:end");
		return "second";
	});

	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(events, ["first:start"]);
	assert.equal(queue.depth("s1", 1), 2);
	releaseFirst();
	assert.equal(await first, "first");
	assert.equal(await second, "second");
	assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
	assert.equal(queue.depth("s1", 1), 0);
});

test("BrowserCommandQueueRegistry rejects when queue depth reaches the configured limit", async () => {
	const queue = new BrowserCommandQueueRegistry(1);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const first = queue.enqueue("s1", 1, async () => {
		await gate;
		return "first";
	});

	await assert.rejects(queue.enqueue("s1", 1, async () => "second"), (error) => error instanceof BrowserBridgeError && error.code === "QUEUE_FULL");
	assert.equal(queue.depth("s1", 1), 1);
	release();
	assert.equal(await first, "first");
	assert.equal(queue.depth("s1", 1), 0);
});

test("BrowserCommandQueueRegistry aliases replacement tab queues until the old chain drains", async () => {
	const queue = new BrowserCommandQueueRegistry();
	const events: string[] = [];
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const first = queue.enqueue("s1", 1, async () => {
		events.push("old:start");
		await firstGate;
		events.push("old:end");
		return "old";
	});

	assert.equal(queue.migrateTabQueue("s1", 1, 2)?.tabId, 2);
	const second = queue.enqueue("s1", 2, async () => {
		events.push("new:start");
		events.push("new:end");
		return "new";
	});

	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(events, ["old:start"]);
	assert.equal(queue.depth("s1", 2), 2);
	assert.equal(queue.snapshot()[0]?.tabId, 2);
	releaseFirst();
	assert.equal(await first, "old");
	assert.equal(await second, "new");
	assert.deepEqual(events, ["old:start", "old:end", "new:start", "new:end"]);
	assert.equal(queue.depth("s1", 2), 0);
});
