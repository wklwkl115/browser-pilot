/**
 * CLI command parity contract (replacement for the MCP tools/list snapshot).
 *
 * Every registered browser_* tool must map to exactly one CLI subcommand, for both
 * capability profiles. This is the CLI's "no capability weakening" guard: the CLI
 * exposes every tool the profile registers — no compact/minimal visibility mode.
 *
 * - core profile = 15 subcommands, security profile = 22 (security adds exactly 7)
 * - subcommand naming round-trips (browser_cookie_analyze <-> cookie-analyze)
 * - subcommands are unique, kebab-case, and carry a description (non-empty help)
 * - the 7 security subcommands appear only in the security profile
 */
import assert from "node:assert/strict";

const { buildCliCommands, toSubcommand, fromSubcommand } = await import(new URL("../../../cli/registry.ts", import.meta.url).href);
const { buildFlagSpecs } = await import(new URL("../../../cli/flags.ts", import.meta.url).href);

const SECURITY_SUBCOMMANDS = ["crawl", "fuzz", "sqli", "template", "callback-oast", "cookie-analyze", "http-replay"];

function assertProfile(commands, expectedCount, label) {
	assert.equal(commands.length, expectedCount, `${label} profile must expose exactly ${expectedCount} subcommands, got ${commands.length}`);
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

const core = buildCliCommands(false);
const coreSubs = assertProfile(core, 15, "core");

const security = buildCliCommands(true);
const securitySubs = assertProfile(security, 22, "security");

assert.equal(security.length - core.length, 7, "security profile must add exactly 7 subcommands over core");
for (const sub of SECURITY_SUBCOMMANDS) {
	assert(securitySubs.has(sub), `security profile must expose ${sub}`);
	assert(!coreSubs.has(sub), `${sub} must not appear in the core profile`);
}

console.log(`cli parity ok — core ${core.length} / security ${security.length} subcommands, naming round-trips, 7 security-only`);
