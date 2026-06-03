// Daemon discovery/lifecycle control — lockfile round-trip, pid liveness, and
// stale-lockfile reclamation. Pure control-plane logic; no BrowserBridgeServer.
// PI_BROWSER_DAEMON_STATE_DIR isolates the user-local state root into a temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	lockfilePath,
	readLockfile,
	writeLockfile,
	removeLockfile,
	isPidAlive,
	findDaemon,
	type DaemonInfo,
} from "../../../cli/daemonControl.ts";

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
	version: "1",
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
