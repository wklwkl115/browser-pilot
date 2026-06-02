import { type NativeErrorCode, normalizeNativeErrorCode } from "../protocol/nativeErrorCodes.js";
import { normalizeError } from "../utils/errors.js";

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
		return { code: this.code, message: this.message, details: this.details };
	}
}

export function errorToPlain(error: unknown): Record<string, unknown> {
	return normalizeError(error);
}

/**
 * Build the canonical TAB_NOT_FOUND error with an actionable recovery hint.
 *
 * A bridge tabId is not stable: it changes when a tab navigates, reloads, or is
 * replaced, so agents that cache a numeric id eventually hit a stale one. Beyond
 * the live `tabs` diagnostics, surface the current/latest tab id and tell the
 * caller it can simply omit tabId to use the active tab.
 */
export function tabNotFoundError(args: {
	tabId: number;
	browserSessionId?: string;
	selectedBrowser?: unknown;
	tabs: Array<{ tabId?: number }>;
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
		tabs: args.tabs,
		recovery: {
			retryable: true,
			hint,
			...(args.latestTabId ? { suggestedTabId: args.latestTabId } : {}),
			liveTabIds,
		},
	});
}
