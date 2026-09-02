import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectStatus, renderStatus } from "../../src/apps/mcp/status.ts";
import type { DaemonInfo, DaemonStatus, FoundDaemon } from "../../src/apps/daemon/daemonControl.ts";
import { localDaemonContractIdentity } from "../../src/apps/daemon/contractIdentity.ts";

async function scratch(t: { after(fn: () => Promise<void>): void }): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-status-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function fakePackage(root: string): Promise<void> {
	await mkdir(path.join(root, "bridge", "browser_pilot_bridge", "dist"), { recursive: true });
	await writeFile(path.join(root, "bridge", "browser_pilot_bridge", "dist", "service-worker.js"), "// worker");
}

async function fakeInstall(stateDir: string, buildId = "build-1"): Promise<void> {
	await mkdir(path.join(stateDir, "extension", "dist"), { recursive: true });
	await writeFile(path.join(stateDir, "extension", "manifest.json"), JSON.stringify({ version: "0.7.0" }));
	await writeFile(path.join(stateDir, "extension", "dist", "build-manifest.json"), JSON.stringify({ buildId }));
}

function daemonInfo(): DaemonInfo {
	return {
		pid: 4242,
		controlHost: "127.0.0.1",
		controlPort: 5555,
		token: "t",
		startedAt: "2026-09-03T00:00:00.000Z",
		version: "0.7.0+daemon.6",
		contractIdentity: localDaemonContractIdentity(),
	};
}

function daemonStatus(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
	return {
		ok: true,
		running: true,
		bridgePort: 6000,
		readiness: "ready",
		extensionConnected: true,
		extension: { id: "ext", version: "0.7.0", extensionStale: false },
		tabCount: 3,
		health: { connectedForMs: 1000 },
		contractIdentity: localDaemonContractIdentity(),
		...overrides,
	};
}

function byId(report: Awaited<ReturnType<typeof collectStatus>>, id: string) {
	const check = report.checks.find((item) => item.id === id);
	assert.ok(check, `${id} check should exist`);
	return check;
}

test("status reports a healthy install, daemon, and extension link", async (t) => {
	const root = await scratch(t);
	const state = await scratch(t);
	await fakePackage(root);
	await fakeInstall(state);
	const found: FoundDaemon = { info: daemonInfo(), status: daemonStatus() };
	const report = await collectStatus({
		stateDir: () => state,
		packageRoot: () => root,
		findDaemon: async () => found,
		readLockfile: () => found.info,
		isPidAlive: () => true,
		expectedBuildId: () => "build-1",
	});
	assert.equal(report.verdict, "ok");
	assert.deepEqual(
		report.checks.map((check) => [check.id, check.level]),
		[
			["packaged-extension", "ok"],
			["installed-extension", "ok"],
			["daemon", "ok"],
			["daemon-contract", "ok"],
			["bridge", "ok"],
		],
	);
	assert.match(renderStatus(report), /Everything looks ready/);
	assert.match(renderStatus(report), /Extension 0\.7\.0 connected \(3 tabs tracked\)/);
});

test("status explains a missing install and a never-connected extension with fixes", async (t) => {
	const root = await scratch(t);
	const state = await scratch(t);
	await fakePackage(root);
	const found: FoundDaemon = {
		info: daemonInfo(),
		status: daemonStatus({ extensionConnected: false, extension: undefined, tabCount: 0, health: {} }),
	};
	const report = await collectStatus({
		stateDir: () => state,
		packageRoot: () => root,
		findDaemon: async () => found,
		readLockfile: () => found.info,
		isPidAlive: () => true,
		expectedBuildId: () => "build-1",
	});
	assert.equal(report.verdict, "fail");
	assert.equal(byId(report, "installed-extension").level, "fail");
	assert.match(byId(report, "installed-extension").fix ?? "", /npx browser-pilot-mcp install/);
	assert.equal(byId(report, "bridge").level, "fail");
	assert.match(byId(report, "bridge").summary, /No browser extension has connected/);
	assert.match(renderStatus(report), /Not ready/);
});

test("status flags stale extension files, stale connected builds, and idle service workers", async (t) => {
	const root = await scratch(t);
	const state = await scratch(t);
	await fakePackage(root);
	await fakeInstall(state, "build-old");
	const found: FoundDaemon = {
		info: daemonInfo(),
		status: daemonStatus({
			extension: { id: "ext", version: "0.6.0", extensionStale: true, expectedBuild: "b2", reportedBuild: "b1" },
		}),
	};
	const stale = await collectStatus({
		stateDir: () => state,
		packageRoot: () => root,
		findDaemon: async () => found,
		readLockfile: () => found.info,
		isPidAlive: () => true,
		expectedBuildId: () => "build-new",
	});
	assert.equal(stale.verdict, "warn");
	assert.equal(byId(stale, "installed-extension").level, "warn");
	assert.equal(byId(stale, "extension-build").level, "warn");

	const idle: FoundDaemon = {
		info: daemonInfo(),
		status: daemonStatus({
			extensionConnected: false,
			health: { lastDisconnectAt: Date.now() - 5000, lastDisconnectReason: "worker_idle" },
		}),
	};
	const dropped = await collectStatus({
		stateDir: () => state,
		packageRoot: () => root,
		findDaemon: async () => idle,
		readLockfile: () => idle.info,
		isPidAlive: () => true,
		expectedBuildId: () => "build-old",
	});
	assert.match(byId(dropped, "bridge").summary, /connected before but is not connected now/);
	assert.match(byId(dropped, "bridge").fix ?? "", /Open or reload any browser tab/);
});

test("status distinguishes no daemon, a dead lockfile, and a contract mismatch", async (t) => {
	const root = await scratch(t);
	const state = await scratch(t);
	await fakePackage(root);
	await fakeInstall(state);
	const base = {
		stateDir: () => state,
		packageRoot: () => root,
		expectedBuildId: () => "build-1",
	};
	const none = await collectStatus({ ...base, findDaemon: async () => undefined, readLockfile: () => undefined });
	assert.equal(byId(none, "daemon").level, "ok");
	assert.match(byId(none, "daemon").summary, /not running/);

	const dead = await collectStatus({
		...base,
		findDaemon: async () => undefined,
		readLockfile: () => daemonInfo(),
		isPidAlive: () => false,
	});
	assert.equal(byId(dead, "daemon").level, "warn");
	assert.match(byId(dead, "daemon").summary, /Stale daemon lockfile/);

	const mismatched: FoundDaemon = {
		info: { ...daemonInfo(), contractIdentity: undefined },
		status: daemonStatus({ contractIdentity: undefined }),
	};
	const mismatch = await collectStatus({
		...base,
		findDaemon: async () => mismatched,
		readLockfile: () => mismatched.info,
		isPidAlive: () => true,
	});
	assert.equal(byId(mismatch, "daemon-contract").level, "warn");
	assert.match(byId(mismatch, "daemon-contract").fix ?? "", /replaces it automatically/);
});
