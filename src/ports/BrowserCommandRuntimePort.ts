import type { BrowserBridgeExecutionResult, BrowserBridgeTargetInfo, BrowserRuntimeCommand } from "./BrowserRuntimeTypes.js";
import type { SessionTabLeaseInfo, SessionUiLockInfo } from "../kernels/session/leaseRegistry.js";
import type { SessionObservationSnapshotInfo } from "../kernels/session/observationSnapshotRegistry.js";
import type { SessionActiveOperationInfo, SessionMutationGuardInput, SessionMutationReplayGuard, SessionOperationBeginInput } from "../kernels/session/operationRegistry.js";
import type { BrowserOperationEvent, BrowserOperationLateEffect, BrowserOperationOutcome } from "../kernels/session/browserOperation.js";
import type { PerceptionLedgerFactState, PerceptionLedgerFrame, PerceptionLedgerKey, PerceptionObjectiveKey, PerceptionTraceSnapshot, PerceptionTraceTerm } from "../kernels/session/perceptionLedger.js";
import type { TemporalConfidence, TemporalFrontierNext, TemporalReason, TemporalVerdictStatus } from "../kernels/temporal/types.js";

export type CommandPerceptionLedgerKey = PerceptionLedgerKey;
export type CommandPerceptionObjectiveKey = PerceptionObjectiveKey;
export type CommandPerceptionLedgerFactState = PerceptionLedgerFactState;
export type CommandPerceptionLedgerFrame = PerceptionLedgerFrame;
export type CommandPerceptionTraceTerm = PerceptionTraceTerm;
export type CommandPerceptionTraceSnapshot = PerceptionTraceSnapshot;

export type CommandTemporalVerdictStatus = TemporalVerdictStatus;
export type CommandTemporalConfidence = TemporalConfidence;
export type CommandTemporalReason = TemporalReason;
export type CommandTemporalFrontierNext = TemporalFrontierNext;

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

export type CommandActiveOperationInfo = SessionActiveOperationInfo;
export type CommandObservationSnapshotInfo = SessionObservationSnapshotInfo;
export type CommandTabLeaseInfo = SessionTabLeaseInfo;
export type CommandUiLockInfo = SessionUiLockInfo;

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

export type BrowserCommandTargetTransactionInput = {
	browserSessionId?: string;
	tabId: number;
	signal?: AbortSignal;
};

export interface BrowserCommandSnapshotPort {
	snapshot(options?: { browserSessionId?: string }): BrowserCommandRuntimeSnapshot;
	getTabs(options?: { includeDisconnected?: boolean }): BrowserTabLike[];
	refreshTabs(timeoutMs?: number, options?: { browserSessionId?: string }): Promise<BrowserTabLike[]>;
	waitForExtensionReconnect(previousClientId: string | undefined, timeoutMs?: number): Promise<BrowserCommandRuntimeSnapshot>;
}

export interface BrowserCommandTargetPort {
	resolveTargetTabId(value: unknown, browserSessionId?: string): number;
}

export interface BrowserCommandDispatchPort extends BrowserCommandTargetPort {
	sendCommand(command: BrowserRuntimeCommand, options?: { browserSessionId?: string; tabId?: number | string; targetRef?: string; operationId?: string; operationGeneration?: number; timeoutMs?: number; accessMode?: "read" | "write"; internal?: boolean; signal?: AbortSignal }): Promise<BrowserBridgeExecutionResult>;
	executeJavaScript(script: string, options?: { browserSessionId?: string; tabId?: number | string; operationId?: string; operationGeneration?: number; timeoutMs?: number; accessMode?: "read" | "write"; signal?: AbortSignal }): Promise<BrowserBridgeExecutionResult>;
	withTargetTransaction?<T>(input: BrowserCommandTargetTransactionInput, run: () => Promise<T>): Promise<T>;
}

export interface BrowserCommandTabControlPort {
	switchTab(tabId: number | string, timeoutMs?: number, options?: { browserSessionId?: string; signal?: AbortSignal }): Promise<BrowserBridgeExecutionResult>;
	createTab(url: string, active?: boolean, timeoutMs?: number, options?: { browserSessionId?: string; incognito?: boolean; signal?: AbortSignal }): Promise<BrowserBridgeExecutionResult>;
	closeTab(tabId: number | string, timeoutMs?: number, options?: { browserSessionId?: string; signal?: AbortSignal }): Promise<BrowserBridgeExecutionResult>;
}

export interface BrowserCommandSessionPort {
	listBrowserSessions(): unknown[];
	createBrowserSession(name?: string): unknown;
	selectBrowserSession(browserSessionId: string): unknown;
	closeBrowserSession(browserSessionId: string): unknown;
	attachTabToBrowserSession(tabId: number | string, options?: { browserSessionId?: string; browserId?: string }): BrowserTabLike;
	detachTabFromBrowserSession(tabId: number | string, options?: { browserSessionId?: string }): unknown;
	selectBrowser(browserId: string, options?: { browserSessionId?: string }): unknown;
}

export interface BrowserCommandLeasePort {
	leaseTab(tabId: number | string, options?: { browserSessionId?: string }): CommandTabLeaseInfo;
	releaseTab(tabId: number | string, options?: { browserSessionId?: string }): CommandTabLeaseInfo | undefined;
	acquireUiLock(browserSessionId: string | undefined, commandName: string): CommandUiLockInfo | Promise<CommandUiLockInfo>;
	releaseUiLock(browserSessionId: string | undefined): CommandUiLockInfo | undefined;
	queueDepth(browserSessionId: string | undefined, tabId: number | undefined): number | undefined;
	leaseOwnerHash(browserSessionId: string | undefined, tabId: number | undefined): string | undefined;
}

export interface BrowserCommandObservationPort {
	createObservationSnapshot(snapshot: Omit<CommandObservationSnapshotInfo, "snapshotId" | "expired" | "ttlMs"> & { snapshotId?: string; ttlMs?: number }): CommandObservationSnapshotInfo;
	getObservationSnapshot(snapshotId: string): CommandObservationSnapshotInfo | undefined;
	listObservationSnapshots(): CommandObservationSnapshotInfo[];
}

export interface BrowserCommandOperationPort {
	beginOperation(operation: SessionOperationBeginInput): CommandActiveOperationInfo;
	updateOperation(operationId: string, patch: Partial<Omit<CommandActiveOperationInfo, "operationId" | "startedAt">>): CommandActiveOperationInfo | undefined;
	finishOperation(operationId: string, outcome?: BrowserOperationOutcome): CommandActiveOperationInfo | undefined;
	finishOperationIfRevision?(operationId: string, expectedRevision: number, outcome?: BrowserOperationOutcome): CommandActiveOperationInfo | undefined;
	getOperation?(operationId: string): CommandActiveOperationInfo | undefined;
	waitForOperationChange?(operationId: string, afterRevision: number, timeoutMs: number, signal?: AbortSignal): Promise<CommandActiveOperationInfo | undefined>;
	recordOperationEvent?(operationId: string, event: Omit<BrowserOperationEvent, "operationId" | "sequence" | "ledgerRevision" | "timestamp"> & { sequence?: number; sourceSequence?: number; timestamp?: number }): CommandActiveOperationInfo | undefined;
	surfaceLateEffects?(input: { ownerId?: string; browserSessionId?: string; excludeOperationId?: string }): BrowserOperationLateEffect[];
	mutationReplayGuard?(input: SessionMutationGuardInput): SessionMutationReplayGuard | undefined;
	markMutationObserved?(input: Omit<SessionMutationGuardInput, "intentId">): number;
}

export interface BrowserCommandRecorderStatePort {
	getKnownRecorderState?(kind: "network" | "hook", browserSessionId: string | undefined, tabId: number | undefined): { active: boolean; lastSeq?: number } | undefined;
	recordKnownRecorderState?(kind: "network" | "hook", browserSessionId: string | undefined, tabId: number | undefined, state: { active: boolean; lastSeq?: number }): void;
}

export interface BrowserCommandPerceptionPort {
	getPerceptionLedgerFrame?(key: CommandPerceptionLedgerKey): CommandPerceptionLedgerFrame | undefined;
	getRecentPerceptionLedgerFrames?(key: CommandPerceptionLedgerKey, limit?: number): CommandPerceptionLedgerFrame[];
	recordPerceptionLedgerFrame?(frame: CommandPerceptionLedgerFrame): CommandPerceptionLedgerFrame;
	recordPerceptionTraceTerms?(browserSessionId: string | undefined, terms: Array<{ term: string; kind: string; weight?: number }>): CommandPerceptionTraceSnapshot;
	perceptionTraceSnapshot?(browserSessionId?: string): CommandPerceptionTraceSnapshot;
}

export interface BrowserCommandTemporalPort {
	buildTemporalProfileSample?(input: CommandTemporalProfileSampleInput): CommandTemporalProfileSample;
	recordTemporalProfileSample?(sample: CommandTemporalProfileSample, options?: { cwd?: string; runId?: string; evalRunDir?: string; runnerSummaryPath?: string }): Promise<unknown>;
}

export interface BrowserCommandIntentRefPort {
	getIntentRefRegistry?(): import("../kernels/session/intentRefRegistry.js").IntentRefRegistry | undefined;
}

export interface BrowserCommandRuntimePort extends
	BrowserCommandSnapshotPort,
	BrowserCommandDispatchPort,
	BrowserCommandTabControlPort,
	BrowserCommandSessionPort,
	BrowserCommandLeasePort,
	BrowserCommandObservationPort,
	BrowserCommandOperationPort,
	BrowserCommandRecorderStatePort,
	BrowserCommandPerceptionPort,
	BrowserCommandTemporalPort,
	BrowserCommandIntentRefPort {
}

export type BrowserCommandRelevanceTracePort = Pick<BrowserCommandPerceptionPort, "recordPerceptionTraceTerms">;

export type { BrowserBridgeExecutionResult, BrowserBridgeTargetInfo };
