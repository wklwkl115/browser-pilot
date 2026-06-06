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
import { nativeToolMetadata } from "../src/protocol/nativeActionMetadata.js";

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

type ActionParamMeta = { action: string; required?: readonly string[]; requiredAny?: readonly (readonly string[])[]; notes?: string };

/** Per-action `--params` keys, surfaced from the generated native protocol metadata (single source of
 *  truth = bridge/native_command_schema.json). Action tools (wait/network/hook/frame) take an opaque
 *  `--params <json>`; this lists the REQUIRED keys the schema knows for each action so a blind agent
 *  doesn't have to guess. Optional keys may also exist — see the action description. Empty for
 *  non-action tools. */
export function nativeActionParamsHelp(toolName: string): string[] {
	const tools = nativeToolMetadata.nativeActionTools as unknown as Record<string, { actions?: readonly ActionParamMeta[] }>;
	const actions = tools[toolName]?.actions;
	if (!actions?.length) return [];
	const rows: string[] = [];
	for (const a of actions) {
		const parts: string[] = [];
		if (a.required?.length) parts.push(`requires ${a.required.join(", ")}`);
		if (a.requiredAny?.length) parts.push(`requires one of ${a.requiredAny.map((g) => g.join("+")).join(" | ")}`);
		if (a.notes) parts.push(a.notes);
		if (parts.length) rows.push(`  ${pad(a.action, 18)}${parts.join("; ")}`);
	}
	return rows;
}

function printCommandHelp(cmd: CliCommand): void {
	const specs = buildFlagSpecs(cmd.parameters);
	const lines = [`pi-browser ${cmd.subcommand}${cmd.description ? ` — ${cmd.description}` : ""}`, "", "Flags:"];
	for (const s of specs) {
		const meta = s.kind === "enum" && s.choices ? ` (${s.choices.join("|")})` : s.kind === "boolean" ? "" : ` <${s.kind}>`;
		lines.push(`  ${pad(`${s.flag}${meta}`, 30)}${s.required ? "[required] " : ""}${s.description ?? ""}`.trimEnd());
	}
	const actionParams = nativeActionParamsHelp(cmd.name);
	if (actionParams.length) {
		lines.push("", "Per-action --params keys (a JSON object; optional keys may also apply — see the action list above):", ...actionParams);
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
			process.on(sig, () => {
				// Force-exit even if close() hangs, so a signalled daemon always terminates.
				const force = setTimeout(() => process.exit(EXIT.ok), 1_500);
				force.unref();
				void handle.close().finally(() => process.exit(EXIT.ok));
			});
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
