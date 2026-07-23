import type { BrowserBridgeExecutionResult, BrowserBridgeTargetInfo, BrowserRuntimeCommand } from "./BrowserRuntimeTypes.js";
import type { SessionObservationSnapshotInfo } from "../kernels/session/observationSnapshotRegistry.js";
import type { PerceptionLedgerFactState, PerceptionLedgerFrame, PerceptionLedgerKey, PerceptionTraceSnapshot } from "../kernels/session/perceptionLedger.js";

export type CommandPerceptionLedgerKey = PerceptionLedgerKey;
export type CommandPerceptionLedgerFactState = PerceptionLedgerFactState;
export type CommandPerceptionLedgerFrame = PerceptionLedgerFrame;
export type CommandPerceptionTraceSnapshot = PerceptionTraceSnapshot;

export type CommandObservationSnapshotInfo = SessionObservationSnapshotInfo;
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
	queues?: Array<Record<string, unknown>>;
	pending: Array<Record<string, unknown>>;
};

export type BrowserTabLike = Record<string, unknown> & {
	tabId?: number;
	tabHandle?: string;
	targetRef?: string;
	url?: string;
	title?: string;
};

export type BrowserCommandTargetTransactionInput = {
	browserSessionId?: string;
	tabId: number;
	targetRef?: string | number;
	signal?: AbortSignal;
};

export interface BrowserCommandSnapshotPort {
	snapshot(options?: { browserSessionId?: string }): BrowserCommandRuntimeSnapshot;
	getTabs(options?: { includeDisconnected?: boolean }): BrowserTabLike[];
	refreshTabs(timeoutMs?: number, options?: { browserSessionId?: string; signal?: AbortSignal }): Promise<BrowserTabLike[]>;
	waitForExtensionReconnect(previousClientId: string | undefined, timeoutMs?: number): Promise<BrowserCommandRuntimeSnapshot>;
}

export interface BrowserCommandTargetPort {
	resolveTargetTabId(value: unknown, browserSessionId?: string): number;
}

export interface BrowserCommandDispatchPort extends BrowserCommandTargetPort {
	sendCommand(command: BrowserRuntimeCommand, options?: { browserSessionId?: string; tabId?: number | string; targetRef?: string; timeoutMs?: number; accessMode?: "read" | "write"; internal?: boolean; signal?: AbortSignal }): Promise<BrowserBridgeExecutionResult>;
	executeJavaScript(script: string, options?: { browserSessionId?: string; tabId?: number | string; timeoutMs?: number; accessMode?: "read" | "write"; signal?: AbortSignal }): Promise<BrowserBridgeExecutionResult>;
	withTargetTransaction?<T>(input: BrowserCommandTargetTransactionInput, run: () => Promise<T>): Promise<T>;
}

export interface BrowserCommandTabControlPort {
	switchTab(tabId: number | string, timeoutMs?: number, options?: { browserSessionId?: string; signal?: AbortSignal }): Promise<BrowserBridgeExecutionResult>;
	createTab(url: string, active?: boolean, timeoutMs?: number, options?: { browserSessionId?: string; incognito?: boolean; signal?: AbortSignal }): Promise<BrowserBridgeExecutionResult>;
	closeTab(tabId: number | string, timeoutMs?: number, options?: { browserSessionId?: string; signal?: AbortSignal }): Promise<BrowserBridgeExecutionResult>;
}

export interface BrowserCommandObservationPort {
	createObservationSnapshot(snapshot: Omit<CommandObservationSnapshotInfo, "snapshotId" | "expired" | "ttlMs"> & { snapshotId?: string; ttlMs?: number }): CommandObservationSnapshotInfo;
	getObservationSnapshot(snapshotId: string): CommandObservationSnapshotInfo | undefined;
	listObservationSnapshots(): CommandObservationSnapshotInfo[];
}

export interface BrowserCommandRecorderStatePort {
	getKnownRecorderState?(kind: "network" | "hook", browserSessionId: string | undefined, tabId: number | undefined): { active: boolean; lastSeq?: number } | undefined;
	recordKnownRecorderState?(kind: "network" | "hook", browserSessionId: string | undefined, tabId: number | undefined, state: { active: boolean; lastSeq?: number }): void;
}

export interface BrowserCommandPerceptionPort {
	getPerceptionLedgerFrame?(key: CommandPerceptionLedgerKey): CommandPerceptionLedgerFrame | undefined;
	recordPerceptionLedgerFrame?(frame: CommandPerceptionLedgerFrame): CommandPerceptionLedgerFrame;
	recordPerceptionTraceTerms?(browserSessionId: string | undefined, terms: Array<{ term: string; kind: string; weight?: number }>): CommandPerceptionTraceSnapshot;
	perceptionTraceSnapshot?(browserSessionId?: string): CommandPerceptionTraceSnapshot;
}

export interface BrowserCommandRuntimePort extends
		BrowserCommandSnapshotPort,
		BrowserCommandDispatchPort,
		BrowserCommandTabControlPort,
		BrowserCommandObservationPort,
	BrowserCommandRecorderStatePort,
	BrowserCommandPerceptionPort {
}

export type BrowserCommandRelevanceTracePort = Pick<BrowserCommandPerceptionPort, "recordPerceptionTraceTerms">;

export type { BrowserBridgeExecutionResult, BrowserBridgeTargetInfo };
