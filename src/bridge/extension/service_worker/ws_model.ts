import { integerInRange as numberInRange, redactSensitive } from "./runtimeSupport.js";
import type { JsonRecord, BrowserPilotBridgeCommand } from "./types";

export type WsSessionState = "opening" | "open" | "closed" | "error";
export type WsTranscriptEvent = "open" | "send" | "message" | "close" | "error";

export type WsTranscriptEntry = JsonRecord & {
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

export type WsSessionRecord = JsonRecord & {
	sessionId: string;
	url: string;
	state: WsSessionState;
	createdAt: number;
	openedAt?: number;
	closedAt?: number;
	lastEventAt?: number;
	lastError?: string;
	protocols: string[];
	maxTranscript: number;
	seq: number;
	transcript: WsTranscriptEntry[];
	ws?: unknown;
	listeners?: JsonRecord;
};

export const browserPilotWsSessions = new Map<string, WsSessionRecord>();
export const BROWSER_PILOT_WS_DEFAULT_SESSION_ID = "default";
const BROWSER_PILOT_WS_DEFAULT_MAX_TRANSCRIPT = 200;

function wsSessionId(msg: BrowserPilotBridgeCommand | JsonRecord | null | undefined): string {
	return String(msg?.sessionId || msg?.session_id || BROWSER_PILOT_WS_DEFAULT_SESSION_ID);
}

function wsSessionKey(tabId: unknown, sessionId: unknown): string {
	return `${Number(tabId)}:${String(sessionId || BROWSER_PILOT_WS_DEFAULT_SESSION_ID)}`;
}

function createWsSession(tabId: unknown, config: { sessionId: string; url: string; protocols: string[]; maxTranscript: number }): WsSessionRecord {
	return {
		tabId: Number(tabId),
		sessionId: config.sessionId,
		key: wsSessionKey(tabId, config.sessionId),
		url: config.url,
		state: "opening",
		createdAt: Date.now(),
		protocols: config.protocols,
		maxTranscript: config.maxTranscript,
		seq: 0,
		transcript: [],
		listeners: {},
	};
}

function rememberWsTranscript(session: WsSessionRecord | null | undefined, entry: JsonRecord): WsTranscriptEntry | null {
	if (!session) return null;
	session.seq += 1;
	const item = redactSensitive({ seq: session.seq, t: Date.now(), ...entry }) as WsTranscriptEntry;
	session.transcript.push(item);
	if (session.transcript.length > session.maxTranscript) session.transcript.splice(0, session.transcript.length - session.maxTranscript);
	session.lastEventAt = Date.now();
	return item;
}

function wsSessionSummary(session: WsSessionRecord | null | undefined, fallbackSessionId?: string): JsonRecord {
	if (!session) return { sessionId: String(fallbackSessionId || BROWSER_PILOT_WS_DEFAULT_SESSION_ID), exists: false, active: false, state: "missing", transcriptCount: 0 };
	return {
		tabId: session.tabId,
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
		lastEvent: session.transcript.at(-1),
	};
}

function normalizeWsProtocols(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
	return raw.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeWsOpenConfig(msg: BrowserPilotBridgeCommand | JsonRecord = {}): { sessionId: string; url: string; protocols: string[]; maxTranscript: number; timeoutMs: number } {
	const url = String(msg.url || "").trim();
	return {
		sessionId: wsSessionId(msg),
		url,
		protocols: normalizeWsProtocols(msg.protocols),
		maxTranscript: numberInRange(msg.maxTranscript ?? msg.max_transcript, BROWSER_PILOT_WS_DEFAULT_MAX_TRANSCRIPT, 1, 5000),
		timeoutMs: numberInRange(msg.timeoutMs ?? msg.timeout_ms, 5000, 100, 120000),
	};
}

function getWsSession(tabId: unknown, sessionId: unknown): WsSessionRecord | null {
	return browserPilotWsSessions.get(wsSessionKey(tabId, sessionId)) || null;
}

function collectWsSessionTranscript(session: WsSessionRecord, afterSeq: number, limit: number): JsonRecord {
	const events = session.transcript.filter((item) => Number(item.seq) > afterSeq).slice(0, limit);
	return {
		...wsSessionSummary(session),
		afterSeq,
		count: events.length,
		total: session.transcript.length,
		events,
	};
}

function cleanupWsSessionsForTab(tabId: number, reason = "tab_cleanup"): JsonRecord {
	let removed = 0;
	const sessionIds: string[] = [];
	for (const [key, session] of Array.from(browserPilotWsSessions.entries())) {
		if (Number(session.tabId) !== Number(tabId)) continue;
		removed += 1;
		sessionIds.push(String(session.sessionId || "default"));
		try {
			const ws = session.ws as { terminate?: () => void; close?: () => void } | undefined;
			ws?.terminate?.();
		} catch {
			/* best-effort websocket termination during session cleanup */
		}
		browserPilotWsSessions.delete(key);
	}
	return { tabId, removed, reason, sessionIds };
}

export { wsSessionId, wsSessionKey, numberInRange, createWsSession, rememberWsTranscript, wsSessionSummary, normalizeWsProtocols, normalizeWsOpenConfig, getWsSession, collectWsSessionTranscript, cleanupWsSessionsForTab };
