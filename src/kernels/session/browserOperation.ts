export type BrowserOperationStatus =
	| "completed"
	| "effect_observed"
	| "no_effect"
	| "stalled"
	| "ambiguous"
	| "target_lost"
	| "failed"
	| "deadline";

export type BrowserOperationClassification = "success" | "inconclusive" | "failure";

export type BrowserOperationCode =
	| "OPERATION_EFFECT_UNVERIFIED"
	| "OPERATION_AMBIGUOUS"
	| "OPERATION_TARGET_LOST"
	| "OPERATION_DEADLINE"
	| "OPERATION_NO_EFFECT"
	| "OPERATION_STALLED"
	| "OPERATION_FAILED";

export const BROWSER_OPERATION_SCHEMA = "browser-operation/v2" as const;

/**
 * Stable public outcome mapping. This object is also part of the daemon command
 * contract identity, so keep it limited to behavioral fields and deterministic
 * data (no descriptions, timestamps, or build-local values).
 */
export const BROWSER_OPERATION_OUTCOME_CONTRACT = {
	completed: { classification: "success", completionVerified: true, ok: true },
	effect_observed: { classification: "inconclusive", completionVerified: false, ok: false, code: "OPERATION_EFFECT_UNVERIFIED" },
	ambiguous: { classification: "inconclusive", completionVerified: false, ok: false, code: "OPERATION_AMBIGUOUS" },
	target_lost: { classification: "inconclusive", completionVerified: false, ok: false, code: "OPERATION_TARGET_LOST" },
	deadline: { classification: "inconclusive", completionVerified: false, ok: false, code: "OPERATION_DEADLINE" },
	no_effect: { classification: "failure", completionVerified: false, ok: false, code: "OPERATION_NO_EFFECT" },
	stalled: { classification: "failure", completionVerified: false, ok: false, code: "OPERATION_STALLED" },
	failed: { classification: "failure", completionVerified: false, ok: false, code: "OPERATION_FAILED" },
} as const satisfies Record<BrowserOperationStatus, {
	classification: BrowserOperationClassification;
	completionVerified: boolean;
	ok: boolean;
	code?: BrowserOperationCode;
}>;

export type BrowserOperationOutcomeFields = {
	classification: BrowserOperationClassification;
	completionVerified: boolean;
	ok: boolean;
	code?: BrowserOperationCode;
};

export function classifyBrowserOperationStatus(status: BrowserOperationStatus): BrowserOperationOutcomeFields {
	return { ...BROWSER_OPERATION_OUTCOME_CONTRACT[status] };
}

export type BrowserOperationEnvelopeClassification =
	| { kind: "not_operation" }
	| { kind: "malformed"; code: "OPERATION_PROTOCOL_ERROR"; message: string }
	| { kind: "operation"; status: BrowserOperationStatus; outcome: BrowserOperationOutcomeFields };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBrowserOperationStatus(value: unknown): value is BrowserOperationStatus {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(BROWSER_OPERATION_OUTCOME_CONTRACT, value);
}

/** Pure classifier shared by JSON and TTY rendering. */
export function classifyBrowserOperationEnvelope(value: unknown): BrowserOperationEnvelopeClassification {
	if (!isObjectRecord(value) || value.schema !== BROWSER_OPERATION_SCHEMA) return { kind: "not_operation" };
	if (!isBrowserOperationStatus(value.status)) {
		return { kind: "malformed", code: "OPERATION_PROTOCOL_ERROR", message: "browser-operation/v2 has an invalid or missing status" };
	}
	const expected = classifyBrowserOperationStatus(value.status);
	if (value.classification !== expected.classification
		|| value.completionVerified !== expected.completionVerified
		|| value.ok !== expected.ok
		|| (expected.code === undefined ? value.code !== undefined : value.code !== expected.code)) {
		return { kind: "malformed", code: "OPERATION_PROTOCOL_ERROR", message: `browser-operation/v2 outcome fields do not match status ${value.status}` };
	}
	if (!Object.prototype.hasOwnProperty.call(value, "continuation")) {
		return { kind: "malformed", code: "OPERATION_PROTOCOL_ERROR", message: "browser-operation/v2 is missing continuation" };
	}
	return { kind: "operation", status: value.status, outcome: expected };
}

export type BrowserOperationTarget = {
	browserSessionId?: string;
	targetRef?: string;
	tabId?: number;
	generation?: number;
	url?: string;
	scriptable?: boolean;
	cdpAvailable?: boolean;
};

export type BrowserOperationSignals = {
	navigation?: string;
	mutationCount?: number;
	networkStarted?: number;
	networkCompleted?: number;
	networkPending?: number;
	dialogs?: number;
	newTabs?: number;
	downloadsStarted?: number;
	downloadsCompleted?: number;
	targetChanged?: boolean;
};

export type BrowserOperationEvent = {
	operationId: string;
	sequence: number;
	type: string;
	timestamp: number;
	targetRef?: string;
	tabId?: number;
	generation?: number;
	progress?: boolean;
	late?: boolean;
	data?: Record<string, unknown>;
};

export type BrowserOperationLateEffect = {
	type: "late_effect";
	operationId: string;
	commandName: string;
	terminalStatus: BrowserOperationStatus;
	event: BrowserOperationEvent;
};

export type BrowserOperationOutcome = {
	schema: typeof BROWSER_OPERATION_SCHEMA;
	operationId: string;
	commandName: string;
	status: BrowserOperationStatus;
	classification: BrowserOperationClassification;
	completionVerified: boolean;
	ok: boolean;
	code?: BrowserOperationCode;
	target: BrowserOperationTarget;
	dispatch: {
		acknowledged: boolean;
		started: boolean;
		finished: boolean;
		startedAt: number;
		finishedAt?: number;
	};
	signals: BrowserOperationSignals;
	completion?: {
		source: string;
		evidence: Record<string, unknown>;
	};
	pageEffect?: {
		appeared?: unknown[];
		disappeared?: unknown[];
		changed?: unknown[];
		newActionables?: unknown[];
	};
	diagnostics?: unknown[];
	lateEffects?: BrowserOperationLateEffect[];
};

/** Public terminal envelope after the command result owner attaches continuation. */
export type BrowserOperationResultV2 = BrowserOperationOutcome & {
	continuation: unknown;
};
