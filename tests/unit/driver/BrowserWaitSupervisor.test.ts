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
			assert.deepEqual(error.details.supervisor.temporal, {
				verdict: { status: "unknown", confidence: "partial", reasons: ["no_ack"] },
				frontier: { next: "retry_same_wait" },
			});
			return true;
		},
	);
});

test("BrowserWaitSupervisor uses URL-aware navigation wait after navigateAndWait", async () => {
	const commands: Record<string, unknown>[] = [];
	let navigationWaitAttempts = 0;
	const server = {
		snapshot() { return { extension: { workerBootId: "boot-url" } }; },
		async sendCommand(command: Record<string, unknown>) {
			commands.push(command);
			if (command.cmd === "wait.navigate") {
				return { acknowledged: true, data: { frameId: "frame-1", bridge: { workerBootId: "boot-url" } } };
			}
			if (command.cmd === "wait.navigation") {
				navigationWaitAttempts += 1;
				assert.equal(command.targetUrl, "https://example.test/new");
				assert.equal(command.waitUntil, "complete");
				if (navigationWaitAttempts === 1) {
					return { acknowledged: true, data: { ok: false, error_code: "TIMEOUT", error: "old page still complete" } };
				}
				return { acknowledged: true, data: { url: "https://example.test/new", stage: "complete", bridge: { workerBootId: "boot-url" } } };
			}
			throw new Error(`unexpected command ${String(command.cmd)}`);
		},
	} as unknown as BrowserBridgeServer;

	const result = await executeBrowserWaitWithSupervisor(server, { cmd: "wait.navigateAndWait", url: "https://example.test/new", state: "complete", timeoutMs: 500 }, { tabId: 101, timeoutMs: 500 });

	assert.equal(result.data && typeof result.data === "object" && (result.data as Record<string, any>).wait.url, "https://example.test/new");
	assert.equal(commands.some((command) => command.cmd === "wait.loadState"), false, "navigateAndWait must not use URL-blind loadState after navigation");
	assert.equal(commands.filter((command) => command.cmd === "wait.navigation").length, 2, "URL wait should retry timeout leases until the target URL loads");
	assert.equal((result.data as Record<string, any>).supervisor.leases[0].status, "lease_timeout");
	assert.equal((result.data as Record<string, any>).supervisor.leases.at(-1).status, "success");
	assert.equal((result.data as Record<string, any>).supervisor.temporal.verdict.reasons[0], "same_wait_history");
	assert.equal(result.diagnostics?.temporalProfile && (result.diagnostics.temporalProfile as Record<string, any>).waitAttempts, 2);
});

test("BrowserWaitSupervisor runs selector waits only after target URL commit", async () => {
	const commands: Record<string, unknown>[] = [];
	const server = {
		snapshot() { return { extension: { workerBootId: "boot-selector" } }; },
		async sendCommand(command: Record<string, unknown>) {
			commands.push(command);
			if (command.cmd === "wait.navigate") return { acknowledged: true, data: { bridge: { workerBootId: "boot-selector" } } };
			if (command.cmd === "wait.navigation") {
				assert.equal(command.targetUrl, "https://example.test/form");
				assert.equal(command.waitUntil, "commit");
				return { acknowledged: true, data: { url: "https://example.test/form", stage: "commit", bridge: { workerBootId: "boot-selector" } } };
			}
			if (command.cmd === "wait.selector") {
				assert.equal(command.selector, "#ready");
				return { acknowledged: true, data: { selector: "#ready", visible: true, bridge: { workerBootId: "boot-selector" } } };
			}
			throw new Error(`unexpected command ${String(command.cmd)}`);
		},
	} as unknown as BrowserBridgeServer;

	const result = await executeBrowserWaitWithSupervisor(server, { cmd: "wait.navigateAndWait", url: "https://example.test/form", state: "selector", selector: "#ready", timeoutMs: 500 }, { tabId: 101, timeoutMs: 500 });

	assert.deepEqual(commands.map((command) => command.cmd), ["wait.navigate", "wait.navigation", "wait.selector"]);
	assert.equal((result.data as Record<string, any>).urlWait.url, "https://example.test/form");
	assert.equal((result.data as Record<string, any>).wait.selector, "#ready");
});
