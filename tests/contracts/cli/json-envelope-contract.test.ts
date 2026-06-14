import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import pkg from "../../../package.json" with { type: "json" };

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const cliEntry = path.join(repoRoot, "cli", "bin.ts");

interface CliRun {
	code: number;
	stdout: string;
	stderr: string;
}

function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): CliRun {
	const result = spawnSync(tsxBin, [cliEntry, ...args], {
		cwd: opts.cwd ?? repoRoot,
		encoding: "utf8",
		shell: process.platform === "win32",
		env: { ...process.env, ...(opts.env ?? {}) },
	});
	return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr || (result.error ? result.error.message : "") };
}

function parseSingleJson(result: CliRun): Record<string, unknown> {
	assert.equal(result.stderr, "", "JSON mode must keep stderr empty for structured CLI failures");
	const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
	assert.equal(lines.length, 1, `JSON mode must write exactly one JSON object to stdout, got ${lines.length}: ${result.stdout}`);
	const parsed = JSON.parse(lines[0]) as unknown;
	assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), "JSON envelope must be an object");
	return parsed as Record<string, unknown>;
}

function assertEnvelope(result: CliRun, expected: { exitCode: number; ok: boolean; code?: string }): Record<string, unknown> {
	assert.equal(result.code, expected.exitCode, result.stderr || result.stdout);
	const env = parseSingleJson(result);
	assert.equal(env.ok, expected.ok);
	assert.equal(env.exitCode, expected.exitCode);
	if (expected.code) assert.equal(env.code, expected.code);
	return env;
}

test("CLI --json success envelope is a single stdout object", () => {
	const env = assertEnvelope(runCli(["commands", "--json"]), { exitCode: 0, ok: true });
	assert.equal(env.command, "commands");
	assert.ok(Array.isArray(env.commands));
});

test("CLI --json usage and local input errors are single parseable envelopes", () => {
	const unknownFlag = assertEnvelope(runCli(["observe", "--mode", "scan", "--not-a-flag", "--json"]), { exitCode: 2, ok: false, code: "CLI_USAGE_ERROR" });
	assert.match(String(unknownFlag.message), /unknown flag/);
	assert.equal((unknownFlag.taxonomy as Record<string, unknown>).category, "usage");

	const malformedObject = assertEnvelope(runCli(["wait", "--action", "selector", "--params", "{bad", "--json"]), { exitCode: 2, ok: false, code: "CLI_USAGE_ERROR" });
	assert.match(String(malformedObject.message), /expects JSON/);

	const missingRequired = assertEnvelope(runCli(["validate", "execute", "--params", "{}", "--json"]), { exitCode: 2, ok: false, code: "CLI_USAGE_ERROR" });
	assert.match(String(missingRequired.message), /Validation failed|script/i);

	const missingScriptDir = mkdtempSync(path.join(os.tmpdir(), "pi-cli-missing-script-"));
	try {
		const missingScript = assertEnvelope(runCli(["execute", "--script-file", "missing.js", "--json"], { cwd: missingScriptDir }), { exitCode: 4, ok: false, code: "CLI_INPUT_ERROR" });
		assert.match(String(missingScript.message), /cannot read --script-file/);
		assert.equal((missingScript.taxonomy as Record<string, unknown>).category, "input");
	} finally {
		rmSync(missingScriptDir, { recursive: true, force: true });
	}
});

test("CLI --json daemon unavailable is a single parseable recovery envelope", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-cli-unavailable-"));
	try {
		const missingEntry = path.join(dir, "missing-daemon-entry.js");
		const env = assertEnvelope(runCli(["tabs", "--action", "list", "--json"], {
			env: {
				PI_BROWSER_DAEMON_STATE_DIR: dir,
				PI_BROWSER_DAEMON_ENTRY: missingEntry,
			},
		}), { exitCode: 3, ok: false, code: "CLI_DAEMON_UNAVAILABLE" });
		assert.equal((env.taxonomy as Record<string, unknown>).category, "daemon");
		const recovery = env.recovery as Record<string, unknown>;
		assert.ok(Array.isArray(recovery.commands));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI connect/status --json envelopes are single parseable objects", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-cli-connect-envelope-"));
	try {
		const status = assertEnvelope(runCli(["status", "--json"], {
			env: { PI_BROWSER_DAEMON_STATE_DIR: dir },
		}), { exitCode: 0, ok: true });
		assert.equal(status.command, "status");
		assert.equal(status.ready, false);

		const missingEntry = path.join(dir, "missing-daemon-entry.js");
		const connect = assertEnvelope(runCli(["connect", "--wait", "--timeout-ms", "100", "--json"], {
			env: {
				PI_BROWSER_DAEMON_STATE_DIR: dir,
				PI_BROWSER_DAEMON_ENTRY: missingEntry,
			},
		}), { exitCode: 3, ok: false, code: "CLI_DAEMON_UNAVAILABLE" });
		assert.equal(connect.command, "connect");
		assert.equal(connect.ready, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI --json daemon invoke/tool runtime error is a single parseable envelope", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-cli-invoke-error-state-"));
	const daemonEntry = path.join(dir, "fake-daemon.js");
	try {
		writeFileSync(daemonEntry, `
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const stateDir = process.env.PI_BROWSER_DAEMON_STATE_DIR;
const token = "test-token";
const server = http.createServer((req, res) => {
  if (req.headers["x-pi-daemon-token"] !== token) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return;
  }
  if (req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, running: false, extensionConnected: false, tabs: [], tools: 22 }));
    return;
  }
  if (req.url === "/invoke") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Validation failed: missing script", details: { missing: ["script"] } }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "browser-daemon.json"), JSON.stringify({
    pid: process.pid,
    controlHost: "127.0.0.1",
    controlPort: address.port,
    token,
    startedAt: new Date().toISOString(),
    version: "${pkg.version}+daemon.4"
  }));
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
setInterval(() => {}, 1000);
`, "utf8");
		const env = assertEnvelope(runCli(["execute", "--script", "1+1", "--json"], {
			cwd: repoRoot,
			env: {
				PI_BROWSER_DAEMON_STATE_DIR: dir,
				PI_BROWSER_DAEMON_ENTRY: daemonEntry,
			},
		}), { exitCode: 1, ok: false, code: "CLI_DAEMON_INVOKE_ERROR" });
		assert.match(String(env.message), /missing script/);
		assert.equal(env.status, 400);
		assert.equal((env.taxonomy as Record<string, unknown>).category, "daemon-invoke");
		const diagnostics = env.diagnostics as Record<string, unknown>;
		assert.ok(Array.isArray(diagnostics.nextActions), "daemon invoke errors expose nextActions");
		assert.ok((diagnostics.nextActions as string[]).includes("browser-pilot schema execute --json"));
		const recovery = env.recovery as Record<string, unknown>;
		assert.ok(Array.isArray(recovery.commands), "daemon invoke errors expose executable recovery commands");
		assert.ok((recovery.commands as Array<Record<string, unknown>>).some((cmd) => cmd.command === "browser-pilot validate execute --params @params.json --json" && Array.isArray(cmd.argv)));
	} finally {
		const stop = spawnSync(tsxBin, [cliEntry, "daemon", "stop", "--json"], {
			cwd: repoRoot,
			encoding: "utf8",
			shell: process.platform === "win32",
			env: { ...process.env, PI_BROWSER_DAEMON_STATE_DIR: dir },
		});
		assert.equal(stop.status ?? 1, 0, stop.stderr || stop.stdout);
		rmSync(dir, { recursive: true, force: true });
	}
});
