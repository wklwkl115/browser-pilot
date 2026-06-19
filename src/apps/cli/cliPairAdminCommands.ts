import { parseArgs, type FlagSpec } from "./flags.js";
import { renderUsageError, writeJsonEnvelope, EXIT } from "./render.js";
import { controlRequest, ensureDaemon } from "../daemon/daemonControl.js";
import type { PairingsResponse, RevokeResponse } from "../daemon/authTypes.js";
import { jsonMode, renderMode } from "./cliBasics.js";
import { pad } from "./help.js";

export async function runRevokeCommand(argv: string[]): Promise<number> {
	const mode = jsonMode(argv);
	const parsed = parseArgs(revokeSpecs(), argv);
	if (!parsed.ok) return renderUsageError(parsed.error, renderMode(parsed.globals));
	if (parsed.value.globals.help) return revokeHelp();
	const pairingId = String(parsed.value.params.pairingId ?? "");
	if (!pairingId) return renderUsageError("--pairing-id is required", mode);
	const info = await ensurePairAdminDaemon("revoke", mode);
	if (typeof info === "number") return info;
	try {
		const { status, json } = await controlRequest(info, "POST", "/revoke", { pairingId });
		if (status === 404 || json?.code === "PAIRING_NOT_FOUND") return renderPairAdminFailure("revoke", mode, `pairingId "${pairingId}" not found`, EXIT.toolError, "PAIRING_NOT_FOUND", pairingId);
		if (status !== 200 || !json || json.ok !== true) return renderPairAdminFailure("revoke", mode, typeof json?.error === "string" ? json.error : `POST /revoke failed (HTTP ${status})`, EXIT.toolError, "CLI_REVOKE_FAILED", pairingId);
		const typed = json as unknown as RevokeResponse;
		if (mode === "json") writeJsonEnvelope({ ok: true, exitCode: EXIT.ok, command: "revoke", revoked: typed.revoked });
		else process.stdout.write(`revoked: ${typed.revoked}\n`);
		return EXIT.ok;
	} catch (error) {
		return renderPairAdminFailure("revoke", mode, error instanceof Error ? error.message : String(error), EXIT.toolError, "CLI_REVOKE_FAILED", pairingId);
	}
}

export async function runPairingsCommand(argv: string[]): Promise<number> {
	const mode = jsonMode(argv);
	const parsed = parseArgs([], argv);
	if (!parsed.ok) return renderUsageError(parsed.error, renderMode(parsed.globals));
	if (parsed.value.globals.help) return pairingsHelp();
	const info = await ensurePairAdminDaemon("pairings", mode);
	if (typeof info === "number") return info;
	try {
		const { status, json } = await controlRequest(info, "GET", "/pairings");
		if (status !== 200 || !json || json.ok !== true) return renderPairAdminFailure("pairings", mode, typeof json?.error === "string" ? json.error : `GET /pairings failed (HTTP ${status})`, EXIT.toolError, "CLI_PAIRINGS_FAILED");
		const agents = (json as unknown as PairingsResponse).agents ?? [];
		if (mode === "json") writeJsonEnvelope({ ok: true, exitCode: EXIT.ok, command: "pairings", agents });
		else renderPairingsText(agents);
		return EXIT.ok;
	} catch (error) {
		return renderPairAdminFailure("pairings", mode, error instanceof Error ? error.message : String(error), EXIT.toolError, "CLI_PAIRINGS_FAILED");
	}
}

function revokeSpecs(): FlagSpec[] {
	return [{ name: "pairingId", flag: "--pairing-id", kind: "string", required: true, description: "The pairingId to revoke." }];
}

function revokeHelp(): number {
	process.stdout.write("browser-pilot revoke --pairing-id <id> [--json]\n\nRevoke a paired agent by pairingId.\n\nFlags:\n  --pairing-id <string>   The pairingId returned by 'pair' (required).\n  --json | --text\n");
	return EXIT.ok;
}

function pairingsHelp(): number {
	process.stdout.write("browser-pilot pairings [--json]\n\nList all paired agents and their current lease status.\n\nFlags:\n  --json | --text\n");
	return EXIT.ok;
}

async function ensurePairAdminDaemon(command: "revoke" | "pairings", mode: ReturnType<typeof jsonMode>) {
	try {
		return await ensureDaemon();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return renderPairAdminFailure(command, mode, `daemon unavailable — ${message}`, EXIT.unavailable, "CLI_DAEMON_UNAVAILABLE");
	}
}

function renderPairAdminFailure(command: string, mode: ReturnType<typeof jsonMode>, message: string, exitCode: number, code: string, pairingId?: string): number {
	if (mode === "json") writeJsonEnvelope({ ok: false, exitCode, code, command, ...(pairingId ? { pairingId } : {}), message });
	else process.stderr.write(`${command} failed: ${message}\n`);
	return exitCode;
}

function renderPairingsText(agents: PairingsResponse["agents"]): void {
	if (!agents.length) {
		process.stdout.write("no paired agents\n");
		return;
	}
	for (const agent of agents) {
		const lease = agent.leaseHeld ? " [lease]" : "";
		process.stdout.write(`${pad(agent.label, 20)}${pad(agent.status, 10)}${pad(agent.pairingId, 38)}${lease}\n`);
	}
}
