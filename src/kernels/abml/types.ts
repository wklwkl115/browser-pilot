import type { RefDescriptor as SharedRefDescriptor, RefGeometry as SharedRefGeometry, RefKind as SharedRefKind, RefLocator } from "../refs/types.js";

export type Locator = RefLocator;
export type RefKind = SharedRefKind;
export type RefGeometry = SharedRefGeometry;
export type RefDescriptor = SharedRefDescriptor;

export type CandidateSource = "dom" | "ax" | "vision" | "region" | "network" | "hook" | "evidence";

export type CandidateSummary = {
	candidateId: string;
	locatorHits: Array<{ by: Locator["by"]; weight: number }>;
	score: number;
	role?: string;
	name?: string;
	source?: CandidateSource;
	geometry?: RefGeometry;
	documentOrder?: number;
};

export type ActionabilityPredicate =
	| "unique"
	| "attached"
	| "visible"
	| "stable"
	| "enabled"
	| "editable"
	| "inViewport"
	| "scrollable"
	| "receivesEvents"
	| "notOccluded";

export type ActionabilityBlockerCode =
	| "not_unique"
	| "detached"
	| "not_visible"
	| "not_stable"
	| "disabled"
	| "not_editable"
	| "outside_viewport"
	| "not_scrollable"
	| "not_receiving_events"
	| "occluded";

export type ActionabilitySpec = {
	timeoutMs: number;
	pollMs: number;
	stableWindowMs: number;
	stableEpsilonPx: number;
	required: ActionabilityPredicate[];
};

export type ActionabilityReport = {
	ok: boolean;
	spec: ActionabilitySpec;
	elapsedMs: number;
	attempts: number;
	checks: Partial<Record<ActionabilityPredicate, boolean>>;
	blockers: Array<{ code: ActionabilityBlockerCode; message: string; evidence?: Record<string, unknown> }>;
	target?: CandidateSummary;
	targets?: Record<string, CandidateSummary>;
	geometry?: { before?: unknown; after?: unknown; final?: unknown };
	hitTest?: { x: number; y: number; topNode?: string; matchedTarget: boolean };
};

export type VerificationStatus = "verified" | "unmet" | "inconclusive";

export type VerificationResult = {
	status: VerificationStatus;
	verb: string;
	expected?: Record<string, unknown>;
	observed: Record<string, unknown>;
	evidence: Array<{ kind: string; summary: string; ref?: string; data?: Record<string, unknown> }>;
	elapsedMs: number;
};

export type AbmlErrorCategory =
	| "ref"
	| "actionability"
	| "backend"
	| "verification"
	| "privacy"
	| "session"
	| "input"
	| "internal";

export type AbmlErrorCode =
	| "REF_NOT_FOUND"
	| "REF_STALE"
	| "REF_AMBIGUOUS"
	| "REF_SCOPE_VIOLATION"
	| "HANDLE_NOT_FOUND"
	| "HANDLE_EXPIRED"
	| "HANDLE_KIND_MISMATCH"
	| "HANDLE_ETAG_MISMATCH"
	| "PRIVACY_BLOCKED"
	| "ACTIONABILITY_TIMEOUT"
	| "TARGET_OCCLUDED"
	| "TARGET_DISABLED"
	| "TARGET_NOT_EDITABLE"
	| "BACKEND_UNAVAILABLE"
	| "CROSS_ORIGIN_BLOCKED"
	| "VERIFY_FAILED"
	| "VERIFY_INCONCLUSIVE"
	| "TARGET_TRANSACTION_CONFLICT"
	| "INVALID_INPUT"
	| "INTERNAL_ERROR";

export type AbmlRecovery = {
	retryable: boolean;
	kind:
		| "read-refresh"
		| "narrow-ref"
		| "wait-and-retry"
		| "scroll-or-dismiss-overlay"
		| "switch-session-or-tab"
		| "recapture-evidence"
		| "use-visual-floor"
		| "manual-review"
		| "none";
	nextActions?: string[];
};

export type AbmlError = {
	code: AbmlErrorCode;
	category: AbmlErrorCategory;
	message: string;
	recovery: AbmlRecovery;
	evidence?: Record<string, unknown>;
	candidates?: CandidateSummary[];
	actionability?: ActionabilityReport;
	verification?: VerificationResult;
	cause?: { source: string; code?: string; message?: string; details?: Record<string, unknown> };
};

export type CaptureState = "active" | "stopped" | "expired" | "lost";

export type CaptureRef = RefDescriptor & {
	kind: "signal";
	streamState: {
		state: CaptureState;
		startedAt: number;
		stoppedAt?: number;
		expiresAt: number;
		lastSeq?: number;
	};
};
