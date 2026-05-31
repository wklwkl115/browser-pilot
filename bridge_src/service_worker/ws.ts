import { PI_BROWSER_ERROR_CODES, findLostRuntimeSession, forgetRuntimeSession, piBrowserError, rememberRuntimeSession, summarizeLostRuntimeSession } from "./runtime";
import { persist as persistState, forget as forgetState, recover as recoverState, registerRecovery, redactConfig } from "./state_store";
import { collectWsSessionTranscript, createWsSession, getWsSession, normalizeWsOpenConfig, piBrowserWsSessions, rememberWsTranscript, wsSessionId, wsSessionSummary, numberInRange, cleanupWsSessionsForTab as cleanupWsSessionsForTabState } from "./ws_model";
import type { JsonRecord, PiBridgeCommand, PiBridgeResponse } from "./types";

const rememberWsRuntimeSession = typeof rememberRuntimeSession === "function" ? rememberRuntimeSession : async () => {};
const forgetWsRuntimeSession = typeof forgetRuntimeSession === "function" ? forgetRuntimeSession : async () => {};
const findLostWsRuntimeSession = typeof findLostRuntimeSession === "function" ? findLostRuntimeSession : async () => undefined;
const summarizeLostWsRuntimeSession = typeof summarizeLostRuntimeSession === "function" ? summarizeLostRuntimeSession : () => undefined;

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function previewText(text: string, limit = 160): string {
	const compact = String(text || "").replace(/\s+/g, " ").trim();
	return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

function unsafeMatcherReason(pattern: unknown): string | undefined {
	const text = String(pattern || "");
	if (!text) return "empty_pattern";
	if (text.length > 512) return "pattern_too_long";
	if (/\\(?:[1-9]|k[<'])/.test(text)) return "backreference";
	if (/\(\?[^:]/.test(text)) return "lookaround_or_special_group";
	if (/\([^)]*(?:[*+]|\{\d)[^)]*\)\s*(?:[*+?]|\{\d)/.test(text)) return "nested_quantifier";
	if (/\([^)]*\|[^)]*\)\s*(?:[*+?]|\{\d)/.test(text)) return "quantified_alternation";
	if ((text.match(/\.\*/g) || []).length > 6) return "too_many_wildcards";
	return undefined;
}

function normalizePayload(data: unknown): { text: string; bytes: number; binary: boolean; json?: unknown } {
	const encoder = new TextEncoder();
	let text: string;
	let binary = false;
	let bytes: number;
	if (typeof data === "string") {
		text = data;
		bytes = encoder.encode(text).length;
	} else if (data instanceof ArrayBuffer) {
		binary = true;
		bytes = data.byteLength;
		text = new TextDecoder().decode(new Uint8Array(data));
	} else if (typeof Blob !== "undefined" && data instanceof Blob) {
		binary = true;
		bytes = data.size;
		text = `[blob:${data.type || "application/octet-stream"}:${data.size}]`;
	} else if (ArrayBuffer.isView(data)) {
		binary = true;
		bytes = data.byteLength;
		text = new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	} else {
		text = String(data ?? "");
		bytes = encoder.encode(text).length;
	}
	try {
		return { text, bytes, binary, json: JSON.parse(text) };
	} catch {
		return { text, bytes, binary };
	}
}

function requireSession(tabId: number, msg: PiBridgeCommand) {
	return getWsSession(tabId, wsSessionId(msg));
}

function requireOpenSession(tabId: number, msg: PiBridgeCommand) {
	const session = requireSession(tabId, msg);
	if (!session) return { error: piBrowserError("WEBSOCKET_SESSION_NOT_FOUND", "ws session not found", { cmd: msg.cmd, tabId, sessionId: wsSessionId(msg) }) };
	if (session.state !== "open") return { error: piBrowserError("WEBSOCKET_SESSION_NOT_OPEN", "ws session is not open", { cmd: msg.cmd, tabId, sessionId: session.sessionId, state: session.state, url: session.url }) };
	return { session };
}

function cleanupWsSocketListeners(session: ReturnType<typeof requireSession>): void {
	if (!session) return;
	const ws = session.ws as WebSocket | undefined;
	if (!ws) return;
	const listeners = asRecord(session.listeners);
	const messageListener = listeners.messageListener as EventListener | undefined;
	const closeListener = listeners.closeListener as EventListener | undefined;
	const errorListener = listeners.errorListener as EventListener | undefined;
	if (messageListener) {
		try {
			ws.removeEventListener("message", messageListener);
		} catch {
			/* best-effort websocket message listener cleanup */
		}
	}
	if (closeListener) {
		try {
			ws.removeEventListener("close", closeListener);
		} catch {
			/* best-effort websocket close listener cleanup */
		}
	}
	if (errorListener) {
		try {
			ws.removeEventListener("error", errorListener);
		} catch {
			/* best-effort websocket error listener cleanup */
		}
	}
	session.listeners = {};
}

async function openWs(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
	const config = normalizeWsOpenConfig(msg);
	if (!config.url) return piBrowserError("WEBSOCKET_INVALID_INPUT", "ws.open requires explicit url", { cmd: msg.cmd, tabId, sessionId: config.sessionId, field: "url" });
	const existing = getWsSession(tabId, config.sessionId);
	if (existing && (existing.state === "opening" || existing.state === "open")) return piBrowserError("WEBSOCKET_SESSION_ALREADY_OPEN", "ws session already open", { cmd: msg.cmd, tabId, sessionId: config.sessionId, url: existing.url, state: existing.state });
	if (existing) {
		try {
			(existing.ws as WebSocket | undefined)?.close();
		} catch {
			/* best-effort prior websocket session close */
		}
		piBrowserWsSessions.delete(String(existing.key || ""));
	}
	const session = createWsSession(tabId, config);
	const ws = config.protocols.length ? new WebSocket(config.url, config.protocols) : new WebSocket(config.url);
	session.ws = ws;
	piBrowserWsSessions.set(String(session.key), session);
	const messageListener = (event: MessageEvent) => {
		const payload = normalizePayload(event.data);
		rememberWsTranscript(session, { event: "message", direction: "inbound", text: payload.text, preview: previewText(payload.text), bytes: payload.bytes, binary: payload.binary, json: payload.json });
	};
	const closeListener = (event: CloseEvent) => {
		session.state = session.state === "error" ? "error" : "closed";
		session.closedAt = Date.now();
		rememberWsTranscript(session, { event: "close", code: Number(event.code || 0), reason: String(event.reason || ""), wasClean: !!event.wasClean });
		cleanupWsSocketListeners(session);
		void forgetWsRuntimeSession("ws", tabId, session.sessionId);
		void forgetState('ws', `${Number(tabId)}:${session.sessionId}`);
	};
	const errorListener = () => {
		session.lastError = session.lastError || "websocket error";
		session.state = "error";
		rememberWsTranscript(session, { event: "error", error: session.lastError, preview: previewText(session.lastError) });
		cleanupWsSocketListeners(session);
		void forgetWsRuntimeSession("ws", tabId, session.sessionId);
		void forgetState('ws', `${Number(tabId)}:${session.sessionId}`);
	};
	ws.addEventListener("message", messageListener);
	ws.addEventListener("close", closeListener);
	ws.addEventListener("error", errorListener);
	session.listeners = { messageListener, closeListener, errorListener };
	return await new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanupWsSocketListeners(session);
			try {
				ws.close();
			} catch {
				/* best-effort websocket close after open timeout */
			}
			piBrowserWsSessions.delete(String(session.key));
			void forgetWsRuntimeSession("ws", tabId, config.sessionId);
			resolve(piBrowserError("WEBSOCKET_OPEN_TIMEOUT", `ws open timed out after ${config.timeoutMs}ms`, { cmd: msg.cmd, tabId, sessionId: config.sessionId, url: config.url, timeoutMs: config.timeoutMs }));
		}, config.timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			ws.removeEventListener("open", onOpen);
			ws.removeEventListener("error", onOpenError);
		};
		const onOpen = () => {
			if (settled) return;
			settled = true;
			cleanup();
			session.state = "open";
			session.openedAt = Date.now();
			rememberWsTranscript(session, { event: "open" });
			void rememberWsRuntimeSession("ws", tabId, session.sessionId, { url: session.url, protocols: session.protocols, maxTranscript: session.maxTranscript });
			// Persist WS config for state recovery (no transcript, no auto-reconnect)
			void persistState('ws', `${Number(tabId)}:${session.sessionId}`, redactConfig({ url: session.url, protocols: session.protocols, maxTranscript: session.maxTranscript }), { tabId, sessionId: session.sessionId, recoveryPolicy: 'diagnosticOnly' }).catch((error) => {
				console.warn('[PI-BROWSER-WS] Failed to persist websocket session state', session.sessionId, error);
			});
			resolve({ ok: true, data: { session: wsSessionSummary(session) } });
		};
		const onOpenError = () => {
			if (settled) return;
			settled = true;
			cleanup();
			cleanupWsSocketListeners(session);
			piBrowserWsSessions.delete(String(session.key));
			void forgetWsRuntimeSession("ws", tabId, config.sessionId);
			resolve(piBrowserError("WEBSOCKET_OPEN_FAILED", "ws open failed", { cmd: msg.cmd, tabId, sessionId: config.sessionId, url: config.url }));
		};
		ws.addEventListener("open", onOpen, { once: true });
		ws.addEventListener("error", onOpenError, { once: true });
	});
}

async function sendWs(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
	const found = requireOpenSession(tabId, msg);
	if (found.error) return found.error;
	const session = found.session;
	const text = String(msg.text ?? msg.message ?? "");
	try {
		(session.ws as WebSocket).send(text);
	} catch (error) {
		return piBrowserError("WEBSOCKET_SEND_FAILED", `ws send failed: ${errorText(error)}`, { cmd: msg.cmd, tabId, sessionId: session.sessionId, url: session.url, error: errorText(error) });
	}
	const entry = rememberWsTranscript(session, { event: "send", direction: "outbound", text, preview: previewText(text), bytes: new TextEncoder().encode(text).length, binary: false });
	return { ok: true, data: { ...wsSessionSummary(session), sent: { seq: entry?.seq, bytes: entry?.bytes, preview: entry?.preview } } };
}

function waitWs(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
	const session = requireSession(tabId, msg);
	if (!session) return Promise.resolve(piBrowserError("WEBSOCKET_SESSION_NOT_FOUND", "ws session not found", { cmd: msg.cmd, tabId, sessionId: wsSessionId(msg) }));
	const afterSeq = numberInRange(msg.afterSeq ?? msg.after_seq, 0, 0, Number.MAX_SAFE_INTEGER);
	const contains = typeof msg.contains === "string" && msg.contains.length ? msg.contains : undefined;
	const regexText = typeof msg.regex === "string" && msg.regex.length ? msg.regex : undefined;
	const unsafe = regexText ? unsafeMatcherReason(regexText) : undefined;
	if (unsafe) return Promise.resolve(piBrowserError("WEBSOCKET_INVALID_MATCHER", "unsafe ws regex matcher", { cmd: msg.cmd, tabId, sessionId: session.sessionId, regex: regexText, reason: unsafe }));
	const regex = regexText ? new RegExp(regexText) : undefined;
	const timeoutMs = numberInRange(msg.timeoutMs ?? msg.timeout_ms, 10000, 50, 300000);
	const immediate = session.transcript.find((entry) => entry.event === "message" && entry.direction === "inbound" && Number(entry.seq) > afterSeq && (!contains || String(entry.text || "").includes(contains)) && (!regex || regex.test(String(entry.text || ""))));
	if (immediate) return Promise.resolve({ ok: true, data: { session: wsSessionSummary(session), matcher: { contains, regex: regexText, afterSeq }, entry: immediate, waitedMs: 0, matchedImmediately: true } });
	if (session.state !== "open") return Promise.resolve(piBrowserError("WEBSOCKET_WAIT_ABORTED", "ws wait aborted because session is not open", { cmd: msg.cmd, tabId, sessionId: session.sessionId, state: session.state, afterSeq, contains, regex: regexText }));
	return new Promise((resolve) => {
		const ws = session.ws as WebSocket;
		let settled = false;
		const startedAt = Date.now();
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(piBrowserError("WEBSOCKET_WAIT_TIMEOUT", `ws wait timed out after ${timeoutMs}ms`, { cmd: msg.cmd, tabId, sessionId: session.sessionId, timeoutMs, afterSeq, contains, regex: regexText }));
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			ws.removeEventListener("message", onMessage);
			ws.removeEventListener("close", onClose);
			ws.removeEventListener("error", onError);
		};
		const onMessage = (event: MessageEvent) => {
			const payload = normalizePayload(event.data);
			const entry = session.transcript.at(-1);
			const matched = entry && entry.event === "message" && entry.direction === "inbound" && Number(entry.seq) > afterSeq && (!contains || payload.text.includes(contains)) && (!regex || regex.test(payload.text));
			if (!matched || settled) return;
			settled = true;
			cleanup();
			resolve({ ok: true, data: { session: wsSessionSummary(session), matcher: { contains, regex: regexText, afterSeq }, entry, waitedMs: Date.now() - startedAt, matchedImmediately: false } });
		};
		const onClose = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(piBrowserError("WEBSOCKET_WAIT_ABORTED", "ws wait aborted because session closed", { cmd: msg.cmd, tabId, sessionId: session.sessionId, state: session.state, afterSeq, contains, regex: regexText }));
		};
		const onError = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(piBrowserError("WEBSOCKET_WAIT_ABORTED", "ws wait aborted because session errored", { cmd: msg.cmd, tabId, sessionId: session.sessionId, state: session.state, lastError: session.lastError, afterSeq, contains, regex: regexText }));
		};
		ws.addEventListener("message", onMessage);
		ws.addEventListener("close", onClose, { once: true });
		ws.addEventListener("error", onError, { once: true });
	});
}

async function replayWs(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
	const session = requireSession(tabId, msg);
	if (!session) return piBrowserError("WEBSOCKET_SESSION_NOT_FOUND", "ws session not found", { cmd: msg.cmd, tabId, sessionId: wsSessionId(msg) });
	const rawSteps = Array.isArray(msg.steps) ? msg.steps : [];
	if (!rawSteps.length) return piBrowserError("WEBSOCKET_INVALID_INPUT", "ws.replay requires explicit steps", { cmd: msg.cmd, tabId, sessionId: session.sessionId, field: "steps" });
	const steps: JsonRecord[] = rawSteps.map((item) => asRecord(item));
	const results: JsonRecord[] = [];
	for (let index = 0; index < steps.length; index += 1) {
		const step = steps[index];
		const sendResult = await sendWs(tabId, { ...msg, cmd: "ws.send", text: String(step.text ?? step.message ?? "") });
		if (!sendResult.ok) {
			return {
				ok: false,
				error_code: String(sendResult.error_code || "WEBSOCKET_SEND_FAILED"),
				error: sendResult.error,
				details: {
					...asRecord(sendResult.details),
					stepIndex: index,
					lastSeq: Number(session.transcript.at(-1)?.seq || 0),
					partialSteps: results,
					partialTranscript: session.transcript.slice(),
				},
			};
		}
		const sent = asRecord(sendResult.data).sent;
		const stepResult: JsonRecord = { index, sent };
		if (typeof step.contains === "string" || typeof step.regex === "string") {
			const timeoutMs = typeof step.timeoutMs === "number" ? step.timeoutMs : typeof step.timeout_ms === "number" ? step.timeout_ms : undefined;
			const waitResult = await waitWs(tabId, { ...msg, cmd: "ws.wait", afterSeq: asRecord(sent).seq, contains: step.contains, regex: step.regex, timeoutMs });
			if (!waitResult.ok) {
				return {
					ok: false,
					error_code: String(waitResult.error_code || "WEBSOCKET_WAIT_TIMEOUT"),
					error: waitResult.error,
					details: {
						...asRecord(waitResult.details),
						stepIndex: index,
						lastSeq: Number(session.transcript.at(-1)?.seq || 0),
						partialSteps: results,
						partialTranscript: session.transcript.slice(),
					},
				};
			}
			stepResult.matched = { matcher: asRecord(waitResult.data).matcher, entry: asRecord(waitResult.data).entry, waitedMs: asRecord(waitResult.data).waitedMs, matchedImmediately: asRecord(waitResult.data).matchedImmediately };
		}
		results.push(stepResult);
	}
	return { ok: true, data: { session: wsSessionSummary(session), steps: results } };
}

function collectWs(tabId: number, msg: PiBridgeCommand): PiBridgeResponse {
	const session = requireSession(tabId, msg);
	if (!session) return piBrowserError("WEBSOCKET_SESSION_NOT_FOUND", "ws session not found", { cmd: msg.cmd, tabId, sessionId: wsSessionId(msg) });
	const afterSeq = numberInRange(msg.afterSeq ?? msg.after_seq, 0, 0, Number.MAX_SAFE_INTEGER);
	const limit = numberInRange(msg.limit, 50, 1, 5000);
	return { ok: true, data: collectWsSessionTranscript(session, afterSeq, limit) };
}

async function closeWs(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
	const session = requireSession(tabId, msg);
	if (!session) return piBrowserError("WEBSOCKET_SESSION_NOT_FOUND", "ws session not found", { cmd: msg.cmd, tabId, sessionId: wsSessionId(msg) });
	if (session.state === "closed" || session.state === "error") return { ok: true, data: { session: wsSessionSummary(session) } };
	const timeoutMs = numberInRange(msg.timeoutMs ?? msg.timeout_ms, 2000, 50, 30000);
	const code = msg.code === undefined ? 1000 : numberInRange(msg.code, 1000, 1000, 4999);
	const reason = String(msg.reason || "");
	return await new Promise((resolve) => {
		const ws = session.ws as WebSocket;
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			session.state = "closed";
			session.closedAt = Date.now();
			cleanupWsSocketListeners(session);
			try {
				ws.close();
			} catch {
				/* best-effort websocket close during timeout-driven shutdown */
			}
			resolve({ ok: true, data: { session: wsSessionSummary(session) } });
		}, timeoutMs);
		const onClose = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void forgetWsRuntimeSession("ws", tabId, session.sessionId);
			resolve({ ok: true, data: { session: wsSessionSummary(session) } });
		};
		ws.addEventListener("close", onClose, { once: true });
		try { ws.close(code, reason); }
		catch { clearTimeout(timer); cleanupWsSocketListeners(session); void forgetWsRuntimeSession("ws", tabId, session.sessionId); resolve({ ok: true, data: { session: wsSessionSummary(session) } }); }
	});
}

async function handlePiBrowserWsCommand(cmd: string, tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
	if (cmd === "ws.open") return await openWs(tabId, msg);
	if (cmd === "ws.status") {
		const sessionId = wsSessionId(msg);
		const session = getWsSession(tabId, sessionId);
		const lost = summarizeLostWsRuntimeSession(await findLostWsRuntimeSession("ws", tabId, sessionId));
		return { ok: true, data: { session: wsSessionSummary(session, sessionId), stateLost: !!lost, lostSession: lost } };
	}
	if (cmd === "ws.send") return await sendWs(tabId, msg);
	if (cmd === "ws.replay") return await replayWs(tabId, msg);
	if (cmd === "ws.wait") return await waitWs(tabId, msg);
	if (cmd === "ws.collect") return collectWs(tabId, msg);
	if (cmd === "ws.close") return await closeWs(tabId, msg);
	return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, `Unknown ws command: ${cmd}`, { cmd, tabId });
}

function cleanupWsSessionsForTab(tabId: number, reason = "tab_cleanup") {
	const cleanupState = typeof cleanupWsSessionsForTabState === "function"
		? cleanupWsSessionsForTabState
		: (_tabId: number, cleanupReason = "tab_cleanup") => {
			let removed = 0;
			const sessionIds: string[] = [];
			for (const [key, session] of Array.from(piBrowserWsSessions.entries())) {
				if (Number(session.tabId) !== Number(_tabId)) continue;
				removed += 1;
				sessionIds.push(String(session.sessionId || "default"));
				try {
					(session.ws as { terminate?: () => void; close?: () => void } | undefined)?.terminate?.();
				} catch {
					/* best-effort websocket termination during tab cleanup */
				}
				piBrowserWsSessions.delete(key);
			}
			return { tabId: _tabId, removed, reason: cleanupReason, sessionIds };
		};
	const result = cleanupState(tabId, reason);
	for (const sessionId of Array.isArray(result.sessionIds) ? result.sessionIds : []) void forgetWsRuntimeSession("ws", tabId, String(sessionId || "default"));
	return result;
}

// --- Startup recovery registration ---
// WS recovery is diagnostic-only: report lost sessions with config summary.
// Do not auto-reconnect WebSocket sessions after restart.
registerRecovery(async (results) => {
	const result = await recoverState('ws', {
		validateTab: true,
		recover: async (_record) => {
			// WS sessions cannot be recovered - just report as lost with config
			return { recovered: false, historyLost: true, reason: 'WebSocket sessions are not auto-recovered after restart' };
		},
	});
	results.push(result);
});

export { handlePiBrowserWsCommand, cleanupWsSessionsForTab };
// ESM module metadata
export const __piBridgeModule_ws = { name: "ws", symbols: { handlePiBrowserWsCommand, cleanupWsSessionsForTab } };
