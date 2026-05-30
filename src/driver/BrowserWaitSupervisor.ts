import { randomUUID } from "node:crypto";
import { isRecord } from "../utils/records";
import { BrowserBridgeError } from "./errors";
import type { BrowserBridgeServer } from "./BrowserBridgeServer";
import type { BrowserBridgeExecutionResult } from "./types";
import type { BridgeCommand } from "../protocol/nativeProtocol";

const WAIT_LEASE_MAX_MS = 25_000;
const WAIT_LEASE_BRIDGE_GRACE_MS = 3_000;
const WAIT_LEASE_TIMEOUT_RETRY_BACKOFF_MS = 50;
const DEFAULT_WAIT_TIMEOUT_MS = 35_000;
const WAIT_TIMEOUT_CODES = new Set(["TIMEOUT", "NAVIGATION_TIMEOUT", "SELECTOR_TIMEOUT", "NETWORK_IDLE_TIMEOUT", "NETWORK_RECORDER_TIMEOUT"]);
const SUPERVISED_WAIT_COMMANDS = new Set(["wait.navigation", "wait.loadState", "wait.networkIdle", "wait.selector", "wait.any", "wait.all", "network.wait"]);

type WaitLeaseSummary = {
	attempt: number;
	timeoutMs: number;
	workerBootId?: string;
	workerBootIdAfter?: string;
	status: "success" | "late_success" | "lease_timeout" | "disconnect" | "bridge_timeout" | "failed";
	errorCode?: string;
	message?: string;
	retryDelayMs?: number;
};

type WaitSupervisorState = {
	waitId: string;
	command: string;
	startedAt: number;
	deadline: number;
	totalTimeoutMs: number;
	initialWorkerBootId?: string;
	workerBootId?: string;
	workerRestarts: number;
	historyLost: boolean;
	leases: WaitLeaseSummary[];
};

function waitTimeoutMs(value: unknown, fallback: number, allowZero = false): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	if (allowZero && n === 0) return 0;
	if (n <= 0) return fallback;
	return Math.max(1, Math.ceil(n));
}

function commandTimeoutMs(command: BridgeCommand, fallback: number): number {
	return waitTimeoutMs(command.timeoutMs ?? command.timeout_ms ?? command.timeout, fallback, true);
}

function waitUntilForNavigateAndWait(command: BridgeCommand): string {
	return String(command.waitUntil ?? command.wait_until ?? command.state ?? "load").toLowerCase().replace(/_/g, "");
}

function waitCommandForNavigateAndWait(command: BridgeCommand): BridgeCommand {
	const waitUntil = waitUntilForNavigateAndWait(command);
	const { url: _url, cmd: _cmd, ...rest } = command;
	if (waitUntil === "networkidle") return { ...rest, cmd: "wait.networkIdle" };
	if (waitUntil === "selector") return { ...rest, cmd: "wait.selector" };
	const state = waitUntil === "load" ? "complete" : waitUntil;
	return { ...rest, cmd: "wait.loadState", state };
}

function bridgeErrorCode(error: unknown): string | undefined {
	if (error instanceof BrowserBridgeError) {
		const result = isRecord(error.details.result) ? error.details.result : undefined;
		if (typeof result?.error_code === "string") return result.error_code;
		const resultDetails = isRecord(result?.details) ? result.details : undefined;
		if (typeof resultDetails?.error_code === "string") return resultDetails.error_code;
		if (typeof error.details.error === "string" && WAIT_TIMEOUT_CODES.has(error.details.error)) return error.details.error;
		return error.code;
	}
	return undefined;
}

function bridgeErrorResult(error: unknown): Record<string, unknown> | undefined {
	return error instanceof BrowserBridgeError && isRecord(error.details.result) ? error.details.result : undefined;
}

function bridgeErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isLeaseTimeout(error: unknown): boolean {
	const code = bridgeErrorCode(error);
	if (code && WAIT_TIMEOUT_CODES.has(code)) return true;
	const result = bridgeErrorResult(error);
	const text = `${bridgeErrorMessage(error)} ${typeof result?.error === "string" ? result.error : ""}`;
	return /\btimeout|timed out\b/i.test(text);
}

function workerBootIdFromResult(result: BrowserBridgeExecutionResult): string | undefined {
	const data = isRecord(result.data) ? result.data : undefined;
	const bridge = isRecord(data?.bridge) ? data.bridge : undefined;
	return typeof bridge?.workerBootId === "string" ? bridge.workerBootId : undefined;
}

function currentWorkerBootId(server: BrowserBridgeServer): string | undefined {
	return server.snapshot().extension?.workerBootId;
}

function compactResultData(data: unknown, supervisor: Record<string, unknown>): unknown {
	if (isRecord(data)) return { ...data, supervisor };
	return { value: data, supervisor };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function supervisorPayload(state: WaitSupervisorState): Record<string, unknown> {
	return {
		durable: true,
		waitId: state.waitId,
		command: state.command,
		totalTimeoutMs: state.totalTimeoutMs,
		elapsedMs: Date.now() - state.startedAt,
		attempts: state.leases.length,
		workerRestarts: state.workerRestarts,
		historyLost: state.historyLost,
		initialWorkerBootId: state.initialWorkerBootId,
		workerBootId: state.workerBootId,
		leases: state.leases,
	};
}

async function waitForReconnect(server: BrowserBridgeServer, previousClientId: string | undefined, remainingMs: number): Promise<void> {
	const timeoutMs = Math.max(250, Math.min(10_000, remainingMs));
	await server.waitForExtensionReconnect(previousClientId, timeoutMs);
}

function rememberWorkerTransition(state: WaitSupervisorState, before: string | undefined, after: string | undefined): void {
	if (after) state.workerBootId = after;
	if (before && after && before !== after) {
		state.workerRestarts += 1;
		state.historyLost = true;
	}
}

function finalWaitError(state: WaitSupervisorState, message: string): BrowserBridgeError {
	const code = state.historyLost ? "WAIT_STATE_LOST" : "WAIT_TIMEOUT";
	return new BrowserBridgeError(code, message, { supervisor: supervisorPayload(state) });
}

type WaitRunClock = {
	startedAt?: number;
	deadline?: number;
	totalTimeoutMs?: number;
	command?: string;
};

async function runLeasedWait(server: BrowserBridgeServer, command: BridgeCommand, options: { browserSessionId?: string; tabId?: number | string; timeoutMs?: number }, totalTimeoutMs: number, clock: WaitRunClock = {}): Promise<BrowserBridgeExecutionResult> {
	const waitId = String(command.waitId ?? command.wait_id ?? `pi_ts_wait_${randomUUID()}`);
	const startedAt = clock.startedAt ?? Date.now();
	const state: WaitSupervisorState = {
		waitId,
		command: clock.command ?? command.cmd,
		startedAt,
		deadline: clock.deadline ?? startedAt + totalTimeoutMs,
		totalTimeoutMs: clock.totalTimeoutMs ?? totalTimeoutMs,
		initialWorkerBootId: currentWorkerBootId(server),
		workerBootId: currentWorkerBootId(server),
		workerRestarts: 0,
		historyLost: false,
		leases: [],
	};

	if (totalTimeoutMs === 0) {
		const attempt = 1;
		const beforeSnapshot = server.snapshot();
		const beforeBootId = beforeSnapshot.extension?.workerBootId;
		const immediateCommand: BridgeCommand = { ...command, waitId, wait_id: waitId, timeoutMs: 0 };
		delete immediateCommand.timeout_ms;
		delete immediateCommand.timeout;
		try {
			const result = await server.sendCommand(immediateCommand, { ...options, timeoutMs: WAIT_LEASE_BRIDGE_GRACE_MS });
			const afterBootId = workerBootIdFromResult(result) ?? currentWorkerBootId(server);
			rememberWorkerTransition(state, beforeBootId, afterBootId);
			state.leases.push({ attempt, timeoutMs: 0, workerBootId: beforeBootId, workerBootIdAfter: afterBootId, status: "success" });
			return { ...result, data: compactResultData(result.data, supervisorPayload(state)) };
		} catch (error) {
			const afterBootId = currentWorkerBootId(server);
			rememberWorkerTransition(state, beforeBootId, afterBootId);
			const errorCode = bridgeErrorCode(error);
			const status = error instanceof BrowserBridgeError && error.code === "BRIDGE_CLIENT_DISCONNECTED" ? "disconnect"
				: error instanceof BrowserBridgeError && error.code === "BRIDGE_TIMEOUT" ? "bridge_timeout"
					: isLeaseTimeout(error) ? "lease_timeout" : "failed";
			state.leases.push({ attempt, timeoutMs: 0, workerBootId: beforeBootId, workerBootIdAfter: afterBootId, status, errorCode, message: bridgeErrorMessage(error) });
			if (error instanceof BrowserBridgeError) throw new BrowserBridgeError(error.code, error.message, { ...error.details, supervisor: supervisorPayload(state) });
			throw error;
		}
	}

	while (Date.now() < state.deadline) {
		const remainingMs = Math.max(1, state.deadline - Date.now());
		const leaseMs = Math.max(50, Math.min(WAIT_LEASE_MAX_MS, remainingMs));
		const attempt = state.leases.length + 1;
		const beforeSnapshot = server.snapshot();
		const beforeBootId = beforeSnapshot.extension?.workerBootId;
		const leaseCommand: BridgeCommand = { ...command, waitId, wait_id: waitId, timeoutMs: leaseMs };
		delete leaseCommand.timeout_ms;
		delete leaseCommand.timeout;
		try {
			const result = await server.sendCommand(leaseCommand, { ...options, timeoutMs: leaseMs + WAIT_LEASE_BRIDGE_GRACE_MS });
			const afterBootId = workerBootIdFromResult(result) ?? currentWorkerBootId(server);
			rememberWorkerTransition(state, beforeBootId, afterBootId);
			const completedAt = Date.now();
			if (completedAt > state.deadline) {
				state.leases.push({ attempt, timeoutMs: leaseMs, workerBootId: beforeBootId, workerBootIdAfter: afterBootId, status: "late_success" });
				throw finalWaitError(state, "browser wait completed after total timeout deadline");
			}
			state.leases.push({ attempt, timeoutMs: leaseMs, workerBootId: beforeBootId, workerBootIdAfter: afterBootId, status: "success" });
			return { ...result, data: compactResultData(result.data, supervisorPayload(state)) };
		} catch (error) {
			if (error instanceof BrowserBridgeError && (error.code === "WAIT_TIMEOUT" || error.code === "WAIT_STATE_LOST")) throw error;
			const afterBootId = currentWorkerBootId(server);
			rememberWorkerTransition(state, beforeBootId, afterBootId);
			const errorCode = bridgeErrorCode(error);
			if (isLeaseTimeout(error)) {
				const retryDelayMs = Math.min(WAIT_LEASE_TIMEOUT_RETRY_BACKOFF_MS, Math.max(0, state.deadline - Date.now()));
				state.leases.push({ attempt, timeoutMs: leaseMs, workerBootId: beforeBootId, workerBootIdAfter: afterBootId, status: "lease_timeout", errorCode, message: bridgeErrorMessage(error), retryDelayMs: retryDelayMs || undefined });
				if (retryDelayMs > 0) await sleep(retryDelayMs);
				if (Date.now() < state.deadline) continue;
				throw finalWaitError(state, bridgeErrorMessage(error) || "browser wait timed out");
			}
			if (error instanceof BrowserBridgeError && error.code === "BRIDGE_CLIENT_DISCONNECTED") {
				state.historyLost = true;
				state.leases.push({ attempt, timeoutMs: leaseMs, workerBootId: beforeBootId, workerBootIdAfter: afterBootId, status: "disconnect", errorCode: error.code, message: error.message });
				await waitForReconnect(server, beforeSnapshot.extension?.id, Math.max(1, state.deadline - Date.now()));
				const reconnectedBootId = currentWorkerBootId(server);
				rememberWorkerTransition(state, beforeBootId, reconnectedBootId);
				continue;
			}
			if (error instanceof BrowserBridgeError && error.code === "BRIDGE_TIMEOUT") {
				state.historyLost = true;
				state.leases.push({ attempt, timeoutMs: leaseMs, workerBootId: beforeBootId, workerBootIdAfter: afterBootId, status: "bridge_timeout", errorCode: error.code, message: error.message });
				throw finalWaitError(state, "browser wait state was not recoverable after bridge timeout");
			}
			state.leases.push({ attempt, timeoutMs: leaseMs, workerBootId: beforeBootId, workerBootIdAfter: afterBootId, status: "failed", errorCode, message: bridgeErrorMessage(error) });
			if (error instanceof BrowserBridgeError) {
				throw new BrowserBridgeError(error.code, error.message, { ...error.details, supervisor: supervisorPayload(state) });
			}
			throw error;
		}
	}
	throw finalWaitError(state, "browser wait timed out");
}

export async function executeBrowserWaitWithSupervisor(server: BrowserBridgeServer, command: BridgeCommand, options: { browserSessionId?: string; tabId?: number | string; timeoutMs?: number } = {}): Promise<BrowserBridgeExecutionResult> {
	const totalTimeoutMs = commandTimeoutMs(command, waitTimeoutMs(options.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, true));
	if (totalTimeoutMs === 0 && (command.cmd === "wait.navigateAndWait" || SUPERVISED_WAIT_COMMANDS.has(command.cmd))) return runLeasedWait(server, command, options, 0);
	if (command.cmd === "wait.navigateAndWait") {
		const startedAt = Date.now();
		const deadline = startedAt + totalTimeoutMs;
		const waitUntil = waitUntilForNavigateAndWait(command);
		const navigationTimeoutMs = Math.min(totalTimeoutMs, WAIT_LEASE_MAX_MS);
		const navigation = await server.sendCommand({ ...command, cmd: "wait.navigate", timeoutMs: navigationTimeoutMs }, { ...options, timeoutMs: navigationTimeoutMs + WAIT_LEASE_BRIDGE_GRACE_MS });
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			const state: WaitSupervisorState = {
				waitId: String(command.waitId ?? command.wait_id ?? `pi_ts_wait_${randomUUID()}`),
				command: command.cmd,
				startedAt,
				deadline,
				totalTimeoutMs,
				initialWorkerBootId: currentWorkerBootId(server),
				workerBootId: currentWorkerBootId(server),
				workerRestarts: 0,
				historyLost: false,
				leases: [],
			};
			throw finalWaitError(state, "wait.navigateAndWait timed out after navigation before wait phase");
		}
		const waitResult = await runLeasedWait(server, waitCommandForNavigateAndWait(command), options, remainingMs, { startedAt, deadline, totalTimeoutMs, command: command.cmd });
		const waitData = isRecord(waitResult.data) ? waitResult.data : { value: waitResult.data };
		const supervisor = isRecord(waitData.supervisor) ? waitData.supervisor : {};
		const { supervisor: _nestedSupervisor, ...wait } = waitData;
		return { ...waitResult, data: { navigation: navigation.data, wait, url: command.url, waitUntil, supervisor } };
	}
	if (!SUPERVISED_WAIT_COMMANDS.has(command.cmd)) return server.sendCommand(command, options);
	return runLeasedWait(server, command, options, totalTimeoutMs);
}
