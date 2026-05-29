import test from "node:test";
import assert from "node:assert/strict";
import { BrowserCommandQueueRegistry } from "../../../src/driver/BrowserCommandQueueRegistry.ts";

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
