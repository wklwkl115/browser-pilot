import test from "node:test";
import assert from "node:assert/strict";
import { computeBridgeGraceMs, computeReconnectBudgetMs, executeBrowserWaitWithSupervisor } from "../../../src/driver/BrowserWaitSupervisor.ts";
import { BrowserBridgeError } from "../../../src/driver/errors.ts";
import type { BrowserBridgeServer } from "../../../src/driver/BrowserBridgeServer.ts";

test("BrowserWaitSupervisor computes smaller bridge grace for tight remaining deadlines", () => {
	assert.equal(computeBridgeGraceMs(2_000), 400);
	assert.equal(computeBridgeGraceMs(100), 50);
	assert.equal(computeBridgeGraceMs(0), 0);
});

test("BrowserWaitSupervisor caps bridge grace and reconnect budget for large deadlines", () => {
	assert.equal(computeBridgeGraceMs(30_000), 3_000);
	assert.equal(computeReconnectBudgetMs(30_000), 6_000);
	assert.equal(computeReconnectBudgetMs(100_000), 10_000);
});

test("BrowserWaitSupervisor reconnect budget never exceeds remaining deadline", () => {
	assert.equal(computeReconnectBudgetMs(40), 40);
	assert.equal(computeReconnectBudgetMs(250), 50);
	assert.equal(computeReconnectBudgetMs(2_000), 400);
});

test("BrowserWaitSupervisor maps navigateAndWait navigation bridge timeouts to wait diagnostics", async () => {
	let sent = 0;
	const server = {
		snapshot() { return { extension: { workerBootId: "boot-nav" } }; },
		async sendCommand(command: Record<string, unknown>) {
			sent += 1;
			assert.equal(command.cmd, "wait.navigate");
			throw new BrowserBridgeError("BRIDGE_TIMEOUT", "No browser response in 195ms (no ACK)", { acked: false });
		},
	} as unknown as BrowserBridgeServer;

	await assert.rejects(
		executeBrowserWaitWithSupervisor(server, { cmd: "wait.navigateAndWait", url: "https://example.test/slow", state: "complete", timeoutMs: 120 }, { tabId: 101, timeoutMs: 120 }),
		(error) => {
			assert.equal(error.code, "WAIT_TIMEOUT");
			assert.equal(sent, 1);
			assert.equal(error.details.supervisor.command, "wait.navigateAndWait");
			assert.equal(error.details.supervisor.totalTimeoutMs, 120);
			assert.deepEqual(error.details.supervisor.leases, []);
			assert.equal(error.details.supervisor.navigation.status, "bridge_timeout");
			assert.equal(error.details.supervisor.navigation.errorCode, "BRIDGE_TIMEOUT");
			return true;
		},
	);
});
