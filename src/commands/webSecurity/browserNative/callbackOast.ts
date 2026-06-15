import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { createCodedError } from "../../../utils/codedError.js";
import https from "node:https";
import dgram from "node:dgram";
import { allSessionStates, createCallbackSession, filterEvents, loadSessionState, normalizeCallbackSessionId, refreshSessionState, sessionInfo, stopSession, updateSessionStateByPath, waitForState, type CallbackSessionState } from "./oastWorkerManager.js";
import { asString, isRecord, normalizeMethod, positiveInt, requestCwd } from "../shared/normalize.js";
import { assertAllowedTargetUrl, normalizeHeaders } from "../shared/http.js";
import type { HeaderMap, RawCallbackOastOptions } from "../shared/types.js";

type CallbackAction = "start" | "list" | "status" | "collect" | "clear" | "trigger" | "stop";

type NormalizedCallbackOastOptions = {
	action: CallbackAction;
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
	maxRuntimeMs: number;
	afterSeq: number;
	timeoutMs: number;
};

function callbackOastInputError(message: string, details: Record<string, unknown> = {}): Error {
	return createCodedError({ name: "CallbackOastInputError", code: "INVALID_RULE", message, details, suppressStack: false });
}

function normalizeCallbackAction(value: unknown): CallbackAction {
	const action = String(value || "start").trim().toLowerCase();
	if (!action || value === undefined || value === null) return "start";
	if (action === "start" || action === "list" || action === "status" || action === "collect" || action === "clear" || action === "trigger" || action === "stop") return action;
	throw callbackOastInputError(`Unsupported browser_callback_oast action: ${action}`, { action });
}

function callbackPort(value: unknown): number {
	const raw = typeof value === "string" ? Number(value) : typeof value === "number" ? value : 0;
	return Number.isInteger(raw) && raw >= 0 && raw <= 65_535 ? raw : 0;
}

function normalizeTriggerMode(value: unknown): "http" | "https" | "dns" {
	const mode = String(value || "").toLowerCase();
	if (mode === "https") return "https";
	if (mode === "dns") return "dns";
	return "http";
}

function normalizeCallbackOastOptions(options: RawCallbackOastOptions): NormalizedCallbackOastOptions {
	const action = normalizeCallbackAction(options.action);
	const rawSessionId = asString(options.sessionId)?.trim() || (action === "start" ? `oast-${randomUUID()}` : undefined);
	const sessionId = rawSessionId ? normalizeCallbackSessionId(rawSessionId) : undefined;
	const bodyBase64 = asString(options.bodyBase64 ?? options.triggerBodyBase64);
	return {
		action,
		cwd: requestCwd(options),
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
		basePath: asString(options.basePath)?.trim() || "/__browser_pilot_oast/{{correlationId}}",
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
		maxRuntimeMs: Math.min(24 * 60 * 60 * 1000, Math.max(1_000, positiveInt(options.maxRuntimeMs, 60 * 60 * 1000))),
		afterSeq: Math.max(0, positiveInt(options.afterSeq, 0)),
		timeoutMs: Math.max(500, positiveInt(options.triggerTimeoutMs ?? options.timeoutMs, 5_000)),
	};
}

function dnsQuestionLabels(name: string) {
	const labels = String(name || "").trim().replace(/\.+$/, "").split(".").filter(Boolean).map((part, index) => ({ index, bytes: Buffer.from(part, "utf8") }));
	for (const label of labels) {
		if (label.bytes.length > 63) throw callbackOastInputError(`browser_callback_oast dns query label ${label.index + 1} exceeds 63 bytes (${label.bytes.length})`, { index: label.index, bytes: label.bytes.length });
	}
	const wireLength = labels.reduce((sum, label) => sum + 1 + label.bytes.length, 1);
	if (wireLength > 255) throw callbackOastInputError(`browser_callback_oast dns query name exceeds 255 bytes (${wireLength})`, { wireLength });
	return labels.map((label) => label.bytes);
}

function buildDnsQuery(name: string, type = "A") {
	const id = Math.floor(Math.random() * 65535);
	const header = Buffer.alloc(12);
	header.writeUInt16BE(id, 0);
	header.writeUInt16BE(0x0100, 2);
	header.writeUInt16BE(1, 4);
	const labels = dnsQuestionLabels(name);
	const question = Buffer.concat([
		...labels.flatMap((label) => [Buffer.from([label.length]), label]),
		Buffer.from([0]),
		Buffer.from([0, String(type || "A").toUpperCase() === "TXT" ? 16 : 1, 0, 1]),
	]);
	return { id, packet: Buffer.concat([header, question]) };
}

async function triggerHttpLike(url: string, options: { method: string; headers: HeaderMap; body?: Buffer | string; rejectUnauthorized: boolean; allowPrivateTargets?: boolean }) {
	await assertAllowedTargetUrl(url, { allowPrivateTargets: options.allowPrivateTargets, allowLoopback: true });
	return await new Promise<Record<string, unknown>>((resolve, reject) => {
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
		if (!target) throw callbackOastInputError("browser_callback_oast trigger dns requires dns listener metadata or queryName/target", { mode: options.mode, field: "target|queryName" });
		const resolverHost = options.resolverHost || (String(state.dnsListenHost || "127.0.0.1") === "0.0.0.0" ? "127.0.0.1" : String(state.dnsListenHost || "127.0.0.1"));
		const resolverPort = options.resolverPort || callbackPort(state.dnsPort);
		if (!resolverPort) throw callbackOastInputError("browser_callback_oast trigger dns requires resolverPort or an active dns listener", { mode: options.mode, field: "resolverPort" });
		trigger = await triggerDnsQuery(target, resolverHost, resolverPort, options.queryType, options.timeoutMs);
	} else {
		target = options.target || asString(options.mode === "https" ? state.httpsCallbackUrl : state.callbackUrl);
		if (!target) throw callbackOastInputError(`browser_callback_oast trigger ${options.mode} requires a target URL or an active ${options.mode.toUpperCase()} listener`, { mode: options.mode, field: "target" });
		const headers = { ...options.headers };
		const body = options.body ?? `${state.correlationId}`;
		if (!headers["Content-Type"] && !headers["content-type"] && typeof body === "string") headers["Content-Type"] = "text/plain; charset=utf-8";
		const allowPrivateTargets = target === state.callbackUrl || target === state.httpsCallbackUrl;
		trigger = await triggerHttpLike(target, { method: options.method, headers, body, rejectUnauthorized: options.mode === "https" ? options.rejectUnauthorized : true, allowPrivateTargets });
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
		const sessions = await allSessionStates(normalized.cwd);
		return { ok: true, action: normalized.action, count: sessions.length, activeCount: sessions.filter((session) => session.listenerActive === true).length, sessions: sessions.map(sessionInfo) };
	}
	if (!normalized.sessionId) throw callbackOastInputError(`browser_callback_oast action ${normalized.action} requires sessionId`, { action: normalized.action, field: "sessionId" });
	const session = await refreshSessionState(await loadSessionState(normalized.sessionId, normalized.cwd));
	if (!session) throw callbackOastInputError(`browser_callback_oast unknown sessionId: ${normalized.sessionId}`, { sessionId: normalized.sessionId });
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
	throw callbackOastInputError(`Unsupported browser_callback_oast action: ${normalized.action}`, { action: normalized.action });
}
