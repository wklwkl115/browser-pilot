/**
 * CLI execution client — ensures the singleton daemon is up, then delegates a
 * single tool invocation to it over the loopback control channel.
 *
 * Only execution is delegated; parsing/help/registry stay local (no browser
 * startup). The caller `cwd` (process.cwd()) is sent on every /invoke so the
 * daemon scopes artifacts/memory to the caller, not to itself.
 */
import { ensureDaemon, controlRequest } from "./daemonControl.js";
import type { ToolResultLike } from "./render.js";

/** Daemon/bridge unavailable — maps to EXIT.unavailable at the dispatch layer. */
export class DaemonUnavailableError extends Error {}

export async function invokeTool(tool: string, params: Record<string, unknown>, cwd: string): Promise<ToolResultLike> {
	let info;
	try {
		info = await ensureDaemon();
	} catch (error) {
		throw new DaemonUnavailableError(error instanceof Error ? error.message : String(error));
	}
	const { status, json } = await controlRequest(info, "POST", "/invoke", { tool, params, cwd });
	if (status !== 200 || !json) throw new DaemonUnavailableError(`daemon /invoke failed (HTTP ${status})`);
	if (json.ok === false) throw new DaemonUnavailableError(String(json.error ?? "invoke failed"));
	return {
		content: Array.isArray(json.content) ? (json.content as ToolResultLike["content"]) : [],
		details: typeof json.details === "object" && json.details ? (json.details as Record<string, unknown>) : undefined,
		terminate: json.terminate === true,
	};
}
