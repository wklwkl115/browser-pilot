/**
 * CLI execution client — ensures the singleton daemon is up, then delegates a
 * single tool invocation to it over the loopback control channel.
 *
 * Only execution is delegated; parsing/help/registry stay local (no browser
 * startup). The caller `cwd` (process.cwd()) is sent on every /invoke so the
 * daemon scopes artifacts/memory to the caller, not to itself.
 */
import { ensureDaemon, controlRequest } from "./daemonControl.js";
import { resolvePairingToken } from "./pairing.js";
import { CLI_LEASE_BUSY } from "./authTypes.js";
import type { ToolResultLike } from "./render.js";

/** Daemon/bridge unavailable — maps to EXIT.unavailable at the dispatch layer. */
export class DaemonUnavailableError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function publicDaemonDiagnostics(json: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!json) return {};
	const details = isRecord(json.details) ? json.details : undefined;
	return {
		daemon: json,
		...(details ? { details } : {}),
	};
}

function daemonInvokeErrorResult(status: number, json: Record<string, unknown> | undefined, tool: string, cli?: Record<string, unknown>): ToolResultLike {
	const message = typeof json?.error === "string" ? json.error : `daemon /invoke failed (HTTP ${status})`;
	const command = typeof cli?.command === "string" ? cli.command : tool.replace(/^browser_/, "").replace(/_/g, "-");
	const schemaCommand = `browser-pilot schema ${command} --json`;
	const validateCommand = `browser-pilot validate ${command} --params @params.json --json`;
	const nextActions = [
		schemaCommand,
		validateCommand,
		"browser-pilot doctor --json",
		"browser-pilot daemon status --json",
	];
	return {
		content: [{
			type: "text",
			text: JSON.stringify({
				ok: false,
				code: "CLI_DAEMON_INVOKE_ERROR",
				message,
				status,
				taxonomy: { domain: "cli", category: "daemon-invoke", retryable: false, source: "cli" },
				diagnostics: { ...publicDaemonDiagnostics(json), nextActions },
				recovery: {
					hint: "Check the command parameters against the current daemon tool contract and daemon readiness.",
					commands: [
						{ command: schemaCommand, argv: ["browser-pilot", "schema", command, "--json"], purpose: "inspect the current CLI parameter schema" },
						{ command: validateCommand, argv: ["browser-pilot", "validate", command, "--params", "@params.json", "--json"], purpose: "validate a file-backed params object without invoking the daemon" },
						{ command: "browser-pilot doctor --json", argv: ["browser-pilot", "doctor", "--json"], purpose: "inspect CLI, daemon, bridge, and extension readiness" },
						{ command: "browser-pilot daemon status --json", argv: ["browser-pilot", "daemon", "status", "--json"], purpose: "inspect daemon version and bridge state" },
					],
					nextActions,
				},
			}),
		}],
		terminate: true,
	};
}

function leaseBusyErrorResult(json: Record<string, unknown> | undefined, _tool: string): ToolResultLike {
	const heldBy = isRecord(json?.heldBy) ? (json!.heldBy as { label?: string; pairingId?: string; since?: string }) : undefined;
	const holderLabel = typeof heldBy?.label === "string" ? heldBy.label : undefined;
	const message = holderLabel
		? `command call blocked: lease held by "${holderLabel}"`
		: "command call blocked: another agent holds the browser lease";
	return {
		content: [{
			type: "text",
			text: JSON.stringify({
				ok: false,
				code: CLI_LEASE_BUSY,
				message,
				taxonomy: { domain: "cli", category: "lease", retryable: true, source: "cli" },
				heldBy: heldBy ?? null,
				recovery: {
					hint: "Wait for the current lease holder to release, or use `browser-pilot lease release` if you are the holder.",
					commands: [
						{ command: "browser-pilot lease status --json", argv: ["browser-pilot", "lease", "status", "--json"], purpose: "inspect the current lease holder" },
						{ command: "browser-pilot pairings --json", argv: ["browser-pilot", "pairings", "--json"], purpose: "list all paired agents" },
					],
				},
			}),
		}],
		terminate: true,
	};
}

export async function invokeTool(tool: string, params: Record<string, unknown>, cwd: string, cli?: Record<string, unknown>): Promise<ToolResultLike> {
	let info;
	try {
		info = await ensureDaemon();
	} catch (error) {
		throw new DaemonUnavailableError(error instanceof Error ? error.message : String(error));
	}
	const pairingToken = resolvePairingToken();
	let response;
	try {
		response = await controlRequest(
			info,
			"POST",
			"/invoke",
			{ tool, params, cwd, ...(cli ? { cli } : {}) },
			120_000,
			pairingToken ? { pairingToken } : undefined,
		);
	} catch (error) {
		throw new DaemonUnavailableError(error instanceof Error ? error.message : String(error));
	}
	const { status, json } = response;
	// 409 LEASE_BUSY: the daemon rejects this invocation because another agent holds the lease
	if (status === 409 && typeof json?.code === "string" && json.code === "LEASE_BUSY") {
		return leaseBusyErrorResult(json, tool);
	}
	if (status !== 200 || !json || json.ok === false) return daemonInvokeErrorResult(status, json, tool, cli);
	return {
		content: Array.isArray(json.content) ? (json.content as ToolResultLike["content"]) : [],
		details: typeof json.details === "object" && json.details ? (json.details as Record<string, unknown>) : undefined,
		terminate: json.terminate === true,
	};
}
