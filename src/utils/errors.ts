import { mergeRecoveries, recoveryForNormalized, isAbmlRecoveryCode, isWebSocketRecoveryCode } from "../kernels/evidence/distill/recovery.js";
import type { ErrorRecovery } from "../kernels/evidence/distill/recovery.js";
import { nativeErrorCodes, type NativeErrorCode, normalizeNativeErrorCode } from "../types/nativeErrorCodes.js";
import { firstDefined, isRecord, pickDefined } from "./records.js";
import { redactSensitiveText, redactSensitiveValue } from "./redaction.js";

export type { ErrorRecovery } from "../kernels/evidence/distill/recovery.js";

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

export type ErrorDiagnostics = {
	scopes: string[];
	target?: Record<string, unknown>;
	session?: Record<string, unknown>;
	pending?: Record<string, unknown>;
	waitDiagnosis?: { waitType: string; condition: string; observedState: string; suggestion: string };
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

function extractWaitDiagnosis(supervisor: Record<string, unknown> | undefined): ErrorDiagnostics["waitDiagnosis"] | undefined {
	if (!supervisor) return undefined;
	const wd = isRecord(supervisor.waitDiagnosis) ? supervisor.waitDiagnosis : undefined;
	if (!wd) return undefined;
	if (typeof wd.waitType !== "string" || typeof wd.condition !== "string" || typeof wd.observedState !== "string" || typeof wd.suggestion !== "string") return undefined;
	return { waitType: wd.waitType, condition: wd.condition, observedState: wd.observedState, suggestion: wd.suggestion };
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
	if (code && isAbmlRecoveryCode(code)) scopes.push("abml");
	if (code && isWebSocketRecoveryCode(code)) scopes.push("websocket");
	const supervisor = isRecord(details.supervisor) ? details.supervisor : undefined;
	const waitDiagnosis = extractWaitDiagnosis(supervisor);
	if (waitDiagnosis) scopes.push("waitDiagnosis");
	return {
		scopes: Array.from(new Set(scopes)),
		...(Object.keys(target).length ? { target } : {}),
		...(Object.keys(session).length ? { session } : {}),
		...(Object.keys(pending).length ? { pending } : {}),
		...(waitDiagnosis ? { waitDiagnosis } : {}),
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
			diagnostics: errorDiagnosticsFromDetails(details, code),
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
		return { code, message, details, taxonomy, diagnostics: errorDiagnosticsFromDetails(details, code), recovery, name: typeof error.name === "string" ? error.name : undefined };
	}
	const details = {};
	const taxonomy = errorTaxonomyForCode(fallbackCode, details);
	const recovery = recoveryForNormalized(fallbackCode, details, taxonomy);
	return { code: fallbackCode, message: String(error), details, taxonomy, diagnostics: errorDiagnosticsFromDetails(details, fallbackCode), recovery, name: "Error" };
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
