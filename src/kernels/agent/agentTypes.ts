/**
 * Pure Agent Interaction Plane types (schema-independent).
 * No browser/Node/runtime dependencies.
 */

import type { BrowserOperationStatus } from "../session/browserOperation.js";
import type { PageIdentity, PageReanchorReason } from "../session/pageIdentity.js";

export const AGENT_VIEW_SCHEMA = "browser-agent-view/v1" as const;
export const AGENT_TURN_SCHEMA = "browser-agent-turn/v1" as const;
export const AGENT_READ_SCHEMA = "browser-agent-read/v1" as const;

export type AgentContextState =
	| "anchored"
	| "transitioning"
	| "needs_reanchor"
	| "ambiguous"
	| "expired";

export type AgentSemanticActionKind =
	| "activate"
	| "fill"
	| "press"
	| "select"
	| "scroll"
	| "drag"
	| "submit"
	| "navigate"
	| "history";

export type AgentCandidateAction =
	| "activate"
	| "fill"
	| "press"
	| "select"
	| "scroll"
	| "drag"
	| "submit";

export type AgentRisk = "normal" | "sensitive" | "irreversible";

export type AgentFailureCode =
	| "CONTEXT_EXPIRED"
	| "CONTEXT_OWNER_MISMATCH"
	| "CONTEXT_BUSY"
	| "CONTEXT_REVISION_MISMATCH"
	| "REF_STALE"
	| "IDENTITY_CHANGED"
	| "TARGET_AMBIGUOUS"
	| "ACTION_UNSUPPORTED_SURFACE"
	| "ACTION_NOT_ALLOWED"
	| "CONFIRMATION_REQUIRED"
	| "CONFIRMATION_MISMATCH"
	| "CONFIRMATION_CONSUMED"
	| "RUNTIME_NOT_READY"
	| "VIEW_UNAVAILABLE"
	| "READ_UNAVAILABLE"
	| "INVALID_AGENT_REQUEST";

export interface BrowserAgentContextSummary {
	contextRef: string;
	contextRevision: number;
	state: AgentContextState;
	pageChanged: boolean;
	reanchorReason?: PageReanchorReason;
}

export interface AgentCandidate {
	ref: string;
	role: string;
	label?: string;
	description?: string;
	state?: {
		visible: boolean;
		enabled?: boolean;
		editable?: boolean;
		selected?: boolean;
		expanded?: boolean;
	};
	actions: AgentCandidateAction[];
	risk?: AgentRisk;
}

export interface AgentTargetCandidate {
	tabRef: string;
	title?: string;
	url?: string;
	active: boolean;
	current: boolean;
	actions: ["view"];
}

export interface AgentNotice {
	kind: "dialog" | "consent" | "error" | "warning" | "validation" | "target_change";
	message: string;
	candidateRefs?: string[];
}

export interface AgentChangeSummary {
	kind: "none" | "same_document" | "document" | "target" | "unknown";
	summary?: string;
	addedCandidateRefs?: string[];
	changedCandidateRefs?: string[];
}

export interface AgentReadOption {
	readRef: string;
	kind: "content" | "collection" | "diagnostics" | "operation_result";
	description: string;
	estimatedItems?: number;
}

export interface AgentTraceDescriptor {
	available: boolean;
	traceRef?: string;
	unavailableReason?: string;
}

export interface AgentCostLimits {
	cost: { chars: number; bytes: number; estimatedTokens: number };
	truncated?: boolean;
}

export type AgentDecision =
	| { kind: "choose_action"; candidateRefs: string[] }
	| { kind: "provide_input"; candidateRef: string; inputKind: "text" | "choice" | "file" }
	| { kind: "confirm"; confirmationRef: string; reason: string }
	| { kind: "inspect"; readRefs: string[] }
	| { kind: "assess_goal" }
	| { kind: "blocked"; reason: string };

export type AgentAutomaticAction =
	| { kind: "ensure_runtime"; result: "reused" | "started" | "reconnected" }
	| { kind: "reattach_cdp" }
	| { kind: "rebind_target"; reason: string }
	| { kind: "reanchor_page"; reason: string }
	| { kind: "relocate_ref"; ref: string }
	| { kind: "retry_read"; attempt: number }
	| { kind: "expand_verified_evidence"; readRef: string };

export interface AgentOutcome {
	classification: "success" | "inconclusive" | "failure";
	status: BrowserOperationStatus;
	completionVerified: boolean;
	ok: boolean;
	completionSource?: string;
	code?: string;
	replay: "not_needed" | "do_not_retry";
	automaticActionsTaken: AgentAutomaticAction[];
}

export interface AgentViewV1 {
	schema: typeof AGENT_VIEW_SCHEMA;
	context: BrowserAgentContextSummary;
	page: {
		title?: string;
		url?: string;
		readyState?: string;
		changed: boolean;
	};
	summary: string;
	notices: AgentNotice[];
	candidates: AgentCandidate[];
	targets?: AgentTargetCandidate[];
	changes?: AgentChangeSummary;
	reads?: AgentReadOption[];
	decision: AgentDecision;
	limits: AgentCostLimits;
	trace: AgentTraceDescriptor;
}

export interface BrowserAgentTurnV1 {
	schema: typeof AGENT_TURN_SCHEMA;
	context: BrowserAgentContextSummary;
	outcome: AgentOutcome;
	viewStatus: "available" | "unavailable";
	view?: AgentViewV1;
	viewUnavailableReason?: string;
	decision: AgentDecision;
	trace: AgentTraceDescriptor;
}

export interface BrowserAgentReadV1 {
	schema: typeof AGENT_READ_SCHEMA;
	context: BrowserAgentContextSummary;
	readRef: string;
	kind: "content" | "collection" | "diagnostics" | "operation_result";
	summary?: string;
	data: unknown;
	page?: {
		offset: number;
		returned: number;
		total?: number;
		hasMore: boolean;
	};
	limits: AgentCostLimits;
	trace: AgentTraceDescriptor;
}

export type SemanticActionV1 =
	| { kind: "activate"; ref: string }
	| { kind: "fill"; ref: string; value: string; replace?: boolean }
	| { kind: "press"; ref?: string; key: string; modifiers?: string[] }
	| { kind: "select"; ref: string; value: string }
	| { kind: "scroll"; ref?: string; direction: "up" | "down" | "left" | "right"; amount?: "small" | "page" }
	| { kind: "drag"; fromRef: string; toRef: string }
	| { kind: "submit"; ref: string }
	| { kind: "navigate"; url: string; disposition?: "current" | "new_tab" }
	| { kind: "history"; direction: "back" | "forward" | "reload" };

/** Published agent-profile write kinds for v1 preview (select/drag/submit deferred). */
export const AGENT_PUBLISHED_WRITE_KINDS = [
	"activate",
	"fill",
	"press",
	"scroll",
	"navigate",
	"history",
] as const satisfies readonly AgentSemanticActionKind[];

export type AgentPublishedWriteKind = (typeof AGENT_PUBLISHED_WRITE_KINDS)[number];

export interface AgentCandidateBinding {
	ref: string;
	contextRevision: number;
	pageIdentity: PageIdentity;
	resourceRef: string;
	role: string;
	label?: string;
	allowedActions: AgentCandidateAction[];
	createdAt: number;
}

export interface AgentTargetBinding {
	tabRef: string;
	targetLineageRef: string;
	tabId?: number;
	title?: string;
	url?: string;
	createdAt: number;
}

export interface AgentReadBinding {
	readRef: string;
	contextRevision: number;
	pageIdentity?: PageIdentity;
	source: "observation_frontier" | "operation_artifact" | "diagnostics" | "content";
	kind: AgentReadOption["kind"];
	descriptor: {
		savedPath?: string;
		jsonPath?: string;
		inlineData?: unknown;
		description: string;
	};
	createdAt: number;
	expiresAt: number;
}

export interface AgentContextRecord {
	id: string;
	owner: string;
	revision: number;
	state: AgentContextState;
	pageIdentity?: PageIdentity;
	targetLineageRef?: string;
	observationId?: string;
	snapshotId?: string;
	baselineSnapshotId?: string;
	candidateBindings: Map<string, AgentCandidateBinding>;
	targetBindings: Map<string, AgentTargetBinding>;
	readBindings: Map<string, AgentReadBinding>;
	activeOperationId?: string;
	lastTraceRef?: string;
	createdAt: number;
	updatedAt: number;
	idleExpiresAt: number;
	absoluteExpiresAt: number;
}

export const AGENT_CONTEXT_BOUNDS = {
	maxContexts: 128,
	maxContextsPerOwner: 16,
	idleTtlMs: 10 * 60_000,
	absoluteTtlMs: 60 * 60_000,
	maxCandidateBindings: 128,
	maxTargetBindings: 64,
	maxReadBindings: 64,
	maxRetainedTraces: 32,
	l0MaxCandidates: 12,
	l0MaxChars: 6_000,
	l0MaxNotices: 6,
	l0MaxReads: 6,
	l1MaxCandidates: 32,
	l1MaxChars: 16_000,
} as const;
