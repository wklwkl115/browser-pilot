/**
 * Daemon discovery + lifecycle control (client side).
 *
 * The daemon is a **user-local singleton** (one per user/profile), NOT per caller
 * cwd. Its lockfile lives in a user-local state root — never under the caller
 * project `.pi/`, which is reserved for artifacts/memory/evidence. Multiple
 * projects invoke the same daemon; each `/invoke` carries the caller `cwd` so
 * artifact/memory roots stay request-scoped.
 *
 * This module is pure control plane (loopback HTTP + lockfile); it does not start
 * a BrowserBridgeServer. Auto-start spawns the resolved local daemon entry via
 * process.execPath — built dist uses bin.js, source runs use the local tsx CLI;
 * never shell out to `pi-browser` by bin name.
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { daemonVersion, packageRoot } from "./packageInfo.js";

export interface DaemonInfo {
	pid: number;
	controlHost: string;
	controlPort: number;
	token: string;
	bridgePort?: number;
	startedAt: string;
	version: string;
}

export interface DaemonStatus {
	ok: boolean;
	bridgePort?: number;
	running?: boolean;
	extensionConnected?: boolean;
	tabs?: unknown[];
	tabCount?: number;
	activeTab?: unknown;
	health?: Record<string, unknown>;
	tools?: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;
const START_LOCK_STALE_MS = 30_000;

/** User-local state root. Overridable for tests/isolation. */
export function stateDir(): string {
	return process.env.PI_BROWSER_DAEMON_STATE_DIR || path.join(os.homedir(), ".pi");
}

export function lockfilePath(): string {
	return path.join(stateDir(), "browser-daemon.json");
}

export function startLockfilePath(): string {
	return path.join(stateDir(), "browser-daemon.starting.json");
}

export function readLockfile(): DaemonInfo | undefined {
	try {
		const parsed = JSON.parse(readFileSync(lockfilePath(), "utf8")) as Partial<DaemonInfo>;
		if (typeof parsed?.pid === "number" && typeof parsed.controlPort === "number" && typeof parsed.token === "string" && typeof parsed.controlHost === "string") {
			return parsed as DaemonInfo;
		}
	} catch {
		/* missing / unreadable / malformed → treat as no daemon */
	}
	return undefined;
}

export function writeLockfile(info: DaemonInfo): void {
	mkdirSync(path.dirname(lockfilePath()), { recursive: true });
	writeFileSync(lockfilePath(), `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

export function removeLockfile(): void {
	try {
		if (existsSync(lockfilePath())) rmSync(lockfilePath(), { force: true });
	} catch {
		/* best-effort */
	}
}

function readStartLock(): { pid?: number; acquiredAt?: string } | undefined {
	try {
		const parsed = JSON.parse(readFileSync(startLockfilePath(), "utf8")) as Record<string, unknown>;
		return {
			pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
			acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : undefined,
		};
	} catch {
		return undefined;
	}
}

function isStartLockStale(): boolean {
	const lock = readStartLock();
	if (!lock) return true;
	if (typeof lock.pid === "number" && !isPidAlive(lock.pid)) return true;
	const acquiredAt = Date.parse(String(lock.acquiredAt || ""));
	return !Number.isFinite(acquiredAt) || Date.now() - acquiredAt > START_LOCK_STALE_MS;
}

function tryAcquireStartLock(): { release: () => void } | undefined {
	mkdirSync(path.dirname(startLockfilePath()), { recursive: true });
	try {
		const fd = openSync(startLockfilePath(), "wx");
		try {
			writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, "utf8");
		} finally {
			closeSync(fd);
		}
		return { release: () => rmSync(startLockfilePath(), { force: true }) };
	} catch {
		if (isStartLockStale()) {
			try {
				rmSync(startLockfilePath(), { force: true });
			} catch {
				// Another process may have removed or replaced the stale marker first.
			}
		}
		return undefined;
	}
}

export function isDaemonVersionCurrent(info: Pick<DaemonInfo, "version">): boolean {
	return info.version === daemonVersion();
}

/** True if a process with this pid exists (signal 0 probe). EPERM means it exists but is not ours. */
export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/** Loopback control request, token-guarded. Resolves with the parsed JSON body. */
export function controlRequest(
	info: Pick<DaemonInfo, "controlHost" | "controlPort" | "token">,
	method: "GET" | "POST",
	pathname: string,
	body?: unknown,
	timeoutMs = 120_000,
): Promise<{ status: number; json: Record<string, unknown> | undefined }> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const safeResolve = (value: { status: number; json: Record<string, unknown> | undefined }): void => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const safeReject = (error: Error): void => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		const data = body !== undefined ? JSON.stringify(body) : undefined;
		const req = http.request(
			{
				host: info.controlHost,
				port: info.controlPort,
				method,
				path: pathname,
				headers: {
					"x-pi-daemon-token": info.token,
					...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
				},
			},
			(res) => {
				let buf = "";
				let responseBytes = 0;
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					responseBytes += Buffer.byteLength(chunk, "utf8");
					if (responseBytes > MAX_CONTROL_RESPONSE_BYTES) {
						const error = new Error(`control response too large (>${MAX_CONTROL_RESPONSE_BYTES} bytes)`);
						res.destroy(error);
						req.destroy(error);
						safeReject(error);
						return;
					}
					buf += chunk;
				});
				res.on("end", () => {
					if (settled) return;
					let json: Record<string, unknown> | undefined;
					try {
						json = buf ? (JSON.parse(buf) as Record<string, unknown>) : undefined;
					} catch {
						json = undefined;
					}
					safeResolve({ status: res.statusCode ?? 0, json });
				});
				res.on("error", (error) => safeReject(error instanceof Error ? error : new Error(String(error))));
			},
		);
		req.on("error", (error) => safeReject(error instanceof Error ? error : new Error(String(error))));
		req.setTimeout(timeoutMs, () => {
			const error = new Error("control request timeout");
			req.destroy(error);
			safeReject(error);
		});
		if (data) req.write(data);
		req.end();
	});
}

/** GET /status; undefined if the daemon is unreachable. */
export async function pingStatus(info: DaemonInfo, timeoutMs = 1_500, opts: { tabs?: boolean } = {}): Promise<DaemonStatus | undefined> {
	try {
		const { status, json } = await controlRequest(info, "GET", opts.tabs ? "/status?tabs=1" : "/status", undefined, timeoutMs);
		if (status === 200 && json) return json as unknown as DaemonStatus;
	} catch {
		/* unreachable */
	}
	return undefined;
}

/** Read the lockfile and confirm the daemon answers. Cleans up a lockfile whose pid is dead. */
export async function findDaemon(opts: { tabs?: boolean } = {}): Promise<{ info: DaemonInfo; status: DaemonStatus } | undefined> {
	const info = readLockfile();
	if (!info) return undefined;
	const status = await pingStatus(info, 1_500, opts);
	if (status) return { info, status };
	// Not answering. Only reclaim the lockfile if the process is gone — a live but
	// slow-starting daemon must not have its lockfile yanked out from under it.
	if (!isPidAlive(info.pid)) removeLockfile();
	return undefined;
}

export interface DaemonStartCommand {
	command: string;
	args: string[];
	/** Working directory for the spawned daemon, when the launch form needs one (e.g. resolving a bare `tsx` specifier). */
	cwd?: string;
}

/**
 * Build the daemon child's environment, adding `--use-system-ca` to NODE_OPTIONS.
 *
 * `--use-system-ca` (Node ≥22.15) makes the daemon trust the OS/browser CA store
 * in addition to Node's bundled bundle. This is what lets web-security fetches
 * (crawl/fuzz/http_replay) work behind a TLS-intercepting proxy/AV or a corporate
 * root CA — exactly the trust the co-located browser already has — WITHOUT
 * disabling certificate verification.
 *
 * It is injected via NODE_OPTIONS (not an exec arg) so it survives the tsx loader
 * re-exec in dev/source runs — tsx spawns a child node that inherits env but not
 * forwarded exec flags — while still applying to the plain `node bin.js` package
 * path. Gated on flag support so older Node (which would abort on an unknown
 * NODE_OPTIONS flag) silently skips it; opt out via `PI_BROWSER_NO_SYSTEM_CA=1`.
 */
export function daemonSpawnEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	if (baseEnv.PI_BROWSER_NO_SYSTEM_CA) return baseEnv;
	let supported = false;
	try {
		supported = process.allowedNodeEnvironmentFlags?.has("--use-system-ca") === true;
	} catch {
		/* allowedNodeEnvironmentFlags unavailable → skip */
	}
	if (!supported) return baseEnv;
	const current = baseEnv.NODE_OPTIONS ?? "";
	if (current.includes("--use-system-ca")) return baseEnv;
	return { ...baseEnv, NODE_OPTIONS: current ? `${current} --use-system-ca` : "--use-system-ca" };
}

/** Command to start the daemon. Built packages use node+bin.js; source/tsx runs use the local tsx CLI. */
export function resolveDaemonStartCommand(): DaemonStartCommand {
	const explicit = process.env.PI_BROWSER_DAEMON_ENTRY;
	if (explicit) return { command: process.execPath, args: [explicit, "daemon", "start"] };
	const dir = path.dirname(fileURLToPath(import.meta.url));
	const jsEntry = path.join(dir, "bin.js");
	if (existsSync(jsEntry)) return { command: process.execPath, args: [jsEntry, "daemon", "start"] };
	const tsEntry = path.join(dir, "bin.ts");
	if (existsSync(tsEntry)) {
		const root = packageRoot() ?? path.resolve(dir, "..");
		const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
		if (existsSync(tsxCli)) {
			// Prefer running the tsx loader IN-PROCESS via `node --import tsx` (Node ≥20.6).
			// The tsx CLI wrapper (tsxCli) re-execs a child node, which escapes the parent's
			// windowsHide and pops a console window on Windows; the single-process form
			// inherits windowsHide and stays invisible. cwd=root so the bare `tsx` resolves.
			// Older Node without `--import` falls back to the (windowed) re-exec wrapper.
			if (supportsImportFlag()) return { command: process.execPath, args: ["--import", "tsx", tsEntry, "daemon", "start"], cwd: root };
			return { command: process.execPath, args: [tsxCli, tsEntry, "daemon", "start"] };
		}
		return { command: process.execPath, args: [tsEntry, "daemon", "start"] };
	}
	return { command: process.execPath, args: [jsEntry, "daemon", "start"] };
}

function supportsImportFlag(): boolean {
	try {
		return process.allowedNodeEnvironmentFlags?.has("--import") === true;
	} catch {
		return false;
	}
}

/** Return a live daemon, auto-starting one (detached) if none is reachable. */
export async function ensureDaemon(opts: { startTimeoutMs?: number } = {}): Promise<DaemonInfo> {
	const found = await findDaemon();
	if (found) {
		if (isDaemonVersionCurrent(found.info)) return found.info;
		await stopDaemon();
	}
	const deadline = Date.now() + (opts.startTimeoutMs ?? 10_000);
	let lock = tryAcquireStartLock();
	while (!lock && Date.now() < deadline) {
		await delay(100);
		const ready = await findDaemon();
		if (ready && isDaemonVersionCurrent(ready.info)) return ready.info;
		lock = tryAcquireStartLock();
	}
	if (!lock) throw new Error("pi-browser daemon start lock timeout");
	let child: ChildProcess | undefined;
	try {
		const again = await findDaemon();
		if (again) {
			if (isDaemonVersionCurrent(again.info)) return again.info;
			await stopDaemon();
		}
		const startCommand = resolveDaemonStartCommand();
		child = spawn(startCommand.command, startCommand.args, {
			detached: true,
			stdio: "ignore",
			// On Windows a detached child is given its own console window; hide it so the
			// background daemon runs invisibly (the process still shows in Task Manager —
			// it is a long-lived singleton by design). No-op on POSIX.
			windowsHide: true,
			...(startCommand.cwd ? { cwd: startCommand.cwd } : {}),
			env: daemonSpawnEnv(),
		});
		child.unref();
		while (Date.now() < deadline) {
			await delay(150);
			const ready = await findDaemon();
			if (ready && isDaemonVersionCurrent(ready.info)) return ready.info;
			if (child.exitCode !== null && child.exitCode !== 0) break;
		}
		throw new Error("pi-browser daemon did not become ready in time");
	} finally {
		lock.release();
	}
}

async function waitForPidDeath(pid: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return true;
		await delay(100);
	}
	return !isPidAlive(pid);
}

function tryKill(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		/* already gone / not ours */
	}
}

/**
 * Stop the singleton daemon if present. Returns true if one was addressed.
 * Escalates so a wedged daemon can't survive: graceful /shutdown → SIGTERM → SIGKILL.
 * (A daemon whose SIGTERM handler blocks on a hung close() would otherwise orphan.)
 */
export async function stopDaemon(): Promise<boolean> {
	const info = readLockfile();
	if (!info) return false;
	let shutdownAcknowledged = false;
	try {
		const response = await controlRequest(info, "POST", "/shutdown", {}, 2_000);
		shutdownAcknowledged = response.status === 200 && response.json?.ok !== false;
	} catch {
		/* may already be down */
	}
	if (!shutdownAcknowledged) {
		if (!isPidAlive(info.pid)) removeLockfile();
		return false;
	}
	if (!(await waitForPidDeath(info.pid, 3_000))) {
		tryKill(info.pid, "SIGTERM");
		if (!(await waitForPidDeath(info.pid, 2_000))) {
			tryKill(info.pid, "SIGKILL");
			await waitForPidDeath(info.pid, 2_000);
		}
	}
	removeLockfile();
	return true;
}
