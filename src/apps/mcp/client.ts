import { controlRequest, ensureDaemon, type DaemonInfo } from "../daemon/daemonControl.js";
import { localDaemonContractIdentity } from "../daemon/contractIdentity.js";
import type { BrowserCommandResult } from "../../commands/commandDefinition.js";

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
	return error && typeof error === "object" && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function rejectedBeforeDispatch(response: { status: number; json?: Record<string, unknown> }): boolean {
	return response.status === 401 || (response.status === 409 && response.json?.code === "DAEMON_CONTRACT_MISMATCH");
}

export async function invokeDaemonTool(tool: string, params: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<McpToolResult> {
	const requestedTimeoutMs = Number(params.timeoutMs);
	const transportTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
		? Math.min(310_000, Math.max(120_000, Math.floor(requestedTimeoutMs) + 10_000))
		: 120_000;
	const body = { tool, params, cwd, contractIdentity: localDaemonContractIdentity() };
	const request = (daemon: DaemonInfo) => controlRequest(daemon, "POST", "/invoke", body, transportTimeoutMs, {
		...(signal ? { signal } : {}),
	});
	let daemon = await currentDaemon();
	let response;
	try {
		response = await request(daemon);
	} catch (error) {
		const code = transportErrorCode(error);
		if (code && ["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code)) invalidateDaemon(daemon);
		if (code !== "ECONNREFUSED") throw error;
		daemon = await currentDaemon();
		response = await request(daemon);
	}
	if (rejectedBeforeDispatch(response)) {
		invalidateDaemon(daemon);
		response = await request(await currentDaemon());
	}
	const json = response.json;
	if (response.status !== 200 || !json || json.ok === false) {
		return {
			content: [{ type: "text", text: JSON.stringify(json ?? { error: `daemon /invoke failed (HTTP ${response.status})` }) }],
				details: json,
				isError: true,
				terminate: true,
		};
	}
	return {
		content: Array.isArray(json.content) ? json.content as McpToolResult["content"] : [],
		details: json.details && typeof json.details === "object" ? json.details as Record<string, unknown> : undefined,
		isError: json.isError === true,
		terminate: json.terminate === true,
	};
}
