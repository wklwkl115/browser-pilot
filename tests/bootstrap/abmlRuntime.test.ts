import assert from "node:assert/strict";
import test from "node:test";
import { executeBrowserAbmlRead, type AbmlBrowserRuntimeServer } from "../../src/browser-runtime/abml/runtime.ts";
import type { BrowserBridgeExecutionResult } from "../../src/ports/BrowserRuntimeTypes.ts";

function result(data: Record<string, unknown>): BrowserBridgeExecutionResult {
	return { id: "runtime", acknowledged: true, data };
}

function runtimeServer(sendCommand: AbmlBrowserRuntimeServer["sendCommand"]): AbmlBrowserRuntimeServer {
	return {
		sendCommand,
		snapshot: () => ({ browserSessionId: "session-1", host: "127.0.0.1", port: 18765, running: true, connectedClients: 1, extensionConnected: true, clients: [], defaultTabId: 7, selectionVersion: 1, tabs: [], pending: [] }),
		createObservationSnapshot: (snapshot) => ({ ...snapshot, snapshotId: "snapshot-1", expired: false, ttlMs: 60_000 }),
	};
}

test("ABML stream reads report inactive recorders without issuing list commands", async () => {
	const commands: string[] = [];
	const server = runtimeServer(async (command) => {
		commands.push(command.cmd);
		return result({ active: false });
	});
	const read = await executeBrowserAbmlRead(server, { plane: "network" });
	assert.equal(read.ok, true);
	assert.deepEqual(read.ok ? read.data : undefined, { plane: "network", mode: "stream", unavailable: "network recorder not active; use browser_command network.start", recorderActive: false });
	assert.deepEqual(commands, ["network.status"]);
});

test("ABML event streams arm at high-water and drain only newer redacted events", async () => {
	const commands: string[] = [];
	const server = runtimeServer(async (command) => {
		commands.push(command.cmd);
		if (command.cmd === "hook.status") return result({ last_seq: 10 });
		return result({ events: [
			{ seq: 10, type: "old", message: "old event" },
			{ seq: 11, type: "click", message: "clicked submit" },
			{ seq: 12, type: "input", message: "typed value" },
		] });
	});
	const armed = await executeBrowserAbmlRead(server, { plane: "event" });
	assert.equal(armed.ok, true);
	const captureRef = armed.ok ? String(armed.data?.captureRef) : "";
	assert.match(captureRef, /^bp-ref:\/\/signal\//);
	const drained = await executeBrowserAbmlRead(server, { plane: "event", ref: captureRef });
	assert.equal(drained.ok, true);
	assert.deepEqual(drained.ok ? drained.entities?.map((entity) => [entity.name, entity.value]) : undefined, [["click", "clicked submit"], ["input", "typed value"]]);
	assert.deepEqual(drained.ok ? { sinceSeq: drained.data?.sinceSeq, cursor: drained.data?.cursor, eventCount: drained.data?.eventCount } : undefined, { sinceSeq: 10, cursor: 12, eventCount: 2 });
	assert.deepEqual(commands, ["hook.status", "hook.status", "hook.collect"]);
});
