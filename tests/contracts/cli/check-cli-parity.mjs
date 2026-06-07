/**
 * CLI command parity contract (replacement for the MCP tools/list snapshot).
 *
 * Every registered browser_* tool must map to exactly one CLI subcommand. This is
 * the CLI's "no capability weakening" guard: the CLI exposes the full always-on
 * browser tool surface — no profile-gated compact/minimal visibility mode.
 *
 * - always-on surface = 22 subcommands
 * - subcommand naming round-trips (browser_cookie_analyze <-> cookie-analyze)
 * - subcommands are unique, kebab-case, and carry a description (non-empty help)
 * - the 7 security subcommands are present
 */
import assert from "node:assert/strict";

const { buildCliCommands, toSubcommand, fromSubcommand } = await import(new URL("../../../cli/registry.ts", import.meta.url).href);
const { buildFlagSpecs } = await import(new URL("../../../cli/flags.ts", import.meta.url).href);

const SECURITY_SUBCOMMANDS = ["crawl", "fuzz", "sqli", "template", "callback-oast", "cookie-analyze", "http-replay"];

function assertCommands(commands) {
	assert.equal(commands.length, 22, `CLI must expose exactly 22 subcommands, got ${commands.length}`);
	const subs = new Set();
	for (const cmd of commands) {
		assert(cmd.name.startsWith("browser_"), `${cmd.name} must be a browser_* tool`);
		assert.equal(fromSubcommand(toSubcommand(cmd.name)), cmd.name, `subcommand round-trip must be lossless for ${cmd.name}`);
		assert.match(cmd.subcommand, /^[a-z0-9]+(-[a-z0-9]+)*$/, `subcommand "${cmd.subcommand}" must be kebab-case (no browser_ prefix, no underscores)`);
		assert(!subs.has(cmd.subcommand), `duplicate subcommand: ${cmd.subcommand}`);
		subs.add(cmd.subcommand);
		assert(typeof cmd.description === "string" && cmd.description.length > 0, `${cmd.subcommand} must carry a non-empty description (help)`);
		// Flag specs must build without throwing (drives --help + parsing).
		const specs = buildFlagSpecs(cmd.parameters);
		assert(Array.isArray(specs), `${cmd.subcommand} flag specs must build`);
	}
	return subs;
}

const commands = buildCliCommands();
const subs = assertCommands(commands);

for (const sub of SECURITY_SUBCOMMANDS) {
	assert(subs.has(sub), `CLI must expose security subcommand ${sub}`);
}

console.log(`cli parity ok — ${commands.length} subcommands, naming round-trips, 7 security tools present`);
