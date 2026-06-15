export const TEMPORAL_VERDICT_STATUSES = ["fresh", "possibly_stale", "stale", "unknown"] as const;
export type TemporalVerdictStatus = (typeof TEMPORAL_VERDICT_STATUSES)[number];

export const TEMPORAL_CONFIDENCES = ["mechanical", "bounded", "partial", "lost"] as const;
export type TemporalConfidence = (typeof TEMPORAL_CONFIDENCES)[number];

export const TEMPORAL_SOURCES = [
	"driver_snapshot",
	"observation_snapshot",
	"ref_descriptor",
	"execute_effect",
	"wait_supervisor",
	"wait_diagnose",
	"page_signal",
	"cdp_event",
	"poll_fallback",
] as const;
export type TemporalSource = (typeof TEMPORAL_SOURCES)[number];

export const TEMPORAL_FRONTIER_NEXT = ["reuse_target", "retry_same_wait", "reobserve", "diagnose", "fail_closed"] as const;
export type TemporalFrontierNext = (typeof TEMPORAL_FRONTIER_NEXT)[number];

export const TEMPORAL_REASONS = [
	"same_target",
	"same_page_epoch",
	"same_wait_history",
	"target_possibly_stale",
	"target_stale_before_dispatch",
	"target_region_dirty",
	"url_changed",
	"selection_version_changed",
	"tab_replaced",
	"tab_disconnected",
	"extension_unavailable",
	"queue_saturated",
	"queue_delay_budget_exceeded",
	"no_ack",
	"acked_bridge_timeout",
	"lease_timeout",
	"client_disconnected",
	"worker_restarted_history_lost",
	"url_mismatch",
	"load_state_unreached",
	"selector_missing",
	"selector_unstable",
	"background_throttling_suspected",
	"network_active",
	"signal_unavailable",
	"underconstrained_wait",
	"late_success_after_deadline",
	"unknown_due_to_history_loss",
	"unknown_due_to_clock_domain",
	"unknown_due_to_missing_anchor",
] as const;
export type TemporalReason = (typeof TEMPORAL_REASONS)[number];

export const TEMPORAL_PLAN_ACTIONS = ["none", "immediate_probe", "wait", "diagnose", "quiet_read", "reobserve_required", "fail_closed"] as const;
export type TemporalPlanAction = (typeof TEMPORAL_PLAN_ACTIONS)[number];

export const TEMPORAL_REASON_MODEL_CAP = 3;

export type TemporalClockDomain = "driver_wall" | "bridge_worker_wall" | "page_wall";

export type TemporalStamp = {
	version: "temporal-stamp/v1";
	browserSessionId?: string;
	tabId?: number;
	targetRef?: string;
	tabHandle?: string;
	browserId?: string;
	selectionVersion?: number;
	workerBootId?: string;
	pageEpoch?: string;
	url?: string;
	readyState?: string;
	changeSeq?: number;
	dirtySinceSeq?: number;
	networkSeq?: number;
	hookSeq?: number;
	capturedAtMs: number;
	clockDomain: TemporalClockDomain;
	sequence?: number;
};

export type TemporalAnchorSource = "observe" | "execute" | "wait" | "ref" | "network" | "hook";

export type TemporalLocator =
	| { by: "backendNodeId"; value: number }
	| { by: "axNodeId"; value: string }
	| { by: "css"; value: string }
	| { by: "textAnchor"; value: string }
	| { by: "point"; x: number; y: number };

export type TemporalAnchor = {
	version: "temporal-anchor/v1";
	source: TemporalAnchorSource;
	operationId?: string;
	snapshotId?: string;
	observationId?: string;
	refId?: string;
	stamp: TemporalStamp;
	evidence?: {
		locators?: TemporalLocator[];
		cssRoots?: string[];
		selector?: string;
		waitId?: string;
		requestId?: string;
	};
};

export type TemporalVerdict =
	| { status: "fresh"; confidence: "mechanical"; reasons: TemporalReason[] }
	| { status: "possibly_stale"; confidence: "bounded"; reasons: TemporalReason[] }
	| { status: "stale"; confidence: "mechanical"; reasons: TemporalReason[] }
	| { status: "unknown"; confidence: "lost" | "partial"; reasons: TemporalReason[] };

export type TemporalFrontier = {
	next: TemporalFrontierNext;
	handle?: string;
};

export type TemporalDecision = {
	verdict: TemporalVerdict;
	frontier: TemporalFrontier;
	source: TemporalSource;
};

export type TemporalCost = {
	wallMs: number;
	bridgeRoundTrips: number;
	expectedToolCalls: number;
	tokenChars: number;
	confidenceLoss: 0 | 1 | 2 | 3;
};

export type TemporalPlan = {
	action: TemporalPlanAction;
	budgetMs: number;
	reason: TemporalReason;
	expectedEvidence: TemporalSource[];
	frontier?: TemporalFrontier;
	verdict?: TemporalVerdict;
};

export type TemporalObservation = {
	anchor?: TemporalAnchor;
	current?: TemporalStamp;
	source: TemporalSource;
	rawSignals?: TemporalReason[];
};

export type TemporalProfileSample = {
	operationId?: string;
	tool: string;
	command?: string;
	target?: { browserSessionId?: string; tabId?: number; targetRef?: string };
	deadlineMs?: number;
	elapsedMs: number;
	bridgeRoundTrips?: number;
	queueDepthAtEnqueue?: number;
	queueDepthAtStart?: number;
	queueDelayMs?: number;
	waitAttempts?: number;
	workerRestarts?: number;
	historyLost?: boolean;
	rawSignals?: string[];
	verdict?: TemporalVerdictStatus;
	reasons?: TemporalReason[];
	recovery?: TemporalFrontierNext;
};
