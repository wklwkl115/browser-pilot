import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserRuntimeRecoveryArtifacts } from "../../../src/driver/BrowserRuntimeRecoveryArtifacts.ts";

test("BrowserRuntimeRecoveryArtifacts writes runtime recovery and network/intercept event jsonl", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-runtime-recovery-artifacts-"));
	await mkdir(path.join(cwd, ".pi", "browser-artifacts"), { recursive: true });
	const artifacts = new BrowserRuntimeRecoveryArtifacts(cwd);
	artifacts.recordRuntimeRecovery(
		{ id: "browser-1", extensionId: "ext-1", connectedAt: Date.now(), lastSeenAt: Date.now() },
		{ workerBootId: "boot-1", runtimeRecovery: { ranAt: Date.now(), recovered: 1, recoveredWithHistoryLoss: 2, lost: 3, byKind: { network: { recovered: 1, lost: 0 } } } },
	);
	artifacts.recordCommandResult(
		{ cmd: "network.status" },
		{ id: "1", acknowledged: true, tabId: 9, data: { generation: 4, recoveredAt: 123, historyLost: true, stateLost: false } },
		{ browserSessionId: "default", target: { browserSessionId: "default", tabId: 9, source: "explicit", implicit: false, selectionVersionAtDispatch: 1 }, snapshot: { browserSessionId: "default", host: "127.0.0.1", port: 1, running: true, connectedClients: 1, extensionConnected: true, extension: { id: "browser-1", extensionId: "ext-1", workerBootId: "boot-2", connectedAt: Date.now(), lastSeenAt: Date.now() }, clients: [], selectionVersion: 1, tabs: [], pending: [] } },
	);
	artifacts.recordCommandResult(
		{ cmd: "intercept.collect" },
		{ id: "2", acknowledged: true, tabId: 41, data: { generation: 7, recoveredAt: 456, historyLost: true, pausedLost: true } },
		{ browserSessionId: "default", target: { browserSessionId: "default", tabId: 41, source: "explicit", implicit: false, selectionVersionAtDispatch: 2 }, snapshot: { browserSessionId: "default", host: "127.0.0.1", port: 1, running: true, connectedClients: 1, extensionConnected: true, extension: { id: "browser-1", extensionId: "ext-1", workerBootId: "boot-3", connectedAt: Date.now(), lastSeenAt: Date.now() }, clients: [], selectionVersion: 1, tabs: [], pending: [] } },
	);
	const baseDir = path.join(cwd, ".pi", "browser-artifacts", "runtime-recovery");
	let runtimeLog = "";
	let networkLog = "";
	let interceptLog = "";
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		try {
			runtimeLog = await readFile(path.join(baseDir, "runtime-recovery.jsonl"), "utf8");
			networkLog = await readFile(path.join(baseDir, "network-events.jsonl"), "utf8");
			interceptLog = await readFile(path.join(baseDir, "intercept-events.jsonl"), "utf8");
			break;
		} catch {}
	}
	assert.ok(runtimeLog && networkLog && interceptLog, "runtime recovery artifact writer must flush all expected jsonl files");
	const runtimeEvent = JSON.parse(runtimeLog.trim().split("\n")[0]);
	const networkEvent = JSON.parse(networkLog.trim().split("\n")[0]);
	const interceptEvent = JSON.parse(interceptLog.trim().split("\n")[0]);
	assert.equal(runtimeEvent.type, "runtimeRecovery");
	assert.equal(runtimeEvent.runtimeRecovery.lost, 3);
	assert.equal(networkEvent.command, "network.status");
	assert.equal(networkEvent.generation, 4);
	assert.equal(networkEvent.historyLost, true);
	assert.equal(interceptEvent.command, "intercept.collect");
	assert.equal(interceptEvent.pausedLost, true);
	assert.equal(interceptEvent.generation, 7);
});
