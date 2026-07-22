import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
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
	type DaemonInfo,
	type FoundDaemon,
} from "../../src/apps/daemon/daemonControl.ts";
import { startDaemon } from "../../src/apps/daemon/server.ts";
import { browserCommandDefinitions } from "../../src/commands/commandDefinitions.ts";

function identity(overrides: Partial<DaemonContractIdentity> = {}): DaemonContractIdentity {
	return { ...localDaemonContractIdentity(), ...overrides };
}

test("daemon identity is stable and includes the live command surface", () => {
	const definitions = browserCommandDefinitions();
	const first = createDaemonContractIdentity(definitions);
	const second = createDaemonContractIdentity(definitions);
	assert.equal(first.commandContractHash, second.commandContractHash);
	assert.match(first.commandContractHash, /^[a-f0-9]{64}$/);
	assert.equal(first.toolCount, definitions.length);
	const payload = commandContractPayload(browserCommandDefinitions());
	assert.match(payload.nativeProtocolHash, /^[a-f0-9]{64}$/);
	assert.ok(payload.commands.some((command) => command.name === "browser_execute"));
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

const DAEMON_CLIENT_SCRIPT = `
	const daemon = await import("./src/apps/daemon/daemonControl.ts");
	if (process.env.BROWSER_PILOT_TEST_ACTION === "stop") {
		console.log(JSON.stringify({ stopped: await daemon.stopDaemon() }));
	} else {
		const info = await daemon.ensureDaemon();
		console.log(JSON.stringify({ daemon: info, status: await daemon.pingStatus(info) }));
	}
`;

function runDaemonClient(action: "ensure" | "stop", stateDir: string) {
	return spawnSync("node", ["--import", "tsx", "--input-type=module", "--eval", DAEMON_CLIENT_SCRIPT], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: { ...process.env, BROWSER_PILOT_DAEMON_STATE_DIR: stateDir, BROWSER_PILOT_TEST_ACTION: action },
		});
}

function runDaemonClientAsync(stateDir: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
			const child = spawn("node", ["--import", "tsx", "--input-type=module", "--eval", DAEMON_CLIENT_SCRIPT], {
				cwd: process.cwd(),
				env: { ...process.env, BROWSER_PILOT_DAEMON_STATE_DIR: stateDir, BROWSER_PILOT_TEST_ACTION: "ensure" },
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

test("managed lifecycle drains and replaces a daemon whose lock identity is stale", () => {
	const stateDir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-contract-replace-"));
	const lockPath = path.join(stateDir, "browser-daemon.json");
	try {
			const first = runDaemonClient("ensure", stateDir);
		assert.equal(first.status, 0, first.stdout + first.stderr);
		const staleLock = JSON.parse(readFileSync(lockPath, "utf8")) as DaemonInfo;
		const firstPid = staleLock.pid;
		assert.ok(staleLock.contractIdentity);
		assert.equal(staleLock.contractIdentity.toolCount, browserCommandDefinitions().length);
		staleLock.contractIdentity = { ...staleLock.contractIdentity, toolCount: staleLock.contractIdentity.toolCount + 3 };
		writeFileSync(lockPath, `${JSON.stringify(staleLock, null, 2)}\n`, "utf8");

			const replaced = runDaemonClient("ensure", stateDir);
		assert.equal(replaced.status, 0, replaced.stdout + replaced.stderr);
		const currentLock = JSON.parse(readFileSync(lockPath, "utf8")) as DaemonInfo;
		assert.notEqual(currentLock.pid, firstPid);
			const body = JSON.parse(replaced.stdout) as { daemon: DaemonInfo; status: { contractIdentity: DaemonContractIdentity } };
			assert.deepEqual(body.status.contractIdentity, currentLock.contractIdentity);
		} finally {
			const stopped = runDaemonClient("stop", stateDir);
		assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
	}
});

test("concurrent clients converge on one contract-identical managed daemon", async () => {
	const stateDir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-contract-concurrent-"));
	const lockPath = path.join(stateDir, "browser-daemon.json");
	try {
		const clients = await Promise.all([
				runDaemonClientAsync(stateDir),
				runDaemonClientAsync(stateDir),
		]);
		for (const client of clients) assert.equal(client.status, 0, client.stdout + client.stderr);
		const lock = JSON.parse(readFileSync(lockPath, "utf8")) as DaemonInfo;
		assert.ok(lock.contractIdentity);
		for (const client of clients) {
			const body = JSON.parse(client.stdout) as { daemon?: { pid?: number } };
			assert.equal(body.daemon?.pid, lock.pid);
		}
		} finally {
			const stopped = runDaemonClient("stop", stateDir);
		assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
	}
});
