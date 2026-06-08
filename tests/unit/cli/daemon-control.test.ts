// Daemon discovery/lifecycle control — lockfile round-trip, pid liveness, and
// stale-lockfile reclamation. Pure control-plane logic; no BrowserBridgeServer.
// PI_BROWSER_DAEMON_STATE_DIR isolates the user-local state root into a temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
	lockfilePath,
	readLockfile,
	writeLockfile,
	removeLockfile,
	isPidAlive,
	findDaemon,
	ensureDaemon,
	controlRequest,
	isDaemonVersionCurrent,
	resolveDaemonStartCommand,
	stopDaemon,
	daemonSpawnEnv,
	startLockfilePath,
	type DaemonInfo,
} from "../../../cli/daemonControl.ts";
import { daemonVersion } from "../../../cli/packageInfo.ts";

function withTempStateDir(fn: () => Promise<void> | void): () => Promise<void> {
	return async () => {
		const prev = process.env.PI_BROWSER_DAEMON_STATE_DIR;
		const dir = mkdtempSync(path.join(os.tmpdir(), "pi-daemon-state-"));
		process.env.PI_BROWSER_DAEMON_STATE_DIR = dir;
		try {
			await fn();
		} finally {
			if (prev === undefined) delete process.env.PI_BROWSER_DAEMON_STATE_DIR;
			else process.env.PI_BROWSER_DAEMON_STATE_DIR = prev;
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

const sampleInfo = (over: Partial<DaemonInfo> = {}): DaemonInfo => ({
	pid: process.pid,
	controlHost: "127.0.0.1",
	controlPort: 65510,
	token: "deadbeef",
	startedAt: new Date().toISOString(),
	version: daemonVersion(),
	...over,
});

test("lockfile round-trips and lives under the configured state dir", withTempStateDir(() => {
	assert.equal(readLockfile(), undefined, "no lockfile initially");
	const info = sampleInfo();
	writeLockfile(info);
	assert.ok(existsSync(lockfilePath()), "lockfile written");
	assert.ok(lockfilePath().startsWith(process.env.PI_BROWSER_DAEMON_STATE_DIR!), "lockfile is under the user-local state dir, not caller .pi/");
	assert.deepEqual(readLockfile(), info);
	removeLockfile();
	assert.equal(readLockfile(), undefined, "removed");
}));

test("readLockfile rejects malformed content", withTempStateDir(() => {
	mkdirSync(path.dirname(lockfilePath()), { recursive: true });
	writeFileSync(lockfilePath(), "{ not json", "utf8");
	assert.equal(readLockfile(), undefined, "malformed JSON → undefined");
	writeFileSync(lockfilePath(), JSON.stringify({ pid: "x" }), "utf8");
	assert.equal(readLockfile(), undefined, "missing required fields → undefined");
}));

test("daemon version helper identifies stale lockfiles", () => {
	assert.equal(isDaemonVersionCurrent(sampleInfo()), true);
	assert.equal(isDaemonVersionCurrent(sampleInfo({ version: "9.9.9+daemon.4" })), true, "same daemon protocol stays compatible across package version changes");
	assert.equal(isDaemonVersionCurrent(sampleInfo({ version: "0.0.0+daemon.0" })), false);
	assert.equal(isDaemonVersionCurrent(sampleInfo({ version: "0.3.0+daemon.5" })), false);
});

test("resolveDaemonStartCommand runs the source tree via tsx and stays single-process where supported", () => {
	const prev = process.env.PI_BROWSER_DAEMON_ENTRY;
	try {
		delete process.env.PI_BROWSER_DAEMON_ENTRY;
		const command = resolveDaemonStartCommand();
		assert.equal(command.command, process.execPath);
		assert.deepEqual(command.args.slice(-2), ["daemon", "start"]);
		if (process.allowedNodeEnvironmentFlags?.has("--import") === true) {
			// In-process loader (`node --import tsx cli/bin.ts ...`): no child re-exec, so
			// the spawn's windowsHide keeps it invisible on Windows. cwd resolves bare tsx.
			assert.equal(command.args[0], "--import");
			assert.equal(command.args[1], "tsx");
			assert.match(command.args[2], /cli[\\/]+bin\.ts$/);
			assert.ok(command.cwd, "cwd is set so the bare `tsx` specifier resolves");
		} else {
			// Legacy fallback on Node without --import: the tsx CLI wrapper (re-execs).
			assert.match(command.args[0], /node_modules[\\/]+tsx[\\/]+dist[\\/]+cli\.mjs$/);
			assert.match(command.args[1], /cli[\\/]+bin\.ts$/);
		}
	} finally {
		if (prev === undefined) delete process.env.PI_BROWSER_DAEMON_ENTRY;
		else process.env.PI_BROWSER_DAEMON_ENTRY = prev;
	}
});

test("resolveDaemonStartCommand honors an explicit daemon entry override", () => {
	const prev = process.env.PI_BROWSER_DAEMON_ENTRY;
	try {
		process.env.PI_BROWSER_DAEMON_ENTRY = "D:\\custom\\daemon-entry.js";
		assert.deepEqual(resolveDaemonStartCommand(), {
			command: process.execPath,
			args: ["D:\\custom\\daemon-entry.js", "daemon", "start"],
		});
	} finally {
		if (prev === undefined) delete process.env.PI_BROWSER_DAEMON_ENTRY;
		else process.env.PI_BROWSER_DAEMON_ENTRY = prev;
	}
});

test("isPidAlive: current process alive, absurd pid dead, non-positive dead", () => {
	assert.equal(isPidAlive(process.pid), true);
	assert.equal(isPidAlive(2_147_483_646), false);
	assert.equal(isPidAlive(0), false);
	assert.equal(isPidAlive(-1), false);
});

test("findDaemon returns undefined and reclaims a stale lockfile (dead pid, no server)", withTempStateDir(async () => {
	assert.equal(await findDaemon(), undefined, "no lockfile → undefined");
	// Dead pid + a control port nobody listens on → unreachable + reclaimable.
	writeLockfile(sampleInfo({ pid: 2_147_483_646, controlPort: 65511 }));
	const found = await findDaemon();
	assert.equal(found, undefined, "unreachable daemon → undefined");
	assert.equal(existsSync(lockfilePath()), false, "stale lockfile with a dead pid is removed");
}));

test("findDaemon keeps the lockfile when the pid is still alive but unreachable", withTempStateDir(async () => {
	// Live pid (this process) but a control port with no server → must NOT reclaim,
	// to avoid yanking the lockfile from a slow-starting daemon.
	writeLockfile(sampleInfo({ pid: process.pid, controlPort: 65512 }));
	const found = await findDaemon();
	assert.equal(found, undefined, "still unreachable → undefined");
	assert.equal(existsSync(lockfilePath()), true, "live-pid lockfile is preserved");
}));

test("ensureDaemon waits on an existing start lock instead of spawning a competing daemon", withTempStateDir(async () => {
	mkdirSync(path.dirname(startLockfilePath()), { recursive: true });
	writeFileSync(startLockfilePath(), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), "utf8");
	const server = http.createServer((req, res) => {
		if (req.headers["x-pi-daemon-token"] !== "test-token") {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, running: true, extensionConnected: false, tabCount: 0, activeTab: null, tools: 22 }));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	try {
		setTimeout(() => {
			writeLockfile(sampleInfo({ controlPort: address.port, token: "test-token" }));
		}, 150);
		const info = await ensureDaemon({ startTimeoutMs: 2_000 });
		assert.equal(info.controlPort, address.port);
		assert.equal(existsSync(startLockfilePath()), true, "a start lock owned by another starter is not removed by the waiter");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}));

test("stopDaemon does not kill a live pid from an unreachable stale lockfile", withTempStateDir(async () => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	try {
		assert.ok(child.pid, "child process started");
		writeLockfile(sampleInfo({ pid: child.pid, controlPort: 65513 }));
		const stopped = await stopDaemon();
		assert.equal(stopped, false, "unreachable lockfile is not considered an addressed daemon");
		assert.equal(isPidAlive(child.pid), true, "stale lockfile PID must not be killed without /shutdown acknowledgement");
		assert.equal(existsSync(lockfilePath()), true, "live-pid lockfile is preserved for diagnostics/slow-start safety");
	} finally {
		if (child.pid && isPidAlive(child.pid)) {
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
	}
}));

test("controlRequest rejects oversized non-daemon responses", async () => {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(`"${"x".repeat(1024 * 1024 + 1)}"`);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	try {
		await assert.rejects(
			() => controlRequest({ controlHost: "127.0.0.1", controlPort: address.port, token: "unused" }, "GET", "/status", undefined, 2_000),
			/control response too large/,
		);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

const systemCaSupported = process.allowedNodeEnvironmentFlags?.has("--use-system-ca") === true;

test("daemonSpawnEnv opts out cleanly when PI_BROWSER_NO_SYSTEM_CA is set", () => {
	const base = { PI_BROWSER_NO_SYSTEM_CA: "1", NODE_OPTIONS: "--max-old-space-size=512" } as NodeJS.ProcessEnv;
	assert.equal(daemonSpawnEnv(base), base, "opt-out returns the base env untouched");
});

test("daemonSpawnEnv appends --use-system-ca to NODE_OPTIONS where supported", () => {
	const out = daemonSpawnEnv({ NODE_OPTIONS: "--max-old-space-size=512" } as NodeJS.ProcessEnv);
	if (systemCaSupported) {
		assert.equal(out.NODE_OPTIONS, "--max-old-space-size=512 --use-system-ca");
	} else {
		assert.equal(out.NODE_OPTIONS, "--max-old-space-size=512", "unsupported Node leaves NODE_OPTIONS unchanged");
	}
});

test("daemonSpawnEnv sets NODE_OPTIONS from empty and never double-adds the flag", () => {
	const fromEmpty = daemonSpawnEnv({} as NodeJS.ProcessEnv);
	assert.equal(fromEmpty.NODE_OPTIONS, systemCaSupported ? "--use-system-ca" : undefined);
	const already = daemonSpawnEnv({ NODE_OPTIONS: "--use-system-ca" } as NodeJS.ProcessEnv);
	assert.equal(already.NODE_OPTIONS, "--use-system-ca", "idempotent when the flag is already present");
});
