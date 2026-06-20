import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveDaemonStartCommand } from "../../src/apps/daemon/daemonControl.ts";

function runCli(args: string[]) {
	return spawnSync("node", ["--import", "tsx", "src/apps/cli/bin.ts", ...args], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
}

test("schema execute emits local JSON metadata", () => {
	const result = runCli(["schema", "execute", "--json"]);
	const body = JSON.parse(result.stdout);
	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	assert.equal(body.command, "schema");
	assert.equal(body.name, "execute");
	assert.equal(body.commandName, "browser_execute");
	assert.equal(body.agentCli.mode, "standard");
	assert.ok(body.flags.some((flag: { name: string }) => flag.name === "scriptFile"));
});

test("validate execute loads --script-file into args.script", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-cli-"));
	const scriptPath = path.join(dir, "snippet.js");
	writeFileSync(scriptPath, "1 + 1;\n", "utf8");
	const result = runCli([
		"validate",
		"execute",
		"--params",
		JSON.stringify({ tabId: 1, scriptFile: scriptPath }),
		"--json",
	]);
	const body = JSON.parse(result.stdout);
	assert.equal(result.status, 0);
	assert.equal(body.command, "validate");
	assert.equal(body.valid, true);
	assert.deepEqual(body.args, { tabId: 1, script: "1 + 1;\n" });
});

test("validate execute reports script-file read failures as CLI input errors", () => {
	const result = runCli([
		"validate",
		"execute",
		"--params",
		JSON.stringify({ tabId: 1, scriptFile: "./does-not-exist.js" }),
		"--json",
	]);
	const body = JSON.parse(result.stdout);
	assert.equal(result.status, 4);
	assert.equal(body.code, "CLI_INPUT_ERROR");
	assert.match(body.message, /cannot read --script-file/i);
});

test("commands emits registered subcommands in json mode", () => {
	const result = runCli(["commands", "--json"]);
	const body = JSON.parse(result.stdout);
	assert.equal(result.status, 0);
	assert.equal(body.command, "commands");
	assert.ok(body.commands.some((command: { name: string }) => command.name === "execute"));
});

test("doctor emits a local recovery report in json mode", () => {
	const result = runCli(["doctor", "--json"]);
	const body = JSON.parse(result.stdout);
	assert.equal(result.status, 0);
	assert.equal(body.command, "doctor");
	assert.equal(Array.isArray(body.recovery.commands), true);
	assert.ok(body.recovery.commands.some((command: { command: string }) => command.command.includes("selftest")));
});

test("unknown subcommands stay usage errors in json mode", () => {
	const result = runCli(["not-a-command", "--json"]);
	const body = JSON.parse(result.stdout);
	assert.equal(result.status, 2);
	assert.equal(body.code, "CLI_USAGE_ERROR");
});

test("daemon status stays a local json command when no daemon is running", () => {
	const result = runCli(["daemon", "status", "--json"]);
	const body = JSON.parse(result.stdout);
	assert.equal(result.status, 0);
	assert.equal(body.command, "daemon.status");
	assert.equal(typeof body.expectedVersion, "string");
});

test("daemon auto-start resolves the real source cli entry", () => {
	const command = resolveDaemonStartCommand();
	assert.equal(command.command, process.execPath);
	assert.ok(command.args.some((arg) => arg.replaceAll("\\", "/").endsWith("src/apps/cli/bin.ts") || arg.replaceAll("\\", "/").endsWith("dist/src/apps/cli/bin.js")), JSON.stringify(command));
});

test("connect and status keep their local help text", () => {
	const connect = runCli(["connect", "--help"]);
	const status = runCli(["status", "--help"]);
	assert.equal(connect.status, 0);
	assert.match(connect.stdout, /^browser-pilot connect --wait --timeout-ms <ms> --json/m);
	assert.equal(status.status, 0);
	assert.match(status.stdout, /^browser-pilot status --json/m);
});

test("selftest, pair, lease, and revoke keep local usage errors in json mode", () => {
	const selftest = JSON.parse(runCli(["selftest", "--json"]).stdout);
	const pair = JSON.parse(runCli(["pair", "--json"]).stdout);
	const lease = JSON.parse(runCli(["lease", "--json"]).stdout);
	const revoke = JSON.parse(runCli(["revoke", "--json"]).stdout);
	assert.equal(selftest.code, "CLI_USAGE_ERROR");
	assert.match(selftest.message, /--confirm/);
	assert.equal(pair.code, "CLI_USAGE_ERROR");
	assert.match(pair.message, /--label is required/);
	assert.equal(lease.code, "CLI_USAGE_ERROR");
	assert.match(lease.message, /lease <status\|acquire\|release>/);
	assert.equal(revoke.code, "CLI_USAGE_ERROR");
	assert.match(revoke.message, /--pairing-id is required/);
});

test("pairings and execute keep their local help surfaces", () => {
	const pairings = runCli(["pairings", "--help"]);
	const execute = runCli(["execute", "--help"]);
	assert.equal(pairings.status, 0);
	assert.match(pairings.stdout, /^browser-pilot pairings \[--json\]/m);
	assert.equal(execute.status, 0);
	assert.match(execute.stdout, /^browser-pilot execute/u);
	assert.match(execute.stdout, /--script-file <string>/);
});

test("bin --help prints top-level usage and exits cleanly", () => {
	const result = runCli(["--help"]);
	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	assert.match(result.stdout, /browser-pilot — drive a live browser via the bridge daemon/);
	assert.match(result.stdout, /^Usage:/m);
	assert.match(result.stdout, /^Commands:/m);
});

test("cli main refactor target stays within the file-size budget", () => {
	const filePath = path.join(process.cwd(), "src/apps/cli/main.ts");
	const lines = readFileSync(filePath, "utf8").split(/\r?\n/).length;
	assert.ok(lines <= 200, `expected src/apps/cli/main.ts to stay within 200 lines, got ${lines}`);
});
