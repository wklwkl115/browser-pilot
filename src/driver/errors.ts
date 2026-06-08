import { type NativeErrorCode, normalizeNativeErrorCode } from "../protocol/nativeErrorCodes.js";
import { compactError } from "../utils/errors.js";
import { redactSensitiveText } from "../utils/redaction.js";

export class BrowserBridgeError extends Error {
	readonly code: NativeErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: NativeErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "BrowserBridgeError";
		this.code = normalizeNativeErrorCode(code);
		this.details = details;
	}

	toJSON() {
		return compactError(this);
	}
}

export function errorToPlain(error: unknown): Record<string, unknown> {
	return compactError(error);
}

/**
 * Build the canonical TAB_NOT_FOUND error with an actionable recovery hint.
 *
 * A bridge tabId is not stable: it changes when a tab navigates, reloads, or is
 * replaced, so agents that cache a numeric id eventually hit a stale one. Beyond
 * the live `tabs` diagnostics, surface the current/latest tab id and tell the
 * caller it can simply omit tabId to use the active tab.
 */
function compactTabForError(tab: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ["id", "browserId", "tabId", "title", "active", "windowId", "incognito", "type", "connectedAt"] as const) {
		if (tab[key] !== undefined) out[key] = tab[key];
	}
	if (typeof tab.url === "string") out.url = compactUrlForError(tab.url);
	return out;
}

function compactUrlForError(value: string): string {
	const base = value.split(/[?#]/, 1)[0] || value;
	try {
		const url = new URL(value);
		const suffix = url.search || url.hash ? "?[redacted]" : "";
		if (url.protocol === "http:" || url.protocol === "https:") return redactSensitiveText(`${url.origin}${url.pathname}${suffix}`);
		if (["data:", "javascript:", "vbscript:", "mailto:"].includes(url.protocol)) return `${url.protocol}[redacted]`;
		return redactSensitiveText(`${base}${suffix}`);
	} catch {
		return redactSensitiveText(base);
	}
}

export function tabNotFoundError(args: {
	tabId: number;
	browserSessionId?: string;
	selectedBrowser?: unknown;
	tabs: Array<{ tabId?: number } & Record<string, unknown>>;
	latestTabId?: number;
}): BrowserBridgeError {
	const liveTabIds = args.tabs.map((tab) => tab.tabId).filter((id): id is number => typeof id === "number");
	const hint = liveTabIds.length
		? `tabId ${args.tabId} is no longer connected — a tab's id changes when it navigates, reloads, or is replaced. Omit tabId to target the active tab${args.latestTabId ? `, or use the current tab id ${args.latestTabId}` : ""}. Live tab ids: ${liveTabIds.join(", ")}.`
		: "No browser tabs are currently connected. Open or attach one with browser_tabs first.";
	return new BrowserBridgeError("TAB_NOT_FOUND", "Target browser tab is not connected", {
		tabId: args.tabId,
		browserSessionId: args.browserSessionId,
		selectedBrowser: args.selectedBrowser,
		tabs: args.tabs.map((tab) => compactTabForError(tab)),
		recovery: {
			retryable: true,
			hint,
			...(args.latestTabId ? { suggestedTabId: args.latestTabId } : {}),
			liveTabIds,
		},
	});
}

/**
 * Build the canonical NO_BROWSER_EXTENSION error with an actionable recovery hint.
 *
 * The bridge is a WebSocket *server*; the browser extension is the client that
 * dials in. The bridge cannot connect to the browser for the caller — so a missing
 * extension is recovered by getting the extension to (re)connect, not by retrying
 * blindly. Distinguish a cold start (never connected) from a dropped MV3 service
 * worker (was connected, went idle), and always name the concrete next steps and
 * the status command, mirroring tabNotFoundError.
 */
export function noBrowserExtensionError(args: {
	port?: number;
	everConnected?: boolean;
	browserSessionId?: string;
	sessions?: unknown;
} = {}): BrowserBridgeError {
	// Keep the port out of the prose hint — it lives in details.port. Embedding a
	// volatile value in the message would break envelope parity across servers.
	const hint = args.everConnected
		? `The browser extension was connected but is not reachable now — its MV3 service worker likely went idle. Open or reload any browser tab to wake it; it reconnects automatically, then retry.`
		: `No Pi browser extension is connected to the bridge. The bridge is a server the extension connects into — it cannot dial the browser for you. Ensure the "Pi Native Browser Bridge" extension is loaded and enabled, then open or reload any tab so its service worker connects.`;
	return new BrowserBridgeError("NO_BROWSER_EXTENSION", "No connected browser bridge extension", {
		...(typeof args.port === "number" ? { port: args.port } : {}),
		...(args.browserSessionId ? { browserSessionId: args.browserSessionId } : {}),
		...(args.sessions ? { sessions: args.sessions } : {}),
		everConnected: args.everConnected === true,
		recovery: {
			retryable: true,
			hint,
			nextActions: [
				"verify the Pi Native Browser Bridge extension is installed and enabled in the browser",
				"open or reload any browser tab so the extension service worker wakes and connects to the bridge",
				"check connection state with `pi-browser daemon status` (or the /browser-status command)",
			],
		},
	});
}
