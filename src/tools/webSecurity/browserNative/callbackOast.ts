import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asString, isRecord, normalizeMethod, positiveInt } from "../shared/normalize";
import { normalizeHeaders } from "../shared/http";
import type { HeaderMap, RawCallbackOastOptions } from "../shared/types";

type CallbackSessionState = Record<string, unknown> & {
	sessionId: string;
	artifactRoot: string;
	statePath: string;
};

type CallbackAction = "start" | "list" | "status" | "collect" | "clear" | "trigger" | "stop";

type NormalizedCallbackOastOptions = {
	action: CallbackAction;
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
	mode: "http" | "https" | "dns";
	target?: string;
	method: string;
	headers: HeaderMap;
	body?: string | Buffer;
	queryName?: string;
	queryType: string;
	resolverHost?: string;
	resolverPort: number;
	rejectUnauthorized: boolean;
	maxEvents: number;
	maxBodyBytes: number;
	afterSeq: number;
	timeoutMs: number;
};

const SESSION_ROOT = path.resolve(process.cwd(), ".pi", "browser-artifacts", "callback-oast-sessions");
const WORKER_PATH = fileURLToPath(new URL("./callbackOastWorker.mjs", import.meta.url));
const STATE_LOCK_TIMEOUT_MS = 10_000;
const STATE_LOCK_RETRY_MS = 25;
const STATE_LOCK_STALE_MS = 30_000;

function normalizeCallbackAction(value: unknown): CallbackAction {
	const action = String(value || "start").trim().toLowerCase();
	if (!action || value === undefined || value === null) return "start";
	if (action === "start" || action === "list" || action === "status" || action === "collect" || action === "clear" || action === "trigger" || action === "stop") return action;
	throw new Error(`Unsupported browser_callback_oast action: ${action}`);
}

function callbackPort(value: unknown): number {
	const raw = typeof value === "string" ? Number(value) : typeof value === "number" ? value : 0;
	return Number.isInteger(raw) && raw >= 0 && raw <= 65_535 ? raw : 0;
}

function callbackPath(basePath: string, correlationId: string): string {
	const withSlash = basePath.startsWith("/") ? basePath : `/${basePath}`;
	if (withSlash.includes("{{correlationId}}")) return withSlash.replaceAll("{{correlationId}}", encodeURIComponent(correlationId));
	return withSlash.endsWith("/") ? `${withSlash}${encodeURIComponent(correlationId)}` : `${withSlash}/${encodeURIComponent(correlationId)}`;
}

function sessionArtifactRoot(sessionId: string): string {
	return path.join(SESSION_ROOT, sessionId);
}

function sessionStatePath(sessionId: string): string {
	return path.join(sessionArtifactRoot(sessionId), "state.json");
}

function normalizeTriggerMode(value: unknown): "http" | "https" | "dns" {
	const mode = String(value || "").toLowerCase();
	if (mode === "https") return "https";
	if (mode === "dns") return "dns";
	return "http";
}

function normalizeCallbackOastOptions(options: RawCallbackOastOptions): NormalizedCallbackOastOptions {
	const action = normalizeCallbackAction(options.action);
	const sessionId = asString(options.sessionId)?.trim() || (action === "start" ? `oast-${randomUUID()}` : undefined);
	const bodyBase64 = asString(options.bodyBase64 ?? options.triggerBodyBase64);
	return {
		action,
		sessionId,
		listenHost: asString(options.listenHost)?.trim() || "127.0.0.1",
		dnsListenHost: asString(options.dnsListenHost)?.trim() || asString(options.listenHost)?.trim() || "127.0.0.1",
		port: callbackPort(options.port),
		httpsPort: callbackPort(options.httpsPort),
		dnsPort: callbackPort(options.dnsPort),
		publicBaseUrl: asString(options.publicBaseUrl)?.trim() || undefined,
		publicHttpsBaseUrl: asString(options.publicHttpsBaseUrl)?.trim() || undefined,
		publicDnsBaseDomain: asString(options.publicDnsBaseDomain)?.trim() || undefined,
		dnsBaseDomain: asString(options.dnsBaseDomain)?.trim() || undefined,
		dnsResponseAddress: asString(options.dnsResponseAddress)?.trim() || "127.0.0.1",
		basePath: asString(options.basePath)?.trim() || "/__pi_oast/{{correlationId}}",
		correlationId: asString(options.correlationId)?.trim() || randomUUID().replace(/-/g, ""),
		responseStatus: Math.min(599, Math.max(100, positiveInt(options.responseStatus, 200))),
		responseBody: asString(options.responseBody) ?? "ok\n",
		responseHeaders: { "Content-Type": "text/plain; charset=utf-8", ...normalizeHeaders(options.responseHeaders) },
		enableHttps: options.enableHttps === true,
		enableDns: options.enableDns === true,
		externalMetadata: isRecord(options.externalMetadata) ? { ...options.externalMetadata } : undefined,
		mode: normalizeTriggerMode(options.mode ?? options.triggerMode),
		target: asString(options.target ?? options.triggerTarget)?.trim() || undefined,
		method: normalizeMethod(options.method ?? options.triggerMethod ?? "POST", "POST"),
		headers: normalizeHeaders(options.requestHeaders ?? options.headers),
		body: bodyBase64 !== undefined ? Buffer.from(bodyBase64, "base64") : asString(options.body ?? options.triggerBody) ?? undefined,
		queryName: asString(options.queryName)?.trim() || undefined,
		queryType: asString(options.queryType)?.trim() || "A",
		resolverHost: asString(options.resolverHost)?.trim() || undefined,
		resolverPort: callbackPort(options.resolverPort),
		rejectUnauthorized: options.rejectUnauthorized === true,
		maxEvents: Math.min(100_000, positiveInt(options.maxEvents, 1_000)),
		maxBodyBytes: Math.min(10_000_000, positiveInt(options.maxBodyBytes, 64_000)),
		afterSeq: Math.max(0, positiveInt(options.afterSeq, 0)),
		timeoutMs: Math.max(500, positiveInt(options.timeoutMs, 5_000)),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

async function withStateLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const dir = path.dirname(filePath);
	const lockPath = `${filePath}.lock`;
	const started = Date.now();
	await mkdir(dir, { recursive: true });
	while (true) {
		let acquired = false;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(lockPath, "wx");
			acquired = true;
			await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), "utf8");
			await handle.close();
			handle = undefined;
			return await fn();
		} catch (error) {
			await handle?.close().catch(() => {});
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (await isStaleStateLock(lockPath)) await rm(lockPath, { force: true }).catch(() => {});
			else if (Date.now() - started >= STATE_LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for callback OAST state lock: ${lockPath}`);
			await sleep(STATE_LOCK_RETRY_MS);
		} finally {
			if (acquired) await rm(lockPath, { force: true }).catch(() => {});
		}
	}
}

async function saveJsonUnlocked(filePath: string, value: unknown) {
	const dir = path.dirname(filePath);
	const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
	await mkdir(dir, { recursive: true });
	await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
	await rename(temp, filePath);
}

async function saveJson(filePath: string, value: unknown) {
	await withStateLock(filePath, () => saveJsonUnlocked(filePath, value));
}

async function updateSessionStateByPath(statePath: string, update: (state: CallbackSessionState) => CallbackSessionState | Promise<CallbackSessionState>): Promise<CallbackSessionState | undefined> {
	return await withStateLock(statePath, async () => {
		const current = await loadSessionStateByPath(statePath);
		if (!current) return undefined;
		const next = await update(current);
		await saveJsonUnlocked(statePath, next);
		return next;
	});
}

async function loadSessionStateByPath(statePath: string): Promise<CallbackSessionState | undefined> {
	try {
		const raw = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
		if (!raw || typeof raw !== "object") return undefined;
		return { ...(raw as Record<string, unknown>), sessionId: String(raw.sessionId || path.basename(path.dirname(statePath))), artifactRoot: String(raw.artifactRoot || path.dirname(statePath)), statePath };
	} catch {
		return undefined;
	}
}

async function loadSessionState(sessionId: string): Promise<CallbackSessionState | undefined> {
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

async function refreshSessionState(state: CallbackSessionState | undefined): Promise<CallbackSessionState | undefined> {
	if (!state) return undefined;
	if (state.listenerActive === true && !isPidAlive(state.workerPid)) {
		return await updateSessionStateByPath(state.statePath, (current) => current.listenerActive === true && !isPidAlive(current.workerPid)
			? { ...current, listenerActive: false, ready: false, recovered: true, stoppedAt: current.stoppedAt || new Date().toISOString(), stopReason: current.stopReason || "worker-exited" } as CallbackSessionState
			: current) ?? state;
	}
	return state;
}

async function allSessionStates(): Promise<CallbackSessionState[]> {
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

function sessionInfo(state: CallbackSessionState) {
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

function filterEvents(state: CallbackSessionState, afterSeq: number): Array<Record<string, unknown>> {
	const events = Array.isArray(state.events) ? state.events : [];
	return events.filter((event) => Number((event as Record<string, unknown>).seq) > afterSeq) as Array<Record<string, unknown>>;
}

async function waitForState(sessionId: string, predicate: (state: CallbackSessionState) => boolean, timeoutMs = 10_000): Promise<CallbackSessionState> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const state = await refreshSessionState(await loadSessionState(sessionId));
		if (state && predicate(state)) return state;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`browser_callback_oast timed out waiting for session ${sessionId}`);
}

async function createCallbackSession(options: NormalizedCallbackOastOptions) {
	const sessionId = options.sessionId || `oast-${randomUUID()}`;
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

async function stopSession(state: CallbackSessionState) {
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

function buildDnsQuery(name: string, type = "A") {
	const id = Math.floor(Math.random() * 65535);
	const header = Buffer.alloc(12);
	header.writeUInt16BE(id, 0);
	header.writeUInt16BE(0x0100, 2);
	header.writeUInt16BE(1, 4);
	const labels = String(name || "").replace(/\.+$/, "").split(".").filter(Boolean).map((part) => Buffer.from(part, "utf8"));
	const question = Buffer.concat([
		...labels.flatMap((label) => [Buffer.from([label.length]), label]),
		Buffer.from([0]),
		Buffer.from([0, String(type || "A").toUpperCase() === "TXT" ? 16 : 1, 0, 1]),
	]);
	return { id, packet: Buffer.concat([header, question]) };
}

function triggerHttpLike(url: string, options: { method: string; headers: HeaderMap; body?: Buffer | string; rejectUnauthorized: boolean }) {
	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const target = new URL(url);
		const lib = target.protocol === "https:" ? https : http;
		const request = lib.request(target, { method: options.method, headers: options.headers, rejectUnauthorized: target.protocol === "https:" ? options.rejectUnauthorized : undefined }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			response.on("end", () => resolve({ status: response.statusCode, statusText: response.statusMessage, headerNames: Object.keys(response.headers), bodyBytes: Buffer.concat(chunks).length }));
		});
		request.on("error", reject);
		if (options.body !== undefined) request.write(options.body);
		request.end();
	});
}

async function triggerDnsQuery(target: string, resolverHost: string, resolverPort: number, queryType: string, timeoutMs: number) {
	const { id, packet } = buildDnsQuery(target, queryType);
	const socket = dgram.createSocket("udp4");
	return await new Promise<Record<string, unknown>>((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.close();
			reject(new Error(`DNS trigger timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		socket.on("message", (message) => {
			clearTimeout(timer);
			socket.close();
			resolve({ id, resolverHost, resolverPort, responseBytes: message.length });
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			socket.close();
			reject(error);
		});
		socket.send(packet, resolverPort, resolverHost);
	});
}

async function triggerSession(state: CallbackSessionState, options: NormalizedCallbackOastOptions) {
	const beforeSeq = Math.max(0, positiveInt(state.nextSeq, 1) - 1);
	let target: string | undefined;
	let trigger: Record<string, unknown>;
	if (options.mode === "dns") {
		target = options.target || options.queryName || asString(state.dnsCallbackHost);
		if (!target) throw new Error("browser_callback_oast trigger dns requires dns listener metadata or queryName/target");
		const resolverHost = options.resolverHost || (String(state.dnsListenHost || "127.0.0.1") === "0.0.0.0" ? "127.0.0.1" : String(state.dnsListenHost || "127.0.0.1"));
		const resolverPort = options.resolverPort || callbackPort(state.dnsPort);
		if (!resolverPort) throw new Error("browser_callback_oast trigger dns requires resolverPort or an active dns listener");
		trigger = await triggerDnsQuery(target, resolverHost, resolverPort, options.queryType, options.timeoutMs);
	} else {
		target = options.target || asString(options.mode === "https" ? state.httpsCallbackUrl : state.callbackUrl);
		if (!target) throw new Error(`browser_callback_oast trigger ${options.mode} requires a target URL or an active ${options.mode.toUpperCase()} listener`);
		const headers = { ...options.headers };
		const body = options.body ?? `${state.correlationId}`;
		if (!headers["Content-Type"] && !headers["content-type"] && typeof body === "string") headers["Content-Type"] = "text/plain; charset=utf-8";
		trigger = await triggerHttpLike(target, { method: options.method, headers, body, rejectUnauthorized: options.mode === "https" ? options.rejectUnauthorized : true });
	}
	const after = await waitForState(state.sessionId, (current) => filterEvents(current, beforeSeq).length > 0 || current.listenerActive !== true, Math.max(1_000, options.timeoutMs));
	const events = filterEvents(after, beforeSeq);
	return { ok: true, action: "trigger", ...sessionInfo(after), mode: options.mode, target, beforeSeq, count: events.length, events, trigger };
}

export async function runCallbackOast(options: RawCallbackOastOptions) {
	const normalized = normalizeCallbackOastOptions(options);
	if (normalized.action === "start") {
		const state = await createCallbackSession(normalized);
		return { ok: true, action: normalized.action, ...sessionInfo(state), events: [] };
	}
	if (normalized.action === "list") {
		const sessions = await allSessionStates();
		return { ok: true, action: normalized.action, count: sessions.length, activeCount: sessions.filter((session) => session.listenerActive === true).length, sessions: sessions.map(sessionInfo) };
	}
	if (!normalized.sessionId) throw new Error(`browser_callback_oast action ${normalized.action} requires sessionId`);
	const session = await refreshSessionState(await loadSessionState(normalized.sessionId));
	if (!session) throw new Error(`browser_callback_oast unknown sessionId: ${normalized.sessionId}`);
	if (normalized.action === "status") return { ok: true, action: normalized.action, ...sessionInfo(session) };
	if (normalized.action === "collect") {
		const events = filterEvents(session, normalized.afterSeq);
		return { ok: true, action: normalized.action, ...sessionInfo(session), afterSeq: normalized.afterSeq, count: events.length, events };
	}
	if (normalized.action === "clear") {
		let cleared = 0;
		const clearedState = await updateSessionStateByPath(session.statePath, (current) => {
			cleared = Array.isArray(current.events) ? current.events.length : 0;
			return { ...current, events: [], eventCount: 0, lastClearedAt: new Date().toISOString() } as CallbackSessionState;
		}) ?? session;
		return { ok: true, action: normalized.action, ...sessionInfo(clearedState), cleared };
	}
	if (normalized.action === "trigger") return await triggerSession(session, normalized);
	if (normalized.action === "stop") {
		const stopped = await stopSession(session);
		const events = Array.isArray(stopped.events) ? stopped.events : [];
		return { ok: true, action: normalized.action, ...sessionInfo(stopped), count: events.length, events };
	}
	throw new Error(`Unsupported browser_callback_oast action: ${normalized.action}`);
}
