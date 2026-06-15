import type { WebSocket } from "ws";
import type { SessionActiveOperationInfo, SessionAutomationSession, SessionObservationSnapshotInfo, SessionReleasedTabLeaseInfo, SessionReleasedUiLockInfo, SessionTabLeaseInfo, SessionUiLockInfo } from "../../kernels/session/index.js";
import type { BrowserBridgeExecutionResult, BrowserBridgeTargetInfo } from "../../ports/BrowserRuntimeTypes.js";

export type { BrowserBridgeExecutionResult, BrowserBridgeTargetInfo, BrowserBridgeTargetSource } from "../../ports/BrowserRuntimeTypes.js";

export type BrowserBridgeClientInfo = {
	id: string;
	extensionId?: string;
	name?: string;
	version?: string;
	build?: unknown;
	extensionStale?: boolean;
	expectedBuild?: string;
	reportedBuild?: string;
	buildManifestPath?: string;
	userAgent?: string;
	workerBootId?: string;
	workerStartedAt?: number;
	connectedAt: number;
	lastSeenAt: number;
	lastPingAt?: number;
	lastPongAt?: number;
};

export type BrowserTabSession = {
	id: string;
	browserId: string;
	tabId: number;
	logicalTabId: string;
	tabHandle: string;
	generation: number;
	url: string;
	title: string;
	active?: boolean;
	windowId?: number;
	openerTabId?: number;
	replacedFromTabId?: number;
	replacedAt?: number;
	activatedAt?: number;
	incognito?: boolean;
	type: "ext_ws";
	connectedAt: number;
	disconnectedAt?: number;
	bridge?: BrowserBridgeClientInfo;
	client: WebSocket;
};

export type BrowserTabInfo = Omit<BrowserTabSession, "client"> & {
	targetRef: string;
};

export type BrowserAutomationSession = SessionAutomationSession<WebSocket>;

export type BrowserAutomationSessionInfo = {
	id: string;
	name?: string;
	defaultTabId?: number;
	defaultTabHandle?: string;
	latestTabId?: number;
	latestTabHandle?: string;
	selectionVersion: number;
	createdAt: number;
	lastSeenAt: number;
	selectedBrowser?: BrowserBridgeClientInfo;
};

export type BrowserTabLeaseInfo = SessionTabLeaseInfo;

export type BrowserReleasedTabLeaseInfo = SessionReleasedTabLeaseInfo;

export type BrowserUiLockInfo = SessionUiLockInfo;

export type BrowserReleasedUiLockInfo = SessionReleasedUiLockInfo;

export type BrowserCommandQueueInfo = {
	key: string;
	browserSessionId: string;
	tabId: number;
	depth: number;
};

export type BrowserActiveOperationInfo = SessionActiveOperationInfo;

export type BrowserObservationSnapshotInfo = SessionObservationSnapshotInfo;

export type BrowserBridgeSnapshot = {
	browserSessionId?: string;
	host: string;
	port: number;
	running: boolean;
	connectedClients: number;
	extensionConnected: boolean;
	extension?: BrowserBridgeClientInfo;
	clients: BrowserBridgeClientInfo[];
	defaultTabId?: number;
	defaultTabHandle?: string;
	latestTabId?: number;
	latestTabHandle?: string;
	selectionVersion: number;
	tabs: BrowserTabInfo[];
	leases?: BrowserTabLeaseInfo[];
	uiLock?: BrowserUiLockInfo;
	queues?: BrowserCommandQueueInfo[];
	operations?: BrowserActiveOperationInfo[];
	pending: Array<{
		id: string;
		tabId?: number;
		createdAt: number;
		acked: boolean;
		target?: BrowserBridgeTargetInfo;
	}>;
};

export type ExecuteOptions = {
	browserSessionId?: string;
	tabId?: number | string;
	targetRef?: string;
	timeoutMs?: number;
	accessMode?: "read" | "write";
	internal?: boolean;
};

export type PendingRequest = {
	id: string;
	tabId?: number;
	client: WebSocket;
	createdAt: number;
	acked: boolean;
	ackAt?: number;
	target?: BrowserBridgeTargetInfo;
	timer: NodeJS.Timeout;
	resolve: (value: BrowserBridgeExecutionResult) => void;
	reject: (error: Error) => void;
};
