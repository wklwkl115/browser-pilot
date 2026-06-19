import { parseArgs, type FlagSpec } from "./flags.js";
import { renderUsageError, writeJsonEnvelope, EXIT } from "./render.js";
import { controlRequest, ensureDaemon } from "../daemon/daemonControl.js";
import { resolvePairingToken } from "./pairing.js";
import type { LeaseAction, LeaseAcquireResponse, LeaseBusyResponse, LeaseStatusResponse } from "../daemon/authTypes.js";
import { firstPositional, jsonMode, renderMode } from "./cliBasics.js";

export async function runLeaseCommand(argv: string[]): Promise<number> {
	const mode = jsonMode(argv);
	const positional = firstPositional(argv);
	const parsed = parseArgs(leaseSpecs(), positional.rest);
	if (!parsed.ok) return renderUsageError(parsed.error, renderMode(parsed.globals));
	if (parsed.value.globals.help) return leaseHelp();
	const action = leaseAction(positional.value, mode);
	if (typeof action !== "string") return action;
	const pairingToken = resolvePairingToken(typeof parsed.value.params.token === "string" ? parsed.value.params.token : undefined);
	const info = await leaseEnsureDaemon(mode);
	if (typeof info === "number") return info;
	try {
		const response = await controlRequest(info, "POST", "/lease", { action }, 10_000, pairingToken ? { pairingToken } : undefined);
		if (response.status === 409 && response.json?.code === "LEASE_BUSY") return renderLeaseBusy(response.json as unknown as LeaseBusyResponse, action, mode);
		if (response.status !== 200 || !response.json || response.json.ok !== true) return renderLeaseFailure(action, mode, typeof response.json?.error === "string" ? response.json.error : `POST /lease failed (HTTP ${response.status})`);
		return renderLeaseSuccess(action, response.json as unknown as LeaseStatusResponse & LeaseAcquireResponse, mode);
	} catch (error) {
		return renderLeaseFailure(action, mode, error instanceof Error ? error.message : String(error));
	}
}

function leaseSpecs(): FlagSpec[] {
	return [{ name: "token", flag: "--token", kind: "string", required: false, description: "Pairing token to use. Defaults to env/stored token." }];
}

function leaseHelp(): number {
	process.stdout.write("browser-pilot lease <status|acquire|release> [--token <tok>] [--json]\n\nManage the exclusive browser lease.\n\nSubcommands:\n  status     Show the current lease holder.\n  acquire    Acquire the lease for this agent.\n  release    Release a lease held by this agent.\n\nFlags:\n  --token <string>   Pairing token (overrides env/stored).\n  --json | --text\n");
	return EXIT.ok;
}

function leaseAction(value: string | undefined, mode: ReturnType<typeof jsonMode>): LeaseAction | number {
	const actions: LeaseAction[] = ["status", "acquire", "release"];
	if (!value || !actions.includes(value as LeaseAction)) return renderUsageError(`usage: browser-pilot lease <${actions.join("|")}> [--token <tok>] [--json]`, mode);
	return value as LeaseAction;
}

async function leaseEnsureDaemon(mode: ReturnType<typeof jsonMode>) {
	try {
		return await ensureDaemon();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (mode === "json") writeJsonEnvelope({ ok: false, exitCode: EXIT.unavailable, code: "CLI_DAEMON_UNAVAILABLE", command: "lease", message });
		else process.stderr.write(`lease failed: daemon unavailable — ${message}\n`);
		return EXIT.unavailable;
	}
}

function renderLeaseBusy(busy: LeaseBusyResponse, action: LeaseAction, mode: ReturnType<typeof jsonMode>): number {
	const holderLabel = busy.heldBy?.label ?? "unknown";
	if (mode === "json") writeJsonEnvelope({ ok: false, exitCode: EXIT.toolError, code: "LEASE_BUSY", command: "lease", action, heldBy: busy.heldBy, message: `lease held by "${holderLabel}"` });
	else process.stderr.write(`lease busy: held by "${holderLabel}" (pairingId: ${busy.heldBy?.pairingId ?? "?"})\n`);
	return EXIT.toolError;
}

function renderLeaseFailure(action: LeaseAction, mode: ReturnType<typeof jsonMode>, message: string): number {
	if (mode === "json") writeJsonEnvelope({ ok: false, exitCode: EXIT.toolError, code: "CLI_LEASE_ERROR", command: "lease", action, message });
	else process.stderr.write(`lease ${action} failed: ${message}\n`);
	return EXIT.toolError;
}

function renderLeaseSuccess(action: LeaseAction, response: LeaseStatusResponse & LeaseAcquireResponse, mode: ReturnType<typeof jsonMode>): number {
	if (action === "status") return renderLeaseStatus(response as LeaseStatusResponse, mode);
	if (mode === "json") writeJsonEnvelope({ ok: true, exitCode: EXIT.ok, command: "lease", action, lease: response.lease ?? null });
	else if (action === "acquire") process.stdout.write(`lease acquired: ${response.lease?.leaseId ?? "ok"}\n  expiresAt: ${response.lease?.expiresAt ?? "?"}\n`);
	else process.stdout.write("lease released\n");
	return EXIT.ok;
}

function renderLeaseStatus(response: LeaseStatusResponse, mode: ReturnType<typeof jsonMode>): number {
	if (mode === "json") {
		writeJsonEnvelope({ ok: true, exitCode: EXIT.ok, command: "lease", action: "status", held: response.lease !== null, self: response.self, lease: response.lease ?? null });
		return EXIT.ok;
	}
	if (!response.lease) {
		process.stdout.write("lease: free\n");
		return EXIT.ok;
	}
	const selfNote = response.self ? " (self)" : "";
	process.stdout.write(`lease: held by "${response.lease.label}"${selfNote}\n  pairingId: ${response.lease.pairingId}\n  since:     ${response.lease.since}\n  expiresAt: ${response.lease.expiresAt}\n`);
	return EXIT.ok;
}
