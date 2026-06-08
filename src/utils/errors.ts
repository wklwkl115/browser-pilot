import { nativeErrorCodes } from "../protocol/nativeErrorCodes.js";
import { isRecord } from "./records.js";
import { redactSensitiveText, redactSensitiveValue } from "./redaction.js";

export type ErrorTaxonomyDomain =
	| "driver"
	| "tool"
	| "native"
	| "page"
	| "cdp"
	| "network"
	| "transfer"
	| "security"
	| "artifact"
	| "protocol"
	| "abml"
	| "websocket"
	| "unknown";

export type ErrorTaxonomy = {
	domain: ErrorTaxonomyDomain;
	category: string;
	retryable: boolean;
	summary: string;
	source: "schema" | "heuristic";
};

export type ErrorRecovery = {
	summary?: string;
	nextActions?: string[];
	[key: string]: unknown;
};

export type ErrorDiagnostics = {
	scopes: string[];
	target?: Record<string, unknown>;
	session?: Record<string, unknown>;
	pending?: Record<string, unknown>;
	nextActions?: string[];
};

export type NormalizedError = {
	code: string;
	message: string;
	details: Record<string, unknown>;
	taxonomy: ErrorTaxonomy;
	diagnostics: ErrorDiagnostics;
	recovery?: ErrorRecovery;
	name?: string;
};

function stripStackFields(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || value === undefined || typeof value !== "object") return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => stripStackFields(item, seen));
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (key.toLowerCase() === "stack") continue;
		out[key] = stripStackFields(item, seen);
	}
	return out;
}

function cleanDetails(value: unknown): Record<string, unknown> {
	return isRecord(value) ? stripStackFields(value) as Record<string, unknown> : {};
}

function firstDefined(record: Record<string, unknown>, keys: string[]): unknown {
	for (const key of keys) if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
	return undefined;
}

function pickDefined(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		const value = record[key];
		if (value !== undefined && value !== null && value !== "") out[key] = value;
	}
	return out;
}

function domainFromCategory(category: string, details: Record<string, unknown>): ErrorTaxonomyDomain {
	if (String(details.domain || "").toLowerCase() === "websecurity") return "security";
	if (category.startsWith("abml.")) return "abml";
	if (category === "bridge.ws") return "websocket";
	if (category.startsWith("driver.")) return "driver";
	if (category === "tool.transfer" || category === "runtime.transfer") return "transfer";
	if (category === "tool.artifact") return "artifact";
	if (category === "tool.security") return "security";
	if (category === "runtime.network") return "network";
	if (category === "runtime.cdp") return "cdp";
	if (category === "runtime.page" || category === "runtime.selector" || category === "runtime.frame" || category === "runtime.tab") return "page";
	if (category.startsWith("tool.")) return "tool";
	if (category.startsWith("runtime.")) return "native";
	return "unknown";
}

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

export function errorTaxonomyForCode(code: string, details: Record<string, unknown> = {}): ErrorTaxonomy {
	const detailsDomain = String(details.domain || "").toLowerCase();
	if (detailsDomain === "websecurity" || detailsDomain === "security") {
		return { domain: "security", category: "tool.security", retryable: false, summary: "WebSecurity tool failure.", source: "heuristic" };
	}
	const schemaEntry = nativeErrorCodes[code as keyof typeof nativeErrorCodes] as { category?: string; retryable?: boolean; summary?: string } | undefined;
	if (schemaEntry) {
		const category = schemaEntry.category || "runtime.internal";
		return {
			domain: code === "INVALID_BROWSER_COMMAND" ? "protocol" : domainFromCategory(category, details),
			category,
			retryable: schemaEntry.retryable === true,
			summary: schemaEntry.summary || code,
			source: "schema",
		};
	}
	if (code.startsWith("ARTIFACT_")) return { domain: "artifact", category: "tool.artifact", retryable: false, summary: "browser_artifact local evidence reader failure.", source: "heuristic" };
	if (code === "INVALID_TIMEOUT") return { domain: "tool", category: "tool.validation", retryable: false, summary: "Tool timeout parameter is invalid.", source: "heuristic" };
	if (code.includes("CDP") || ["NO_TAB_ID", "SESSION_LIMIT", "ATTACH_FAILED", "DETACH_FAILED", "SEND_FAILED", "FRAME_EVAL_FAILED", "NO_METHOD", "FRAME_NOT_FOUND", "NO_SOURCE", "NO_IDENTIFIER", "SCRIPT_NOT_FOUND", "UNKNOWN_ACTION"].includes(code)) {
		return { domain: "cdp", category: "runtime.cdp", retryable: /TIMEOUT|FAILED|DETACH|ATTACH|SEND/.test(code), summary: "Persistent CDP bridge failure.", source: "heuristic" };
	}
	if (["ELEMENT_INDEX_OUT_OF_RANGE", "ELEMENT_NOT_CLICKABLE", "MEDIA_URL_NOT_FOUND"].includes(code)) return { domain: "page", category: "runtime.page", retryable: false, summary: "Page-side element operation failed.", source: "heuristic" };
	return { domain: "unknown", category: "unknown", retryable: false, summary: code || "Unknown error.", source: "heuristic" };
}

export function errorDiagnosticsFromDetails(details: Record<string, unknown>, code?: string): ErrorDiagnostics {
	const scopes: string[] = [];
	const targetRecord = isRecord(details.target) ? details.target : {};
	const target = {
		...pickDefined(details, ["tabId", "browserId", "selectionVersion"]),
		...pickDefined(targetRecord, ["tabId", "browserId", "source", "selectionVersion"]),
	};
	const session = {
		...pickDefined(details, ["sessionId", "session_id", "requestId", "request_id", "waitId", "wait_id", "listenerId", "listener_id"]),
	};
	const pending = {
		...pickDefined(details, ["id", "pendingCount", "acked", "timeoutMs"]),
	};
	if (Object.keys(target).length) scopes.push("target");
	if (Object.keys(session).length) scopes.push("session");
	if (Object.keys(pending).length) scopes.push("pending");
	if (firstDefined(details, ["recorder", "bodyAvailability", "bodyUnavailableReason"])) scopes.push("network");
	if (code?.startsWith("ARTIFACT_") || firstDefined(details, ["path", "requested", "bytes", "maxBytes", "allowedRoot", "fileCount", "root", "glob"])) scopes.push("artifact");
	if (firstDefined(details, ["files", "files_count", "selector", "downloadId"])) scopes.push("transfer");
	if (isRecord(details.operation)) scopes.push("operation");
	if (isRecord(details.snapshot) || firstDefined(details, ["snapshotId", "invalidatedReason"])) scopes.push("snapshot");
	if (String(details.domain || "").toLowerCase() === "websecurity") scopes.push("security");
	if (code && ABML_ERROR_CODES.has(code)) scopes.push("abml");
	if (code && WEBSOCKET_ERROR_CODES.has(code)) scopes.push("websocket");
	if (code?.startsWith("MEMORY_") || code === "UNSUPPORTED_SCOPE_KIND") scopes.push("memory");
	return {
		scopes: Array.from(new Set(scopes)),
		...(Object.keys(target).length ? { target } : {}),
		...(Object.keys(session).length ? { session } : {}),
		...(Object.keys(pending).length ? { pending } : {}),
	};
}

function abmlRecoveryActions(code: string, details: Record<string, unknown>): string[] {
	if (!ABML_ERROR_CODES.has(code)) return [];
	const ref = typeof details.ref === "string" ? redactSensitiveText(details.ref) : undefined;
	const uri = typeof details.uri === "string" ? redactSensitiveText(details.uri) : undefined;
	return uniqueActions([
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
	if (!WEBSOCKET_ERROR_CODES.has(code)) return [];
	return uniqueActions([
		code === "WEBSOCKET_INVALID_INPUT" ? "use /browser-ws open|send|wait|replay|collect|close with explicit url/session/steps" : undefined,
		["WEBSOCKET_SESSION_ALREADY_OPEN", "WEBSOCKET_SESSION_NOT_FOUND", "WEBSOCKET_SESSION_NOT_OPEN"].includes(code) ? "use /browser-ws collect/status/open with the intended session id, or close the stale session before retrying" : undefined,
		["WEBSOCKET_OPEN_FAILED", "WEBSOCKET_OPEN_TIMEOUT", "WEBSOCKET_SEND_FAILED", "WEBSOCKET_WAIT_TIMEOUT", "WEBSOCKET_WAIT_ABORTED"].includes(code) ? "collect the WebSocket transcript, verify session state/url, then retry with explicit timeoutMs" : undefined,
		code === "WEBSOCKET_INVALID_MATCHER" ? "replace unsafe regex matching with contains or a bounded safe regex before retrying /browser-ws wait" : undefined,
	]);
}

function memoryRecoveryActions(code: string, details: Record<string, unknown>): string[] {
	const id = typeof details.id === "string" ? redactSensitiveText(details.id) : undefined;
	const uri = typeof details.uri === "string" ? redactSensitiveText(details.uri) : undefined;
	const scopeKind = typeof details.scopeKind === "string" ? redactSensitiveText(details.scopeKind) : undefined;
	const scopeHint = scopeKind ? ` for scopeKind=${scopeKind}` : "";
	return uniqueActions([
		code === "MEMORY_ACTION_UNSUPPORTED" ? "use browser_memory action=record|recall|read|validate" : undefined,
		["MEMORY_SCOPE_REQUIRED", "UNSUPPORTED_SCOPE_KIND"].includes(code) ? `browser_memory action=record|recall with url or explicit scopeKind/scopeKey${scopeHint}` : undefined,
		code === "MEMORY_EVIDENCE_REQUIRED" ? "record memory with durable evidenceRefs such as saved.path, browser-result://, or a non-stale snapshot reference" : undefined,
		["MEMORY_EVIDENCE_UNREADABLE", "MEMORY_EVIDENCE_UNRESOLVABLE", "MEMORY_EVIDENCE_STALE", "MEMORY_RESOURCE_STALE"].includes(code) ? "re-capture evidence with browser_observe or the original capture tool, then retry browser_memory" : undefined,
		code === "MEMORY_SECRET_DETECTED" ? "remove secrets, tokens, credentials, captcha-evasion, or stealth instructions before recording memory" : undefined,
		code === "MEMORY_SCHEMA_INVALID" ? "validate browser_memory payload shape: title, non-empty triggers, bounded body, and supported scope fields" : undefined,
		code === "MEMORY_ENTRY_NOT_FOUND" ? "browser_memory action=recall or read by a fresh browser-memory:// URI/id" : undefined,
		id && ["MEMORY_ENTRY_NOT_FOUND", "MEMORY_RESOURCE_STALE"].includes(code) ? `browser_memory action=read id=${id}` : undefined,
		uri && ["MEMORY_EVIDENCE_UNRESOLVABLE", "MEMORY_RESOURCE_STALE", "MEMORY_ENTRY_NOT_FOUND"].includes(code) ? `retry with a fresh resource URI instead of ${uri}` : undefined,
	]);
}

function uniqueActions(actions: Array<string | undefined | false>): string[] {
	return Array.from(new Set(actions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)));
}

function mergeRecoveries(primary: ErrorRecovery | undefined, secondary: ErrorRecovery | undefined): ErrorRecovery | undefined {
	if (!primary) return secondary;
	if (!secondary) return primary;
	const nextActions = uniqueActions([...(primary.nextActions || []), ...(secondary.nextActions || [])]);
	return {
		...secondary,
		...primary,
		...(nextActions.length ? { nextActions } : {}),
	};
}

function recoveryForNormalized(code: string, details: Record<string, unknown>, taxonomy: ErrorTaxonomy): ErrorRecovery | undefined {
	const selector = typeof details.selector === "string" ? redactSensitiveText(details.selector) : undefined;
	const path = typeof details.path === "string" ? redactSensitiveText(details.path) : undefined;
	const query = typeof details.query === "string" ? redactSensitiveText(details.query) : undefined;
	const actions = uniqueActions([
		...abmlRecoveryActions(code, details),
		...websocketRecoveryActions(code),
		...memoryRecoveryActions(code, details),
		["NO_TAB", "TAB_NOT_FOUND", "INVALID_TAB_ID", "TAB_ID_REQUIRED", "BROWSER_NOT_FOUND"].includes(code) ? "browser_tabs action=list" : undefined,
		code === "AMBIGUOUS_TAB_ID" ? "browser_tabs action=selectBrowser then retry with explicit tabId" : undefined,
		["SELECTOR_NOT_FOUND", "INVALID_SELECTOR", "ELEMENT_NOT_FOUND"].includes(code) ? "browser_observe mode=scan|html" : undefined,
		selector ? `verify selector=${selector} against the current DOM` : undefined,
		["BODY_UNAVAILABLE", "REQUEST_NOT_FOUND", "NETWORK_RECORDER_NOT_STARTED"].includes(code) ? "browser_network action=list|body with a fresh recorder session" : undefined,
		["ARTIFACT_NOT_FOUND", "ARTIFACT_PATH_REQUIRED", "ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT", "ARTIFACT_TOO_LARGE", "ARTIFACT_SEARCH_QUERY_REQUIRED", "ARTIFACT_SEARCH_REGEX_INVALID", "ARTIFACT_SEARCH_REGEX_UNSAFE", "ARTIFACT_MULTI_SEARCH_MODE_INVALID", "ARTIFACT_QUERY_REQUIRES_SEARCH_MODE", "ARTIFACT_JSON_INVALID"].includes(code) ? "browser_artifact mode=search|json|text with explicit path/paths and bounded limits" : undefined,
		code === "ARTIFACT_QUERY_REQUIRES_SEARCH_MODE" ? "use browser_artifact mode=search with query, or remove query from json/text/sample reads" : undefined,
		code === "ARTIFACT_JSON_INVALID" ? "use browser_artifact mode=text|search for non-JSON artifacts, or choose a valid JSON artifact path" : undefined,
		path ? `browser_artifact path=${path}` : undefined,
		query && (code.startsWith("ARTIFACT_SEARCH_") || code === "ARTIFACT_QUERY_REQUIRES_SEARCH_MODE") ? `retry browser_artifact search with query=${query}` : undefined,
		["UPLOAD_CONFIRMATION_REQUIRED", "UPLOAD_REQUIRES_BROWSER_UPLOAD"].includes(code) ? "use browser_upload confirm:true with explicit absolute file paths" : undefined,
		code === "DOWNLOAD_TARGET_REQUIRED" ? "use browser_download with explicit selector or url" : undefined,
		["INVALID_TIMEOUT", "TIMEOUT", "BRIDGE_TIMEOUT", "NAVIGATION_TIMEOUT", "NETWORK_IDLE_TIMEOUT", "SELECTOR_TIMEOUT", "MATURE_BRIDGE_LAUNCHER_PROBE_TIMEOUT", "MATURE_BRIDGE_PROCESS_TIMEOUT"].includes(code) ? "retry with explicit timeoutMs and tabId/browserSessionId" : undefined,
		["TAB_LEASE_CONFLICT", "UI_LOCK_CONFLICT"].includes(code) ? "browser_tabs action=snapshot" : undefined,
		code === "INVALID_BROWSER_COMMAND" ? "use browser_command with a validated command object" : undefined,
		["MATURE_BRIDGE_LAUNCHER_NOT_FOUND", "MATURE_BRIDGE_LAUNCHER_PROBE_FAILED", "MATURE_BRIDGE_LAUNCH_FAILED"].includes(code) ? "configure sqlmapPath/nucleiPath or the matching PI_*_PATH environment variable, then retry" : undefined,
		code === "MATURE_BRIDGE_TARGET_REQUIRED" ? "use browser_http_replay or a direct url/rawRequest/request/HAR input before invoking the mature bridge" : undefined,
		code === "MATURE_BRIDGE_TEMPLATE_SELECTION_REQUIRED" ? "supply explicit templatePaths/workflowPaths/templateIds/tags/severities/authors before invoking browser_template engine:nuclei" : undefined,
	]);
	if (!actions.length) return undefined;
	return {
		summary: taxonomy.retryable ? "Retry after verifying target, selector, timeout, or evidence inputs." : "Inspect the suggested follow-up action before retrying.",
		nextActions: actions,
	};
}

export function normalizeError(error: unknown, fallbackCode = "INTERNAL_ERROR"): NormalizedError {
	if (error instanceof Error) {
		const extra = error as Error & { code?: unknown; details?: unknown };
		const code = typeof extra.code === "string" && extra.code.trim() ? extra.code : fallbackCode;
		const details = cleanDetails(extra.details);
		const taxonomy = errorTaxonomyForCode(code, details);
		const generatedRecovery = recoveryForNormalized(code, details, taxonomy);
		const existingRecovery = isRecord(details.recovery) ? details.recovery as ErrorRecovery : undefined;
		const recovery = mergeRecoveries(existingRecovery, generatedRecovery);
		return {
			code,
			message: error.message || code,
			details,
			taxonomy,
			diagnostics: { ...errorDiagnosticsFromDetails(details, code), ...(recovery?.nextActions?.length ? { nextActions: recovery.nextActions } : {}) },
			recovery,
			name: error.name || "Error",
		};
	}
	if (isRecord(error)) {
		const nested = isRecord(error.error) ? error.error : {};
		const code =
			typeof error.code === "string" && error.code.trim() ? error.code
				: typeof error.error_code === "string" && error.error_code.trim() ? error.error_code
					: typeof nested.code === "string" && nested.code.trim() ? nested.code
						: typeof nested.error_code === "string" && nested.error_code.trim() ? nested.error_code
							: fallbackCode;
		const message =
			typeof error.message === "string" && error.message ? error.message
				: typeof error.error === "string" && error.error ? error.error
					: typeof nested.message === "string" && nested.message ? nested.message
						: typeof nested.error === "string" && nested.error ? nested.error
							: String(code);
		const nestedDetails = cleanDetails(nested.details);
		const details = cleanDetails({ ...nestedDetails, ...cleanDetails(error.details) });
		const taxonomy = errorTaxonomyForCode(code, details);
		const generatedRecovery = recoveryForNormalized(code, details, taxonomy);
		const existingRecovery = isRecord(details.recovery) ? details.recovery as ErrorRecovery : undefined;
		const recovery = mergeRecoveries(existingRecovery, generatedRecovery);
		return { code, message, details, taxonomy, diagnostics: { ...errorDiagnosticsFromDetails(details, code), ...(recovery?.nextActions?.length ? { nextActions: recovery.nextActions } : {}) }, recovery, name: typeof error.name === "string" ? error.name : undefined };
	}
	const details = {};
	const taxonomy = errorTaxonomyForCode(fallbackCode, details);
	const recovery = recoveryForNormalized(fallbackCode, details, taxonomy);
	return { code: fallbackCode, message: String(error), details, taxonomy, diagnostics: { ...errorDiagnosticsFromDetails(details, fallbackCode), ...(recovery?.nextActions?.length ? { nextActions: recovery.nextActions } : {}) }, recovery, name: "Error" };
}

export function suppressErrorStack<T extends Error>(error: T): T {
	const descriptor = Object.getOwnPropertyDescriptor(error, "stack");
	if (!descriptor) {
		if (Object.isExtensible(error)) Object.defineProperty(error, "stack", { value: undefined, configurable: true, writable: true });
		return error;
	}
	if (descriptor.configurable) {
		Reflect.deleteProperty(error, "stack");
		return error;
	}
	if ("writable" in descriptor && descriptor.writable) Object.defineProperty(error, "stack", { value: undefined });
	return error;
}

export function compactError(error: unknown, fallbackCode = "INTERNAL_ERROR"): Record<string, unknown> {
	const normalized = normalizeError(error, fallbackCode);
	const diagnostics = redactSensitiveValue(normalized.diagnostics);
	const recovery = normalized.recovery ? redactSensitiveValue(normalized.recovery) : undefined;
	return {
		code: normalized.code,
		message: redactSensitiveText(normalized.message),
		taxonomy: normalized.taxonomy,
		diagnostics,
		details: redactSensitiveValue(normalized.details),
		recovery,
		name: normalized.name,
	};
}
