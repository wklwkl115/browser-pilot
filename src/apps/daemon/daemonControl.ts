/**
 * Daemon discovery + lifecycle control (client side).
 *
 * The daemon is a **user-local singleton** (one per user/profile), NOT per caller
 * cwd. Its lockfile lives in a user-local state root — never under the caller
 * project `.browser-pilot/`, which is reserved for artifacts and evidence. Multiple
 * projects invoke the same daemon; each `/invoke` carries the caller `cwd` so
 * artifact roots stay request-scoped.
 *
 * This module is pure control plane (loopback HTTP + lockfile); it does not start
 * a BrowserBridgeServer. Auto-start spawns the resolved local daemon entry via
 * process.execPath — built dist uses the daemon bin, source runs use local tsx.
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageRoot } from "./packageInfo.js";
import {
	compareDaemonContractIdentity,
	localDaemonContractIdentity,
	type DaemonContractCheck,
	type DaemonContractIdentity,
} from "./contractIdentity.js";

export interface DaemonInfo {
	pid: number;
	controlHost: string;
	controlPort: number;
	token: string;
	bridgePort?: number;
	startedAt: string;
	version: string;
	contractIdentity?: DaemonContractIdentity;
}

export interface DaemonStatus {
	ok: boolean;
	bridgePort?: number;
	running?: boolean;
	readiness?: string;
	extensionConnected?: boolean;
	extension?: Record<string, unknown>;
	tabs?: unknown[];
	tabCount?: number;
	activeTab?: unknown;
	health?: Record<string, unknown>;
	tools?: number;
	contractIdentity?: DaemonContractIdentity;
}

export type FoundDaemon = { info: DaemonInfo; status: DaemonStatus };

export type DaemonContractReport = {
	local: DaemonContractIdentity;
	daemon: DaemonContractIdentity | null;
	lock: DaemonContractIdentity | null;
	check: DaemonContractCheck;
	daemonCheck: DaemonContractCheck;
	lockCheck: DaemonContractCheck;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;
const START_LOCK_STALE_MS = 30_000;

/** User-local state root. Overridable for tests/isolation. */
export function stateDir(): string {
	return process.env.BROWSER_PILOT_DAEMON_STATE_DIR || path.join(os.homedir(), ".browser-pilot");
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

type StartLockInfo = { pid?: number; acquiredAt?: string; token?: string };
type StartLockSnapshot = { raw: string; mtimeMs: number; info?: StartLockInfo };

function readStartLockSnapshot(): StartLockSnapshot | undefined {
	try {
		const raw = readFileSync(startLockfilePath(), "utf8");
		const mtimeMs = statSync(startLockfilePath()).mtimeMs;
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const info = {
			pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
			acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : undefined,
			token: typeof parsed.token === "string" ? parsed.token : undefined,
		};
		return { raw, mtimeMs, info };
	} catch {
		try {
			return { raw: readFileSync(startLockfilePath(), "utf8"), mtimeMs: statSync(startLockfilePath()).mtimeMs };
		} catch {
			return undefined;
		}
	}
}

function readStartLock(): StartLockInfo | undefined {
	return readStartLockSnapshot()?.info;
}

function isStartLockStale(snapshot = readStartLockSnapshot()): boolean {
	if (!snapshot) return true;
	const lock = snapshot.info;
	if (!lock) return Date.now() - snapshot.mtimeMs > START_LOCK_STALE_MS;
	const pidAlive = typeof lock.pid === "number" && isPidAlive(lock.pid);
	if (typeof lock.pid === "number" && !pidAlive) return true;
	const acquiredAt = Date.parse(String(lock.acquiredAt || ""));
	if (!Number.isFinite(acquiredAt)) return true;
	// If the PID is still alive, the daemon is just starting slowly — use a
	// longer stale window (2x) to avoid concurrent clients spawning daemons.
	const effectiveStaleMs = pidAlive ? START_LOCK_STALE_MS * 2 : START_LOCK_STALE_MS;
	return Date.now() - acquiredAt > effectiveStaleMs;
}

function removeObservedStartLock(snapshot: StartLockSnapshot): void {
	const current = readStartLockSnapshot();
	if (!current || current.raw !== snapshot.raw || current.mtimeMs !== snapshot.mtimeMs) return;
	try {
		rmSync(startLockfilePath(), { force: true });
	} catch {
		// Another process may have removed the observed stale marker first.
	}
}

function releaseOwnedStartLock(token: string): void {
	const current = readStartLock();
	if (current?.token !== token) return;
	rmSync(startLockfilePath(), { force: true });
}

function tryAcquireStartLock(): { release: () => void } | undefined {
	mkdirSync(path.dirname(startLockfilePath()), { recursive: true });
	try {
		const fd = openSync(startLockfilePath(), "wx");
		const token = randomUUID();
		try {
			writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token })}\n`, "utf8");
		} finally {
			closeSync(fd);
		}
		return { release: () => releaseOwnedStartLock(token) };
	} catch {
		const snapshot = readStartLockSnapshot();
		const lock = snapshot?.info;
		const pidAlive = typeof lock?.pid === "number" && isPidAlive(lock.pid);
		const stale = isStartLockStale(snapshot);
		if (pidAlive && !stale) {
			const ageS = lock?.acquiredAt ? Math.round((Date.now() - Date.parse(lock.acquiredAt)) / 1000) : "?";
			console.error(`daemon startup in progress (pid ${lock!.pid}, started ${ageS}s ago) — waiting`);
		} else if (stale && snapshot) {
			removeObservedStartLock(snapshot);
		}
		return undefined;
	}
}

/** Full local/daemon/lock identity report used by reuse, status, and doctor. */
export function daemonContractReport(found?: FoundDaemon): DaemonContractReport {
	const local = localDaemonContractIdentity();
	const daemon = found?.status.contractIdentity ?? null;
	const lock = (found?.info ?? readLockfile())?.contractIdentity ?? null;
	const daemonCheck = compareDaemonContractIdentity(local, daemon);
	const lockCheck = compareDaemonContractIdentity(local, lock);
	const ok = daemonCheck.ok && lockCheck.ok;
	const check: DaemonContractCheck = ok
		? { ok: true, code: "DAEMON_CONTRACT_MATCH", reason: "match", mismatches: [] }
		: {
			ok: false,
			code: "DAEMON_CONTRACT_MISMATCH",
			reason: !found
				? "daemon_missing"
				: daemonCheck.reason === "identity_missing" || daemonCheck.reason === "daemon_missing" || lockCheck.reason === "identity_missing" || lockCheck.reason === "daemon_missing"
					? "identity_missing"
					: "field_mismatch",
			mismatches: [
				...daemonCheck.mismatches.map((mismatch) => ({ ...mismatch, source: "daemon" as const })),
				...lockCheck.mismatches.map((mismatch) => ({ ...mismatch, source: "lock" as const })),
			],
		};
	return {
		local,
		daemon,
		lock,
		check,
		daemonCheck,
		lockCheck,
	};
}

/** A daemon is reusable only when both its live status and lock metadata match. */
export function isDaemonReadyForReuse(found: FoundDaemon): boolean {
	return daemonContractReport(found).check.ok;
}

export class DaemonReplacementError extends Error {
	readonly code = "DAEMON_REPLACEMENT_FAILED" as const;

	constructor(message: string, readonly details: Record<string, unknown> = {}) {
		super(message);
		this.name = "DaemonReplacementError";
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

export interface ControlRequestOptions {
	/** If provided, adds the x-browser-pilot-pairing-token header on the request. */
	pairingToken?: string;
	signal?: AbortSignal;
}

/** Loopback control request, token-guarded. Resolves with the parsed JSON body. */
export function controlRequest(
	info: Pick<DaemonInfo, "controlHost" | "controlPort" | "token">,
	method: "GET" | "POST",
	pathname: string,
	body?: unknown,
	timeoutMs = 120_000,
	opts?: ControlRequestOptions,
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
					signal: opts?.signal,
					headers: {
					"x-browser-pilot-daemon-token": info.token,
					...(opts?.pairingToken ? { "x-browser-pilot-pairing-token": opts.pairingToken } : {}),
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
export async function findDaemon(opts: { tabs?: boolean } = {}): Promise<FoundDaemon | undefined> {
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
 * in addition to Node's bundled bundle. This is what lets daemon HTTP requests
 * work behind a TLS-intercepting proxy/AV or a corporate root CA — exactly the
 * trust the co-located browser already has — WITHOUT
 * disabling certificate verification.
 *
 * It is injected via NODE_OPTIONS (not an exec arg) so it survives the tsx loader
 * re-exec in dev/source runs — tsx spawns a child node that inherits env but not
 * forwarded exec flags — while still applying to the plain `node bin.js` package
 * path. Gated on flag support so older Node (which would abort on an unknown
 * NODE_OPTIONS flag) silently skips it; opt out via `BROWSER_PILOT_NO_SYSTEM_CA=1`.
 */
export function daemonSpawnEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	if (baseEnv.BROWSER_PILOT_NO_SYSTEM_CA) return baseEnv;
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

/** Command to start the daemon. Built packages use node+bin.js; source runs use local tsx. */
export function resolveDaemonStartCommand(): DaemonStartCommand {
	const explicit = process.env.BROWSER_PILOT_DAEMON_ENTRY;
	if (explicit) return { command: process.execPath, args: [explicit] };
	const modulePath = fileURLToPath(import.meta.url);
	const root = packageRoot() ?? path.resolve(path.dirname(modulePath), "..", "..", "..");
	const tsEntry = [
		path.join(root, "src", "apps", "daemon", "bin.ts"),
		path.join(root, "daemon", "bin.ts"),
	].find((candidate) => existsSync(candidate));
	// A source checkout may also contain an older dist/ from a prior build. Starting
	// that output would be correctly rejected by contract identity but could never
	// converge, so source execution must launch the source entry.
	if (modulePath.endsWith(".ts") && tsEntry) return resolveSourceDaemonStartCommand(root, tsEntry);
	const jsEntry = [
		path.join(root, "dist", "src", "apps", "daemon", "bin.js"),
		path.join(root, "dist", "daemon", "bin.js"),
	].find((candidate) => existsSync(candidate));
	if (jsEntry) return { command: process.execPath, args: [jsEntry] };
	if (tsEntry) return resolveSourceDaemonStartCommand(root, tsEntry);
	return { command: process.execPath, args: [path.join(root, "dist", "src", "apps", "daemon", "bin.js")] };
}

function resolveSourceDaemonStartCommand(root: string, tsEntry: string): DaemonStartCommand {
	const tsxEntry = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
	if (existsSync(tsxEntry)) {
		// Prefer running the tsx loader IN-PROCESS via `node --import tsx` (Node ≥20.6).
		// The tsx wrapper re-execs a child node, which escapes the parent's
		// windowsHide and pops a console window on Windows; the single-process form
		// inherits windowsHide and stays invisible. cwd=root so the bare `tsx` resolves.
		// Older Node without `--import` falls back to the (windowed) re-exec wrapper.
			if (supportsImportFlag()) return { command: process.execPath, args: ["--import", "tsx", tsEntry], cwd: root };
		return { command: process.execPath, args: [tsxEntry, tsEntry] };
	}
	return { command: process.execPath, args: [tsEntry, "daemon", "start"] };
}

function supportsImportFlag(): boolean {
	try {
		return process.allowedNodeEnvironmentFlags?.has("--import") === true;
	} catch {
		return false;
	}
}

const DAEMON_REPLACEMENT_GRACE_MS = 5_000;

function removeLockfileForPid(pid: number): void {
	if (readLockfile()?.pid === pid) removeLockfile();
}

/**
 * Ask a stale managed daemon to drain and exit. Replacement never escalates to
 * signals: if graceful shutdown cannot be proven within the grace period, the
 * old process remains isolated and the caller receives a stable failure code.
 */
export async function replaceStaleDaemon(
	info: DaemonInfo,
	opts: { graceMs?: number } = {},
): Promise<void> {
	let acknowledged = false;
	try {
		const response = await controlRequest(info, "POST", "/shutdown", { reason: "contract_mismatch", drain: true }, 2_000);
		acknowledged = response.status === 200 && response.json?.ok !== false;
	} catch {
		/* reported below with a stable replacement failure */
	}
	if (!acknowledged) {
		if (!isPidAlive(info.pid)) {
			removeLockfileForPid(info.pid);
			return;
		}
		throw new DaemonReplacementError("stale browser-pilot daemon did not acknowledge graceful replacement", { pid: info.pid });
	}
	if (!(await waitForPidDeath(info.pid, opts.graceMs ?? DAEMON_REPLACEMENT_GRACE_MS))) {
		throw new DaemonReplacementError("stale browser-pilot daemon did not drain within the replacement grace period", {
			pid: info.pid,
			graceMs: opts.graceMs ?? DAEMON_REPLACEMENT_GRACE_MS,
		});
	}
	removeLockfileForPid(info.pid);
}

type DaemonStartLock = NonNullable<ReturnType<typeof tryAcquireStartLock>>;
type DaemonStartPermit = { daemon: DaemonInfo; lock?: never } | { daemon?: never; lock: DaemonStartLock };

async function acquireDaemonStartPermit(deadline: number): Promise<DaemonStartPermit> {
	let lock = tryAcquireStartLock();
	while (!lock && Date.now() < deadline) {
		await delay(100);
		const ready = await findDaemon();
		if (ready && isDaemonReadyForReuse(ready)) return { daemon: ready.info };
		lock = tryAcquireStartLock();
	}
	if (!lock) throw new Error("browser-pilot daemon start lock timeout");
	return { lock };
}

/** Return a live contract-identical daemon, auto-starting one when safe. */
export async function ensureDaemon(opts: { startTimeoutMs?: number } = {}): Promise<DaemonInfo> {
	const found = await findDaemon();
	if (found && isDaemonReadyForReuse(found)) return found.info;
	const deadline = Date.now() + (opts.startTimeoutMs ?? 10_000);
	const permit = await acquireDaemonStartPermit(deadline);
	if (permit.daemon) return permit.daemon;
	const { lock } = permit;
	let child: ChildProcess | undefined;
	try {
		const again = await findDaemon();
		if (again && isDaemonReadyForReuse(again)) return again.info;

		// A reachable mismatch or a live-but-unreachable lock owner must be replaced
		// before spawning. This prevents any invocation from slipping into an old daemon.
		const stale = again?.info ?? readLockfile();
		if (stale) {
			if (isPidAlive(stale.pid)) await replaceStaleDaemon(stale);
			else removeLockfileForPid(stale.pid);
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
			if (ready && isDaemonReadyForReuse(ready)) return ready.info;
			if (child.exitCode !== null && child.exitCode !== 0) break;
		}
		throw new DaemonReplacementError("replacement browser-pilot daemon did not become contract-identical in time", {
			startedPid: child.pid,
		});
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
	let stopped = await waitForPidDeath(info.pid, 3_000);
	if (!stopped) {
		tryKill(info.pid, "SIGTERM");
		stopped = await waitForPidDeath(info.pid, 2_000);
		if (!stopped) {
			tryKill(info.pid, "SIGKILL");
			stopped = await waitForPidDeath(info.pid, 2_000);
		}
	}
	if (stopped) removeLockfileForPid(info.pid);
	return stopped;
}
