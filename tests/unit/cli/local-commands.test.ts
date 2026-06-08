import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const cliEntry = path.join(repoRoot, "cli", "bin.ts");
const packageVersion = (JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
const expectedDaemonVersion = `${packageVersion}+daemon.4`;

function runCli(args: string[], cwd = repoRoot, env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
	const result = spawnSync(tsxBin, [cliEntry, ...args], {
		cwd,
		encoding: "utf8",
		shell: process.platform === "win32",
		env: { ...process.env, ...env },
	});
	return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr || (result.error ? result.error.message : "") };
}

function runNpm(args: string[], cwd = repoRoot): { code: number; stdout: string; stderr: string } {
	const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npmBin, args, {
		cwd,
		encoding: "utf8",
		shell: process.platform === "win32",
		env: { ...process.env },
	});
	return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr || (result.error ? result.error.message : "") };
}

function parseOneJson(stdout: string): Record<string, unknown> {
	const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
	assert.equal(lines.length, 1, "JSON mode must write exactly one JSON document");
	return JSON.parse(lines[0]) as Record<string, unknown>;
}

function writeFakeDaemonEntry(dir: string, extensionConnected: boolean): string {
	const daemonEntry = path.join(dir, "fake-daemon.js");
	writeFileSync(daemonEntry, `
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const stateDir = process.env.PI_BROWSER_DAEMON_STATE_DIR;
const token = "test-token";
const extensionConnected = process.env.PI_BROWSER_FAKE_EXTENSION_CONNECTED === "1";
const tabs = extensionConnected ? [{ tabId: 7, id: 7, active: true, url: "https://example.test/", title: "Example" }] : [];
const activeTab = tabs.find((tab) => tab.active) || tabs[0] || null;
function statusPayload(includeTabs) {
  return {
    ok: true,
    bridgePort: extensionConnected ? 18765 : undefined,
    running: extensionConnected,
    extensionConnected,
    tabCount: tabs.length,
    activeTab,
    health: {
      connectedAt: extensionConnected ? 1000 : undefined,
      lastSeenAt: extensionConnected ? 2000 : undefined,
      lastPingAt: extensionConnected ? 3000 : undefined,
      lastPongAt: extensionConnected ? 4000 : undefined,
      connectedForMs: extensionConnected ? 500 : undefined,
      tabSyncAt: extensionConnected ? 6000 : undefined,
      tabSyncAgeMs: extensionConnected ? 700 : undefined,
      connectedClients: extensionConnected ? 1 : 0
    },
    ...(includeTabs ? { tabs } : {}),
    tools: 22
  };
}
const server = http.createServer((req, res) => {
  if (req.headers["x-pi-daemon-token"] !== token) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return;
  }
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(statusPayload(url.searchParams.get("tabs") === "1")));
    return;
  }
  if (url.pathname === "/shutdown") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    setImmediate(() => {
      try { rmSync(path.join(stateDir, "browser-daemon.json"), { force: true }); } catch {}
      server.close(() => process.exit(0));
    });
    return;
  }
  if (url.pathname === "/connect") {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        startedBridge: !extensionConnected,
        status: statusPayload(parsed.tabs === true)
      }));
    });
    return;
  }
  if (url.pathname === "/invoke") {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        content: [{ type: "text", text: JSON.stringify({ ok: true, ...parsed }) }],
        terminate: false
      }));
    });
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
    version: "${expectedDaemonVersion}"
  }));
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
setInterval(() => {}, 1000);
`, "utf8");
	return daemonEntry;
}

function withFakeDaemonStatus(extensionConnected: boolean, fn: (env: Record<string, string>) => void): void {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-fake-daemon-status-"));
	const daemonEntry = writeFakeDaemonEntry(dir, extensionConnected);
	const env = {
		PI_BROWSER_DAEMON_STATE_DIR: dir,
		PI_BROWSER_DAEMON_ENTRY: daemonEntry,
		PI_BROWSER_FAKE_EXTENSION_CONNECTED: extensionConnected ? "1" : "0",
	};
	try {
		const start = runCli(["tabs", "--action", "list", "--json"], repoRoot, env);
		assert.notEqual(start.code, 3, start.stderr || start.stdout);
		fn(env);
	} finally {
		runCli(["daemon", "stop", "--json"], repoRoot, { PI_BROWSER_DAEMON_STATE_DIR: dir });
		rmSync(dir, { recursive: true, force: true });
	}
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

test("top-level help and every command help are local and daemon-free", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-help-local-"));
	try {
		const top = runCli(["--help"], repoRoot, { PI_BROWSER_DAEMON_STATE_DIR: dir });
		assert.equal(top.code, 0, top.stderr);
		assert.match(top.stdout, /pi-browser/);
		assert.equal(top.stderr, "");

		const commands = parseOneJson(runCli(["commands", "--json"], repoRoot, { PI_BROWSER_DAEMON_STATE_DIR: dir }).stdout).commands as Array<Record<string, unknown>>;
		for (const cmd of commands) {
			const help = runCli([String(cmd.name), "--help"], repoRoot, { PI_BROWSER_DAEMON_STATE_DIR: dir });
			assert.equal(help.code, 0, `${cmd.name} help failed: ${help.stderr || help.stdout}`);
			assert.match(help.stdout, new RegExp(`pi-browser ${String(cmd.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.equal(help.stderr, "");
		}
		assert.equal(existsSync(path.join(dir, "browser-daemon.json")), false, "local help/discovery must not start a daemon or write a lockfile");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("npm wrapper JSON mode is documented: normal npm run contaminates stdout, --silent does not", () => {
	const noisy = runNpm(["run", "cli", "--", "--json", "schema", "execute"]);
	assert.equal(noisy.code, 0, noisy.stderr);
	assert.match(noisy.stdout, /> pi-browser-tools@/);
	assert.throws(() => parseOneJson(noisy.stdout), /JSON mode must write exactly one JSON document/);

	const silent = runNpm(["--silent", "run", "cli", "--", "--json", "schema", "execute"]);
	assert.equal(silent.code, 0, silent.stderr);
	const env = parseOneJson(silent.stdout);
	assert.equal(env.command, "schema");
	assert.equal(env.toolName, "browser_execute");
});

test("commands --json exposes agent CLI routing roles", () => {
	const result = runCli(["commands", "--json"]);
	assert.equal(result.code, 0, result.stderr);
	const env = parseOneJson(result.stdout);
	const commands = env.commands as Array<Record<string, unknown>>;
	const wait = commands.find((cmd) => cmd.name === "wait");
	const network = commands.find((cmd) => cmd.name === "network");
	const command = commands.find((cmd) => cmd.name === "command");
	assert.ok(wait, "wait command metadata exists");
	assert.ok(network, "network command metadata exists");
	assert.ok(command, "command escape-hatch metadata exists");
	assert.ok(wait.artifactBehavior && typeof wait.artifactBehavior === "object", "commands metadata exposes artifact behavior");
	const artifactBehavior = wait.artifactBehavior as Record<string, unknown>;
	assert.equal(artifactBehavior.resultField, "saved.path");
	assert.equal(artifactBehavior.readCommand, "pi-browser artifact --path <saved.path> --mode json --json-path data --json");
	assert.deepEqual(artifactBehavior.readModes, ["json", "text", "search", "sample"]);
	assert.ok((artifactBehavior.commonJsonPaths as string[]).includes("data.content"));
	assert.ok((artifactBehavior.commonJsonPaths as string[]).includes("snapshot.snapshotId"));
	assert.deepEqual(wait.agentCli, {
		mode: "advancedCompatibility",
		recommended: false,
		interface: "--action/--params",
		reason: ["compatibility", "full-native-action-coverage", "advanced-json-escape-hatch"],
	});
	const waitSubcommands = wait.subcommands as Array<Record<string, unknown>>;
	const selector = waitSubcommands.find((sub) => sub.name === "selector");
	assert.ok(selector, "wait selector natural metadata exists");
	assert.deepEqual(selector.agentCli, {
		mode: "natural",
		recommended: true,
		action: "selector",
		naturalSubcommand: "selector",
		translatesTo: { action: "selector", params: "nativeActionParams" },
	});
	assert.deepEqual(command.agentCli, {
		mode: "nativeEscapeHatch",
		recommended: false,
		interface: "command --command",
		reason: ["full-native-bridge-command-access", "advanced-json-escape-hatch"],
	});
	assert.equal((network.agentCli as Record<string, unknown>).mode, "advancedCompatibility");
});

test("leading --json is accepted for local discovery commands", () => {
	const commands = runCli(["--json", "commands"]);
	assert.equal(commands.code, 0, commands.stderr);
	assert.equal(parseOneJson(commands.stdout).command, "commands");

	const schema = runCli(["--json", "schema", "execute"]);
	assert.equal(schema.code, 0, schema.stderr);
	assert.equal(parseOneJson(schema.stdout).toolName, "browser_execute");
});

test("leading --json keeps CLI usage errors machine-readable", () => {
	const result = runCli(["--json", "not-a-command"]);
	assert.equal(result.code, 2);
	assert.equal(result.stderr, "");
	const env = parseOneJson(result.stdout);
	assert.equal(env.ok, false);
	assert.equal(env.code, "CLI_USAGE_ERROR");
});

test("flag values that look like output globals do not force human parse errors", () => {
	const result = runCli(["observe", "--mode", "--text"]);
	assert.equal(result.code, 2);
	assert.equal(result.stderr, "");
	const env = parseOneJson(result.stdout);
	assert.equal(env.ok, false);
	assert.equal(env.code, "CLI_USAGE_ERROR");
	assert.match(String(env.message), /--mode/);
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

test("execute --script-file reads local JavaScript and invokes the daemon with --script", () => {
	withFakeDaemonStatus(true, (envVars) => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "pi-execute-script-file-"));
		try {
			const script = "(() => ({ value: 42 }))();\n";
			writeFileSync(path.join(dir, "extract.js"), script, "utf8");
			const result = runCli(["execute", "--script-file", "extract.js", "--json"], dir, envVars);
			assert.equal(result.code, 0, result.stderr || result.stdout);
			const env = parseOneJson(result.stdout);
			assert.equal(env.ok, true);
			assert.equal(env.tool, "browser_execute");
			const params = env.params as Record<string, unknown>;
			assert.equal(params.script, script);
			assert.equal("scriptFile" in params, false);
			assert.equal(env.cwd, dir);
			const cli = env.cli as Record<string, unknown>;
			assert.equal(cli.command, "execute");
			assert.equal(cli.routing, "standard");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("natural wait/network help is discoverable and action-specific", () => {
	const waitHelp = runCli(["wait", "--help"]);
	assert.equal(waitHelp.code, 0, waitHelp.stderr);
	assert.match(waitHelp.stdout, /Natural subcommands \(recommended\):/);
	assert.match(waitHelp.stdout, /selector\s+requires --selector/);
	assert.match(waitHelp.stdout, /network-idle/);
	assert.match(waitHelp.stdout, /Advanced legacy flags:/);

	const selectorHelp = runCli(["wait", "selector", "--help"]);
	assert.equal(selectorHelp.code, 0, selectorHelp.stderr);
	assert.match(selectorHelp.stdout, /pi-browser wait selector/);
	assert.match(selectorHelp.stdout, /--selector <string>/);
	assert.match(selectorHelp.stdout, /Advanced equivalent: pi-browser wait --action selector --params <json>/);

	const networkHelp = runCli(["network", "--help"]);
	assert.equal(networkHelp.code, 0, networkHelp.stderr);
	assert.match(networkHelp.stdout, /Natural subcommands \(recommended\):/);
	assert.match(networkHelp.stdout, /export-har/);
});

test("natural frame/hook help is scoped to recommended high-frequency actions", () => {
	const frameHelp = runCli(["frame", "--help"]);
	assert.equal(frameHelp.code, 0, frameHelp.stderr);
	assert.match(frameHelp.stdout, /Natural subcommands \(recommended\):/);
	assert.match(frameHelp.stdout, /list\s+pi-browser frame list/);
	assert.match(frameHelp.stdout, /evaluate\s+requires --frame-id \/ --expression/);
	assert.doesNotMatch(frameHelp.stdout, /add-new-document-script\s+requires --source/, "script lifecycle stays advanced compatibility until eval proves it should be recommended");

	const frameEvalHelp = runCli(["frame", "evaluate", "--help"]);
	assert.equal(frameEvalHelp.code, 0, frameEvalHelp.stderr);
	assert.match(frameEvalHelp.stdout, /pi-browser frame evaluate/);
	assert.match(frameEvalHelp.stdout, /--frame-id <string>/);
	assert.match(frameEvalHelp.stdout, /--expression <string>/);
	assert.match(frameEvalHelp.stdout, /Advanced equivalent: pi-browser frame --action evaluate --params <json>/);

	const hookHelp = runCli(["hook", "--help"]);
	assert.equal(hookHelp.code, 0, hookHelp.stderr);
	assert.match(hookHelp.stdout, /Natural subcommands \(recommended\):/);
	assert.match(hookHelp.stdout, /install-targets\s+requires --targets/);
	assert.match(hookHelp.stdout, /list-sessions/);
	assert.match(hookHelp.stdout, /performance/);
	assert.doesNotMatch(hookHelp.stdout, /get-node-listeners\s+requires --selector/, "selector/listener inspection remains advanced compatibility for now");
});

test("schema exposes natural wait selector metadata without daemon startup", () => {
	const result = runCli(["schema", "wait", "selector", "--json"]);
	assert.equal(result.code, 0, result.stderr);
	const env = parseOneJson(result.stdout);
	assert.equal(env.ok, true);
	assert.equal(env.command, "schema");
	assert.equal(env.toolName, "browser_wait");
	assert.equal(env.naturalSubcommand, "selector");
	assert.equal(env.action, "selector");
	assert.ok(env.artifactBehavior && typeof env.artifactBehavior === "object", "schema metadata exposes artifact behavior");
	assert.ok(((env.artifactBehavior as Record<string, unknown>).commonJsonPaths as string[]).includes("data.actionables"));
	assert.deepEqual(env.agentCli, {
		mode: "natural",
		recommended: true,
		action: "selector",
		naturalSubcommand: "selector",
		translatesTo: { action: "selector", params: "nativeActionParams" },
	});
	const flags = env.flags as Array<Record<string, unknown>>;
	assert.ok(flags.some((flag) => flag.flag === "--selector"), "selector natural schema exposes --selector");
	assert.ok(!flags.some((flag) => flag.flag === "--action"), "selector natural schema hides legacy --action");
});

test("schema exposes legacy action interface as advanced compatibility", () => {
	const result = runCli(["schema", "wait", "--json"]);
	assert.equal(result.code, 0, result.stderr);
	const env = parseOneJson(result.stdout);
	assert.deepEqual(env.agentCli, {
		mode: "advancedCompatibility",
		recommended: false,
		interface: "--action/--params",
		reason: ["compatibility", "full-native-action-coverage", "advanced-json-escape-hatch"],
	});
	const subcommands = env.subcommands as Array<Record<string, unknown>>;
	assert.ok(subcommands.some((sub) => sub.name === "selector" && (sub.agentCli as Record<string, unknown>).mode === "natural"), "legacy schema also lists recommended natural routes");
});

test("schema exposes natural frame/hook metadata and rejects non-recommended action aliases", () => {
	const frame = runCli(["schema", "frame", "evaluate", "--json"]);
	assert.equal(frame.code, 0, frame.stderr);
	const frameEnv = parseOneJson(frame.stdout);
	assert.equal(frameEnv.toolName, "browser_frame");
	assert.equal(frameEnv.naturalSubcommand, "evaluate");
	assert.deepEqual(frameEnv.agentCli, {
		mode: "natural",
		recommended: true,
		action: "evaluate",
		naturalSubcommand: "evaluate",
		translatesTo: { action: "evaluate", params: "nativeActionParams" },
	});
	const frameFlags = frameEnv.flags as Array<Record<string, unknown>>;
	assert.ok(frameFlags.some((flag) => flag.flag === "--frame-id"));
	assert.ok(frameFlags.some((flag) => flag.flag === "--expression"));
	assert.ok(!frameFlags.some((flag) => flag.flag === "--source"));

	const hook = runCli(["schema", "hook", "install-targets", "--json"]);
	assert.equal(hook.code, 0, hook.stderr);
	const hookEnv = parseOneJson(hook.stdout);
	assert.equal(hookEnv.toolName, "browser_hook");
	assert.equal(hookEnv.action, "installTargets");
	const hookFlags = hookEnv.flags as Array<Record<string, unknown>>;
	const targetsFlag = hookFlags.find((flag) => flag.flag === "--targets");
	assert.ok(targetsFlag);
	assert.equal(targetsFlag.split, "comma");
	assert.ok(!hookFlags.some((flag) => flag.flag === "--selector"));

	const frameSchema = runCli(["schema", "frame", "--json"]);
	assert.equal(frameSchema.code, 0, frameSchema.stderr);
	const frameSchemaEnv = parseOneJson(frameSchema.stdout);
	const frameSubcommands = frameSchemaEnv.subcommands as Array<Record<string, unknown>>;
	assert.ok(frameSubcommands.some((sub) => sub.name === "list" && (sub.agentCli as Record<string, unknown>).mode === "natural"));
	assert.ok(frameSubcommands.some((sub) => sub.name === "evaluate" && (sub.agentCli as Record<string, unknown>).mode === "natural"));

	const hookSchema = runCli(["schema", "hook", "--json"]);
	assert.equal(hookSchema.code, 0, hookSchema.stderr);
	const hookSchemaEnv = parseOneJson(hookSchema.stdout);
	const hookSubcommands = hookSchemaEnv.subcommands as Array<Record<string, unknown>>;
	assert.ok(hookSubcommands.some((sub) => sub.name === "install-targets" && (sub.agentCli as Record<string, unknown>).mode === "natural"));
	assert.ok(hookSubcommands.some((sub) => sub.name === "collect" && (sub.agentCli as Record<string, unknown>).mode === "natural"));

	const nonRecommended = runCli(["schema", "hook", "get-node-listeners", "--json"]);
	assert.equal(nonRecommended.code, 2);
	const err = parseOneJson(nonRecommended.stdout);
	assert.equal(err.ok, false);
	assert.match(String(err.message), /unknown hook subcommand/);
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

test("validate command accepts large file-backed command and replay inputs without daemon startup", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-validate-large-inputs-"));
	try {
		const nativeCommandPath = path.join(dir, "native-command.json");
		writeFileSync(nativeCommandPath, JSON.stringify({ cmd: "tabs", method: "list", meta: { note: "x".repeat(2048) } }), "utf8");
		const commandParamsPath = path.join(dir, "command-params.json");
		writeFileSync(commandParamsPath, JSON.stringify({ command: `@${nativeCommandPath}` }), "utf8");
		const commandResult = runCli(["validate", "command", "--params", `@${commandParamsPath}`, "--json"]);
		assert.equal(commandResult.code, 0, commandResult.stderr);
		const commandEnv = parseOneJson(commandResult.stdout);
		assert.equal(commandEnv.valid, true);
		assert.deepEqual((commandEnv.args as Record<string, unknown>).command, { cmd: "tabs", method: "list", meta: { note: "x".repeat(2048) } });

		const rawRequestPath = path.join(dir, "request.txt");
		writeFileSync(rawRequestPath, `POST /api/items HTTP/1.1\r\nHost: example.test\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ body: "y".repeat(2048) })}`, "utf8");
		const requestsPath = path.join(dir, "requests.json");
		writeFileSync(requestsPath, JSON.stringify([{ url: "https://example.test/a", method: "GET" }, { rawRequest: `@${rawRequestPath}` }]), "utf8");
		const replayParamsPath = path.join(dir, "replay-params.json");
		writeFileSync(replayParamsPath, JSON.stringify({
			url: "https://example.test",
			rawRequest: `@${rawRequestPath}`,
			request: `@${nativeCommandPath}`,
			requests: `@${requestsPath}`,
		}), "utf8");
		const replayResult = runCli(["validate", "http-replay", "--params", `@${replayParamsPath}`, "--json"]);
		assert.equal(replayResult.code, 0, replayResult.stderr);
		const replayEnv = parseOneJson(replayResult.stdout);
		assert.equal(replayEnv.valid, true);
		const replayArgs = replayEnv.args as Record<string, unknown>;
		assert.match(String(replayArgs.rawRequest), /POST \/api\/items/);
		assert.deepEqual(replayArgs.request, { cmd: "tabs", method: "list", meta: { note: "x".repeat(2048) } });
		assert.ok(Array.isArray(replayArgs.requests));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("validate accepts leading --json without treating it as the command name", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-validate-leading-"));
	try {
		writeFileSync(path.join(dir, "params.json"), JSON.stringify({ script: "1+1" }), "utf8");
		const result = runCli(["--json", "validate", "execute", "--params", `@${path.join(dir, "params.json")}`]);
		assert.equal(result.code, 0, result.stderr);
		const env = parseOneJson(result.stdout);
		assert.equal(env.ok, true);
		assert.equal(env.command, "validate");
		assert.equal(env.toolName, "browser_execute");
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
	assert.equal(env.commandCount, 22);
	assert.deepEqual(env.commandGroups, { core: 15, security: 7 });
	assert.equal(env.webSecurityCommandCount, 7);
	assert.ok(typeof env.artifactRoot === "string");
	assert.ok(env.daemon && typeof env.daemon === "object");
	const daemon = env.daemon as Record<string, unknown>;
	assert.equal(daemon.expectedVersion, expectedDaemonVersion);
	assert.equal(typeof daemon.lockfile, "string");
	assert.equal(typeof daemon.running, "boolean");
	assert.equal(typeof daemon.reachable, "boolean");
	assert.equal("bridgePort" in daemon, true);
	assert.equal("bridgeRunning" in daemon, true);
	assert.equal("extensionConnected" in daemon, true);
	assert.ok(env.recovery && typeof env.recovery === "object");
	const recovery = env.recovery as Record<string, unknown>;
	const commands = recovery.commands as Array<Record<string, unknown>>;
	assert.ok(Array.isArray(commands));
	assert.ok(commands.some((cmd) => cmd.command === "pi-browser daemon status --json" && Array.isArray(cmd.argv)));
	assert.ok(commands.some((cmd) => cmd.command === "pi-browser tabs --action list --json" && Array.isArray(cmd.argv)));
});

test("doctor reports the pi-browser-tools package version, not the caller cwd package", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-doctor-cwd-"));
	try {
		writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "caller-project", version: "9.9.9" }), "utf8");
		const result = runCli(["doctor", "--json"], dir);
		assert.equal(result.code, 0, result.stderr);
		const env = parseOneJson(result.stdout);
		assert.equal(env.version, packageVersion);
		assert.notEqual(env.version, "9.9.9");
		assert.equal(env.cwd, dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("doctor reports a reachable daemon running without extension", () => {
	withFakeDaemonStatus(false, (envVars) => {
		const result = runCli(["doctor", "--json"], repoRoot, envVars);
		assert.equal(result.code, 0, result.stderr);
		const env = parseOneJson(result.stdout);
		const daemon = env.daemon as Record<string, unknown>;
		assert.equal(daemon.running, true);
		assert.equal(daemon.reachable, true);
		assert.equal(daemon.bridgeRunning, false);
		assert.equal(daemon.extensionConnected, false);
		assert.equal(daemon.versionStale, false);
		assert.equal(env.activeTab, null);
	});
});

test("doctor reports extension-connected daemon and active tab summary", () => {
	withFakeDaemonStatus(true, (envVars) => {
		const result = runCli(["doctor", "--json"], repoRoot, envVars);
		assert.equal(result.code, 0, result.stderr);
		const env = parseOneJson(result.stdout);
		const daemon = env.daemon as Record<string, unknown>;
		assert.equal(daemon.running, true);
		assert.equal(daemon.reachable, true);
		assert.equal(daemon.bridgePort, 18765);
		assert.equal(daemon.bridgeRunning, true);
		assert.equal(daemon.extensionConnected, true);
		assert.deepEqual(env.activeTab, { tabId: 7, id: 7, active: true, url: "https://example.test/", title: "Example" });
	});
});

test("status --json is read-only and does not start daemon", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-status-local-"));
	try {
		const result = runCli(["status", "--json"], repoRoot, { PI_BROWSER_DAEMON_STATE_DIR: dir });
		assert.equal(result.code, 0, result.stderr);
		const env = parseOneJson(result.stdout);
		assert.equal(env.ok, true);
		assert.equal(env.command, "status");
		assert.equal(env.ready, false);
		assert.equal(env.tabCount, 0);
		assert.equal("tabs" in env, false, "status is compact by default");
		assert.equal(existsSync(path.join(dir, "browser-daemon.json")), false, "status must not start daemon or write lockfile");
		const daemon = env.daemon as Record<string, unknown>;
		assert.equal(daemon.running, false);
		assert.equal(daemon.reachable, false);
		assert.ok(env.recovery && typeof env.recovery === "object");
		const commands = (env.recovery as Record<string, unknown>).commands as Array<Record<string, unknown>>;
		assert.ok(commands.some((cmd) => cmd.command === "pi-browser connect --wait --timeout-ms 15000 --json"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("status reports extension-connected daemon with active tab without mutating lifecycle", () => {
	withFakeDaemonStatus(true, (envVars) => {
		const result = runCli(["status", "--json"], repoRoot, envVars);
		assert.equal(result.code, 0, result.stderr);
		const env = parseOneJson(result.stdout);
		assert.equal(env.command, "status");
		assert.equal(env.ready, true);
		const bridge = env.bridge as Record<string, unknown>;
		assert.equal(bridge.running, true);
		assert.equal(bridge.port, 18765);
		assert.deepEqual(env.extension, { connected: true });
		assert.equal(env.tabCount, 1);
		assert.equal("tabs" in env, false, "status defaults to tabCount/activeTab without full tabs[]");
		assert.deepEqual(env.activeTab, { tabId: 7, id: 7, active: true, url: "https://example.test/", title: "Example" });
		const health = env.health as Record<string, unknown>;
		assert.equal(health.lastPingAt, 3000);
		assert.equal(health.lastPongAt, 4000);
		assert.equal(health.connectedForMs, 500);
		assert.equal(health.tabSyncAgeMs, 700);
	});
});

test("status --tabs expands full tab list on demand", () => {
	withFakeDaemonStatus(true, (envVars) => {
		const result = runCli(["status", "--tabs", "--json"], repoRoot, envVars);
		assert.equal(result.code, 0, result.stderr);
		const env = parseOneJson(result.stdout);
		assert.equal(env.tabCount, 1);
		assert.ok(Array.isArray(env.tabs));
		assert.deepEqual((env.tabs as unknown[])[0], { tabId: 7, id: 7, active: true, url: "https://example.test/", title: "Example" });
	});
});

test("connect --wait returns ready envelope when fake daemon extension is connected", () => {
	withFakeDaemonStatus(true, (envVars) => {
		const result = runCli(["connect", "--wait", "--timeout-ms", "1000", "--json"], repoRoot, envVars);
		assert.equal(result.code, 0, result.stderr || result.stdout);
		const env = parseOneJson(result.stdout);
		assert.equal(env.ok, true);
		assert.equal(env.command, "connect");
		assert.equal(env.ready, true);
		assert.equal(env.startedDaemon, false);
		const extension = env.extension as Record<string, unknown>;
		assert.equal(extension.connected, true);
		const bridge = env.bridge as Record<string, unknown>;
		assert.equal(bridge.running, true);
		assert.equal(bridge.port, 18765);
		assert.equal(env.tabCount, 1);
		assert.equal("tabs" in env, false, "connect defaults to compact tabCount/activeTab");
		assert.deepEqual(env.activeTab, { tabId: 7, id: 7, active: true, url: "https://example.test/", title: "Example" });
		const health = env.health as Record<string, unknown>;
		assert.equal(health.lastPongAt, 4000);
	});
});

test("connect --tabs expands full tab list on demand", () => {
	withFakeDaemonStatus(true, (envVars) => {
		const result = runCli(["connect", "--wait", "--timeout-ms", "1000", "--tabs", "--json"], repoRoot, envVars);
		assert.equal(result.code, 0, result.stderr || result.stdout);
		const env = parseOneJson(result.stdout);
		assert.equal(env.tabCount, 1);
		assert.ok(Array.isArray(env.tabs));
		assert.deepEqual((env.tabs as unknown[])[0], { tabId: 7, id: 7, active: true, url: "https://example.test/", title: "Example" });
	});
});

test("connect --wait returns parseable unavailable envelope when extension is not connected", () => {
	withFakeDaemonStatus(false, (envVars) => {
		const result = runCli(["connect", "--wait", "--timeout-ms", "100", "--json"], repoRoot, envVars);
		assert.equal(result.code, 3);
		assert.equal(result.stderr, "");
		const env = parseOneJson(result.stdout);
		assert.equal(env.ok, false);
		assert.equal(env.exitCode, 3);
		assert.equal(env.code, "CLI_EXTENSION_NOT_CONNECTED");
		assert.equal(env.command, "connect");
		assert.equal(env.ready, false);
		assert.deepEqual(env.extension, { connected: false });
		assert.equal("tabs" in env, false);
		const recovery = env.recovery as Record<string, unknown>;
		assert.ok((recovery.commands as Array<Record<string, unknown>>).some((cmd) => cmd.command === "pi-browser status --json"));
	});
});

test("daemon accepts leading --json before the lifecycle action", () => {
	const result = runCli(["daemon", "--json", "status"]);
	assert.equal(result.code, 0, result.stderr);
	const env = parseOneJson(result.stdout);
	assert.equal(env.ok, true);
	assert.equal(env.command, "daemon.status");
	assert.equal(typeof env.running, "boolean");
	assert.equal(env.expectedVersion, expectedDaemonVersion);
});

test("daemon status reports an unreachable live-pid lockfile without leaking the token", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-status-stale-lock-"));
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	try {
		assert.ok(child.pid, "child process started");
		writeFileSync(path.join(dir, "browser-daemon.json"), JSON.stringify({
			pid: child.pid,
			controlHost: "127.0.0.1",
			controlPort: 65514,
			token: "secret-token",
			startedAt: new Date().toISOString(),
			version: "0.0.0+daemon.0",
		}), "utf8");
		const result = runCli(["daemon", "status", "--json"], repoRoot, { PI_BROWSER_DAEMON_STATE_DIR: dir });
		assert.equal(result.code, 0, result.stderr);
		const env = parseOneJson(result.stdout);
		assert.equal(env.running, false);
		assert.ok(env.staleLockfile && typeof env.staleLockfile === "object");
		const stale = env.staleLockfile as Record<string, unknown>;
		assert.equal(stale.pid, child.pid);
		assert.equal(stale.pidAlive, true);
		assert.equal(stale.unreachable, true);
		assert.equal(stale.versionStale, true);
		assert.equal("token" in stale, false);
		const status = runCli(["status", "--json"], repoRoot, { PI_BROWSER_DAEMON_STATE_DIR: dir });
		assert.equal(status.code, 0, status.stderr);
		const statusEnv = parseOneJson(status.stdout);
		assert.equal(statusEnv.ready, false);
		const statusStale = ((statusEnv.daemon as Record<string, unknown>).staleLockfile as Record<string, unknown>);
		assert.equal(statusStale.pid, child.pid);
		assert.equal("token" in statusStale, false);
	} finally {
		if (child.pid) {
			try {
				process.kill(child.pid, "SIGTERM");
			} catch {
				/* already gone */
			}
		}
		if (child.exitCode === null) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 2_000);
				child.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		rmSync(dir, { recursive: true, force: true });
	}
});
