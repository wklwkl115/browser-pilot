import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HeaderMap } from "../shared/types";

export type CallbackSessionState = Record<string, unknown> & {
	sessionId: string;
	artifactRoot: string;
	statePath: string;
};

export type NormalizedCallbackSessionOptions = {
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
};

const SESSION_ROOT = path.resolve(process.cwd(), ".pi", "browser-artifacts", "callback-oast-sessions");
const WORKER_PATH = fileURLToPath(new URL("./callbackOastWorker.mjs", import.meta.url));
const STATE_LOCK_TIMEOUT_MS = 10_000;
const STATE_LOCK_RETRY_MS = 25;
const STATE_LOCK_STALE_MS = 30_000;

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

export function sessionArtifactRoot(sessionId: string): string {
	return path.join(SESSION_ROOT, sessionId);
}

export function sessionStatePath(sessionId: string): string {
	return path.join(sessionArtifactRoot(sessionId), "state.json");
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
	} catch {}
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
		if (await isStaleStateLock(lockPath)) await rm(lockPath, { force: true }).catch(() => {});
	} catch (error) {
		await handle?.close().catch(() => {});
		if (created) await rm(breakerPath, { force: true }).catch(() => {});
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (Date.now() - started >= STATE_LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for callback OAST state lock breaker: ${breakerPath}`);
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
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (await isStaleStateLock(lockPath)) await breakStaleStateLock(lockPath, breakerPath, started);
			else if (Date.now() - started >= STATE_LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for callback OAST state lock: ${lockPath}`);
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
		const raw = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
		if (!raw || typeof raw !== "object") return undefined;
		return { ...(raw as Record<string, unknown>), sessionId: String(raw.sessionId || path.basename(path.dirname(statePath))), artifactRoot: String(raw.artifactRoot || path.dirname(statePath)), statePath };
	} catch {
		return undefined;
	}
}

export async function loadSessionState(sessionId: string): Promise<CallbackSessionState | undefined> {
	return await loadSessionStateByPath(sessionStatePath(sessionId));
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

export async function allSessionStates(): Promise<CallbackSessionState[]> {
	await mkdir(SESSION_ROOT, { recursive: true });
	const names = await readdir(SESSION_ROOT, { withFileTypes: true });
	const states: CallbackSessionState[] = [];
	for (const entry of names) {
		if (!entry.isDirectory()) continue;
		const state = await refreshSessionState(await loadSessionStateByPath(path.join(SESSION_ROOT, entry.name, "state.json")));
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
		lastEventAt: state.lastEventAt,
		listenerActive: state.listenerActive,
		recovered: state.recovered,
		workerPid: state.workerPid,
		maxEvents: state.maxEvents,
		maxBodyBytes: state.maxBodyBytes,
		eventCount: state.eventCount ?? (Array.isArray(state.events) ? state.events.length : 0),
		nextSeq: state.nextSeq,
		enabledProtocols: [state.callbackUrl ? "http" : undefined, state.httpsCallbackUrl ? "https" : undefined, state.dnsCallbackHost ? "dns" : undefined].filter(Boolean),
	};
}

export function filterEvents(state: CallbackSessionState, afterSeq: number): Array<Record<string, unknown>> {
	const events = Array.isArray(state.events) ? state.events : [];
	return events.filter((event) => Number((event as Record<string, unknown>).seq) > afterSeq) as Array<Record<string, unknown>>;
}

export async function waitForState(sessionId: string, predicate: (state: CallbackSessionState) => boolean, timeoutMs = 10_000): Promise<CallbackSessionState> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const state = await refreshSessionState(await loadSessionState(sessionId));
		if (state && predicate(state)) return state;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`browser_callback_oast timed out waiting for session ${sessionId}`);
}

export async function createCallbackSession(options: NormalizedCallbackSessionOptions) {
	const sessionId = options.sessionId || `oast-${randomUUID()}`;
	if (options.enableDns === true && !parseIpv4Address(options.dnsResponseAddress)) throw new Error(`browser_callback_oast dnsResponseAddress must be a valid IPv4 address for DNS A-record responses: ${options.dnsResponseAddress}`);
	const existing = await refreshSessionState(await loadSessionState(sessionId));
	if (existing?.listenerActive) throw new Error(`browser_callback_oast session already exists: ${sessionId}`);
	if (existing && !existing.listenerActive) await rm(existing.artifactRoot, { recursive: true, force: true }).catch(() => {});
	const artifactRoot = sessionArtifactRoot(sessionId);
	const statePath = sessionStatePath(sessionId);
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
		responseStatus: options.responseStatus,
		responseBody: options.responseBody,
		responseHeaders: options.responseHeaders,
		enableHttps: options.enableHttps,
		enableDns: options.enableDns,
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
	const ready = await waitForState(sessionId, (current) => current.ready === true || typeof current.error === "string", 10_000);
	if (typeof ready.error === "string") throw new Error(`browser_callback_oast worker failed: ${ready.error}`);
	return ready;
}

export async function stopSession(state: CallbackSessionState) {
	const pid = state.workerPid;
	if (isPidAlive(pid)) {
		try {
			process.kill(Number(pid), "SIGTERM");
		} catch {}
	}
	try {
		return await waitForState(state.sessionId, (current) => current.listenerActive !== true, 10_000);
	} catch {
		return await updateSessionStateByPath(state.statePath, (current) => ({ ...current, listenerActive: false, ready: false, recovered: true, stoppedAt: new Date().toISOString(), stopReason: current.stopReason || state.stopReason || "stop-timeout" } as CallbackSessionState))
			?? { ...state, listenerActive: false, ready: false, recovered: true, stoppedAt: new Date().toISOString(), stopReason: state.stopReason || "stop-timeout" } as CallbackSessionState;
	}
}

