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
 * a BrowserBridgeServer. Auto-start spawns a detached `node <cli>/bin.js daemon
 * start` via process.execPath — never a shell `pi-browser` by bin name.
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
	tools?: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** User-local state root. Overridable for tests/isolation. */
export function stateDir(): string {
	return process.env.PI_BROWSER_DAEMON_STATE_DIR || path.join(os.homedir(), ".pi");
}

export function lockfilePath(): string {
	return path.join(stateDir(), "browser-daemon.json");
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
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					buf += chunk;
				});
				res.on("end", () => {
					let json: Record<string, unknown> | undefined;
					try {
						json = buf ? (JSON.parse(buf) as Record<string, unknown>) : undefined;
					} catch {
						json = undefined;
					}
					resolve({ status: res.statusCode ?? 0, json });
				});
			},
		);
		req.on("error", reject);
		req.setTimeout(timeoutMs, () => req.destroy(new Error("control request timeout")));
		if (data) req.write(data);
		req.end();
	});
}

/** GET /status; undefined if the daemon is unreachable. */
export async function pingStatus(info: DaemonInfo, timeoutMs = 1_500): Promise<DaemonStatus | undefined> {
	try {
		const { status, json } = await controlRequest(info, "GET", "/status", undefined, timeoutMs);
		if (status === 200 && json) return json as unknown as DaemonStatus;
	} catch {
		/* unreachable */
	}
	return undefined;
}

/** Read the lockfile and confirm the daemon answers. Cleans up a lockfile whose pid is dead. */
export async function findDaemon(): Promise<{ info: DaemonInfo; status: DaemonStatus } | undefined> {
	const info = readLockfile();
	if (!info) return undefined;
	const status = await pingStatus(info);
	if (status) return { info, status };
	// Not answering. Only reclaim the lockfile if the process is gone — a live but
	// slow-starting daemon must not have its lockfile yanked out from under it.
	if (!isPidAlive(info.pid)) removeLockfile();
	return undefined;
}

/** Path to the daemon entry that auto-start spawns (the built CLI bin sibling). */
function daemonEntry(): string {
	return process.env.PI_BROWSER_DAEMON_ENTRY || path.join(path.dirname(fileURLToPath(import.meta.url)), "bin.js");
}

/** Return a live daemon, auto-starting one (detached) if none is reachable. */
export async function ensureDaemon(opts: { startTimeoutMs?: number } = {}): Promise<DaemonInfo> {
	const found = await findDaemon();
	if (found) return found.info;
	const child = spawn(process.execPath, [daemonEntry(), "daemon", "start"], {
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();
	const deadline = Date.now() + (opts.startTimeoutMs ?? 10_000);
	while (Date.now() < deadline) {
		await delay(150);
		const ready = await findDaemon();
		if (ready) return ready.info;
		if (child.exitCode !== null && child.exitCode !== 0) break;
	}
	throw new Error("pi-browser daemon did not become ready in time");
}

/** Stop the singleton daemon if present. Returns true if one was addressed. */
export async function stopDaemon(): Promise<boolean> {
	const info = readLockfile();
	if (!info) return false;
	try {
		await controlRequest(info, "POST", "/shutdown", {}, 2_000);
	} catch {
		/* may already be down */
	}
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		await delay(100);
		if (!isPidAlive(info.pid)) break;
	}
	if (isPidAlive(info.pid)) {
		try {
			process.kill(info.pid, "SIGTERM");
		} catch {
			/* best-effort */
		}
	}
	removeLockfile();
	return true;
}
