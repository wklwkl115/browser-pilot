import type { BrowserBridgeExecutionResult, BrowserBridgeTargetInfo, BrowserRuntimeCommand } from "./BrowserRuntimeTypes.js";

export type CommandPerceptionLedgerKey = {
	browserSessionId?: string;
	tabId?: number;
	navigationEpoch?: string;
};

export type CommandPerceptionObjectiveKey = {
	tabId?: number;
	navigationEpoch?: string;
};

export type CommandPerceptionLedgerFactState = {
	versionStamp: string;
	stableStamp?: string;
	lastShownGranularity: "full" | "compact" | "line" | "ref";
};

export type CommandPerceptionLedgerFrame = {
	key: CommandPerceptionLedgerKey;
	snapshotId: string;
	capturedAt: number;
	facts: Record<string, CommandPerceptionLedgerFactState>;
	pageFingerprint?: {
		changeSeq: number;
		url?: string;
		title?: string;
		readyState?: string;
		visibleCount?: number;
		interactiveCount?: number;
		capturedAt?: number;
		dirty?: {
			roots: string[];
			overflow: boolean;
			sinceSeq?: number;
		};
	};
	renderCache?: {
		mode: string;
		detailLevel: string;
		maxChars: number;
		paramsSignature: string;
		renderedAt: number;
	};
	allocation?: {
		budgetUsedRatio: number;
		omittedCount: number;
	};
	objective?: {
		key: CommandPerceptionObjectiveKey;
		snapshotId: string;
		shared: boolean;
	};
};

export type CommandPerceptionTraceTerm = {
	term: string;
	kind: string;
	weight?: number;
	at: number;
	seq: number;
};

export type CommandPerceptionTraceSnapshot = {
	terms: CommandPerceptionTraceTerm[];
	latestSeq: number;
};

export type CommandTemporalVerdictStatus = "fresh" | "possibly_stale" | "stale" | "unknown";
export type CommandTemporalConfidence = "mechanical" | "bounded" | "partial" | "lost";
export type CommandTemporalReason =
	| "same_target"
	| "same_page_epoch"
	| "same_wait_history"
	| "target_possibly_stale"
	| "target_stale_before_dispatch"
	| "target_region_dirty"
	| "url_changed"
	| "selection_version_changed"
	| "tab_replaced"
	| "tab_disconnected"
	| "extension_unavailable"
	| "queue_saturated"
	| "queue_delay_budget_exceeded"
	| "no_ack"
	| "acked_bridge_timeout"
	| "lease_timeout"
	| "client_disconnected"
	| "worker_restarted_history_lost"
	| "url_mismatch"
	| "load_state_unreached"
	| "selector_missing"
	| "selector_unstable"
	| "background_throttling_suspected"
	| "network_active"
	| "signal_unavailable"
	| "underconstrained_wait"
	| "late_success_after_deadline"
	| "unknown_due_to_history_loss"
	| "unknown_due_to_clock_domain"
	| "unknown_due_to_missing_anchor";
export type CommandTemporalFrontierNext = "reuse_target" | "retry_same_wait" | "reobserve" | "diagnose" | "fail_closed";

export type CommandTemporalVerdict = {
	status: CommandTemporalVerdictStatus;
	confidence: CommandTemporalConfidence;
	reasons: CommandTemporalReason[];
};

export type CommandTemporalDecision = {
	verdict: CommandTemporalVerdict;
	frontier: {
		next: CommandTemporalFrontierNext;
		handle?: string;
	};
	source?: string;
};

export type CommandTemporalProfileSample = {
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
	verdict?: CommandTemporalVerdictStatus;
	reasons?: CommandTemporalReason[];
	recovery?: CommandTemporalFrontierNext;
};

export type CommandActiveOperationInfo = {
	operationId: string;
	commandName: string;
	command?: string;
	browserSessionId?: string;
	tabId?: number;
	phase: string;
	progress?: number;
	queueDepth?: number;
	leaseOwnerHash?: string;
	conflictReason?: string;
	snapshotId?: string;
	sourceMode?: string;
	details?: Record<string, unknown>;
	startedAt: number;
	updatedAt: number;
};

export type CommandObservationSnapshotInfo = {
	snapshotId: string;
	browserSessionId?: string;
	tabId?: number;
	url?: string;
	frameScope?: string;
	selectionVersion?: number;
	sourceMode: string;
	capturedAt: number;
	ttlMs: number;
	networkSeq?: number;
	hookSeq?: number;
	invalidatedReason?: string;
	expired?: boolean;
	saved?: {
		path?: string;
	};
};

export type CommandTabLeaseInfo = {
	id: string;
	browserSessionId: string;
	tabSessionId: string;
	browserId: string;
	tabId: number;
	explicit: boolean;
	createdAt: number;
	lastSeenAt: number;
};

export type CommandUiLockInfo = {
	browserSessionId: string;
	commandName: string;
	createdAt: number;
	lastSeenAt: number;
	count: number;
};

export type BrowserCommandRuntimeSnapshot = {
	browserSessionId?: string;
	host: string;
	port: number;
	running: boolean;
	connectedClients: number;
	extensionConnected: boolean;
	extension?: ({ id?: string; workerBootId?: string } & Record<string, unknown>);
	clients: unknown[];
	defaultTabId?: number;
	defaultTabHandle?: string;
	latestTabId?: number;
	latestTabHandle?: string;
	selectionVersion: number;
	tabs: Array<Record<string, unknown>>;
	leases?: CommandTabLeaseInfo[];
	uiLock?: CommandUiLockInfo;
	queues?: Array<Record<string, unknown>>;
	operations?: CommandActiveOperationInfo[];
	pending: Array<Record<string, unknown>>;
};

export type BrowserTabLike = Record<string, unknown> & {
	tabId?: number;
	tabHandle?: string;
	targetRef?: string;
	url?: string;
	title?: string;
};

export type CommandTemporalProfileSampleInput = {
	operationId?: string;
	tool: string;
	command?: string;
	target?: { browserSessionId?: string; tabId?: number; targetRef?: string };
	deadlineMs?: number;
	elapsedMs: number;
	result?: BrowserBridgeExecutionResult;
	diagnostics?: Record<string, unknown>;
};

export interface BrowserCommandRuntimePort {
	snapshot(options?: { browserSessionId?: string }): BrowserCommandRuntimeSnapshot;
	getTabs(options?: { includeDisconnected?: boolean }): BrowserTabLike[];
	refreshTabs(timeoutMs?: number, options?: { browserSessionId?: string }): Promise<BrowserTabLike[]>;
	resolveTargetTabId(value: unknown, browserSessionId?: string): number;
	sendCommand(command: BrowserRuntimeCommand, options?: { browserSessionId?: string; tabId?: number | string; targetRef?: string; timeoutMs?: number; accessMode?: "read" | "write"; internal?: boolean }): Promise<BrowserBridgeExecutionResult>;
	executeJavaScript(script: string, options?: { browserSessionId?: string; tabId?: number | string; timeoutMs?: number }): Promise<BrowserBridgeExecutionResult>;
	switchTab(tabId: number | string, timeoutMs?: number, options?: { browserSessionId?: string }): Promise<BrowserBridgeExecutionResult>;
	createTab(url: string, active?: boolean, timeoutMs?: number, options?: { browserSessionId?: string; incognito?: boolean }): Promise<BrowserBridgeExecutionResult>;
	closeTab(tabId: number | string, timeoutMs?: number, options?: { browserSessionId?: string }): Promise<BrowserBridgeExecutionResult>;
	waitForExtensionReconnect(previousClientId: string | undefined, timeoutMs?: number): Promise<BrowserCommandRuntimeSnapshot>;
	listBrowserSessions(): unknown[];
	createBrowserSession(name?: string): unknown;
	selectBrowserSession(browserSessionId: string): unknown;
	closeBrowserSession(browserSessionId: string): unknown;
	attachTabToBrowserSession(tabId: number | string, options?: { browserSessionId?: string; browserId?: string }): BrowserTabLike;
	detachTabFromBrowserSession(tabId: number | string, options?: { browserSessionId?: string }): unknown;
	leaseTab(tabId: number | string, options?: { browserSessionId?: string }): CommandTabLeaseInfo;
	releaseTab(tabId: number | string, options?: { browserSessionId?: string }): CommandTabLeaseInfo | undefined;
	acquireUiLock(browserSessionId: string | undefined, commandName: string): CommandUiLockInfo;
	releaseUiLock(browserSessionId: string | undefined): CommandUiLockInfo | undefined;
	selectBrowser(browserId: string, options?: { browserSessionId?: string }): unknown;
	createObservationSnapshot(snapshot: Omit<CommandObservationSnapshotInfo, "snapshotId" | "expired" | "ttlMs"> & { snapshotId?: string; ttlMs?: number }): CommandObservationSnapshotInfo;
	getObservationSnapshot(snapshotId: string): CommandObservationSnapshotInfo | undefined;
	listObservationSnapshots(): CommandObservationSnapshotInfo[];
	beginOperation(operation: Omit<CommandActiveOperationInfo, "operationId" | "startedAt" | "updatedAt"> & { operationId?: string }): CommandActiveOperationInfo;
	updateOperation(operationId: string, patch: Partial<Omit<CommandActiveOperationInfo, "operationId" | "startedAt">>): CommandActiveOperationInfo | undefined;
	finishOperation(operationId: string): CommandActiveOperationInfo | undefined;
	queueDepth(browserSessionId: string | undefined, tabId: number | undefined): number | undefined;
	leaseOwnerHash(browserSessionId: string | undefined, tabId: number | undefined): string | undefined;
	getPerceptionLedgerFrame?(key: CommandPerceptionLedgerKey): CommandPerceptionLedgerFrame | undefined;
	getRecentPerceptionLedgerFrames?(key: CommandPerceptionLedgerKey, limit?: number): CommandPerceptionLedgerFrame[];
	recordPerceptionLedgerFrame?(frame: CommandPerceptionLedgerFrame): CommandPerceptionLedgerFrame;
	recordPerceptionTraceTerms?(browserSessionId: string | undefined, terms: Array<{ term: string; kind: string; weight?: number }>): CommandPerceptionTraceSnapshot;
	perceptionTraceSnapshot?(browserSessionId?: string): CommandPerceptionTraceSnapshot;
	buildTemporalProfileSample?(input: CommandTemporalProfileSampleInput): CommandTemporalProfileSample;
	recordTemporalProfileSample?(sample: CommandTemporalProfileSample, options?: { cwd?: string; runId?: string; evalRunDir?: string; runnerSummaryPath?: string }): Promise<unknown>;
}

export type { BrowserBridgeExecutionResult, BrowserBridgeTargetInfo };
