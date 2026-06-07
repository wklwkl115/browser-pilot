import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

function runCli(args: string[], cwd = repoRoot): { code: number; stdout: string; stderr: string } {
	const result = spawnSync(tsxBin, ["cli/bin.ts", ...args], {
		cwd,
		encoding: "utf8",
		shell: process.platform === "win32",
	});
	return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr || (result.error ? result.error.message : "") };
}

function parseOneJson(stdout: string): Record<string, unknown> {
	const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
	assert.equal(lines.length, 1, "JSON mode must write exactly one JSON document");
	return JSON.parse(lines[0]) as Record<string, unknown>;
}

test("commands --json is local and machine-readable", () => {
	const result = runCli(["commands", "--json"]);
	assert.equal(result.code, 0, result.stderr);
	const env = parseOneJson(result.stdout);
	assert.equal(env.ok, true);
	assert.equal(env.command, "commands");
	assert.ok(Array.isArray(env.commands));
	assert.ok((env.commands as Array<Record<string, unknown>>).some((cmd) => cmd.name === "execute" && cmd.toolName === "browser_execute"));
});

test("schema --json returns parameter schema and flag mapping", () => {
	const result = runCli(["schema", "execute", "--json"]);
	assert.equal(result.code, 0, result.stderr);
	const env = parseOneJson(result.stdout);
	assert.equal(env.ok, true);
	assert.equal(env.command, "schema");
	assert.equal(env.toolName, "browser_execute");
	assert.ok(Array.isArray(env.flags));
	assert.ok((env.flags as Array<Record<string, unknown>>).some((flag) => flag.flag === "--script-file"));
});

test("validate command validates params from @file without daemon startup", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-validate-"));
	try {
		writeFileSync(path.join(dir, "params.json"), JSON.stringify({ script: "1+1" }), "utf8");
		const result = runCli(["validate", "execute", "--params", `@${path.join(dir, "params.json")}`, "--json"]);
		assert.equal(result.code, 0, result.stderr);
		const env = parseOneJson(result.stdout);
		assert.equal(env.ok, true);
		assert.equal(env.command, "validate");
		assert.equal(env.valid, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("doctor --json is read-only and reports daemon readiness fields", () => {
	const result = runCli(["doctor", "--json"]);
	assert.equal(result.code, 0, result.stderr);
	const env = parseOneJson(result.stdout);
	assert.equal(env.ok, true);
	assert.equal(env.command, "doctor");
	assert.ok(typeof env.cwd === "string");
	assert.ok(typeof env.commandCount === "number");
	assert.ok(env.daemon && typeof env.daemon === "object");
});
