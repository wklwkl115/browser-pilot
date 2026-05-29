import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { WebSocket, type ClientOptions, type RawData } from "ws";
import { isSafeRegexPattern, unsafeRegexReason } from "../../../utils/safeRegex";
import { tryJson } from "./normalize";

export type WsSessionState = "opening" | "open" | "closed" | "error";
export type WsTranscriptEvent = "open" | "send" | "message" | "close" | "error";

export type WsTranscriptEntry = {
	seq: number;
	t: number;
	event: WsTranscriptEvent;
	direction?: "outbound" | "inbound";
	text?: string;
	preview?: string;
	bytes?: number;
	binary?: boolean;
	json?: unknown;
	code?: number;
	reason?: string;
	wasClean?: boolean;
	error?: string;
};

type WsSessionRecord = {
	sessionId: string;
	url: string;
	state: WsSessionState;
	createdAt: string;
	openedAt?: string;
	closedAt?: string;
	lastEventAt?: string;
	lastError?: string;
	headers: Record<string, string>;
	protocols: string[];
	maxTranscript: number;
	seq: number;
	transcript: WsTranscriptEntry[];
	ws: WebSocket;
	emitter: EventEmitter;
};

export type WsSessionStatus = {
	sessionId: string;
	exists: boolean;
	active: boolean;
	url?: string;
	state?: WsSessionState | "missing";
	createdAt?: string;
	openedAt?: string;
	closedAt?: string;
	lastEventAt?: string;
	lastError?: string;
	transcriptCount: number;
	maxTranscript?: number;
	protocols?: string[];
	headers?: Record<string, string>;
	lastEvent?: WsTranscriptEntry;
};

export type OpenWsSessionParams = {
	sessionId?: string;
	url: string;
	headers?: Record<string, string>;
	protocols?: string[];
	timeoutMs?: number;
	maxTranscript?: number;
};

export type SendWsSessionParams = {
	sessionId?: string;
	text: string;
};

export type ReplayWsSequenceStep = {
	text: string;
	contains?: string;
	regex?: string;
	timeoutMs?: number;
};

export type WaitWsSessionParams = {
	sessionId?: string;
	afterSeq?: number;
	contains?: string;
	regex?: string;
	timeoutMs?: number;
};

export type CollectWsSessionParams = {
	sessionId?: string;
	afterSeq?: number;
	limit?: number;
};

export type CloseWsSessionParams = {
	sessionId?: string;
	code?: number;
	reason?: string;
	timeoutMs?: number;
};

export type WsWaitMatch = {
	matcher: { contains?: string; regex?: string; afterSeq: number };
	entry: WsTranscriptEntry;
	waitedMs: number;
	matchedImmediately: boolean;
};

export type WsReplayStepResult = {
	index: number;
	sent: { seq: number; bytes: number; preview: string };
	matched?: WsWaitMatch;
};

export type WsReplayFailure = {
	stepIndex: number;
	step: ReplayWsSequenceStep;
	lastSeq: number;
	partialSteps: WsReplayStepResult[];
	partialTranscript: WsTranscriptEntry[];
	error: { code?: string; message: string; details?: Record<string, unknown> };
};

const wsSessions = new Map<string, WsSessionRecord>();
const DEFAULT_SESSION_ID = "default";
const DEFAULT_OPEN_TIMEOUT_MS = 5_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_TRANSCRIPT = 200;

function wsShellError(message: string, code: string, details: Record<string, unknown> = {}): Error & { code: string; details: Record<string, unknown> } {
	const error = new Error(message) as Error & { code: string; details: Record<string, unknown> };
	error.code = code;
	error.details = details;
	return error;
}

function sessionKey(sessionId: unknown): string {
	const normalized = String(sessionId || DEFAULT_SESSION_ID).trim();
	return normalized || DEFAULT_SESSION_ID;
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function nowIso(): string {
	return new Date().toISOString();
}

function previewText(text: string, limit = 160): string {
	const compact = String(text || "").replace(/\s+/g, " ").trim();
	return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

function normalizeRawData(data: RawData): { text: string; bytes: number; binary: boolean } {
	if (typeof data === "string") return { text: data, bytes: Buffer.byteLength(data, "utf8"), binary: false };
	if (Buffer.isBuffer(data)) return { text: data.toString("utf8"), bytes: data.byteLength, binary: true };
	if (data instanceof ArrayBuffer) {
		const buffer = Buffer.from(data);
		return { text: buffer.toString("utf8"), bytes: buffer.byteLength, binary: true };
	}
	if (ArrayBuffer.isView(data)) {
		const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
		return { text: buffer.toString("utf8"), bytes: buffer.byteLength, binary: true };
	}
	if (Array.isArray(data)) {
		const buffers = data.map((item) => Buffer.isBuffer(item) ? item : Buffer.from(item));
		const buffer = Buffer.concat(buffers);
		return { text: buffer.toString("utf8"), bytes: buffer.byteLength, binary: true };
	}
	const text = String(data ?? "");
	return { text, bytes: Buffer.byteLength(text, "utf8"), binary: false };
}

function rememberTranscript(session: WsSessionRecord, entry: Omit<WsTranscriptEntry, "seq" | "t">): WsTranscriptEntry {
	session.seq += 1;
	const item: WsTranscriptEntry = {
		seq: session.seq,
		t: Date.now(),
		...entry,
	};
	session.transcript.push(item);
	if (session.transcript.length > session.maxTranscript) session.transcript.splice(0, session.transcript.length - session.maxTranscript);
	session.lastEventAt = nowIso();
	session.emitter.emit("entry", item);
	return item;
}

function statusFromSession(session: WsSessionRecord | undefined | null, sessionId: string): WsSessionStatus {
	if (!session) return { sessionId, exists: false, active: false, state: "missing", transcriptCount: 0 };
	return {
		sessionId: session.sessionId,
		exists: true,
		active: session.state === "open" || session.state === "opening",
		url: session.url,
		state: session.state,
		createdAt: session.createdAt,
		openedAt: session.openedAt,
		closedAt: session.closedAt,
		lastEventAt: session.lastEventAt,
		lastError: session.lastError,
		transcriptCount: session.transcript.length,
		maxTranscript: session.maxTranscript,
		protocols: session.protocols.slice(),
		headers: { ...session.headers },
		lastEvent: session.transcript.at(-1),
	};
}

function requireSession(sessionId: unknown): WsSessionRecord {
	const key = sessionKey(sessionId);
	const session = wsSessions.get(key);
	if (!session) throw wsShellError(`WebSocket session not found: ${key}`, "WEBSOCKET_SESSION_NOT_FOUND", { sessionId: key });
	return session;
}

function requireOpenSession(sessionId: unknown): WsSessionRecord {
	const session = requireSession(sessionId);
	if (session.state !== "open") throw wsShellError(`WebSocket session is not open: ${session.sessionId}`, "WEBSOCKET_SESSION_NOT_OPEN", { sessionId: session.sessionId, state: session.state, url: session.url });
	return session;
}

function matchesTranscriptEntry(entry: WsTranscriptEntry, matcher: { contains?: string; regex?: RegExp }, afterSeq: number): boolean {
	if (entry.event !== "message" || entry.direction !== "inbound") return false;
	if (entry.seq <= afterSeq) return false;
	const text = String(entry.text || "");
	if (matcher.contains && !text.includes(matcher.contains)) return false;
	if (matcher.regex && !matcher.regex.test(text)) return false;
	return true;
}

function compileMatcher(regex: unknown): RegExp | undefined {
	if (regex === undefined || regex === null || regex === "") return undefined;
	const pattern = String(regex);
	const unsafe = unsafeRegexReason(pattern);
	if (unsafe || !isSafeRegexPattern(pattern)) throw wsShellError(`Unsafe regex matcher: ${unsafe || "invalid"}`, "WEBSOCKET_INVALID_MATCHER", { regex: pattern, reason: unsafe || "invalid_regex" });
	return new RegExp(pattern);
}

function createWebSocket(url: string, headers: Record<string, string>, protocols: string[], timeoutMs: number): WebSocket {
	const options: ClientOptions = { headers, handshakeTimeout: timeoutMs };
	if (protocols.length) return new WebSocket(url, protocols, options);
	return new WebSocket(url, options);
}

export async function openWsSession(params: OpenWsSessionParams): Promise<WsSessionStatus> {
	const sessionId = sessionKey(params.sessionId);
	const url = String(params.url || "").trim();
	if (!url) throw wsShellError("WebSocket open requires an explicit url", "WEBSOCKET_INVALID_INPUT", { sessionId, field: "url" });
	const existing = wsSessions.get(sessionId);
	if (existing && (existing.state === "open" || existing.state === "opening")) throw wsShellError(`WebSocket session already open: ${sessionId}`, "WEBSOCKET_SESSION_ALREADY_OPEN", { sessionId, url: existing.url, state: existing.state });
	if (existing) {
		try { existing.ws.terminate(); } catch {}
		wsSessions.delete(sessionId);
	}
	const timeoutMs = positiveInt(params.timeoutMs, DEFAULT_OPEN_TIMEOUT_MS, 100, 120_000);
	const maxTranscript = positiveInt(params.maxTranscript, DEFAULT_MAX_TRANSCRIPT, 1, 5_000);
	const headers = { ...(params.headers || {}) };
	const protocols = Array.isArray(params.protocols) ? params.protocols.map((item) => String(item || "").trim()).filter(Boolean) : [];
	const ws = createWebSocket(url, headers, protocols, timeoutMs);
	const session: WsSessionRecord = {
		sessionId,
		url,
		state: "opening",
		createdAt: nowIso(),
		headers,
		protocols,
		maxTranscript,
		seq: 0,
		transcript: [],
		ws,
		emitter: new EventEmitter(),
	};
	wsSessions.set(sessionId, session);
	ws.on("message", (data) => {
		const normalized = normalizeRawData(data);
		rememberTranscript(session, {
			event: "message",
			direction: "inbound",
			text: normalized.text,
			preview: previewText(normalized.text),
			bytes: normalized.bytes,
			binary: normalized.binary,
			json: tryJson(normalized.text),
		});
	});
	ws.on("close", (code, reason) => {
		session.state = session.state === "error" ? "error" : "closed";
		session.closedAt = nowIso();
		rememberTranscript(session, {
			event: "close",
			code: Number(code || 0),
			reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || ""),
			wasClean: Number(code || 0) === 1000,
		});
		session.emitter.emit("state", session.state);
	});
	ws.on("error", (error) => {
		session.lastError = error instanceof Error ? error.message : String(error);
		session.state = "error";
		rememberTranscript(session, {
			event: "error",
			error: session.lastError,
			preview: previewText(session.lastError),
		});
		session.emitter.emit("state", session.state);
	});
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try { ws.terminate(); } catch {}
			wsSessions.delete(sessionId);
			reject(wsShellError(`WebSocket open timed out after ${timeoutMs}ms`, "WEBSOCKET_OPEN_TIMEOUT", { sessionId, url, timeoutMs }));
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			ws.off("open", onOpen);
			ws.off("error", onError);
		};
		const onOpen = () => {
			if (settled) return;
			settled = true;
			cleanup();
			session.state = "open";
			session.openedAt = nowIso();
			rememberTranscript(session, { event: "open" });
			resolve();
		};
		const onError = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			wsSessions.delete(sessionId);
			reject(wsShellError(`WebSocket open failed: ${error.message}`, "WEBSOCKET_OPEN_FAILED", { sessionId, url, error: error.message }));
		};
		ws.once("open", onOpen);
		ws.once("error", onError);
	});
	return statusFromSession(session, sessionId);
}

export async function sendWsSession(params: SendWsSessionParams): Promise<WsSessionStatus & { sent: { seq: number; bytes: number; preview: string } }> {
	const session = requireOpenSession(params.sessionId);
	const text = String(params.text || "");
	await new Promise<void>((resolve, reject) => {
		session.ws.send(text, (error) => {
			if (error) reject(wsShellError(`WebSocket send failed: ${error.message}`, "WEBSOCKET_SEND_FAILED", { sessionId: session.sessionId, url: session.url, error: error.message }));
			else resolve();
		});
	});
	const entry = rememberTranscript(session, {
		event: "send",
		direction: "outbound",
		text,
		preview: previewText(text),
		bytes: Buffer.byteLength(text, "utf8"),
		binary: false,
		json: tryJson(text),
	});
	return {
		...statusFromSession(session, session.sessionId),
		sent: { seq: entry.seq, bytes: Number(entry.bytes || 0), preview: String(entry.preview || "") },
	};
}

export async function waitWsSession(params: WaitWsSessionParams): Promise<WsWaitMatch & { session: WsSessionStatus }> {
	const session = requireSession(params.sessionId);
	const afterSeq = positiveInt(params.afterSeq ?? 0, 0, 0, Number.MAX_SAFE_INTEGER);
	const contains = typeof params.contains === "string" && params.contains.length ? params.contains : undefined;
	const regexText = typeof params.regex === "string" && params.regex.length ? params.regex : undefined;
	const regex = compileMatcher(regexText);
	const matcher = { contains, regex };
	const startedAt = Date.now();
	const immediate = session.transcript.find((entry) => matchesTranscriptEntry(entry, matcher, afterSeq));
	if (immediate) {
		return {
			matcher: { contains, regex: regexText, afterSeq },
			entry: immediate,
			waitedMs: 0,
			matchedImmediately: true,
			session: statusFromSession(session, session.sessionId),
		};
	}
	if (session.state !== "open") throw wsShellError(`WebSocket wait aborted because session is not open: ${session.sessionId}`, "WEBSOCKET_WAIT_ABORTED", { sessionId: session.sessionId, state: session.state, afterSeq, contains, regex: regexText });
	const timeoutMs = positiveInt(params.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, 50, 300_000);
	return await new Promise((resolve, reject) => {
		const onEntry = (entry: WsTranscriptEntry) => {
			if (!matchesTranscriptEntry(entry, matcher, afterSeq)) return;
			cleanup();
			resolve({
				matcher: { contains, regex: regexText, afterSeq },
				entry,
				waitedMs: Date.now() - startedAt,
				matchedImmediately: false,
				session: statusFromSession(session, session.sessionId),
			});
		};
		const onState = () => {
			if (session.state === "open") return;
			cleanup();
			reject(wsShellError(`WebSocket wait aborted because session changed state: ${session.state}`, "WEBSOCKET_WAIT_ABORTED", { sessionId: session.sessionId, state: session.state, afterSeq, contains, regex: regexText, waitedMs: Date.now() - startedAt }));
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(wsShellError(`WebSocket wait timed out after ${timeoutMs}ms`, "WEBSOCKET_WAIT_TIMEOUT", { sessionId: session.sessionId, timeoutMs, afterSeq, contains, regex: regexText }));
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			session.emitter.off("entry", onEntry);
			session.emitter.off("state", onState);
		};
		session.emitter.on("entry", onEntry);
		session.emitter.on("state", onState);
	});
}

export async function replayWsSequence(params: { sessionId?: string; steps: ReplayWsSequenceStep[] }): Promise<{ session: WsSessionStatus; steps: WsReplayStepResult[]; failure?: WsReplayFailure }> {
	const steps = Array.isArray(params.steps) ? params.steps : [];
	if (!steps.length) throw wsShellError("WebSocket replay requires at least one explicit step", "WEBSOCKET_INVALID_INPUT", { sessionId: sessionKey(params.sessionId), field: "steps" });
	const results: WsReplayStepResult[] = [];
	for (let index = 0; index < steps.length; index += 1) {
		const step = steps[index];
		try {
			const sent = await sendWsSession({ sessionId: params.sessionId, text: String(step.text || "") });
			const stepResult: WsReplayStepResult = {
				index,
				sent: { ...sent.sent },
			};
			if (step.contains || step.regex) {
				const matched = await waitWsSession({ sessionId: params.sessionId, afterSeq: sent.sent.seq, contains: step.contains, regex: step.regex, timeoutMs: step.timeoutMs });
				stepResult.matched = {
					matcher: matched.matcher,
					entry: matched.entry,
					waitedMs: matched.waitedMs,
					matchedImmediately: matched.matchedImmediately,
				};
			}
			results.push(stepResult);
		} catch (error) {
			const session = requireSession(params.sessionId);
			const details = error && typeof error === "object" && "details" in error ? (error as { details?: Record<string, unknown> }).details : undefined;
			return {
				session: statusWsSession(params.sessionId),
				steps: results,
				failure: {
					stepIndex: index,
					step,
					lastSeq: Number(session.transcript.at(-1)?.seq || 0),
					partialSteps: results,
					partialTranscript: session.transcript.slice(),
					error: {
						code: error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : undefined,
						message: error instanceof Error ? error.message : String(error),
						details,
					},
				},
			};
		}
	}
	return { session: statusWsSession(params.sessionId), steps: results };
}

export function collectWsSession(params: CollectWsSessionParams): { session: WsSessionStatus; afterSeq: number; count: number; total: number; events: WsTranscriptEntry[] } {
	const session = requireSession(params.sessionId);
	const afterSeq = positiveInt(params.afterSeq ?? 0, 0, 0, Number.MAX_SAFE_INTEGER);
	const limit = positiveInt(params.limit ?? 50, 50, 1, 5_000);
	const filtered = session.transcript.filter((entry) => entry.seq > afterSeq);
	return {
		session: statusFromSession(session, session.sessionId),
		afterSeq,
		count: Math.min(filtered.length, limit),
		total: session.transcript.length,
		events: filtered.slice(0, limit),
	};
}

export async function closeWsSession(params: CloseWsSessionParams): Promise<WsSessionStatus> {
	const session = requireSession(params.sessionId);
	if (session.state === "closed" || session.state === "error") return statusFromSession(session, session.sessionId);
	const timeoutMs = positiveInt(params.timeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, 50, 30_000);
	const code = params.code === undefined ? 1000 : positiveInt(params.code, 1000, 1000, 4999);
	const reason = String(params.reason || "");
	await new Promise<void>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try { session.ws.terminate(); } catch {}
			resolve();
		}, timeoutMs);
		const onClose = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		session.ws.once("close", onClose);
		try { session.ws.close(code, reason); }
		catch { clearTimeout(timer); resolve(); }
	});
	return statusFromSession(session, session.sessionId);
}

export function statusWsSession(sessionId?: string): WsSessionStatus {
	const normalized = sessionKey(sessionId);
	return statusFromSession(wsSessions.get(normalized), normalized);
}

export async function cleanupWsSessionsForTests(): Promise<void> {
	const sessions = Array.from(wsSessions.values());
	for (const session of sessions) {
		try {
			if (session.state === "open" || session.state === "opening") {
				try { session.ws.terminate(); } catch {}
			}
		} finally {
			wsSessions.delete(session.sessionId);
		}
	}
}
