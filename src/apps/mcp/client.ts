import { controlRequest, ensureDaemon, type DaemonInfo } from "../daemon/daemonControl.js";
import { localDaemonContractIdentity } from "../daemon/contractIdentity.js";
import type { BrowserCommandResult } from "../../commands/commandDefinition.js";
import { randomUUID } from "node:crypto";
import { BrowserBridgeError } from "../../utils/errors.js";
import { unknownBusiness } from "../../operations/operationRegistry.js";

export type McpToolResult = BrowserCommandResult;

let cachedDaemon: DaemonInfo | undefined;
let daemonResolution: Promise<DaemonInfo> | undefined;

async function currentDaemon(): Promise<DaemonInfo> {
	if (cachedDaemon) return cachedDaemon;
	daemonResolution ??= ensureDaemon();
	try {
		cachedDaemon = await daemonResolution;
		return cachedDaemon;
	} finally {
		daemonResolution = undefined;
	}
}

function invalidateDaemon(info: DaemonInfo): void {
	if (cachedDaemon?.controlPort === info.controlPort && cachedDaemon.token === info.token) cachedDaemon = undefined;
}

function transportErrorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function rejectedBeforeDispatch(response: { status: number; json?: Record<string, unknown> }): boolean {
	return response.status === 401 || (response.status === 409 && response.json?.code === "DAEMON_CONTRACT_MISMATCH");
}

/**
 * Tool timeouts are owned by the daemon (see commandShared.ts); the loopback transport only needs
 * to outlive the longest daemon-side budget so a slow tool never surfaces as an HTTP timeout.
 */
const TRANSPORT_TIMEOUT_MS = 120_000;

export async function invokeDaemonTool(
	tool: string,
	params: Record<string, unknown>,
	cwd: string,
	signal?: AbortSignal,
): Promise<McpToolResult> {
	const operationId = randomUUID();
	const observedOperationId =
		tool === "browser_operation" && typeof params.operationId === "string" ? params.operationId : undefined;
	const delivery = { attempted: false };
	try {
		signal?.throwIfAborted();
		return await invokeDaemonToolWithId(tool, params, cwd, operationId, delivery, signal);
	} catch (error) {
		const notDispatched =
			!observedOperationId && (!delivery.attempted || transportErrorCode(error) === "ECONNREFUSED");
		throw new BrowserBridgeError(
			"BRIDGE_CLIENT_DISCONNECTED",
			`Daemon response unavailable: ${error instanceof Error ? error.message : String(error)}`,
			{
				operation: {
					operationId: observedOperationId ?? operationId,
					execution: { status: notDispatched ? "not_dispatched" : "dispatched_unknown" },
					business: unknownBusiness(
						observedOperationId
							? "Operation observation unavailable; the original execution and business outcome remain unknown"
							: "No daemon receipt was received; browser execution and business outcome are not established",
					),
					recovery: { action: notDispatched ? "retry_after_review" : "observe_only", automaticReplay: false },
				},
			},
		);
	}
}

async function invokeDaemonToolWithId(
	tool: string,
	params: Record<string, unknown>,
	cwd: string,
	operationId: string,
	delivery: { attempted: boolean },
	signal?: AbortSignal,
): Promise<McpToolResult> {
	const transportTimeoutMs = TRANSPORT_TIMEOUT_MS;
	const body = { tool, params, cwd, operationId, contractIdentity: localDaemonContractIdentity() };
	const request = (daemon: DaemonInfo) => {
		if (!signal?.aborted) delivery.attempted = true;
		return controlRequest(daemon, "POST", "/invoke", body, transportTimeoutMs, {
			...(signal ? { signal } : {}),
		});
	};
	let daemon = await currentDaemon();
	let response;
	try {
		response = await request(daemon);
	} catch (error) {
		const code = transportErrorCode(error);
		if (code && ["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code)) invalidateDaemon(daemon);
		if (code !== "ECONNREFUSED") throw error;
		delivery.attempted = false;
		daemon = await currentDaemon();
		response = await request(daemon);
	}
	if (rejectedBeforeDispatch(response)) {
		delivery.attempted = false;
		invalidateDaemon(daemon);
		response = await request(await currentDaemon());
	}
	const json = response.json;
	if (response.status === 200 && (!json || (json.ok !== false && !Array.isArray(json.content))))
		throw new Error("Daemon returned no readable tool result; execution outcome is unknown");
	if (response.status !== 200 || !json || json.ok === false) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(json ?? { error: `daemon /invoke failed (HTTP ${response.status})` }),
				},
			],
			details: json,
			isError: true,
			terminate: true,
		};
	}
	return {
		content: Array.isArray(json.content) ? (json.content as McpToolResult["content"]) : [],
		details:
			json.details && typeof json.details === "object" ? (json.details as Record<string, unknown>) : undefined,
		isError: json.isError === true,
		terminate: json.terminate === true,
	};
}
