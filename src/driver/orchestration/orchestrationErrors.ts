import { BrowserBridgeError } from "../errors";
import type { JsonRecord, OrchestrationFailure } from "./types";

export const ORCHESTRATION_ERROR_CODES = {
	INVALID_DESIRED: "ORCHESTRATION_INVALID_DESIRED",
	TARGET_CONFLICT: "ORCHESTRATION_TARGET_CONFLICT",
	SESSION_NOT_FOUND: "ORCHESTRATION_SESSION_NOT_FOUND",
	BROWSER_NOT_FOUND: "ORCHESTRATION_BROWSER_NOT_FOUND",
	TIMEOUT: "ORCHESTRATION_TIMEOUT",
	LOCKED: "ORCHESTRATION_LOCKED",
	COMMAND_FAILED: "ORCHESTRATION_COMMAND_FAILED",
	WINDOW_OWNERSHIP_REQUIRED: "ORCHESTRATION_WINDOW_OWNERSHIP_REQUIRED",
	TARGET_STALE: "ORCHESTRATION_TARGET_STALE",
} as const;

const RETRYABLE_CODES = new Set<string>([
	ORCHESTRATION_ERROR_CODES.TIMEOUT,
	ORCHESTRATION_ERROR_CODES.LOCKED,
	"BRIDGE_TIMEOUT",
	"BRIDGE_CLIENT_DISCONNECTED",
	"BRIDGE_STOPPED",
	"NO_BROWSER_EXTENSION",
	"BROWSER_EXTENSION_RECONNECT_TIMEOUT",
]);

export class BrowserOrchestrationError extends BrowserBridgeError {
	readonly retryable: boolean;

	constructor(code: string, message: string, details: JsonRecord = {}, options: { retryable?: boolean } = {}) {
		super(code, message, details);
		this.name = "BrowserOrchestrationError";
		this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
	}
}

export function isRetryableOrchestrationCode(code: string | undefined): boolean {
	return !!code && RETRYABLE_CODES.has(code);
}

export function orchestrationFailure(error: unknown, operationId?: string): OrchestrationFailure {
	if (error instanceof BrowserOrchestrationError) {
		return {
			operationId,
			code: error.code,
			message: error.message,
			retryable: error.retryable,
			details: error.details,
		};
	}
	if (error instanceof BrowserBridgeError) {
		return {
			operationId,
			code: error.code,
			message: error.message,
			retryable: isRetryableOrchestrationCode(error.code),
			details: error.details,
		};
	}
	if (error && typeof error === "object") {
		const record = error as Record<string, unknown>;
		const code = typeof record.code === "string" ? record.code : ORCHESTRATION_ERROR_CODES.COMMAND_FAILED;
		const message = typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : String(error);
		const details = record.details && typeof record.details === "object" && !Array.isArray(record.details) ? record.details as JsonRecord : {};
		return { operationId, code, message, retryable: isRetryableOrchestrationCode(code), details };
	}
	return { operationId, code: ORCHESTRATION_ERROR_CODES.COMMAND_FAILED, message: String(error), retryable: false };
}

export function invalidDesired(message: string, details: JsonRecord = {}): BrowserOrchestrationError {
	return new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.INVALID_DESIRED, message, details, { retryable: false });
}

export function targetConflict(message: string, details: JsonRecord = {}): BrowserOrchestrationError {
	return new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.TARGET_CONFLICT, message, details, { retryable: false });
}

export function browserNotFound(message: string, details: JsonRecord = {}): BrowserOrchestrationError {
	return new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.BROWSER_NOT_FOUND, message, details, { retryable: true });
}

export function orchestrationLocked(message: string, details: JsonRecord = {}): BrowserOrchestrationError {
	return new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.LOCKED, message, details, { retryable: true });
}

export function orchestrationTimeout(message: string, details: JsonRecord = {}): BrowserOrchestrationError {
	return new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.TIMEOUT, message, details, { retryable: true });
}
