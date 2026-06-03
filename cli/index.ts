/**
 * pi-browser CLI dispatch.
 *
 * `pi-browser --help`            → list subcommands (one per registered tool)
 * `pi-browser <cmd> --help`      → flags for that command
 * `pi-browser <cmd> [--flags]`   → parse + coerce, then execute via the daemon
 * `pi-browser daemon <start|stop|status>`  → daemon lifecycle
 *
 * Parsing/help is fully local (no browser startup); only execution is delegated
 * to the daemon. Default output is human on a TTY, JSON otherwise; --json/--text
 * override.
 */
import { buildCliCommands, type CliCommand } from "./registry.js";
import { buildFlagSpecs, parseArgs, coerceParams, type GlobalFlags } from "./flags.js";
import { renderResult, renderUsageError, EXIT, type RenderMode } from "./render.js";
import { invokeTool, DaemonUnavailableError } from "./client.js";
import { findDaemon, stopDaemon } from "./daemonControl.js";

/** Left-align in a column; if the head already fills the column, keep a 2-space gap so the
 *  description never glues onto a long flag/subcommand. */
function pad(head: string, width: number): string {
	return head.length < width ? head.padEnd(width) : `${head}  `;
}

function printHelp(): void {
	const cmds = buildCliCommands();
	const lines = [
		"pi-browser — drive a live browser via the bridge daemon",
		"",
		"Usage:",
		"  pi-browser <command> [--flags]",
		"  pi-browser daemon <start|stop|status>",
		"",
		"Commands:",
	];
	for (const c of cmds) lines.push(`  ${pad(c.subcommand, 22)}${c.description ?? ""}`.trimEnd());
	lines.push("", "Run 'pi-browser <command> --help' for flags. Global: --json | --text | --help");
	process.stdout.write(`${lines.join("\n")}\n`);
}

function printCommandHelp(cmd: CliCommand): void {
	const specs = buildFlagSpecs(cmd.parameters);
	const lines = [`pi-browser ${cmd.subcommand}${cmd.description ? ` — ${cmd.description}` : ""}`, "", "Flags:"];
	for (const s of specs) {
		const meta = s.kind === "enum" && s.choices ? ` (${s.choices.join("|")})` : s.kind === "boolean" ? "" : ` <${s.kind}>`;
		lines.push(`  ${pad(`${s.flag}${meta}`, 30)}${s.required ? "[required] " : ""}${s.description ?? ""}`.trimEnd());
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

function renderMode(globals: GlobalFlags): RenderMode {
	if (globals.json) return "json";
	if (globals.text) return "human";
	return process.stdout.isTTY ? "human" : "json";
}

async function runDaemonControl(action: string | undefined): Promise<number> {
	if (action === "stop") {
		const stopped = await stopDaemon();
		process.stdout.write(stopped ? "daemon stopped\n" : "no daemon running\n");
		return EXIT.ok;
	}
	if (action === "status") {
		const found = await findDaemon();
		if (!found) { process.stdout.write("daemon: not running\n"); return EXIT.ok; }
		process.stdout.write(`${JSON.stringify({ pid: found.info.pid, controlPort: found.info.controlPort, ...found.status }, null, 2)}\n`);
		return EXIT.ok;
	}
	if (action === "start") {
		// Foreground: own the process until a signal or /shutdown. Auto-start spawns this detached.
		const { startDaemon } = await import("./daemon.js");
		const handle = await startDaemon({ onShutdown: () => process.exit(EXIT.ok) });
		process.stderr.write(`[pi-browser] daemon listening on 127.0.0.1:${handle.controlPort}\n`);
		for (const sig of ["SIGINT", "SIGTERM"] as const) {
			process.on(sig, () => { void handle.close().then(() => process.exit(EXIT.ok)); });
		}
		await new Promise<never>(() => {}); // keep alive
		return EXIT.ok; // unreachable
	}
	process.stderr.write("usage: pi-browser daemon <start|stop|status>\n");
	return EXIT.usage;
}

export async function main(argv: string[]): Promise<number> {
	const [sub, ...rest] = argv;
	if (!sub || sub === "--help" || sub === "-h") { printHelp(); return EXIT.ok; }
	if (sub === "daemon") return runDaemonControl(rest[0]);

	const cmd = buildCliCommands().find((c) => c.subcommand === sub);
	if (!cmd) return renderUsageError(`unknown command "${sub}"; run 'pi-browser --help'`);

	const specs = buildFlagSpecs(cmd.parameters);
	const parsed = parseArgs(specs, rest);
	if (!parsed.ok) return renderUsageError(parsed.error);
	if (parsed.value.globals.help) { printCommandHelp(cmd); return EXIT.ok; }

	const coerced = coerceParams(cmd.parameters, parsed.value.params);
	if (!coerced.ok) return renderUsageError(coerced.error);

	// Only execution is delegated to the daemon; the caller cwd rides along so
	// artifacts/memory land under the caller's .pi/, not the daemon's.
	try {
		const result = await invokeTool(cmd.name, coerced.args, process.cwd());
		return renderResult(result, renderMode(parsed.value.globals));
	} catch (error) {
		if (error instanceof DaemonUnavailableError) {
			process.stderr.write(`${"error:"} pi-browser daemon unavailable — ${error.message}\n`);
			return EXIT.unavailable;
		}
		throw error;
	}
}
