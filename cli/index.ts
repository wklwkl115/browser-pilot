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
import { buildFlagSpecs, parseArgs, coerceParams } from "./flags.js";
import { renderUsageError, EXIT } from "./render.js";

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
	for (const c of cmds) lines.push(`  ${c.subcommand.padEnd(22)}${c.description ?? ""}`.trimEnd());
	lines.push("", "Run 'pi-browser <command> --help' for flags. Global: --json | --text | --help");
	process.stdout.write(`${lines.join("\n")}\n`);
}

function printCommandHelp(cmd: CliCommand): void {
	const specs = buildFlagSpecs(cmd.parameters);
	const lines = [`pi-browser ${cmd.subcommand}${cmd.description ? ` — ${cmd.description}` : ""}`, "", "Flags:"];
	for (const s of specs) {
		const meta = s.kind === "enum" && s.choices ? ` (${s.choices.join("|")})` : s.kind === "boolean" ? "" : ` <${s.kind}>`;
		lines.push(`  ${`${s.flag}${meta}`.padEnd(30)}${s.required ? "[required] " : ""}${s.description ?? ""}`.trimEnd());
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

export async function main(argv: string[]): Promise<number> {
	const [sub, ...rest] = argv;
	if (!sub || sub === "--help" || sub === "-h") { printHelp(); return EXIT.ok; }
	if (sub === "daemon") {
		process.stderr.write("daemon control is not implemented yet (next checkpoint)\n");
		return EXIT.unavailable;
	}
	const cmd = buildCliCommands().find((c) => c.subcommand === sub);
	if (!cmd) return renderUsageError(`unknown command "${sub}"; run 'pi-browser --help'`);

	const specs = buildFlagSpecs(cmd.parameters);
	const parsed = parseArgs(specs, rest);
	if (!parsed.ok) return renderUsageError(parsed.error);
	if (parsed.value.globals.help) { printCommandHelp(cmd); return EXIT.ok; }

	const coerced = coerceParams(cmd.parameters, parsed.value.params);
	if (!coerced.ok) return renderUsageError(coerced.error);

	// Execution via the daemon /invoke lands in the next checkpoint. For now,
	// print the resolved (tool, params) so the parse→coerce chain is verifiable.
	process.stdout.write(`${JSON.stringify({ tool: cmd.name, params: coerced.args }, null, 2)}\n`);
	return EXIT.ok;
}
