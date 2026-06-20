import { parseArgs, type FlagSpec } from "./flags.js";
import { renderUsageError, writeJsonEnvelope, EXIT } from "./render.js";
import { connectBrowser, connectionStatus, staleLockfileDiagnostic } from "./connection.js";
import { findDaemon, isDaemonVersionCurrent, stopDaemon } from "../daemon/daemonControl.js";
import { daemonVersion } from "../daemon/packageInfo.js";
import { firstPositional, jsonMode, renderLocalJson, renderMode } from "./cliBasics.js";

function connectSpecs(): FlagSpec[] {
	return [
		{ name: "wait", flag: "--wait", kind: "boolean", required: false, description: "Wait until the browser extension is connected." },
		{ name: "timeoutMs", flag: "--timeout-ms", kind: "number", required: false, description: "Maximum readiness wait in milliseconds." },
		{ name: "tabs", flag: "--tabs", kind: "boolean", required: false, description: "Include full tabs[] instead of the default compact tabCount/activeTab fields." },
	];
}

function connectHelp(): string {
	return "browser-pilot connect --wait --timeout-ms <ms> --json\n\nFlags:\n  --wait                         Wait until extensionConnected is true.\n  --timeout-ms <number>          Bound readiness wait. Default 30000. For a fully\n                                 cold extension (browser just started), pass a\n                                 value above 60000 so the 1-minute wake alarm lands.\n  --tabs                         Include full tabs[]. Default is compact tabCount/activeTab.\n  --json | --text | --help\n";
}

function parseConnectArgs(argv: string[]) {
	const parsed = parseArgs(connectSpecs(), argv);
	if (!parsed.ok) return { ok: false as const, code: renderUsageError(parsed.error, renderMode(parsed.globals)) };
	if (parsed.value.globals.help) {
		process.stdout.write(connectHelp());
		return { ok: false as const, code: EXIT.ok };
	}
	const rawTimeout = parsed.value.params.timeoutMs;
	const timeoutMs = rawTimeout === undefined ? 30_000 : Number(rawTimeout);
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return { ok: false as const, code: renderUsageError("--timeout-ms must be a non-negative number", jsonMode(argv)) };
	return { ok: true as const, wait: parsed.value.params.wait === true, timeoutMs: Math.floor(timeoutMs), tabs: parsed.value.params.tabs === true };
}

export async function runConnectCommand(argv: string[]): Promise<number> {
	const mode = jsonMode(argv);
	const parsed = parseConnectArgs(argv);
	if (!parsed.ok) return parsed.code;
	const result = await connectBrowser({ wait: parsed.wait, timeoutMs: parsed.timeoutMs, cwd: process.cwd(), tabs: parsed.tabs });
	if (mode === "json") {
		writeJsonEnvelope(result.envelope as Parameters<typeof writeJsonEnvelope>[0]);
		return result.exitCode;
	}
	if (result.exitCode !== EXIT.ok) {
		process.stderr.write(`connect failed: ${String(result.envelope.message ?? "browser extension not connected")}\n`);
		return result.exitCode;
	}
	process.stdout.write(result.envelope.ready === true ? "ready\n" : `not ready (${String(result.envelope.readiness ?? "unknown")})\n`);
	return result.exitCode;
}

export async function runStatusCommand(argv: string[]): Promise<number> {
	const mode = jsonMode(argv);
	const specs: FlagSpec[] = [{ name: "tabs", flag: "--tabs", kind: "boolean", required: false, description: "Include full tabs[] instead of the default compact tabCount/activeTab fields." }];
	const parsed = parseArgs(specs, argv);
	if (!parsed.ok) return renderUsageError(parsed.error, renderMode(parsed.globals));
	if (parsed.value.globals.help) {
		process.stdout.write("browser-pilot status --json\n\nRead-only browser connection status. Does not start daemon or bridge.\n\nFlags:\n  --tabs                         Include full tabs[]. Default is compact tabCount/activeTab.\n");
		return EXIT.ok;
	}
	const env = await connectionStatus(process.cwd(), 15_000, { tabs: parsed.value.params.tabs === true });
	if (mode === "json") return renderLocalJson(env);
	process.stdout.write(`ready: ${env.ready === true ? "true" : "false"} (${String(env.readiness ?? "unknown")})\n`);
	return EXIT.ok;
}

export async function runDaemonControl(action: string | undefined, argv: string[] = []): Promise<number> {
	const mode = jsonMode(argv);
	if (action === "stop") return stopDaemonMode(mode);
	if (action === "status") return daemonStatusMode(mode);
	if (action === "start") return startDaemonMode();
	return renderUsageError("usage: browser-pilot daemon <start|stop|status>", mode);
}

async function stopDaemonMode(mode: ReturnType<typeof jsonMode>): Promise<number> {
	const stopped = await stopDaemon();
	if (mode === "json") return renderLocalJson({ command: "daemon.stop", stopped, ...(stopped ? {} : { staleLockfile: staleLockfileDiagnostic() }) });
	process.stdout.write(stopped ? "daemon stopped\n" : "no daemon running\n");
	return EXIT.ok;
}

async function daemonStatusMode(mode: ReturnType<typeof jsonMode>): Promise<number> {
	const found = await findDaemon();
	if (!found) return daemonStatusMissing(mode);
	const status = { command: "daemon.status", running: true, pid: found.info.pid, controlPort: found.info.controlPort, version: found.info.version, expectedVersion: daemonVersion(), versionStale: !isDaemonVersionCurrent(found.info), ...found.status };
	if (mode === "json") return renderLocalJson(status);
	process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
	return EXIT.ok;
}

function daemonStatusMissing(mode: ReturnType<typeof jsonMode>): number {
	if (mode === "json") return renderLocalJson({ command: "daemon.status", running: false, daemon: null, expectedVersion: daemonVersion(), staleLockfile: staleLockfileDiagnostic() });
	process.stdout.write("daemon: not running\n");
	return EXIT.ok;
}

async function startDaemonMode(): Promise<number> {
	const { startDaemon } = await import("../daemon/server.js");
	const handle = await startDaemon({ onShutdown: () => process.exit(EXIT.ok) });
	process.stderr.write(`[browser-pilot] daemon listening on 127.0.0.1:${handle.controlPort}\n`);
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => shutdownDaemon(handle));
	await new Promise<never>(() => {});
	return EXIT.ok;
}

function shutdownDaemon(handle: { close: () => Promise<void> }): void {
	const force = setTimeout(() => process.exit(EXIT.ok), 1_500);
	force.unref();
	void handle.close().finally(() => process.exit(EXIT.ok));
}

export function daemonAction(argv: string[]): string | undefined {
	return firstPositional(argv).value;
}
