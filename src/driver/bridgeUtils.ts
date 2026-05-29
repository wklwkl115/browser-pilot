import { WebSocket } from "ws";
import { recordValue, toTabId } from "../utils/records";
import { DEFAULT_BROWSER_BRIDGE_PORT } from "./browserBridgeConfig";
import type { BrowserTabInfo, BrowserTabSession } from "./types";

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

export function isAllowedBridgeOrigin(origin: string | undefined): boolean {
	if (origin === undefined || origin === "null") return true;
	return origin.startsWith("chrome-extension://");
}

export function bridgeResultFailure(data: unknown): { message: string; details: Record<string, unknown> } | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	if (record.ok !== false) return undefined;
	const message = typeof record.error === "string" && record.error ? record.error
		: typeof record.message === "string" && record.message ? record.message
			: "Browser bridge command failed";
	const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
		? record.details as Record<string, unknown>
		: {};
	return { message, details };
}

export function browserTabInfo(session: BrowserTabSession): BrowserTabInfo {
	const { client: _client, ...info } = session;
	return info;
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
		url: session.url,
		active: session.active,
	};
}
