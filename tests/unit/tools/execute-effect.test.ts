import test from "node:test";
import assert from "node:assert/strict";
import { nextActionsForExecutionEffect } from "../../../src/distill-core/recovery.ts";
import { commandCollectsExecutionEffect, withExecutionEffect } from "../../../src/tools/executionEffect.ts";
import type { BrowserBridgeServer } from "../../../src/driver/BrowserBridgeServer.ts";
import type { BrowserBridgeExecutionResult } from "../../../src/driver/types.ts";

function fakeResult(): BrowserBridgeExecutionResult {
	return {
		acknowledged: true,
		data: { ok: true },
		target: { tabId: 7, browserSessionId: "session-1", source: "explicit" },
		sourceMode: "bridge",
	};
}

test("withExecutionEffect reports cheap signal deltas around dispatch", async () => {
	const fingerprints = [
		{ changeSeq: 1, url: "https://example.test/a", visibleCount: 2, interactiveCount: 3 },
		{ changeSeq: 3, url: "https://example.test/b", visibleCount: 5, interactiveCount: 4 },
		{ changeSeq: 3, url: "https://example.test/b", visibleCount: 5, interactiveCount: 4 },
	];
	const networkSeq = [10, 12, 12];
	const hookSeq = [4, 5, 5];
	let snapshots = 0;
	const commands: string[] = [];
	const server = {
		snapshot() {
			snapshots += 1;
			return { selectionVersion: snapshots === 1 ? 1 : 2, defaultTabId: snapshots === 1 ? 7 : 8 };
		},
		async sendCommand(command: Record<string, unknown>) {
			commands.push(String(command.cmd));
			if (command.cmd === "content.fingerprint") return { ok: true, data: fingerprints.shift() };
			if (command.cmd === "network.status") return { ok: true, data: { active: true, lastSeq: networkSeq.shift() } };
			if (command.cmd === "hook.status") return { ok: true, data: { last_seq: hookSeq.shift() } };
			return { ok: true, data: {} };
		},
	} as unknown as BrowserBridgeServer;

	const run = await withExecutionEffect(server, { browserSessionId: "session-1", tabId: 7, timeoutMs: 1000, quietMs: 0 }, async () => fakeResult());

	assert.equal(run.result.acknowledged, true);
	assert.equal(run.effect?.mutations, 2);
	assert.equal(run.effect?.settled, true);
	assert.equal(run.effect?.navigated, true);
	assert.equal(run.effect?.visibleDelta, 3);
	assert.equal(run.effect?.interactiveDelta, 1);
	assert.equal(run.effect?.requestsFired, 2);
	assert.equal(run.effect?.hookEventsFired, 1);
	assert.deepEqual(run.effect?.targetDelta, { selectionVersionBefore: 1, selectionVersionAfter: 2, tabIdBefore: 7, tabIdAfter: 8 });
	assert.deepEqual(run.effect?.anchor, { changeSeq: 3, networkSeq: 12, hookSeq: 5 });
	assert.equal(commands.filter((cmd) => cmd === "content.fingerprint").length, 3);
});

test("withExecutionEffect respects kill switch", async () => {
	const previous = process.env.PI_BROWSER_EXECUTE_EFFECT;
	process.env.PI_BROWSER_EXECUTE_EFFECT = "0";
	try {
		let signalReads = 0;
		const server = {
			snapshot: () => ({}),
			sendCommand: async () => {
				signalReads += 1;
				return { ok: true, data: {} };
			},
		} as unknown as BrowserBridgeServer;
		const run = await withExecutionEffect(server, { tabId: 7, timeoutMs: 1000 }, async () => fakeResult());
		assert.equal(run.effect, undefined);
		assert.equal(signalReads, 0);
	} finally {
		if (previous === undefined) delete process.env.PI_BROWSER_EXECUTE_EFFECT;
		else process.env.PI_BROWSER_EXECUTE_EFFECT = previous;
	}
});

test("commandCollectsExecutionEffect follows protocol write access", () => {
	assert.equal(commandCollectsExecutionEffect({ cmd: "input.keys", tabId: 1, text: "secret" }), true);
	assert.equal(commandCollectsExecutionEffect({ cmd: "wait.selector", tabId: 1, selector: "body" }), false);
	assert.equal(commandCollectsExecutionEffect({ cmd: "tabs", method: "list" }), false);
	assert.equal(commandCollectsExecutionEffect({ cmd: "tabs", method: "create", url: "https://example.test" }), false);
});

test("nextActionsForExecutionEffect stays factual", () => {
	assert.deepEqual(nextActionsForExecutionEffect({ mutations: 0, settled: true, navigated: false, visibleDelta: 0, interactiveDelta: 0 }), undefined);
	assert.deepEqual(nextActionsForExecutionEffect({ mutations: 0, settled: true, navigated: true, visibleDelta: 0, interactiveDelta: 0 }), [
		"tab identity may have changed; list/switch tabs before the next tab-scoped call if targeting is ambiguous",
	]);
});
