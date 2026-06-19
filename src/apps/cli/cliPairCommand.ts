import { parseArgs, type FlagSpec } from "./flags.js";
import { renderUsageError, writeJsonEnvelope, EXIT } from "./render.js";
import { controlRequest, ensureDaemon } from "../daemon/daemonControl.js";
import { writeAgentToken } from "./pairing.js";
import { PAIR_WAIT_DEFAULT_MS } from "../daemon/authTypes.js";
import { jsonMode, renderMode } from "./cliBasics.js";

export async function runPairCommand(argv: string[]): Promise<number> {
	const mode = jsonMode(argv);
	const parsed = parseArgs(pairSpecs(), argv);
	if (!parsed.ok) return renderUsageError(parsed.error, renderMode(parsed.globals));
	if (parsed.value.globals.help) return pairHelp();
	const label = String(parsed.value.params.label ?? "");
	if (!label) return renderUsageError("--label is required", mode);
	const timeoutMs = pairTimeout(parsed.value.params.timeoutMs, mode);
	if (typeof timeoutMs !== "number") return timeoutMs;
	const info = await pairEnsureDaemon(mode);
	if (typeof info === "number") return info;
	const start = await startPairing(info, label, mode);
	if (typeof start === "number") return start;
	printPairingCode(mode, start.code, timeoutMs);
	const wait = await waitForPairing(info, start.pairingId, timeoutMs, mode);
	if (typeof wait === "number") return wait;
	await persistPairToken(wait.token, start.pairingId, label);
	if (mode === "json") {
		writeJsonEnvelope({ ok: true, exitCode: EXIT.ok, command: "pair", pairingId: start.pairingId, label });
		return EXIT.ok;
	}
	process.stdout.write(`paired: ${start.pairingId}\n`);
	return EXIT.ok;
}

function pairSpecs(): FlagSpec[] {
	return [
		{ name: "label", flag: "--label", kind: "string", required: true, description: "Human-readable name for this agent (e.g. \"claude-code\")." },
		{ name: "timeoutMs", flag: "--timeout-ms", kind: "number", required: false, description: "Maximum wait for user approval in milliseconds. Default: 120000." },
	];
}

function pairHelp(): number {
	process.stdout.write("browser-pilot pair --label <name> [--timeout-ms <ms>] [--json]\n\nPair this agent with the browser extension. The user must approve in the popup.\n\nFlags:\n  --label <string>     Agent label shown in the extension popup (required).\n  --timeout-ms <ms>    How long to wait for approval. Default 120000.\n  --json | --text\n");
	return EXIT.ok;
}

function pairTimeout(rawTimeout: unknown, mode: ReturnType<typeof jsonMode>): number {
	const timeoutMs = rawTimeout === undefined ? PAIR_WAIT_DEFAULT_MS : Number(rawTimeout);
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return renderUsageError("--timeout-ms must be a non-negative number", mode);
	return timeoutMs;
}

async function pairEnsureDaemon(mode: ReturnType<typeof jsonMode>) {
	try {
		return await ensureDaemon();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (mode === "json") writeJsonEnvelope({ ok: false, exitCode: EXIT.unavailable, code: "CLI_DAEMON_UNAVAILABLE", command: "pair", message });
		else process.stderr.write(`pair failed: daemon unavailable — ${message}\n`);
		return EXIT.unavailable;
	}
}

async function startPairing(info: Awaited<ReturnType<typeof ensureDaemon>>, label: string, mode: ReturnType<typeof jsonMode>) {
	try {
		const { status, json } = await controlRequest(info, "POST", "/pair/start", { label });
		if (status === 409 && json?.code === "PAIR_NO_EXTENSION") return pairFailure(mode, "PAIR_NO_EXTENSION", "browser extension is not connected — open the browser with Browser Pilot Bridge enabled first", EXIT.unavailable);
		if (status !== 200 || !json || json.ok !== true) return pairFailure(mode, "CLI_PAIR_START_FAILED", typeof json?.error === "string" ? json.error : `POST /pair/start failed (HTTP ${status})`, EXIT.unavailable);
		return { pairingId: String(json.pairingId), code: String(json.code) };
	} catch (error) {
		return pairFailure(mode, "CLI_PAIR_START_FAILED", error instanceof Error ? error.message : String(error), EXIT.unavailable);
	}
}

function printPairingCode(mode: ReturnType<typeof jsonMode>, code: string, timeoutMs: number): void {
	if (mode === "json") process.stderr.write(`\nPairing code: ${code}\n  Match this code in the browser extension popup to approve.\n\n`);
	else process.stdout.write(`\n  Pairing code: ${code}\n\n  Match this code in the browser extension popup to approve.\n  Waiting up to ${Math.round(timeoutMs / 1000)}s...\n\n`);
}

async function waitForPairing(info: Awaited<ReturnType<typeof ensureDaemon>>, pairingId: string, timeoutMs: number, mode: ReturnType<typeof jsonMode>) {
	try {
		const { status, json } = await controlRequest(info, "POST", "/pair/wait", { pairingId, timeoutMs }, timeoutMs + 5_000);
		if (status === 403 || json?.code === "PAIR_DENIED") return pairFailure(mode, "PAIR_DENIED", "pairing was denied by the user", EXIT.unavailable, pairingId);
		if (status === 408 || json?.code === "PAIR_TIMEOUT") return pairFailure(mode, "PAIR_TIMEOUT", "pairing approval timed out", EXIT.unavailable, pairingId);
		if (status !== 200 || !json || json.ok !== true) return pairFailure(mode, "CLI_PAIR_WAIT_FAILED", typeof json?.error === "string" ? json.error : `POST /pair/wait failed (HTTP ${status})`, EXIT.unavailable, pairingId);
		return { token: String(json.token) };
	} catch (error) {
		return pairFailure(mode, "CLI_PAIR_WAIT_FAILED", error instanceof Error ? error.message : String(error), EXIT.unavailable, pairingId);
	}
}

async function persistPairToken(token: string, pairingId: string, label: string): Promise<void> {
	try {
		await writeAgentToken(token, pairingId, label);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`warning: could not persist agent token: ${message}\n`);
	}
}

function pairFailure(mode: ReturnType<typeof jsonMode>, code: string, message: string, exitCode: number, pairingId?: string): number {
	if (mode === "json") writeJsonEnvelope({ ok: false, exitCode, code, command: "pair", ...(pairingId ? { pairingId } : {}), message });
	else process.stderr.write(`pair failed: ${message}\n`);
	return exitCode;
}
