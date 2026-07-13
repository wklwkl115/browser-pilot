import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import {
	canonicalContractJson,
	commandContractHash,
	commandContractPayload,
	compareDaemonContractIdentity,
	createDaemonContractIdentity,
	localDaemonContractIdentity,
	type DaemonContractIdentity,
} from "../../src/apps/daemon/contractIdentity.ts";
import {
	controlRequest,
	isDaemonReadyForReuse,
	replaceStaleDaemon,
	resolveDaemonStartCommand,
	type DaemonInfo,
	type FoundDaemon,
} from "../../src/apps/daemon/daemonControl.ts";
import { startDaemon } from "../../src/apps/daemon/server.ts";
import { collectCommandDefs } from "../../src/apps/cli/registry.ts";
import type { CommandDefinition } from "../../src/commands/commandManifestIndex.ts";
import { strictCommandParameters } from "../../src/commands/commandShared.ts";
import { BROWSER_OPERATION_OUTCOME_CONTRACT, BROWSER_OPERATION_SCHEMA } from "../../src/kernels/session/browserOperation.ts";

function definition(parameters: unknown, description = "display prose"): CommandDefinition {
	return {
		name: "browser_contract_fixture",
		description,
		parameters,
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	};
}

function identity(overrides: Partial<DaemonContractIdentity> = {}): DaemonContractIdentity {
	return { ...localDaemonContractIdentity(), ...overrides };
}

test("command contract canonicalization and SHA-256 identity are stable", () => {
	const definitions = collectCommandDefs();
	const identities = Array.from({ length: 10 }, () => createDaemonContractIdentity(definitions));
	assert.equal(new Set(identities.map((item) => item.commandContractHash)).size, 1);
	assert.match(identities[0]!.commandContractHash, /^[a-f0-9]{64}$/);
	assert.equal(identities[0]!.toolCount, definitions.length);
	assert.equal(identities[0]!.toolCount, 19);
	assert.deepEqual(Object.keys(identities[0]!).sort(), [
		"commandContractHash",
		"commandContractVersion",
		"daemonProtocolVersion",
		"packageVersion",
		"toolCount",
	]);
	assert.equal(canonicalContractJson({ z: 1, a: { y: 2, x: 3 } }), canonicalContractJson({ a: { x: 3, y: 2 }, z: 1 }));
});

test("source execution starts the source daemon even when stale dist output exists", () => {
	const command = resolveDaemonStartCommand();
	assert.ok(command.args.some((arg) => arg.replaceAll("\\", "/").endsWith("src/apps/cli/bin.ts")), JSON.stringify(command));
});

test("contract payload includes canonical actions, operation-v2 outcomes, and native protocol hash", () => {
	const payload = commandContractPayload(collectCommandDefs());
	assert.deepEqual(payload.operationResult, { schema: BROWSER_OPERATION_SCHEMA, outcomes: BROWSER_OPERATION_OUTCOME_CONTRACT });
	assert.match(payload.nativeProtocolHash, /^[a-f0-9]{64}$/);
	assert.ok(payload.actions.some((action) => action.commandName === "browser_network" && action.action === "captureReload" && action.cliAction === "capture-reload"));
	assert.equal(payload.actions.some((action) => action.commandName === "browser_network" && action.action === "wait"), false);
	assert.ok(payload.commands.some((command) => command.name === "browser_execute"));
	assert.ok(payload.commands.some((command) => command.name === "browser_tabs" && command.cliSubcommands.some((route) => route.token === "list" && route.parameter === "action" && route.value === "list")));
	assert.ok(payload.commands.some((command) => command.name === "browser_artifact" && ["inspect", "paths", "json"].every((token) => command.cliSubcommands.some((route) => route.token === token && route.parameter === "mode" && route.value === token))));
});

test("every declared contract component participates in the outer hash", () => {
	const payload = commandContractPayload(collectCommandDefs());
	const original = commandContractHash(payload);
	const mutate = (change: (copy: CommandContractPayloadClone) => void): string => {
		const copy = structuredClone(payload) as unknown as CommandContractPayloadClone;
		change(copy);
		return commandContractHash(copy as unknown as typeof payload);
	};
	type Outcome = { classification: string; completionVerified: boolean; ok: boolean; code?: string };
	type CommandContractPayloadClone = {
		commands: Array<{ name: string; parameters: unknown; cliSubcommands: Array<{ token: string; parameter: string; value: string }> }>;
		actions: Array<Record<string, unknown>>;
		operationResult: { schema: string; outcomes: Record<string, Outcome> };
		daemonProtocolVersion: number;
		nativeProtocolHash: string;
	};
	assert.notEqual(mutate((copy) => { copy.commands[0]!.name += "_changed"; }), original);
	assert.notEqual(mutate((copy) => { copy.commands[0]!.parameters = { type: "null" }; }), original);
	const routedCommandIndex = payload.commands.findIndex((command) => command.cliSubcommands.length > 0);
	assert.ok(routedCommandIndex >= 0);
	assert.notEqual(mutate((copy) => { copy.commands[routedCommandIndex]!.cliSubcommands[0]!.value += "_changed"; }), original);
	assert.notEqual(mutate((copy) => { copy.actions[0]!.schemaRef = "changed"; }), original);
	assert.notEqual(mutate((copy) => { copy.operationResult.outcomes.failed!.code = "CHANGED"; }), original);
	assert.notEqual(mutate((copy) => { copy.daemonProtocolVersion += 1; }), original);
	assert.notEqual(mutate((copy) => { copy.nativeProtocolHash = "0".repeat(64); }), original);
});

test("schema behavior changes affect the hash while prose annotations do not", () => {
	const stringDescription = strictCommandParameters({ description: Type.String({ description: "first prose" }) });
	const numberDescription = strictCommandParameters({ description: Type.Number({ description: "first prose" }) });
	const changedAnnotation = strictCommandParameters({ description: Type.String({ description: "second prose" }) });
	const first = createDaemonContractIdentity([definition(stringDescription, "first command prose")]);
	const proseOnly = createDaemonContractIdentity([definition(changedAnnotation, "second command prose")]);
	const behavior = createDaemonContractIdentity([definition(numberDescription)]);
	assert.equal(first.commandContractHash, proseOnly.commandContractHash);
	assert.notEqual(first.commandContractHash, behavior.commandContractHash);
});

test("full identity comparison and daemon reuse reject every mismatched field", () => {
	const local = identity();
	assert.equal(compareDaemonContractIdentity(local, local).ok, true);
	for (const field of ["packageVersion", "daemonProtocolVersion", "commandContractVersion", "commandContractHash", "toolCount"] as const) {
		const daemon = { ...local } as DaemonContractIdentity;
		if (field === "packageVersion") daemon[field] = `${local[field]}-stale`;
		else if (field === "commandContractHash") daemon[field] = "0".repeat(64);
		else (daemon as unknown as Record<string, number>)[field] = Number(local[field]) + 1;
		const check = compareDaemonContractIdentity(local, daemon);
		assert.equal(check.ok, false, field);
		assert.equal(check.mismatches[0]?.field, field);
	}

	const info: DaemonInfo = {
		pid: process.pid,
		controlHost: "127.0.0.1",
		controlPort: 1,
		token: "token",
		startedAt: new Date(0).toISOString(),
		version: "display-only",
		contractIdentity: local,
	};
	const found: FoundDaemon = { info, status: { ok: true, contractIdentity: local } };
	assert.equal(isDaemonReadyForReuse(found), true);
	assert.equal(isDaemonReadyForReuse({ ...found, status: { ok: true, contractIdentity: identity({ toolCount: local.toolCount + 1 }) } }), false);
	assert.equal(isDaemonReadyForReuse({ ...found, info: { ...info, contractIdentity: undefined } }), false);
});

test("graceful stale replacement fails explicitly when a live daemon refuses shutdown", async () => {
	const server = http.createServer((_req, res) => {
		res.writeHead(503, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: false }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const info: DaemonInfo = {
			pid: process.pid,
			controlHost: "127.0.0.1",
			controlPort: address.port,
			token: "token",
			startedAt: new Date(0).toISOString(),
			version: "stale",
		};
		await assert.rejects(() => replaceStaleDaemon(info, { graceMs: 10 }), (error: unknown) => {
			assert.equal((error as { code?: unknown }).code, "DAEMON_REPLACEMENT_FAILED");
			return true;
		});
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("graceful stale replacement reports drain timeout without killing the old process", async () => {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address === "object");
		await assert.rejects(() => replaceStaleDaemon({
			pid: process.pid,
			controlHost: "127.0.0.1",
			controlPort: address.port,
			token: "token",
			startedAt: new Date(0).toISOString(),
			version: "stale",
		}, { graceMs: 10 }), (error: unknown) => {
			assert.equal((error as { code?: unknown }).code, "DAEMON_REPLACEMENT_FAILED");
			assert.match(String((error as Error).message), /did not drain/);
			return true;
		});
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("graceful stale replacement waits for an acknowledged managed process to exit", async () => {
	const child = spawn(process.execPath, ["-e", `
		const http = require("node:http");
		const server = http.createServer((req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			if (req.url === "/shutdown") setImmediate(() => server.close(() => process.exit(0)));
		});
		server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
	`], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	assert.ok(child.pid);
	const lines = createInterface({ input: child.stdout! });
	const port = await new Promise<number>((resolve, reject) => {
		lines.once("line", (line) => resolve(Number(line)));
		child.once("exit", (code) => reject(new Error(`replacement fixture exited before ready (${code})`)));
	});
	try {
		await replaceStaleDaemon({
			pid: child.pid!,
			controlHost: "127.0.0.1",
			controlPort: port,
			token: "token",
			startedAt: new Date(0).toISOString(),
			version: "stale",
		}, { graceMs: 2_000 });
	} finally {
		lines.close();
		if (child.exitCode === null) child.kill();
	}
});

test("daemon status publishes the exact identity used by its command registry", async () => {
	const daemon = await startDaemon({ writeLock: false, startBridgeEagerly: false });
	try {
		const response = await controlRequest(daemon, "GET", "/status", undefined, 1_000);
		assert.equal(response.status, 200);
		assert.deepEqual(response.json?.contractIdentity, daemon.contractIdentity);
		assert.equal(response.json?.tools, daemon.contractIdentity.toolCount);
	} finally {
		await daemon.close();
	}
});

function runCli(args: string[], stateDir: string) {
	return spawnSync("node", ["--import", "tsx", "src/apps/cli/bin.ts", ...args], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...process.env, BROWSER_PILOT_DAEMON_STATE_DIR: stateDir },
	});
}

function runCliAsync(args: string[], stateDir: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("node", ["--import", "tsx", "src/apps/cli/bin.ts", ...args], {
			cwd: process.cwd(),
			env: { ...process.env, BROWSER_PILOT_DAEMON_STATE_DIR: stateDir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		child.once("error", reject);
		child.once("close", (status) => resolve({ status, stdout, stderr }));
	});
}

test("status and doctor query normally but --check exits 1 on a missing daemon identity", () => {
	const stateDir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-contract-check-"));
	for (const command of ["status", "doctor"] as const) {
		const query = runCli([command, "--json"], stateDir);
		const checked = runCli([command, "--check", "--json"], stateDir);
		const queryBody = JSON.parse(query.stdout) as Record<string, unknown>;
		const checkedBody = JSON.parse(checked.stdout) as Record<string, unknown>;
		assert.equal(query.status, 0, `${command}: ${query.stderr}`);
		assert.equal((queryBody.contract as { check: { ok: boolean } }).check.ok, false);
		assert.equal(checked.status, 1, `${command}: ${checked.stderr}`);
		assert.equal(checkedBody.ok, false);
		assert.equal(checkedBody.code, "DAEMON_CONTRACT_MISMATCH");
		assert.equal((checkedBody.contract as { local: { commandContractVersion: number } }).local.commandContractVersion, 3);
		assert.equal((checkedBody.contract as { daemon: unknown }).daemon, null);
	}
});

test("managed lifecycle drains and replaces a daemon whose lock identity is stale", () => {
	const stateDir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-contract-replace-"));
	const lockPath = path.join(stateDir, "browser-daemon.json");
	try {
		const first = runCli(["connect", "--json"], stateDir);
		assert.equal(first.status, 0, first.stdout + first.stderr);
		const staleLock = JSON.parse(readFileSync(lockPath, "utf8")) as DaemonInfo;
		const firstPid = staleLock.pid;
		assert.ok(staleLock.contractIdentity);
		assert.equal(staleLock.contractIdentity.toolCount, 19);
		staleLock.contractIdentity = { ...staleLock.contractIdentity, toolCount: staleLock.contractIdentity.toolCount + 3 };
		writeFileSync(lockPath, `${JSON.stringify(staleLock, null, 2)}\n`, "utf8");

		const replaced = runCli(["connect", "--json"], stateDir);
		assert.equal(replaced.status, 0, replaced.stdout + replaced.stderr);
		const currentLock = JSON.parse(readFileSync(lockPath, "utf8")) as DaemonInfo;
		assert.notEqual(currentLock.pid, firstPid);
		const checked = runCli(["status", "--check", "--json"], stateDir);
		assert.equal(checked.status, 0, checked.stdout + checked.stderr);
		const body = JSON.parse(checked.stdout) as { contract: { check: { ok: boolean }; daemon: DaemonContractIdentity; lock: DaemonContractIdentity } };
		assert.equal(body.contract.check.ok, true);
		assert.deepEqual(body.contract.daemon, body.contract.lock);
	} finally {
		const stopped = runCli(["daemon", "stop", "--json"], stateDir);
		assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
	}
});

test("concurrent clients converge on one contract-identical managed daemon", async () => {
	const stateDir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-contract-concurrent-"));
	const lockPath = path.join(stateDir, "browser-daemon.json");
	try {
		const clients = await Promise.all([
			runCliAsync(["connect", "--json"], stateDir),
			runCliAsync(["connect", "--json"], stateDir),
		]);
		for (const client of clients) assert.equal(client.status, 0, client.stdout + client.stderr);
		const lock = JSON.parse(readFileSync(lockPath, "utf8")) as DaemonInfo;
		assert.ok(lock.contractIdentity);
		for (const client of clients) {
			const body = JSON.parse(client.stdout) as { daemon?: { pid?: number } };
			assert.equal(body.daemon?.pid, lock.pid);
		}
		const checked = runCli(["status", "--check", "--json"], stateDir);
		assert.equal(checked.status, 0, checked.stdout + checked.stderr);
		assert.equal((JSON.parse(checked.stdout) as { daemon: { pid: number } }).daemon.pid, lock.pid);
	} finally {
		const stopped = runCli(["daemon", "stop", "--json"], stateDir);
		assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
	}
});
