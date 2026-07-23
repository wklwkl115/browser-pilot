import { controlRequest, ensureDaemon } from "../daemon/daemonControl.js";
import type { BrowserCommandResult } from "../../commands/commandDefinition.js";

export type McpToolResult = BrowserCommandResult;

export async function invokeDaemonTool(tool: string, params: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<McpToolResult> {
	const daemon = await ensureDaemon();
	const requestedTimeoutMs = Number(params.timeoutMs);
	const transportTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
		? Math.min(310_000, Math.max(120_000, Math.floor(requestedTimeoutMs) + 10_000))
		: 120_000;
	const response = await controlRequest(daemon, "POST", "/invoke", { tool, params, cwd }, transportTimeoutMs, {
		...(signal ? { signal } : {}),
	});
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
