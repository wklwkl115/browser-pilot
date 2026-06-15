import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeErrorCode } from "../../../bridge/protocol/nativeErrorCodes.js";
import { createCodedError } from "../../../utils/codedError.js";
import { tryJson } from "../../../utils/json.js";
import { isRecord } from "../shared/normalize.js";
import type { HeaderMap } from "../shared/types.js";

export type CallbackSessionState = Record<string, unknown> & {
	sessionId: string;
	artifactRoot: string;
	statePath: string;
};

export type NormalizedCallbackSessionOptions = {
	/** Caller cwd (request-scoped); session state lives under <cwd>/.browser-pilot/... not the daemon's. */
	cwd?: string;
	sessionId?: string;
	listenHost: string;
	dnsListenHost: string;
	port: number;
	httpsPort: number;
	dnsPort: number;
	publicBaseUrl?: string;
	publicHttpsBaseUrl?: string;
	publicDnsBaseDomain?: string;
	dnsBaseDomain?: string;
	dnsResponseAddress: string;
	basePath: string;
	correlationId: string;
	responseStatus: number;
	responseBody: string;
	responseHeaders: HeaderMap;
	enableHttps: boolean;
	enableDns: boolean;
	externalMetadata?: Record<string, unknown>;
	maxEvents: number;
	maxBodyBytes: number;
	maxRuntimeMs: number;
};

// Callback-OAST session state is request-scoped: it lives under the CALLER's cwd
// (.browser-pilot/artifacts/callback-oast-sessions), threaded from runCallbackOast via
// requestCwd(options), NOT under the daemon's process.cwd(). Path-based helpers
// (load/update by absolute statePath) stay cwd-agnostic — they trust the path.
function sessionRoot(cwd?: string): string {
	return path.resolve(cwd ?? process.cwd(), ".browser-pilot", "artifacts", "callback-oast-sessions");
}
// callbackOastWorker.mjs is a plain-JS worker that tsc does NOT emit to dist/. The package
// ships both src/ and dist/, so resolve the worker in src/ even when running from the compiled
// dist build (the CLI daemon runs from dist/cli/bin.js) — `<root>/dist/src/...` → `<root>/src/...`.
// From source (tsx) the path has no dist/src/ segment, so the rewrite is a no-op.
const WORKER_PATH = fileURLToPath(new URL("./callbackOastWorker.mjs", import.meta.url))
	.replace(`${path.sep}dist${path.sep}src${path.sep}`, `${path.sep}src${path.sep}`);
const STATE_LOCK_TIMEOUT_MS = 10_000;
const STATE_LOCK_RETRY_MS = 25;
const STATE_LOCK_STALE_MS = 30_000;
const CALLBACK_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const DEFAULT_CALLBACK_MAX_RUNTIME_MS = 60 * 60 * 1000;
const OPENSSL_CERT_DAYS = 3650;

type CallbackOastToolError = Error & { code: Extract<NativeErrorCode, "INVALID_RULE" | "HTTPS_CERT_GENERATION_FAILED">; details: Record<string, unknown> };

function callbackToolError(code: Extract<NativeErrorCode, "INVALID_RULE" | "HTTPS_CERT_GENERATION_FAILED">, message: string, details: Record<string, unknown> = {}): Error {
	return createCodedError({ name: "CallbackOastError", code, message, details, suppressStack: false }) as CallbackOastToolError;
}

export function parseIpv4Address(value: string): [number, number, number, number] | undefined {
	const parts = String(value || "").trim().split(".");
	if (parts.length !== 4) return undefined;
	const octets = parts.map((part) => {
		if (!/^\d+$/.test(part)) return undefined;
		const value = Number(part);
		return Number.isInteger(value) && value >= 0 && value <= 255 ? value : undefined;
	});
	return octets.every((part) => part !== undefined) ? octets as [number, number, number, number] : undefined;
}

export function normalizeCallbackSessionId(value: unknown): string {
	const sessionId = String(value || "").trim();
	if (!CALLBACK_SESSION_ID_PATTERN.test(sessionId)) {
		throw callbackToolError("INVALID_RULE", "browser_callback_oast sessionId must match ^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$", { sessionId });
	}
	return sessionId;
}

function ensureSessionRootPath(targetPath: string, cwd?: string): string {
	const root = sessionRoot(cwd);
	const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
	const resolved = path.resolve(targetPath);
	if (resolved !== root && !resolved.startsWith(rootWithSep)) {
		throw new Error(`browser_callback_oast resolved path escaped session root: ${resolved}`);
	}
	return resolved;
}

function isPathWithinSessionRoot(targetPath: string, cwd?: string): boolean {
	try {
		ensureSessionRootPath(targetPath, cwd);
		return true;
	} catch {
		return false;
	}
}

function callbackRuntimeMs(value: unknown, fallback = DEFAULT_CALLBACK_MAX_RUNTIME_MS): number {
	const raw = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
	if (!Number.isFinite(raw) || raw <= 0) return fallback;
	return Math.min(24 * 60 * 60 * 1000, Math.max(1_000, Math.floor(raw)));
}

function readLockToken(value: unknown): string | undefined {
	return isRecord(value) && typeof value.token === "string" ? String(value.token) : undefined;
}

async function loadLockToken(lockPath: string): Promise<string | undefined> {
	const parsed = tryJson(await readFile(lockPath, "utf8"));
	return readLockToken(parsed);
}

function resolveHttpsKeyPath(artifactRoot: string): string {
	return path.join(artifactRoot, "https.key.pem");
}

function resolveHttpsCertPath(artifactRoot: string): string {
	return path.join(artifactRoot, "https.cert.pem");
}

function prepareHttpsCertificate(artifactRoot: string): { keyPath: string; certPath: string } {
	const keyPath = resolveHttpsKeyPath(artifactRoot);
	const certPath = resolveHttpsCertPath(artifactRoot);
	const subjectAltName = "subjectAltName=DNS:localhost,IP:127.0.0.1";
	const result = spawnSync("openssl", [
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-sha256",
		"-nodes",
		"-days",
		String(OPENSSL_CERT_DAYS),
		"-subj",
		"/CN=localhost",
		"-addext",
		subjectAltName,
		"-keyout",
		keyPath,
		"-out",
		certPath,
	], { encoding: "utf8", windowsHide: true });
	if (result.error || result.status !== 0) {
		const errorText = String(result.error?.message || result.stderr || result.stdout || "openssl req failed").trim();
		throw callbackToolError("HTTPS_CERT_GENERATION_FAILED", `browser_callback_oast HTTPS certificate generation failed: ${errorText}`, { command: "openssl", keyPath, certPath, status: result.status ?? null });
	}
	return { keyPath, certPath };
}

export function sessionArtifactRoot(sessionId: string, cwd?: string): string {
	return ensureSessionRootPath(path.join(sessionRoot(cwd), normalizeCallbackSessionId(sessionId)), cwd);
}

export function sessionStatePath(sessionId: string, cwd?: string): string {
	return ensureSessionRootPath(path.join(sessionArtifactRoot(sessionId, cwd), "state.json"), cwd);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameStateFileWithRetry(tempPath: string, finalPath: string): Promise<void> {
	const retryCodes = new Set(["EBUSY", "EPERM", "EACCES"]);
	let lastError: unknown;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			await rename(tempPath, finalPath);
			return;
		} catch (error) {
			lastError = error;
			if (!retryCodes.has((error as NodeJS.ErrnoException).code || "")) throw error;
			await sleep(Math.min(250, 10 + attempt * 15));
		}
	}
	await rm(tempPath, { force: true }).catch(() => {});
	throw lastError;
}

function isProcessAlive(pid: unknown): boolean {
	const n = typeof pid === "number" ? pid : typeof pid === "string" ? Number(pid) : Number.NaN;
	if (!Number.isInteger(n) || n <= 0) return false;
	try {
		process.kill(n, 0);
		return true;
	} catch {
		return false;
	}
}

async function isStaleStateLock(lockPath: string): Promise<boolean> {
	try {
		const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
		const acquiredAt = Date.parse(String(parsed.acquiredAt || ""));
		const ageMs = Number.isFinite(acquiredAt) ? Date.now() - acquiredAt : Number.POSITIVE_INFINITY;
		const pid = Number(parsed.pid);
		if (Number.isInteger(pid)) return !isProcessAlive(pid) || ageMs > STATE_LOCK_STALE_MS * 20;
		return ageMs > STATE_LOCK_STALE_MS;
	} catch {
		try {
			const info = await stat(lockPath);
			return Date.now() - info.mtimeMs > STATE_LOCK_STALE_MS;
		} catch {
			return true;
		}
	}
}

async function stateLockExists(lockPath: string): Promise<boolean> {
	try {
		await stat(lockPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function releaseStateLock(lockPath: string, token: string): Promise<void> {
	try {
		const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
		if (parsed.token !== token) return;
		await rm(lockPath, { force: true });
	} catch {
		/* best-effort state lock release */
	}
}

async function removeLockIfUnchanged(lockPath: string, expectedToken?: string): Promise<void> {
	if (expectedToken) {
		const currentToken = await loadLockToken(lockPath);
		if (currentToken !== expectedToken) return;
	}
	await rm(lockPath, { force: true }).catch(() => {});
}

export async function waitForStateLockBreaker(breakerPath: string, started: number): Promise<void> {
	while (await stateLockExists(breakerPath)) {
		if (Date.now() - started >= STATE_LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for callback OAST state lock breaker: ${breakerPath}`);
		await sleep(STATE_LOCK_RETRY_MS);
	}
}

async function breakStaleStateLock(lockPath: string, breakerPath: string, started: number): Promise<void> {
	const token = randomUUID();
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	let created = false;
	try {
		handle = await open(breakerPath, "wx");
		created = true;
		await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token }), "utf8");
		await handle.close();
		handle = undefined;
		const staleToken = await loadLockToken(lockPath);
		if (await isStaleStateLock(lockPath)) await removeLockIfUnchanged(lockPath, staleToken);
	} catch (error) {
		await handle?.close().catch(() => {});
		if (created) await rm(breakerPath, { force: true }).catch(() => {});
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(`Failed to acquire callback OAST state lock breaker: ${breakerPath}`, { cause: error });
		if (Date.now() - started >= STATE_LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for callback OAST state lock breaker: ${breakerPath}`, { cause: error });
	} finally {
		if (created) await releaseStateLock(breakerPath, token);
	}
}

async function withStateLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const dir = path.dirname(filePath);
	const lockPath = `${filePath}.lock`;
	const breakerPath = `${lockPath}.breaker`;
	const started = Date.now();
	await mkdir(dir, { recursive: true });
	while (true) {
		await waitForStateLockBreaker(breakerPath, started);
		const token = randomUUID();
		let created = false;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(lockPath, "wx");
			created = true;
			await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token }), "utf8");
			await handle.close();
			handle = undefined;
		} catch (error) {
			await handle?.close().catch(() => {});
			if (created) await rm(lockPath, { force: true }).catch(() => {});
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(`Failed to acquire callback OAST state lock: ${lockPath}`, { cause: error });
			if (await isStaleStateLock(lockPath)) await breakStaleStateLock(lockPath, breakerPath, started);
			else if (Date.now() - started >= STATE_LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for callback OAST state lock: ${lockPath}`, { cause: error });
			await sleep(STATE_LOCK_RETRY_MS);
			continue;
		}
		try {
			return await fn();
		} finally {
			await releaseStateLock(lockPath, token);
		}
	}
}

export async function saveJsonUnlocked(filePath: string, value: unknown) {
	const dir = path.dirname(filePath);
	const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
	await mkdir(dir, { recursive: true });
	await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
	await renameStateFileWithRetry(temp, filePath);
}

export async function saveJson(filePath: string, value: unknown) {
	await withStateLock(filePath, () => saveJsonUnlocked(filePath, value));
}

export async function updateSessionStateByPath(statePath: string, update: (state: CallbackSessionState) => CallbackSessionState | Promise<CallbackSessionState>): Promise<CallbackSessionState | undefined> {
	return await withStateLock(statePath, async () => {
		const current = await loadSessionStateByPath(statePath);
		if (!current) return undefined;
		const next = await update(current);
		await saveJsonUnlocked(statePath, next);
		return next;
	});
}

export async function loadSessionStateByPath(statePath: string): Promise<CallbackSessionState | undefined> {
	try {
		// Trust the absolute path it is given (sessions are caller-cwd-rooted, so the
		// daemon-global root can't pin it). Derive artifactRoot/statePath from the path,
		// and keep path-traversal defense via the session-id + folder-segment checks.
		const resolvedStatePath = path.resolve(statePath);
		const artifactRoot = path.dirname(resolvedStatePath);
		if (path.basename(resolvedStatePath) !== "state.json") return undefined;
		if (path.basename(path.dirname(artifactRoot)) !== "callback-oast-sessions") return undefined;
		const dirSessionId = normalizeCallbackSessionId(path.basename(artifactRoot));
		const raw = JSON.parse(await readFile(resolvedStatePath, "utf8")) as Record<string, unknown>;
		if (!raw || typeof raw !== "object") return undefined;
		const sessionId = normalizeCallbackSessionId(raw.sessionId || dirSessionId);
		return {
			...(raw as Record<string, unknown>),
			sessionId,
			artifactRoot,
			statePath: resolvedStatePath,
		};
	} catch {
		return undefined;
	}
}

export async function loadSessionState(sessionId: string, cwd?: string): Promise<CallbackSessionState | undefined> {
	return await loadSessionStateByPath(sessionStatePath(sessionId, cwd));
}

function isPidAlive(pid: unknown): boolean {
	const n = typeof pid === "number" ? pid : typeof pid === "string" ? Number(pid) : Number.NaN;
	if (!Number.isInteger(n) || n <= 0) return false;
	try {
		process.kill(n, 0);
		return true;
	} catch {
		return false;
	}
}

export async function refreshSessionState(state: CallbackSessionState | undefined): Promise<CallbackSessionState | undefined> {
	if (!state) return undefined;
	if (state.listenerActive === true && !isPidAlive(state.workerPid)) {
		return await updateSessionStateByPath(state.statePath, (current) => current.listenerActive === true && !isPidAlive(current.workerPid)
			? { ...current, listenerActive: false, ready: false, recovered: true, stoppedAt: current.stoppedAt || new Date().toISOString(), stopReason: current.stopReason || "worker-exited" } as CallbackSessionState
			: current) ?? state;
	}
	return state;
}

export async function allSessionStates(cwd?: string): Promise<CallbackSessionState[]> {
	const root = sessionRoot(cwd);
	await mkdir(root, { recursive: true });
	const names = await readdir(root, { withFileTypes: true });
	const states: CallbackSessionState[] = [];
	for (const entry of names) {
		if (!entry.isDirectory() || !CALLBACK_SESSION_ID_PATTERN.test(entry.name)) continue;
		const state = await refreshSessionState(await loadSessionStateByPath(path.join(root, entry.name, "state.json")));
		if (state) states.push(state);
	}
	return states.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
}

export function sessionInfo(state: CallbackSessionState) {
	return {
		sessionId: state.sessionId,
		artifactRoot: state.artifactRoot,
		statePath: state.statePath,
		listenHost: state.listenHost,
		port: state.port,
		httpsPort: state.httpsPort,
		dnsPort: state.dnsPort,
		dnsListenHost: state.dnsListenHost,
		basePath: state.basePath,
		correlationId: state.correlationId,
		callbackUrl: state.callbackUrl,
		httpsCallbackUrl: state.httpsCallbackUrl,
		dnsCallbackHost: state.dnsCallbackHost,
		publicBaseUrl: state.publicBaseUrl,
		publicCallbackUrl: state.publicCallbackUrl,
		publicHttpsCallbackUrl: state.publicHttpsCallbackUrl,
		publicDnsCallbackHost: state.publicDnsCallbackHost,
		httpsCertificate: state.httpsCertificate,
		externalMetadata: state.externalMetadata,
		startedAt: state.startedAt,
		stoppedAt: state.stoppedAt,
		stopReason: state.stopReason,
		lastEventAt: state.lastEventAt,
		listenerActive: state.listenerActive,
		recovered: state.recovered,
		workerPid: state.workerPid,
		maxEvents: state.maxEvents,
		maxBodyBytes: state.maxBodyBytes,
		maxRuntimeMs: state.maxRuntimeMs,
		eventCount: state.eventCount ?? (Array.isArray(state.events) ? state.events.length : 0),
		nextSeq: state.nextSeq,
		enabledProtocols: [state.callbackUrl ? "http" : undefined, state.httpsCallbackUrl ? "https" : undefined, state.dnsCallbackHost ? "dns" : undefined].filter(Boolean),
	};
}

export function filterEvents(state: CallbackSessionState, afterSeq: number): Array<Record<string, unknown>> {
	const events = Array.isArray(state.events) ? state.events : [];
	return events.filter((event) => Number((event as Record<string, unknown>).seq) > afterSeq) as Array<Record<string, unknown>>;
}

export async function waitForState(sessionId: string, predicate: (state: CallbackSessionState) => boolean, timeoutMs = 10_000, cwd?: string): Promise<CallbackSessionState> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const state = await refreshSessionState(await loadSessionState(sessionId, cwd));
		if (state && predicate(state)) return state;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`browser_callback_oast timed out waiting for session ${sessionId}`);
}

export async function createCallbackSession(options: NormalizedCallbackSessionOptions) {
	const cwd = options.cwd;
	const sessionId = normalizeCallbackSessionId(options.sessionId || `oast-${randomUUID()}`);
	if (options.enableDns === true && !parseIpv4Address(options.dnsResponseAddress)) throw new Error(`browser_callback_oast dnsResponseAddress must be a valid IPv4 address for DNS A-record responses: ${options.dnsResponseAddress}`);
	const artifactRoot = sessionArtifactRoot(sessionId, cwd);
	const statePath = sessionStatePath(sessionId, cwd);
	const existing = await refreshSessionState(await loadSessionState(sessionId, cwd));
	if (existing?.listenerActive) throw new Error(`browser_callback_oast session already exists: ${sessionId}`);
	if (existing && !existing.listenerActive) {
		if (!isPathWithinSessionRoot(existing.artifactRoot, cwd)) throw new Error(`browser_callback_oast session artifact root escaped callback session storage: ${existing.artifactRoot}`);
		await rm(existing.artifactRoot, { recursive: true, force: true }).catch(() => {});
	}
	await mkdir(artifactRoot, { recursive: true });
	const httpsMaterial = options.enableHttps ? prepareHttpsCertificate(artifactRoot) : undefined;
	const state: CallbackSessionState = {
		sessionId,
		artifactRoot,
		statePath,
		listenHost: options.listenHost,
		dnsListenHost: options.dnsListenHost,
		port: options.port,
		httpsPort: options.httpsPort,
		dnsPort: options.dnsPort,
		publicBaseUrl: options.publicBaseUrl,
		publicHttpsBaseUrl: options.publicHttpsBaseUrl,
		publicDnsBaseDomain: options.publicDnsBaseDomain,
		dnsBaseDomain: options.dnsBaseDomain,
		dnsResponseAddress: options.dnsResponseAddress,
		basePath: options.basePath,
		correlationId: options.correlationId,
		startedAt: new Date().toISOString(),
		maxEvents: options.maxEvents,
		maxBodyBytes: options.maxBodyBytes,
		maxRuntimeMs: callbackRuntimeMs(options.maxRuntimeMs),
		responseStatus: options.responseStatus,
		responseBody: options.responseBody,
		responseHeaders: options.responseHeaders,
		enableHttps: options.enableHttps,
		enableDns: options.enableDns,
		httpsKeyPath: httpsMaterial?.keyPath,
		httpsCertPath: httpsMaterial?.certPath,
		externalMetadata: options.externalMetadata,
		listenerActive: false,
		ready: false,
		recovered: false,
		nextSeq: 1,
		eventCount: 0,
		events: [],
	};
	await saveJson(statePath, state);
	const stdoutPath = path.join(artifactRoot, "worker.stdout.log");
	const stderrPath = path.join(artifactRoot, "worker.stderr.log");
	const stdoutFd = openSync(stdoutPath, "a");
	const stderrFd = openSync(stderrPath, "a");
	try {
		const child = spawn(process.execPath, [WORKER_PATH, statePath], { detached: true, stdio: ["ignore", stdoutFd, stderrFd], windowsHide: true });
		child.unref();
	} finally {
		closeSync(stdoutFd);
		closeSync(stderrFd);
	}
	const ready = await waitForState(sessionId, (current) => current.ready === true || typeof current.error === "string", 10_000, cwd);
	if (typeof ready.error === "string") {
		if (options.enableHttps) {
			await rm(resolveHttpsKeyPath(artifactRoot), { force: true }).catch(() => {});
			await rm(resolveHttpsCertPath(artifactRoot), { force: true }).catch(() => {});
		}
		throw new Error(`browser_callback_oast worker failed: ${ready.error}`);
	}
	return ready;
}

export async function stopSession(state: CallbackSessionState) {
	const pid = state.workerPid;
	if (isPidAlive(pid)) {
		try {
			process.kill(Number(pid), "SIGTERM");
		} catch {
			/* best-effort worker shutdown signal */
		}
	}
	try {
		return await waitForState(state.sessionId, (current) => current.listenerActive !== true, 10_000);
	} catch {
		return await updateSessionStateByPath(state.statePath, (current) => ({ ...current, listenerActive: false, ready: false, recovered: true, stoppedAt: new Date().toISOString(), stopReason: current.stopReason || state.stopReason || "stop-timeout" } as CallbackSessionState))
			?? { ...state, listenerActive: false, ready: false, recovered: true, stoppedAt: new Date().toISOString(), stopReason: state.stopReason || "stop-timeout" } as CallbackSessionState;
	}
}

