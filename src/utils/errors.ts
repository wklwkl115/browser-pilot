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

export function errorDiagnosticsFromDetails(details: Record<string, unknown>): ErrorDiagnostics {
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
	if (firstDefined(details, ["path", "bytes", "maxBytes", "allowedRoot", "fileCount", "root", "glob"])) scopes.push("artifact");
	if (firstDefined(details, ["files", "files_count", "selector", "downloadId"])) scopes.push("transfer");
	if (isRecord(details.operation)) scopes.push("operation");
	if (isRecord(details.snapshot) || firstDefined(details, ["snapshotId", "invalidatedReason"])) scopes.push("snapshot");
	if (String(details.domain || "").toLowerCase() === "websecurity") scopes.push("security");
	return {
		scopes: Array.from(new Set(scopes)),
		...(Object.keys(target).length ? { target } : {}),
		...(Object.keys(session).length ? { session } : {}),
		...(Object.keys(pending).length ? { pending } : {}),
	};
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
	const selector = typeof details.selector === "string" ? details.selector : undefined;
	const path = typeof details.path === "string" ? details.path : undefined;
	const query = typeof details.query === "string" ? details.query : undefined;
	const actions = uniqueActions([
		["NO_TAB", "TAB_NOT_FOUND", "INVALID_TAB_ID", "TAB_ID_REQUIRED", "BROWSER_NOT_FOUND"].includes(code) ? "browser_tabs action=list" : undefined,
		code === "AMBIGUOUS_TAB_ID" ? "browser_tabs action=selectBrowser then retry with explicit tabId" : undefined,
		["SELECTOR_NOT_FOUND", "INVALID_SELECTOR", "ELEMENT_NOT_FOUND"].includes(code) ? "browser_observe mode=scan|html" : undefined,
		selector ? `verify selector=${selector} against the current DOM` : undefined,
		["BODY_UNAVAILABLE", "REQUEST_NOT_FOUND", "NETWORK_RECORDER_NOT_STARTED"].includes(code) ? "browser_network action=list|body with a fresh recorder session" : undefined,
		["ARTIFACT_PATH_REQUIRED", "ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT", "ARTIFACT_TOO_LARGE", "ARTIFACT_SEARCH_QUERY_REQUIRED", "ARTIFACT_SEARCH_REGEX_INVALID", "ARTIFACT_SEARCH_REGEX_UNSAFE", "ARTIFACT_MULTI_SEARCH_MODE_INVALID"].includes(code) ? "browser_artifact mode=search|json|text with explicit path/paths and bounded limits" : undefined,
		path ? `browser_artifact path=${path}` : undefined,
		query && code.startsWith("ARTIFACT_SEARCH_") ? `retry browser_artifact search with query=${query}` : undefined,
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
			diagnostics: { ...errorDiagnosticsFromDetails(details), ...(recovery?.nextActions?.length ? { nextActions: recovery.nextActions } : {}) },
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
		return { code, message, details, taxonomy, diagnostics: { ...errorDiagnosticsFromDetails(details), ...(recovery?.nextActions?.length ? { nextActions: recovery.nextActions } : {}) }, recovery, name: typeof error.name === "string" ? error.name : undefined };
	}
	const details = {};
	const taxonomy = errorTaxonomyForCode(fallbackCode, details);
	const recovery = recoveryForNormalized(fallbackCode, details, taxonomy);
	return { code: fallbackCode, message: String(error), details, taxonomy, diagnostics: { ...errorDiagnosticsFromDetails(details), ...(recovery?.nextActions?.length ? { nextActions: recovery.nextActions } : {}) }, recovery, name: "Error" };
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
	return {
		code: normalized.code,
		message: redactSensitiveText(normalized.message),
		taxonomy: normalized.taxonomy,
		diagnostics: normalized.diagnostics,
		details: redactSensitiveValue(normalized.details),
		recovery: normalized.recovery,
		name: normalized.name,
	};
}
