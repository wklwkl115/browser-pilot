import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	filterToolsByProfile,
	toolsForProfile,
	AGENT_FACADE_TOOL_NAMES,
} from "../../src/commands/capabilityProfileCatalog.js";
import { buildCliCommands, buildRunnableCliCommands, collectCommandDefs } from "../../src/apps/cli/registry.js";
import { validateBrowserCommandArguments } from "../../src/commands/commandValidation.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function runCli(args: string[]) {
	return spawnSync(process.execPath, ["--import", "tsx", path.join(root, "src/apps/cli/bin.ts"), ...args], {
		encoding: "utf8",
		cwd: root,
	});
}

test("public catalog is 22 tools including agent façade", () => {
	assert.equal(collectCommandDefs().length, 22);
	assert.equal(buildCliCommands().length, 22);
	const runnable = buildRunnableCliCommands();
	assert.equal(runnable.length, 22);
	for (const name of AGENT_FACADE_TOOL_NAMES) {
		assert.ok(runnable.some((cmd) => cmd.name === name));
		assert.ok(buildCliCommands().some((cmd) => cmd.name === name));
	}
});

test("agent and agent-preview profiles filter to three tools", () => {
	for (const profile of ["agent", "agent-preview"] as const) {
		const names = toolsForProfile(profile);
		assert.deepEqual([...names].sort(), [...AGENT_FACADE_TOOL_NAMES].sort());
		const filtered = filterToolsByProfile(buildRunnableCliCommands().map((c) => ({ name: c.name })), profile);
		assert.equal(filtered.length, 3);
	}
});

test("expert profile keeps core commands and excludes security", () => {
	const expert = new Set(toolsForProfile("expert"));
	assert.ok(expert.has("browser_observe"));
	assert.ok(expert.has("browser_execute"));
	assert.equal(expert.has("browser_crawl"), false);
	assert.equal(expert.has("browser_view"), false);
});

test("closed schema rejects unknown fields on browser_view", () => {
	const view = buildRunnableCliCommands().find((c) => c.name === "browser_view");
	assert.ok(view);
	const validated = validateBrowserCommandArguments(view.def, { contextRef: "x", unknownField: true });
	assert.equal(validated.ok, false);
});

test("CLI commands --profile agent lists only façade tools", () => {
	const result = runCli(["commands", "--profile", "agent", "--json"]);
	assert.equal(result.status, 0, result.stderr);
	const body = JSON.parse(result.stdout);
	assert.equal(body.profile, "agent");
	assert.deepEqual(body.tools.sort(), [...AGENT_FACADE_TOOL_NAMES].sort());
	assert.equal(body.commands.length, 3);
});

test("public commands --json reports toolCount 22 including façade", () => {
	const result = runCli(["commands", "--json"]);
	assert.equal(result.status, 0, result.stderr);
	const body = JSON.parse(result.stdout);
	assert.equal(body.contract.toolCount, 22);
	assert.equal(body.commands.length, 22);
	assert.ok(body.commands.some((c: { tool: string }) => c.tool === "browser_view"));
	assert.ok(body.commands.some((c: { tool: string }) => c.tool === "browser_act"));
	assert.ok(body.commands.some((c: { tool: string }) => c.tool === "browser_read"));
	assert.equal(Buffer.byteLength(result.stdout, "utf8") <= 25 * 1024, true);
});
