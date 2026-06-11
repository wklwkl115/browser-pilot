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
	assert.equal(updated?.leaseOwnerHash, started.leaseOwnerHash, "progress updates must not re-hash the already-redacted owner id");
	const reassigned = operations.update(started.operationId, { leaseOwnerHash: "session-b" });
	assert.equal(typeof reassigned?.leaseOwnerHash, "string");
	assert.notEqual(reassigned?.leaseOwnerHash, started.leaseOwnerHash, "explicit owner changes should produce a new stable hash");
	assert.notEqual(reassigned?.leaseOwnerHash, "session-b");
	const finished = operations.finish(started.operationId);
	assert.equal(finished?.phase, "completed");
	assert.equal(finished?.leaseOwnerHash, reassigned?.leaseOwnerHash);
	assert.equal(operations.get(started.operationId), undefined);
});

test("BrowserOperationRegistry prunes stale operations and caps retained entries", () => {
	let now = 1_000;
	const stale = new BrowserOperationRegistry({ ttlMs: 1_000, now: () => now });
	const old = stale.begin({ operationId: "old", toolName: "browser_wait", phase: "running" });
	now += 1_001;
	assert.equal(stale.get(old.operationId), undefined, "stale entries are pruned on reads");
	assert.deepEqual(stale.snapshot(), []);

	now = 2_000;
	const capped = new BrowserOperationRegistry({ maxOperations: 2, now: () => now });
	capped.begin({ operationId: "first", toolName: "browser_wait", phase: "running" });
	now += 1;
	capped.begin({ operationId: "second", toolName: "browser_wait", phase: "running" });
	now += 1;
	capped.begin({ operationId: "third", toolName: "browser_wait", phase: "running" });

	assert.deepEqual(capped.snapshot().map((item) => item.operationId), ["second", "third"]);
	assert.equal(capped.get("first"), undefined);
});
