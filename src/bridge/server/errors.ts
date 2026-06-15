import { type NativeErrorCode, normalizeNativeErrorCode } from "../protocol/nativeErrorCodes.js";
import { compactError } from "../../utils/errors.js";
import { redactSensitiveText } from "../../utils/redaction.js";

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
 * A numeric bridge tabId can still churn when Chrome replaces a physical tab.
 * Stable tabHandle/targetRef values survive in-place replacement while numeric
 * ids auto-follow only when the replacement chain is unambiguous.
 */
function compactTabForError(tab: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ["id", "browserId", "tabId", "tabHandle", "targetRef", "title", "active", "windowId", "openerTabId", "incognito", "type", "connectedAt"] as const) {
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
	replacedByTabId?: number;
}): BrowserBridgeError {
	const liveTabIds = args.tabs.map((tab) => tab.tabId).filter((id): id is number => typeof id === "number");
	const hint = liveTabIds.length
		? `tabId ${args.tabId} is not connected. Use a stable tabHandle/targetRef from browser_tabs list, omit tabId to target the active tab${args.replacedByTabId ? `, or retry with replacement tabId ${args.replacedByTabId}` : args.latestTabId ? `, or use the current tab id ${args.latestTabId}` : ""}. Live tab ids: ${liveTabIds.join(", ")}.`
		: "No browser tabs are currently connected. Open or attach one with browser_tabs first.";
	return new BrowserBridgeError("TAB_NOT_FOUND", "Target browser tab is not connected", {
		tabId: args.tabId,
		...(args.replacedByTabId ? { replacedByTabId: args.replacedByTabId } : {}),
		browserSessionId: args.browserSessionId,
		selectedBrowser: args.selectedBrowser,
		tabs: args.tabs.map((tab) => compactTabForError(tab)),
		recovery: {
			retryable: true,
			hint,
			...(args.replacedByTabId ? { suggestedTabId: args.replacedByTabId } : args.latestTabId ? { suggestedTabId: args.latestTabId } : {}),
			liveTabIds,
		},
	});
}

export function targetHandleNotFoundError(args: {
	tabHandle: string;
	browserSessionId?: string;
	tabs: Array<{ tabHandle?: string; tabId?: number } & Record<string, unknown>>;
}): BrowserBridgeError {
	const compactTabs = args.tabs.map((tab) => compactTabForError(tab));
	const liveTabHandles = args.tabs.map((tab) => tab.tabHandle).filter((handle): handle is string => typeof handle === "string");
	const suggestedTargetRef = liveTabHandles.length === 1 ? liveTabHandles[0] : undefined;
	return new BrowserBridgeError("TAB_NOT_FOUND", "Target tab handle is not connected", {
		tabHandle: args.tabHandle,
		browserSessionId: args.browserSessionId,
		tabs: compactTabs,
		recovery: {
			retryable: true,
			hint: suggestedTargetRef
				? `The stable target reference is no longer connected. Retry with targetRef ${suggestedTargetRef} if it matches the intended live tab; otherwise list tabs to choose explicitly.`
				: "The stable target reference is no longer connected. Possible causes: (1) the tab was closed or navigated away; (2) the extension service worker reconnected after going idle and the handle could not be rebound (this happens when the extensionId changed or multiple matching sessions were ambiguous). Re-list tabs to obtain the current handle and retry.",
			nextActions: suggestedTargetRef
				? [
					`retry with targetRef ${suggestedTargetRef}`,
					"browser_tabs action=list if multiple tabs are possible or the suggested target is not intended",
					"omit targetRef/tabId to use the selected active tab",
				]
				: [
					"browser_tabs action=list",
					"retry with targetRef set to a live tabHandle, or omit targetRef/tabId to use the selected active tab",
				],
			liveTabHandles,
			...(suggestedTargetRef ? { suggestedTargetRef } : {}),
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
	extensionConnected?: boolean;
	extensionWaitMs?: number;
	connectionWaitMs?: number;
	negativeCacheActive?: boolean;
	negativeCacheRemainingMs?: number;
	browserSessionId?: string;
	sessions?: unknown;
} = {}): BrowserBridgeError {
	// Keep the port out of the prose hint — it lives in details.port. Embedding a
	// volatile value in the message would break envelope parity across servers.
	const hint = args.everConnected
		? `The browser extension was connected but is not reachable now — its MV3 service worker likely went idle. Open or reload any browser tab to wake it; it reconnects automatically, then retry.`
		: `No Browser Pilot extension is connected to the bridge. The bridge is a server the extension connects into — it cannot dial the browser for you. Ensure the "Browser Pilot Bridge" extension is loaded and enabled, then open or reload any tab so its service worker connects.`;
	return new BrowserBridgeError("NO_BROWSER_EXTENSION", "No connected browser bridge extension", {
		...(typeof args.port === "number" ? { port: args.port } : {}),
		...(args.browserSessionId ? { browserSessionId: args.browserSessionId } : {}),
		...(args.sessions ? { sessions: args.sessions } : {}),
		everConnected: args.everConnected === true,
		extensionConnected: args.extensionConnected === true,
		...(typeof args.extensionWaitMs === "number" ? { extensionWaitMs: args.extensionWaitMs } : {}),
		...(typeof args.connectionWaitMs === "number" ? { connectionWaitMs: args.connectionWaitMs } : {}),
		...(typeof args.negativeCacheActive === "boolean" ? { negativeCacheActive: args.negativeCacheActive } : {}),
		...(typeof args.negativeCacheRemainingMs === "number" ? { negativeCacheRemainingMs: args.negativeCacheRemainingMs } : {}),
		recovery: {
			retryable: true,
			hint,
			nextActions: [
				"verify the Browser Pilot Bridge extension is installed and enabled in the browser",
				"open or reload any browser tab so the extension service worker wakes and connects to the bridge",
				"check connection state with `browser-pilot daemon status`",
			],
		},
	});
}
