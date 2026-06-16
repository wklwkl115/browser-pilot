import type { WebSocket } from "ws";
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

export type BrowserAutomationSession = {
	id: string;
	name?: string;
	selectedClient?: WebSocket;
	defaultSessionId?: string;
	latestSessionId?: string;
	selectionVersion: number;
	createdAt: number;
	lastSeenAt: number;
};

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

export type BrowserTabLeaseInfo = {
	id: string;
	browserSessionId: string;
	tabSessionId: string;
	browserId: string;
	tabId: number;
	explicit: boolean;
	createdAt: number;
	lastSeenAt: number;
};

export type BrowserReleasedTabLeaseInfo = BrowserTabLeaseInfo & {
	releaseReason: "ttl" | "disconnect";
};

export type BrowserUiLockInfo = {
	browserSessionId: string;
	commandName: string;
	createdAt: number;
	lastSeenAt: number;
	count: number;
};

export type BrowserReleasedUiLockInfo = BrowserUiLockInfo & {
	releaseReason: "ttl" | "disconnect";
};

export type BrowserCommandQueueInfo = {
	key: string;
	browserSessionId: string;
	tabId: number;
	depth: number;
};

export type BrowserActiveOperationInfo = {
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

export type BrowserObservationSnapshotInfo = {
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

export type BrowserBridgeSnapshot = {
	browserSessionId?: string;
	host: string;
	port: number;
	running: boolean;
	connectedClients: number;
	extensionConnected: boolean;
	extension?: BrowserBridgeClientInfo;
	clients: BrowserBridgeClientInfo[];
	lastDisconnectReason?: string;
	lastDisconnectAt?: number;
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
