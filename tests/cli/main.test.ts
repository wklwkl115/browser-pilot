import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveDaemonStartCommand } from "../../src/apps/daemon/daemonControl.ts";
import { normalizeJsonEnvelope, renderResult } from "../../src/apps/cli/render.ts";
import { BROWSER_OPERATION_SCHEMA, classifyBrowserOperationStatus, type BrowserOperationStatus } from "../../src/kernels/session/browserOperation.ts";

function runNode(args: string[], cwd = process.cwd()) {
	return spawnSync("node", args, {
		cwd,
		encoding: "utf8",
	});
}

function runCli(args: string[]) {
	return runNode(["--import", "tsx", "src/apps/cli/bin.ts", ...args]);
}

function captureStdout(run: () => void): string {
	const originalWrite = process.stdout.write;
	const chunks: string[] = [];
	process.stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stdout.write;
	try {
		run();
	} finally {
		process.stdout.write = originalWrite;
	}
	return chunks.join("");
}

function nestedStringValues(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(nestedStringValues);
	if (value && typeof value === "object") return Object.values(value).flatMap(nestedStringValues);
	return [];
}

function operationEnvelope(status: BrowserOperationStatus, continuation: unknown = null) {
	return { schema: BROWSER_OPERATION_SCHEMA, status, ...classifyBrowserOperationStatus(status), continuation };
}

test("schema execute emits local JSON metadata", () => {
	const result = runCli(["schema", "execute", "--json"]);
	const body = JSON.parse(result.stdout);
	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	assert.equal(body.schema, "browser-pilot-command-schema/v3");
	assert.equal(body.contract.version, 3);
	assert.deepEqual(body.command, { cli: "execute", tool: "browser_execute" });
	assert.equal(body.parameters.type, "object");
	assert.equal(body.parameters.additionalProperties, false);
	assert.equal(typeof body.parameters.properties.script, "object");
	assert.equal(typeof body.parameters.properties.program, "object");
	assert.equal(body.flags, undefined);
});

test("CLI artifact read commands use safe placeholders and bounded returned hints", () => {
	const savedPath = "C:\\tmp\\artifact space $(whoami) `tick` $env:SECRET \\\"quoted\\\".json";
	const completionPath = "completion.evidence[$env:SECRET`$(whoami)]";
	const nextActionPath = "diagnostics[$env:OTHER`$(hostname)]";
	const unverifiedPath = "missing[$env:UNVERIFIED`$(hostname)]";
	const snapshotId = "snapshot $env:VALUE `$(hostname)";
	const body = normalizeJsonEnvelope({
		...operationEnvelope("completed"),
		saved: { path: savedPath, bytes: 100 },
		artifact_hints: {
			jsonPaths: { completionResult: completionPath, diagnostics: nextActionPath },
			preferredReads: [{ jsonPath: completionPath }, { jsonPath: nextActionPath }],
		},
		nextActions: [
			`read_saved_artifact mode=json jsonPath=${completionPath}`,
			`read_saved_artifact mode=json jsonPath=${nextActionPath}`,
			`read_saved_artifact mode=json jsonPath=${unverifiedPath}`,
		],
		snapshot: { snapshotId },
	}, 0, "OK") as Record<string, unknown>;
	const artifacts = body.artifacts as Array<Record<string, unknown>>;
	assert.equal(artifacts.length, 1);
	assert.equal(artifacts[0]?.path, savedPath);
	assert.deepEqual(artifacts[0]?.jsonPaths, [completionPath, nextActionPath]);
	const reads = artifacts[0]?.readCommands as Array<{ command: string; argvTemplate: string[]; pathRef: string; jsonPathRef?: string }>;
	assert.equal(nestedStringValues(artifacts[0]).filter((value) => value === savedPath).length, 1);
	assert.equal(reads.length, 3);
	assert.deepEqual(reads.map((read) => read.command), [
		"browser-pilot artifact --path <saved.path> --mode inspect --json",
		"browser-pilot artifact --path <saved.path> --mode paths --json",
		"browser-pilot artifact --path <saved.path> --mode json --json-path <verified-json-path> --json",
	]);
	for (const read of reads) {
		assert.equal(read.command.includes(savedPath), false);
		assert.equal(read.command.includes(completionPath), false);
		assert.equal(read.argvTemplate[3], "<saved.path>");
		assert.equal(read.pathRef, "path");
		assert.equal(JSON.stringify(read).includes(savedPath), false);
	}
	assert.equal(reads.some((read) => read.command.includes("--mode search")), false);
	assert.equal(reads[2]?.argvTemplate[7], "<verified-json-path>");
	assert.equal(reads[2]?.jsonPathRef, "jsonPaths[0]");

	const cliNextActions = body.cliNextActions as Array<{ kind: string; command: string; argv?: string[]; argvTemplate?: string[]; pathRef?: string; jsonPathRef?: string }>;
	const artifactActions = cliNextActions.filter((action) => action.kind === "artifact-read");
	assert.equal(artifactActions.length, 1);
	const artifactAction = artifactActions[0];
	assert.equal(artifactAction?.command, "browser-pilot artifact --path <saved.path> --mode json --json-path <verified-json-path> --json");
	assert.equal(artifactAction?.command.includes(savedPath), false);
	assert.equal(artifactAction?.command.includes(nextActionPath), false);
	assert.equal(artifactAction?.argvTemplate?.[3], "<saved.path>");
	assert.equal(artifactAction?.argvTemplate?.[7], "<verified-json-path>");
	assert.equal(artifactAction?.pathRef, "artifacts[0].path");
	assert.equal(artifactAction?.jsonPathRef, "artifacts[0].jsonPaths[1]");
	assert.equal(nestedStringValues(cliNextActions).includes(savedPath), false);
	assert.equal(nestedStringValues(cliNextActions).includes(unverifiedPath), false);
	const baselineAction = cliNextActions.find((action) => action.kind === "observe-baseline");
	assert.equal(baselineAction?.command, "browser-pilot observe --baseline-snapshot-id <snapshot.snapshotId> --json");
	assert.equal(baselineAction?.command.includes(snapshotId), false);
	assert.equal(baselineAction?.argv?.[3], snapshotId);
});

test("CLI artifact read commands omit targeted and search reads without verified hints", () => {
	const body = normalizeJsonEnvelope({
		saved: { path: "C:\\tmp\\operation.json" },
	}, 0, "OK") as Record<string, unknown>;
	const artifact = (body.artifacts as Array<Record<string, unknown>>)[0];
	const reads = artifact?.readCommands as Array<{ command: string }>;
	assert.deepEqual(artifact?.jsonPaths, []);
	assert.equal(reads.length, 2);
	assert.equal(reads.some((read) => read.command.includes("--mode search")), false);
	assert.equal(reads.some((read) => read.command.includes("--mode json")), false);
});

test("human rendering exposes the direct browser operation terminal contract", () => {
	let exitCode = -1;
	const output = captureStdout(() => {
		exitCode = renderResult({
			content: [{
				type: "text",
				text: JSON.stringify({
					...operationEnvelope("completed", { next: "inspect_artifact", replay: "not_needed", reason: "result_compacted" }),
					operationId: "op-123",
					commandName: "browser_execute",
					dispatch: { acknowledged: true, started: true, finished: true },
					completion: { source: "native-command-result", evidence: { result: 42 } },
					saved: { path: "C:\\tmp\\operation.json" },
				}),
			}],
		}, "human");
	});
	assert.equal(exitCode, 0);
	assert.match(output, /^browser_execute · completed/m);
	assert.match(output, /^operation: op-123/m);
	assert.match(output, /^dispatch: acknowledged · finished/m);
	assert.match(output, /^completion: native-command-result/m);
	assert.match(output, /^continuation: inspect_artifact · replay not_needed · result_compacted/m);
	assert.match(output, /^artifact: C:\\tmp\\operation\.json/m);
});

test("human rendering never emits a blank line for a small execute success", () => {
	const output = captureStdout(() => {
		renderResult({
			content: [{
				type: "text",
				text: JSON.stringify({
					...operationEnvelope("completed"),
					operationId: "op-small",
					commandName: "browser_execute",
					dispatch: { acknowledged: true, started: true, finished: true },
					completion: { source: "native-command-result", evidence: { result: 2 } },
				}),
			}],
		}, "human");
	});
	assert.notEqual(output, "\n");
	assert.match(output, /^browser_execute · completed/m);
	assert.match(output, /^completion: native-command-result/m);
});

test("validate execute loads a script @file into args.script", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-cli-"));
	const scriptPath = path.join(dir, "snippet.js");
	writeFileSync(scriptPath, "1 + 1;\n", "utf8");
	const result = runCli([
		"validate",
		"execute",
		"--params",
		JSON.stringify({ tabId: 1, script: `@${scriptPath}` }),
		"--json",
	]);
	const body = JSON.parse(result.stdout);
	assert.equal(result.status, 0);
	assert.equal(body.command, "validate");
	assert.equal(body.valid, true);
	assert.deepEqual(body.args, { tabId: 1, script: "1 + 1;\n" });
});

test("validate execute reports script @file read failures as CLI input errors", () => {
	const result = runCli([
		"validate",
		"execute",
		"--params",
		JSON.stringify({ tabId: 1, script: "@./does-not-exist.js" }),
		"--json",
	]);
	const body = JSON.parse(result.stdout);
	assert.equal(result.status, 4);
	assert.equal(body.code, "CLI_INPUT_ERROR");
	assert.match(body.message, /cannot read .*does-not-exist\.js/i);
});

test("commands emits registered subcommands in json mode", () => {
	const result = runCli(["commands", "--json"]);
	const body = JSON.parse(result.stdout);
	assert.equal(result.status, 0);
	assert.equal(body.schema, "browser-pilot-command-catalog/v3");
	assert.equal(body.contract.version, 3);
	assert.equal(body.contract.toolCount, 22);
	assert.ok(body.commands.some((command: { cli: string; tool: string }) => command.cli === "execute" && command.tool === "browser_execute"));
	assert.equal(Buffer.byteLength(result.stdout, "utf8") <= 25 * 1024, true);
	assert.equal(body.commands.some((command: Record<string, unknown>) => "flags" in command || "artifactBehavior" in command), false);
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

test("removed wait subcommand is an explicit unknown command with no compatibility execution", () => {
	const result = runCli(["wait", "selector", "--selector", "#result", "--json"]);
	const body = JSON.parse(result.stdout);
	assert.equal(result.status, 2);
	assert.equal(body.code, "CLI_USAGE_ERROR");
	assert.match(String(body.message), /unknown command.*wait/i);
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
	assert.match(execute.stdout, /--script <string>/);
	assert.match(execute.stdout, /stdin \(-\)/i);
});

test("schema command marks --command as inline-only", () => {
	const result = runCli(["schema", "command", "--json"]);
	const body = JSON.parse(result.stdout);
	assert.equal(result.status, 0);
	assert.equal(body.schema, "browser-pilot-command-schema/v3");
	assert.deepEqual(body.command, { cli: "command", tool: "browser_command" });
	assert.match(body.parameters.properties.command.description, /Validated native bridge command object/);
	assert.equal(body.flags, undefined);
});

test("command help rejects --command @file guidance and execute help recommends unified script inputs", () => {
	const command = runCli(["command", "--help"]);
	const execute = runCli(["execute", "--help"]);
	assert.equal(command.status, 0);
	assert.match(command.stdout, /--command <json>/);
	assert.match(command.stdout, /inline JSON only/);
	assert.match(command.stdout, /do not use --command @file/);
	assert.equal(execute.status, 0);
	assert.match(execute.stdout, /--program <array>/);
	assert.match(execute.stdout, /--program @file/);
	assert.match(execute.stdout, /--script @file/);
	assert.match(execute.stdout, /--script -/);
	assert.doesNotMatch(execute.stdout, /--script-file/);
});

test("command --command @file fails as inline-only", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-cli-"));
	const commandPath = path.join(dir, "command.json");
	writeFileSync(commandPath, JSON.stringify({ cmd: "tabs", method: "list" }), "utf8");
	const result = runCli(["command", "--command", `@${commandPath}`, "--json"]);
	const body = JSON.parse(result.stdout);
	assert.equal(result.status, 2);
	assert.equal(body.code, "CLI_USAGE_ERROR");
	assert.match(body.message, /inline JSON/);
});

test("package layout keeps Windows bin target and help imports aligned when built", () => {
	const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
	const binTarget = pkg.bin["browser-pilot"] as string;
	assert.equal(binTarget.replaceAll("\\", "/"), "./dist/src/apps/cli/bin.js");
	const builtEntry = path.join(process.cwd(), binTarget);
	assert.equal(existsSync(builtEntry), true);
	const helpImport = path.join(path.dirname(builtEntry), "help.js");
	const mainImport = path.join(path.dirname(builtEntry), "main.js");
	assert.equal(existsSync(helpImport), true);
	assert.equal(existsSync(mainImport), true);
	const source = readFileSync(builtEntry, "utf8");
	assert.match(source, /import\("\.\/help\.js"\)/);
	assert.match(source, /import\("\.\/main\.js"\)/);
});

test("built package bin --help works from a Windows-style global shim layout", () => {
	const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
	const binTarget = pkg.bin["browser-pilot"] as string;
	const packageRoot = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-package-"));
	const cliDir = path.join(packageRoot, "dist", "src", "apps", "cli");
	mkdirSync(cliDir, { recursive: true });
	for (const fileName of ["bin.js", "help.js", "main.js"]) copyFileSync(path.join(process.cwd(), "dist", "src", "apps", "cli", fileName), path.join(cliDir, fileName));
	const result = runNode([path.join(packageRoot, binTarget), "--help"], packageRoot);
	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	assert.match(result.stdout, /^Usage:/m);
	assert.match(result.stdout, /^Commands:/m);
});

test("built package bin gives recovery guidance when adjacent files are not built", () => {
	const packageRoot = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-unbuilt-"));
	const cliDir = path.join(packageRoot, "dist", "src", "apps", "cli");
	mkdirSync(cliDir, { recursive: true });
	copyFileSync(path.join(process.cwd(), "dist", "src", "apps", "cli", "bin.js"), path.join(cliDir, "bin.js"));
	const result = runNode([path.join(cliDir, "bin.js"), "--help"], packageRoot);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /browser-pilot CLI is missing built files required by the package entrypoint/);
	assert.match(result.stderr, /npm run build/);
	assert.match(result.stderr, /reinstall browser-pilot/);
	assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);
});

test("bin --help prints top-level usage and exits cleanly", () => {
	const result = runCli(["--help"]);
	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	assert.match(result.stdout, /browser-pilot — agent browser control via the local bridge daemon/);
	assert.match(result.stdout, /Agent primary loop/);
	assert.match(result.stdout, /^Usage:/m);
	assert.match(result.stdout, /^Commands:/m);
	assert.match(result.stdout, /^\s+view\s+/m);
	assert.match(result.stdout, /^\s+act\s+/m);
	assert.match(result.stdout, /^\s+read\s+/m);
});

test("cli main refactor target stays within the file-size budget", () => {
	const filePath = path.join(process.cwd(), "src/apps/cli/main.ts");
	const lines = readFileSync(filePath, "utf8").split(/\r?\n/).length;
	assert.ok(lines <= 200, `expected src/apps/cli/main.ts to stay within 200 lines, got ${lines}`);
});
