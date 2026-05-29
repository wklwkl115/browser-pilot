import test from "node:test";
import assert from "node:assert/strict";
import { BrowserOperationRegistry } from "../../../src/driver/BrowserOperationRegistry.ts";

test("BrowserOperationRegistry hashes lease owner and updates operation state", () => {
	const operations = new BrowserOperationRegistry();
	const started = operations.begin({
		toolName: "browser_wait",
		command: "wait.selector",
		browserSessionId: "session-a",
		tabId: 7,
		phase: "running",
		progress: 10,
	});
	assert.equal(started.toolName, "browser_wait");
	assert.equal(typeof started.leaseOwnerHash, "string");
	assert.notEqual(started.leaseOwnerHash, "session-a");
	const updated = operations.update(started.operationId, { progress: 90, phase: "completed" });
	assert.equal(updated?.progress, 90);
	assert.equal(updated?.phase, "completed");
	const finished = operations.finish(started.operationId);
	assert.equal(finished?.phase, "completed");
	assert.equal(operations.get(started.operationId), undefined);
});
