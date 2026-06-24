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
	"RESOURCE_NOT_FOUND",
	"RESOURCE_STALE",
	"RESOURCE_READ_ERROR",
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

type ExecutionEffectRecoveryLike = {
	navigated?: boolean;
	targetDelta?: unknown;
	requestsFired?: number;
	hookEventsFired?: number;
	targetRegionDirty?: boolean;
	temporal?: {
		verdict?: {
			reasons?: unknown;
		};
	};
};

type EvidenceSourceSummaryLike = {
	ok?: unknown;
	error_code?: unknown;
	events?: unknown;
	items?: unknown;
	entries?: unknown;
	count?: unknown;
};

const CAPTURE_NOT_STARTED_CODES = new Set(["NO_SESSION", "NOT_INSTALLED", "NETWORK_RECORDER_NOT_STARTED"]);

/**
 * Advisory (non-error) ordering hint for browser_evidence: the bundle always returns ok:true even
 * when no capture was active, so an empty bundle is otherwise a silent dead-end the agent discovers
 * calls later. Surfaces the "start capture BEFORE the action" ordering constraint immediately.
 */
export function nextActionsForEvidenceBundle(sources: Record<string, EvidenceSourceSummaryLike> | undefined): string[] | undefined {
	if (!sources || Object.keys(sources).length === 0) return undefined;
	const num = (value: unknown): number => (typeof value === "number" ? value : 0);
	const entries = Object.values(sources);
	const anyEvidence = entries.some((source) => num(source.events) > 0 || num(source.items) > 0 || num(source.entries) > 0 || num(source.count) > 0);
	if (anyEvidence) return undefined;
	const notStarted = entries.some((source) => typeof source.error_code === "string" && CAPTURE_NOT_STARTED_CODES.has(source.error_code));
	if (notStarted) {
		return ["evidence bundle is empty because capture was not active — install hooks with browser_hook action=installTargets and/or start recording with browser_network action=start BEFORE the triggering action, then re-run browser_evidence"];
	}
	return ["evidence bundle is empty — capture started after the action records nothing; start browser_hook/browser_network before the action that should produce evidence, then re-run browser_evidence"];
}

export function nextActionsForExecutionEffect(effect: ExecutionEffectRecoveryLike | undefined): string[] | undefined {
	if (!effect) return undefined;
	const actions = uniqueRecoveryActions([
		effect.navigated || effect.targetDelta ? "tab identity may have changed; list tabs and use targetRef/tabHandle before the next tab-scoped call if targeting is ambiguous" : undefined,
		(effect.requestsFired ?? 0) > 0 || (effect.hookEventsFired ?? 0) > 0 ? "effect anchor is available for browser_observe baseline/causal follow-up" : undefined,
		Array.isArray(effect.temporal?.verdict?.reasons) && effect.temporal.verdict.reasons.includes("target_stale_before_dispatch") ? "target ref was stale before dispatch; refresh with browser_observe mode=scan before retrying the same bp-ref" : undefined,
		effect.targetRegionDirty === true ? "target ref region changed after the action; refresh with browser_observe mode=scan before reusing the same bp-ref" : undefined,
	]);
	return actions.length ? actions : undefined;
}

function abmlRecoveryActions(code: string, details: Record<string, unknown>): string[] {
	if (!isAbmlRecoveryCode(code)) return [];
	const ref = typeof details.ref === "string" ? redactSensitiveText(details.ref) : undefined;
	const uri = typeof details.uri === "string" ? redactSensitiveText(details.uri) : undefined;
	return uniqueRecoveryActions([
		["REF_NOT_FOUND", "REF_STALE", "HANDLE_NOT_FOUND", "HANDLE_EXPIRED", "HANDLE_ETAG_MISMATCH"].includes(code) ? "browser_observe mode=scan to re-capture fresh ABML refs/resources" : undefined,
		code === "REF_AMBIGUOUS" ? "narrow the ABML ref with role/name/text or re-run browser_observe for current candidates" : undefined,
		code === "REF_SCOPE_VIOLATION" ? "switch to the owning browser session/tab or re-capture the ref in the current scope" : undefined,
		code === "HANDLE_KIND_MISMATCH" || code === "INVALID_INPUT" ? "retry with a ref/handle and parameters that match the requested ABML operation" : undefined,
		code === "PRIVACY_BLOCKED" ? "use redacted output or explicitly scoped same-session evidence instead of private cross-scope data" : undefined,
		["ACTIONABILITY_TIMEOUT", "TARGET_OCCLUDED", "TARGET_DISABLED"].includes(code) ? "wait, scroll, dismiss overlays, or refresh actionability evidence before retrying the ABML action" : undefined,
		code === "TARGET_NOT_EDITABLE" ? "choose an editable target or focus the editor before retrying" : undefined,
		code === "BACKEND_UNAVAILABLE" ? "retry after the browser/CDP backend is healthy or refresh the browser session" : undefined,
		code === "CROSS_ORIGIN_BLOCKED" ? "switch to a reachable frame or use a visual/read fallback when cross-origin access is blocked" : undefined,
		["VERIFY_FAILED", "VERIFY_INCONCLUSIVE"].includes(code) ? "run browser_observe after the action and retry with tighter verification evidence" : undefined,
		["RESOURCE_NOT_FOUND", "RESOURCE_STALE", "RESOURCE_READ_ERROR"].includes(code) ? "re-run the original capture tool or browser_observe to mint a fresh browser-result:// resource" : undefined,
		ref ? `retry with a fresh ABML ref instead of ${ref}` : undefined,
		uri ? `retry with a fresh resource URI instead of ${uri}` : undefined,
	]);
}

function websocketRecoveryActions(code: string): string[] {
	if (!isWebSocketRecoveryCode(code)) return [];
	return uniqueRecoveryActions([
		code === "WEBSOCKET_INVALID_INPUT" ? "use explicit WebSocket open|send|wait|replay|collect|close parameters with url/session/steps" : undefined,
		["WEBSOCKET_SESSION_ALREADY_OPEN", "WEBSOCKET_SESSION_NOT_FOUND", "WEBSOCKET_SESSION_NOT_OPEN"].includes(code) ? "collect/status/open with the intended session id, or close the stale session before retrying" : undefined,
		["WEBSOCKET_OPEN_FAILED", "WEBSOCKET_OPEN_TIMEOUT", "WEBSOCKET_SEND_FAILED", "WEBSOCKET_WAIT_TIMEOUT", "WEBSOCKET_WAIT_ABORTED"].includes(code) ? "collect the WebSocket transcript, verify session state/url, then retry with explicit timeoutMs" : undefined,
		code === "WEBSOCKET_INVALID_MATCHER" ? "replace unsafe regex matching with contains or a bounded safe regex before retrying WebSocket wait" : undefined,
	]);
}

function memoryRecoveryActions(code: string, details: Record<string, unknown>): string[] {
	const id = typeof details.id === "string" ? redactSensitiveText(details.id) : undefined;
	const uri = typeof details.uri === "string" ? redactSensitiveText(details.uri) : undefined;
	const scopeKind = typeof details.scopeKind === "string" ? redactSensitiveText(details.scopeKind) : undefined;
	const scopeHint = scopeKind ? ` for scopeKind=${scopeKind}` : "";
	return uniqueRecoveryActions([
		code === "MEMORY_ACTION_UNSUPPORTED" ? "use browser_memory action=record|recall|read|validate" : undefined,
		["MEMORY_SCOPE_REQUIRED", "UNSUPPORTED_SCOPE_KIND"].includes(code) ? `browser_memory action=record|recall with url or explicit scopeKind/scopeKey${scopeHint}` : undefined,
		code === "MEMORY_EVIDENCE_REQUIRED" ? "record memory facts with durable evidenceRefs such as saved.path, browser-result://, or a non-stale snapshot reference" : undefined,
		["MEMORY_EVIDENCE_UNREADABLE", "MEMORY_EVIDENCE_UNRESOLVABLE", "MEMORY_EVIDENCE_STALE", "MEMORY_RESOURCE_STALE"].includes(code) ? "re-capture evidence with browser_observe or the original capture tool, then retry browser_memory" : undefined,
		code === "MEMORY_SECRET_DETECTED" ? "remove secrets, tokens, credentials, captcha-evasion, or stealth instructions before recording memory" : undefined,
		code === "MEMORY_SCHEMA_INVALID" ? "record only durable memory facts with title, non-empty triggers, bounded body, kind=fact, and supported scope fields; do not store SOP/workflow/instruction content" : undefined,
		code === "MEMORY_ENTRY_NOT_FOUND" ? "browser_memory action=recall or read by a fresh browser-memory:// URI/id" : undefined,
		id && ["MEMORY_ENTRY_NOT_FOUND", "MEMORY_RESOURCE_STALE"].includes(code) ? `browser_memory action=read id=${id}` : undefined,
		uri && ["MEMORY_EVIDENCE_UNRESOLVABLE", "MEMORY_RESOURCE_STALE", "MEMORY_ENTRY_NOT_FOUND"].includes(code) ? `retry with a fresh resource URI instead of ${uri}` : undefined,
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
	const selector = typeof details.selector === "string" ? redactSensitiveText(details.selector) : undefined;
	const path = typeof details.path === "string" ? redactSensitiveText(details.path) : undefined;
	const query = typeof details.query === "string" ? redactSensitiveText(details.query) : undefined;
	const actions = uniqueRecoveryActions([
		...abmlRecoveryActions(code, details),
		...websocketRecoveryActions(code),
		...memoryRecoveryActions(code, details),
		["NO_TAB", "TAB_NOT_FOUND", "INVALID_TAB_ID", "TAB_ID_REQUIRED", "BROWSER_NOT_FOUND"].includes(code) ? "browser_tabs action=list" : undefined,
		code === "AMBIGUOUS_TAB_ID" ? "browser_tabs action=selectBrowser then retry with explicit targetRef/tabHandle" : undefined,
		["SELECTOR_NOT_FOUND", "INVALID_SELECTOR", "ELEMENT_NOT_FOUND"].includes(code) ? "browser_observe mode=scan|html" : undefined,
		selector ? `verify selector=${selector} against the current DOM` : undefined,
		["BODY_UNAVAILABLE", "REQUEST_NOT_FOUND", "NETWORK_RECORDER_NOT_STARTED"].includes(code) ? "browser_network action=list|body with a fresh recorder session" : undefined,
		["NO_SESSION", "NOT_INSTALLED"].includes(code) ? "set the target tab (pass targetRef/tabHandle) and install a hook session (browser_hook action=installTargets) before collect/status/evaluate" : undefined,
		["ARTIFACT_NOT_FOUND", "ARTIFACT_PATH_REQUIRED", "ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT", "ARTIFACT_TOO_LARGE", "ARTIFACT_SEARCH_QUERY_REQUIRED", "ARTIFACT_SEARCH_REGEX_INVALID", "ARTIFACT_SEARCH_REGEX_UNSAFE", "ARTIFACT_MULTI_SEARCH_MODE_INVALID", "ARTIFACT_QUERY_REQUIRES_SEARCH_MODE", "ARTIFACT_JSON_INVALID"].includes(code) ? "browser_artifact mode=search|json|text with explicit path/paths and bounded limits" : undefined,
		code === "ARTIFACT_QUERY_REQUIRES_SEARCH_MODE" ? "use browser_artifact mode=search with query, or remove query from json/text/sample reads" : undefined,
		code === "ARTIFACT_JSON_INVALID" ? "use browser_artifact mode=text|search for non-JSON artifacts, or choose a valid JSON artifact path" : undefined,
		path ? `browser_artifact path=${path}` : undefined,
		query && (code.startsWith("ARTIFACT_SEARCH_") || code === "ARTIFACT_QUERY_REQUIRES_SEARCH_MODE") ? `retry browser_artifact search with query=${query}` : undefined,
		["UPLOAD_CONFIRMATION_REQUIRED", "UPLOAD_REQUIRES_BROWSER_UPLOAD"].includes(code) ? "use browser_upload confirm:true with explicit absolute file paths" : undefined,
		code === "DOWNLOAD_TARGET_REQUIRED" ? "use browser_download with explicit selector or url" : undefined,
		["INVALID_TIMEOUT", "TIMEOUT", "BRIDGE_TIMEOUT", "NAVIGATION_TIMEOUT", "NETWORK_IDLE_TIMEOUT", "SELECTOR_TIMEOUT", "MATURE_BRIDGE_LAUNCHER_PROBE_TIMEOUT", "MATURE_BRIDGE_PROCESS_TIMEOUT"].includes(code) ? "retry with explicit timeoutMs and targetRef/browserSessionId" : undefined,
		["TAB_LEASE_CONFLICT", "UI_LOCK_CONFLICT"].includes(code) ? "browser_tabs action=snapshot" : undefined,
		["TAB_LEASE_CONFLICT", "UI_LOCK_CONFLICT"].includes(code) ? "browser_tabs action=list to target an unleased tab, or retry after the lease's remainingMs elapses" : undefined,
		code === "INVALID_BROWSER_COMMAND" ? "use browser_command with a validated command object" : undefined,
		code === "BROWSER_COMMAND_FAILED" ? "use browser_command with a validated command object" : undefined,
		code === "BROWSER_EXECUTION_ERROR" ? "inspect the page error in this result; if selectors targeted stale DOM, refresh with browser_observe mode=scan" : undefined,
		code === "FRAME_DETACHED" ? "browser_frame action=list" : undefined,
		["SESSION_NOT_FOUND", "TAB_CRASHED"].includes(code) ? "browser_tabs action=list" : undefined,
		["MATURE_BRIDGE_LAUNCHER_NOT_FOUND", "MATURE_BRIDGE_LAUNCHER_PROBE_FAILED", "MATURE_BRIDGE_LAUNCH_FAILED"].includes(code) ? "configure sqlmapPath/nucleiPath or the matching BROWSER_PILOT_*_PATH environment variable, then retry" : undefined,
		code === "MATURE_BRIDGE_TARGET_REQUIRED" ? "use browser_http_replay or a direct url/rawRequest/request/HAR input before invoking the mature bridge" : undefined,
		code === "MATURE_BRIDGE_TEMPLATE_SELECTION_REQUIRED" ? "supply explicit templatePaths/workflowPaths/templateIds/tags/severities/authors before invoking browser_template engine:nuclei" : undefined,
	]);
	if (!actions.length) return undefined;
	return {
		summary: taxonomy.retryable ? "Retry after verifying target, selector, timeout, or evidence inputs." : "Inspect the suggested follow-up action before retrying.",
		nextActions: actions,
	};
}
