import { redactSensitiveText } from "../../../utils/redaction.js";

export type RecoveryTaxonomyLike = {
	retryable: boolean;
};

export type ErrorRecovery = {
	summary?: string;
	nextActions?: string[];
	[key: string]: unknown;
};

const ABML_ERROR_CODES = new Set([
	"REF_NOT_FOUND",
	"REF_STALE",
	"REF_AMBIGUOUS",
	"REF_SCOPE_VIOLATION",
	"HANDLE_NOT_FOUND",
	"HANDLE_EXPIRED",
	"HANDLE_KIND_MISMATCH",
	"HANDLE_ETAG_MISMATCH",
	"PRIVACY_BLOCKED",
	"ACTIONABILITY_TIMEOUT",
	"TARGET_OCCLUDED",
	"TARGET_DISABLED",
	"TARGET_NOT_EDITABLE",
	"BACKEND_UNAVAILABLE",
	"CROSS_ORIGIN_BLOCKED",
	"VERIFY_FAILED",
	"VERIFY_INCONCLUSIVE",
		"INVALID_INPUT",
]);

const WEBSOCKET_ERROR_CODES = new Set([
	"WEBSOCKET_INVALID_INPUT",
	"WEBSOCKET_SESSION_ALREADY_OPEN",
	"WEBSOCKET_SESSION_NOT_FOUND",
	"WEBSOCKET_SESSION_NOT_OPEN",
	"WEBSOCKET_OPEN_FAILED",
	"WEBSOCKET_OPEN_TIMEOUT",
	"WEBSOCKET_SEND_FAILED",
	"WEBSOCKET_INVALID_MATCHER",
	"WEBSOCKET_WAIT_TIMEOUT",
	"WEBSOCKET_WAIT_ABORTED",
]);

export function isAbmlRecoveryCode(code: string): boolean {
	return ABML_ERROR_CODES.has(code);
}

export function isWebSocketRecoveryCode(code: string): boolean {
	return WEBSOCKET_ERROR_CODES.has(code);
}

export function uniqueRecoveryActions(actions: Array<string | undefined | false>): string[] {
	return Array.from(new Set(actions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)));
}

function abmlRecoveryActions(code: string, details: Record<string, unknown>): string[] {
	if (!isAbmlRecoveryCode(code)) return [];
	const ref = typeof details.ref === "string" ? redactSensitiveText(details.ref) : undefined;
	const uri = typeof details.uri === "string" ? redactSensitiveText(details.uri) : undefined;
	return uniqueRecoveryActions([
		["REF_NOT_FOUND", "REF_STALE", "HANDLE_NOT_FOUND", "HANDLE_EXPIRED", "HANDLE_ETAG_MISMATCH"].includes(code) ? "browser_observe to re-capture fresh ABML refs" : undefined,
		code === "REF_AMBIGUOUS" ? "narrow the ABML ref with role/name/text or re-run browser_observe for current candidates" : undefined,
		code === "REF_SCOPE_VIOLATION" ? "remove the conflicting targetRef so the ref routes automatically, or re-capture it on the intended tab" : undefined,
		code === "HANDLE_KIND_MISMATCH" || code === "INVALID_INPUT" ? "retry with a ref/handle and parameters that match the requested ABML operation" : undefined,
		code === "PRIVACY_BLOCKED" ? "use redacted output or evidence scoped to the current page instead of private cross-scope data" : undefined,
		["ACTIONABILITY_TIMEOUT", "TARGET_OCCLUDED", "TARGET_DISABLED"].includes(code) ? "scroll or dismiss overlays in a new operation, or refresh actionability evidence before retrying the ABML action" : undefined,
		code === "TARGET_NOT_EDITABLE" ? "choose an editable target or focus the editor before retrying" : undefined,
		code === "BACKEND_UNAVAILABLE" ? "retry once after the browser/CDP backend recovers" : undefined,
		code === "CROSS_ORIGIN_BLOCKED" ? "switch to a reachable frame or use a visual/read fallback when cross-origin access is blocked" : undefined,
		["VERIFY_FAILED", "VERIFY_INCONCLUSIVE"].includes(code) ? "use the returned effect or evidence; refresh with browser_observe only if it remains inconclusive" : undefined,
		ref ? `retry with a fresh ABML ref instead of ${ref}` : undefined,
		uri ? `retry with a fresh resource URI instead of ${uri}` : undefined,
	]);
}

function websocketRecoveryActions(code: string): string[] {
	if (!isWebSocketRecoveryCode(code)) return [];
	return uniqueRecoveryActions([
		code === "WEBSOCKET_INVALID_INPUT" ? "use the WebSocket primitive's documented url, connection id, matcher, or steps fields" : undefined,
		["WEBSOCKET_SESSION_ALREADY_OPEN", "WEBSOCKET_SESSION_NOT_FOUND", "WEBSOCKET_SESSION_NOT_OPEN"].includes(code) ? "use status or open with the intended WebSocket connection id" : undefined,
		["WEBSOCKET_OPEN_FAILED", "WEBSOCKET_OPEN_TIMEOUT", "WEBSOCKET_SEND_FAILED", "WEBSOCKET_WAIT_TIMEOUT", "WEBSOCKET_WAIT_ABORTED"].includes(code) ? "collect the WebSocket transcript, then retry once if the task still requires the connection; Browser Pilot owns the deadline" : undefined,
		code === "WEBSOCKET_INVALID_MATCHER" ? "replace unsafe regex matching with contains or a bounded safe regex before retrying WebSocket wait" : undefined,
	]);
}

export function mergeRecoveries(primary: ErrorRecovery | undefined, secondary: ErrorRecovery | undefined): ErrorRecovery | undefined {
	if (!primary) return secondary;
	if (!secondary) return primary;
	const nextActions = uniqueRecoveryActions([...(primary.nextActions || []), ...(secondary.nextActions || [])]);
	return {
		...secondary,
		...primary,
		...(nextActions.length ? { nextActions } : {}),
	};
}

export function recoveryForNormalized(code: string, details: Record<string, unknown>, taxonomy: RecoveryTaxonomyLike): ErrorRecovery | undefined {
	const actions = uniqueRecoveryActions([
		...abmlRecoveryActions(code, details),
		...websocketRecoveryActions(code),
		["NO_TAB", "TAB_NOT_FOUND", "INVALID_TAB_ID", "TAB_ID_REQUIRED"].includes(code) ? "browser_tabs action=list" : undefined,
		["SELECTOR_NOT_FOUND", "INVALID_SELECTOR", "ELEMENT_NOT_FOUND"].includes(code) ? "browser_observe to refresh the page model; use browser_command html.get for exact DOM evidence" : undefined,
		["BODY_UNAVAILABLE", "REQUEST_NOT_FOUND", "NETWORK_RECORDER_NOT_STARTED"].includes(code) ? "use browser_command network.start on the intended tab, then network.list or network.body" : undefined,
		["NO_SESSION", "NOT_INSTALLED"].includes(code) ? "use browser_command hook.install on the intended tab before collecting hook events" : undefined,
		["INVALID_TIMEOUT", "TIMEOUT", "BRIDGE_TIMEOUT", "NAVIGATION_TIMEOUT", "NETWORK_IDLE_TIMEOUT", "SELECTOR_TIMEOUT"].includes(code) ? "retry once with the current targetRef; Browser Pilot owns the execution deadline" : undefined,
		code === "TARGET_TRANSACTION_CONFLICT" ? "finish the current target operation before starting work on another browser tab" : undefined,
		code === "INVALID_BROWSER_COMMAND" ? "use browser_command with a validated command object" : undefined,
		code === "BROWSER_COMMAND_FAILED" ? "use browser_command with a validated command object" : undefined,
		code === "BROWSER_EXECUTION_ERROR" ? "inspect the page error in this result; if selectors targeted stale DOM, refresh with browser_observe" : undefined,
		code === "FRAME_DETACHED" ? "use browser_command frame.list" : undefined,
		["SESSION_NOT_FOUND", "TAB_CRASHED"].includes(code) ? "browser_tabs action=list" : undefined,
	]);
	if (!actions.length) return undefined;
	return {
		summary: taxonomy.retryable ? "Retry after correcting the target, selector, or evidence inputs." : "Inspect the suggested follow-up action before retrying.",
		nextActions: actions,
	};
}
