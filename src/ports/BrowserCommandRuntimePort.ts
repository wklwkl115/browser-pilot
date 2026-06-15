import type { BrowserBridgeExecutionResult, BrowserBridgeTargetInfo, BrowserRuntimeCommand } from "./BrowserRuntimeTypes.js";
import type { PerceptionLedgerFrame, PerceptionLedgerKey, PerceptionTraceSnapshot } from "../kernels/session/perceptionLedger.js";
import type { SessionActiveOperationInfo, SessionObservationSnapshotInfo, SessionTabLeaseInfo, SessionUiLockInfo } from "../kernels/session/index.js";
import type { TemporalProfileSample } from "../kernels/temporal/types.js";

export type CommandPerceptionLedgerFrame = PerceptionLedgerFrame;
export type CommandPerceptionLedgerKey = PerceptionLedgerKey;
export type CommandPerceptionTraceSnapshot = PerceptionTraceSnapshot;
export type CommandTemporalProfileSample = TemporalProfileSample;

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
	leases?: SessionTabLeaseInfo[];
	uiLock?: SessionUiLockInfo;
	queues?: Array<Record<string, unknown>>;
	operations?: SessionActiveOperationInfo[];
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
	leaseTab(tabId: number | string, options?: { browserSessionId?: string }): SessionTabLeaseInfo;
	releaseTab(tabId: number | string, options?: { browserSessionId?: string }): SessionTabLeaseInfo | undefined;
	acquireUiLock(browserSessionId: string | undefined, commandName: string): SessionUiLockInfo;
	releaseUiLock(browserSessionId: string | undefined): SessionUiLockInfo | undefined;
	selectBrowser(browserId: string, options?: { browserSessionId?: string }): unknown;
	createObservationSnapshot(snapshot: Omit<SessionObservationSnapshotInfo, "snapshotId" | "expired" | "ttlMs"> & { snapshotId?: string; ttlMs?: number }): SessionObservationSnapshotInfo;
	getObservationSnapshot(snapshotId: string): SessionObservationSnapshotInfo | undefined;
	listObservationSnapshots(): SessionObservationSnapshotInfo[];
	beginOperation(operation: Omit<SessionActiveOperationInfo, "operationId" | "startedAt" | "updatedAt"> & { operationId?: string }): SessionActiveOperationInfo;
	updateOperation(operationId: string, patch: Partial<Omit<SessionActiveOperationInfo, "operationId" | "startedAt">>): SessionActiveOperationInfo | undefined;
	finishOperation(operationId: string): SessionActiveOperationInfo | undefined;
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
