import type { AbmlError, AbmlErrorCategory, AbmlErrorCode, AbmlRecovery, ActionabilityReport, VerificationResult } from "./types.js";
import { failedChecksFromReport, actionabilityFailureReason } from "./actionabilityModel.js";
import { normalizeError } from "../../utils/errors.js";
import { redactSensitiveText, redactSensitiveValue } from "../../utils/redaction.js";

export type AbmlNormalizeErrorOptions = {
	message?: string;
	evidence?: Record<string, unknown>;
	candidates?: AbmlError["candidates"];
	actionability?: ActionabilityReport;
	verification?: VerificationResult;
};

const DEFAULT_RECOVERIES: Record<AbmlErrorCode, AbmlRecovery> = {
	REF_NOT_FOUND: { retryable: true, kind: "read-refresh", nextActions: ["refresh the read target and mint a new ref"] },
	REF_STALE: { retryable: true, kind: "read-refresh", nextActions: ["re-read the page and resolve a fresh ref"] },
	REF_AMBIGUOUS: { retryable: true, kind: "narrow-ref", nextActions: ["add more locators or narrow by role/name/text"] },
	REF_SCOPE_VIOLATION: { retryable: true, kind: "switch-session-or-tab", nextActions: ["switch to the owning browser session/tab or re-capture in the current scope"] },
	HANDLE_NOT_FOUND: { retryable: true, kind: "recapture-evidence", nextActions: ["recreate the source evidence handle"] },
	HANDLE_EXPIRED: { retryable: true, kind: "recapture-evidence", nextActions: ["recreate the expired handle or snapshot"] },
	HANDLE_KIND_MISMATCH: { retryable: false, kind: "manual-review", nextActions: ["use a handle of the expected kind"] },
	HANDLE_ETAG_MISMATCH: { retryable: true, kind: "recapture-evidence", nextActions: ["refresh the underlying artifact and obtain a new handle"] },
	PRIVACY_BLOCKED: { retryable: false, kind: "manual-review", nextActions: ["request explicit same-session sensitive access or use redacted output"] },
	ACTIONABILITY_TIMEOUT: { retryable: true, kind: "wait-and-retry", nextActions: ["wait for visibility/stability and retry"] },
	TARGET_OCCLUDED: { retryable: true, kind: "scroll-or-dismiss-overlay", nextActions: ["scroll or dismiss the overlay, then retry"] },
	TARGET_DISABLED: { retryable: true, kind: "wait-and-retry", nextActions: ["wait until the target becomes enabled"] },
	TARGET_NOT_EDITABLE: { retryable: false, kind: "manual-review", nextActions: ["use an editable target or focus the editor first"] },
	BACKEND_UNAVAILABLE: { retryable: true, kind: "wait-and-retry", nextActions: ["retry with a healthy backend or refresh the browser state"] },
	CROSS_ORIGIN_BLOCKED: { retryable: false, kind: "use-visual-floor", nextActions: ["switch to a reachable frame or use a visual fallback if allowed"] },
	VERIFY_FAILED: { retryable: true, kind: "manual-review", nextActions: ["inspect observed state and retry with tighter expectations"] },
	VERIFY_INCONCLUSIVE: { retryable: true, kind: "manual-review", nextActions: ["inspect evidence and perform a follow-up read to confirm state"] },
	TARGET_TRANSACTION_CONFLICT: { retryable: true, kind: "wait-and-retry", nextActions: ["finish the current target operation before using another browser tab"] },
	INVALID_INPUT: { retryable: false, kind: "manual-review", nextActions: ["fix invalid selectors/params before retrying"] },
	INTERNAL_ERROR: { retryable: false, kind: "none", nextActions: ["inspect the cause and runtime diagnostics"] },
};

const CODE_CATEGORY: Record<AbmlErrorCode, AbmlErrorCategory> = {
	REF_NOT_FOUND: "ref",
	REF_STALE: "ref",
	REF_AMBIGUOUS: "ref",
	REF_SCOPE_VIOLATION: "session",
	HANDLE_NOT_FOUND: "ref",
	HANDLE_EXPIRED: "ref",
	HANDLE_KIND_MISMATCH: "input",
	HANDLE_ETAG_MISMATCH: "ref",
	PRIVACY_BLOCKED: "privacy",
	ACTIONABILITY_TIMEOUT: "actionability",
	TARGET_OCCLUDED: "actionability",
	TARGET_DISABLED: "actionability",
	TARGET_NOT_EDITABLE: "actionability",
	BACKEND_UNAVAILABLE: "backend",
	CROSS_ORIGIN_BLOCKED: "backend",
	VERIFY_FAILED: "verification",
	VERIFY_INCONCLUSIVE: "verification",
	TARGET_TRANSACTION_CONFLICT: "session",
	INVALID_INPUT: "input",
	INTERNAL_ERROR: "internal",
};

const CODE_TO_ABML: Partial<Record<string, AbmlErrorCode>> = {
	HANDLE_NOT_FOUND: "HANDLE_NOT_FOUND",
	HANDLE_EXPIRED: "HANDLE_EXPIRED",
	HANDLE_KIND_MISMATCH: "HANDLE_KIND_MISMATCH",
	HANDLE_ETAG_MISMATCH: "HANDLE_ETAG_MISMATCH",
	TARGET_TRANSACTION_CONFLICT: "TARGET_TRANSACTION_CONFLICT",
	NO_SESSION: "REF_SCOPE_VIOLATION",
	SESSION_NOT_FOUND: "REF_SCOPE_VIOLATION",
	SELECTOR_NOT_FOUND: "REF_STALE",
	INVALID_SELECTOR: "INVALID_INPUT",
	CROSS_ORIGIN_IFRAME: "CROSS_ORIGIN_BLOCKED",
	SELECTOR_TIMEOUT: "ACTIONABILITY_TIMEOUT",
	TIMEOUT: "ACTIONABILITY_TIMEOUT",
};

function mapToAbmlCode(code: string): AbmlErrorCode {
	if ((code as AbmlErrorCode) in DEFAULT_RECOVERIES) return code as AbmlErrorCode;
	if (CODE_TO_ABML[code]) return CODE_TO_ABML[code]!;
	return "INTERNAL_ERROR";
}

function defaultMessageForCode(code: AbmlErrorCode): string {
	switch (code) {
		case "REF_NOT_FOUND": return "ABML ref was not found.";
		case "REF_STALE": return "ABML ref is stale.";
		case "REF_AMBIGUOUS": return "ABML ref resolved ambiguously.";
		case "REF_SCOPE_VIOLATION": return "ABML ref scope does not match the current session/tab/origin.";
		case "HANDLE_NOT_FOUND": return "Referenced handle was not found.";
		case "HANDLE_EXPIRED": return "Referenced handle expired.";
		case "HANDLE_KIND_MISMATCH": return "Referenced handle kind does not match the expected kind.";
		case "HANDLE_ETAG_MISMATCH": return "Referenced handle etag does not match the current artifact.";
		case "PRIVACY_BLOCKED": return "Requested access is blocked by ABML privacy policy.";
		case "ACTIONABILITY_TIMEOUT": return "Target did not satisfy actionability predicates before timeout.";
		case "TARGET_OCCLUDED": return "Target is occluded and cannot receive events.";
		case "TARGET_DISABLED": return "Target is disabled.";
		case "TARGET_NOT_EDITABLE": return "Target is not editable.";
		case "BACKEND_UNAVAILABLE": return "Required backend is unavailable.";
		case "CROSS_ORIGIN_BLOCKED": return "Requested operation is blocked by cross-origin frame boundaries.";
		case "VERIFY_FAILED": return "Post-action verification failed.";
		case "VERIFY_INCONCLUSIVE": return "Post-action verification was inconclusive.";
		case "TARGET_TRANSACTION_CONFLICT": return "The active target transaction cannot acquire another browser tab.";
		case "INVALID_INPUT": return "Input is invalid.";
		case "INTERNAL_ERROR": return "Unexpected ABML internal error.";
	}
}

export function normalizeAbmlError(error: unknown, options: AbmlNormalizeErrorOptions = {}): AbmlError {
	const normalized = normalizeError(error);
	const code = mapToAbmlCode(normalized.code);
	// When an actionability report is attached and has failures, surface the failed
	// predicate names and a human-readable reason in evidence so agents can react
	// (scroll, dismiss overlay, wait for enable, etc.) without parsing the full report.
	const actionabilityEvidence = options.actionability && !options.actionability.ok
		? actionabilityDiagnostics(options.actionability)
		: undefined;
	const mergedEvidence = actionabilityEvidence
		? { ...actionabilityEvidence, ...(options.evidence || {}) }
		: options.evidence;
	return {
		code,
		category: CODE_CATEGORY[code],
		message: redactSensitiveText(options.message || normalized.message || defaultMessageForCode(code)),
		recovery: DEFAULT_RECOVERIES[code],
		...(mergedEvidence ? { evidence: redactSensitiveValue(mergedEvidence) as Record<string, unknown> } : {}),
		...(options.candidates?.length ? { candidates: redactSensitiveValue(options.candidates) as AbmlError["candidates"] } : {}),
		...(options.actionability ? { actionability: redactSensitiveValue(options.actionability) as ActionabilityReport } : {}),
		...(options.verification ? { verification: redactSensitiveValue(options.verification) as VerificationResult } : {}),
		cause: {
			source: normalized.taxonomy.source,
			code: normalized.code,
			message: redactSensitiveText(normalized.message),
			details: redactSensitiveValue(normalized.details) as Record<string, unknown>,
		},
	};
}

function actionabilityDiagnostics(report: ActionabilityReport): Record<string, unknown> | undefined {
	const failedChecks = failedChecksFromReport(report);
	if (!failedChecks.length) return undefined;
	const reason = actionabilityFailureReason(report);
	return {
		failedChecks,
		...(reason ? { reason } : {}),
	};
}
