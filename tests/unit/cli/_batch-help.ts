import path from "node:path";

const stateDir = process.argv[2];
if (!stateDir) { process.stderr.write("usage: _batch-help.ts <stateDir>\n"); process.exit(1); }
process.env.PI_BROWSER_DAEMON_STATE_DIR = stateDir;

function capture(fn: () => void): string {
	let buf = "";
	const orig = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array) => { buf += String(chunk); return true; }) as typeof process.stdout.write;
	try { fn(); } finally { process.stdout.write = orig; }
	return buf;
}

const { helpText } = await import("../../../cli/help.js");
const { buildCliCommands } = await import("../../../cli/registry.js");
const { printCommandHelp } = await import("../../../cli/commandMetadata.js");

const topHelp = helpText();
const commands = await buildCliCommands();
const commandNames = commands.map(c => c.subcommand);

const perCommand: Record<string, string> = {};
for (const cmd of commands) {
	perCommand[cmd.subcommand] = capture(() => printCommandHelp(cmd));
}

process.stdout.write(JSON.stringify({ topHelp, commandNames, perCommand }) + "\n");
