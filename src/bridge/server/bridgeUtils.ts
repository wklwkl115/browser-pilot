import { WebSocket } from "ws";
import { recordValue, toTabId } from "../../utils/records.js";
import { DEFAULT_BROWSER_BRIDGE_PORT } from "./browserBridgeConfig.js";
import { BROWSER_PILOT_EXTENSION_ID } from "./browserBridgeConfig.js";
import type { BrowserTabInfo, BrowserTabSession } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const CLOSED_STATES = new Set([WebSocket.CLOSED, WebSocket.CLOSING]);

export function normalizePort(value: string | number | undefined, fallback = DEFAULT_BROWSER_BRIDGE_PORT): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return fallback;
	return parsed;
}

export function isOpen(ws: WebSocket | undefined): ws is WebSocket {
	return !!ws && ws.readyState === WebSocket.OPEN;
}

export { toTabId, recordValue };

export function normalizeErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object") {
		const item = error as { message?: unknown; error?: unknown; name?: unknown };
		if (typeof item.message === "string") return item.message;
		if (typeof item.error === "string") return item.error;
		if (typeof item.name === "string") return item.name;
	}
	return String(error);
}

export function isAllowedBridgeOrigin(origin: string | undefined, extensionId = BROWSER_PILOT_EXTENSION_ID): boolean {
	return origin === `chrome-extension://${extensionId}`;
}

export type BridgeReadiness = "bridge-down" | "bridge-up" | "connecting" | "degraded" | "extension-stale" | "ready";

/**
 * Derive a coarse, honest connection-readiness state from bridge snapshot fields,
 * so callers get a graded signal instead of a binary
 * connected/not-connected. Pure + deterministic — pass `now` in tests.
 *
 * - bridge-down: the bridge server is not listening yet.
 * - ready:       an extension is connected and has completed the ext_ready handshake.
 * - extension-stale: the connected extension does not match the unpacked build.
 * - connecting:  a client socket is open but ext_ready has not arrived yet.
 * - degraded:    no client, but one disconnected within the reconnect window — an
 *                idle/restarting MV3 worker is expected to re-dial shortly.
 * - bridge-up:   listening, but no extension has connected (idle / never loaded).
 */
export function deriveBridgeReadiness(input: {
	running: boolean;
	extensionConnected: boolean;
	extensionStale?: boolean;
	connectedClients?: number;
	lastDisconnectAt?: number;
	now?: number;
	reconnectWindowMs?: number;
}): BridgeReadiness {
	if (!input.running) return "bridge-down";
	if (input.extensionConnected && input.extensionStale) return "extension-stale";
	if (input.extensionConnected) return "ready";
	if ((input.connectedClients ?? 0) > 0) return "connecting";
	const now = input.now ?? Date.now();
	const windowMs = input.reconnectWindowMs ?? 30_000;
	if (typeof input.lastDisconnectAt === "number" && now - input.lastDisconnectAt <= windowMs) return "degraded";
	return "bridge-up";
}

export function bridgeResultFailure(data: unknown): { message: string; details: Record<string, unknown> } | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	if (record.ok !== false) return undefined;
	const message = typeof record.error === "string" && record.error ? record.error
		: typeof record.message === "string" && record.message ? record.message
			: "Browser bridge command failed";
	const details = recordValue(record.details) || {};
	return { message, details };
}

export function browserTabInfo(session: BrowserTabSession): BrowserTabInfo {
	const { client: _client, ...info } = session;
	return { ...info, targetGeneration: info.generation, targetRef: info.tabHandle };
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	const currentSignal = signal;
	if (currentSignal?.aborted) return Promise.reject(currentSignal.reason ?? new Error("Aborted"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			currentSignal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			currentSignal?.removeEventListener("abort", onAbort);
			reject(currentSignal?.reason ?? new Error("Aborted"));
		};
		currentSignal?.addEventListener("abort", onAbort, { once: true });
	});
}


export function tabSessionSummary(session: BrowserTabSession): Record<string, unknown> {
	return {
		sessionId: session.id,
		browserId: session.browserId,
		extensionId: session.bridge?.extensionId,
		name: session.bridge?.name,
		tabId: session.tabId,
		tabHandle: session.tabHandle,
		url: session.url,
		active: session.active,
		openerTabId: session.openerTabId,
		incognito: session.incognito,
	};
}
