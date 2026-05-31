import type { WebSocket } from "ws";

export type BrowserBridgeClientInfo = {
	id: string;
	extensionId?: string;
	name?: string;
	version?: string;
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
	url: string;
	title: string;
	active?: boolean;
	windowId?: number;
	type: "ext_ws";
	connectedAt: number;
	disconnectedAt?: number;
	bridge?: BrowserBridgeClientInfo;
	client: WebSocket;
};

export type BrowserTabInfo = Omit<BrowserTabSession, "client">;

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
	latestTabId?: number;
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
	toolName: string;
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

export type BrowserToolCapabilityProfileInfo = {
	name: "security" | "core";
	source: "default" | "env";
	envVar: "PI_BROWSER_TOOL_PROFILE";
	securityToolsEnabled: boolean;
	enableHint: string;
	warnings?: string[];
};

export type BrowserActiveOperationInfo = {
	operationId: string;
	toolName: string;
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
	invalidatedReason?: string;
	expired?: boolean;
	saved?: {
		path?: string;
	};
};

export type BrowserBridgeTargetSource = "explicit" | "default" | "latest" | "none";

export type BrowserBridgeTargetInfo = {
	browserSessionId?: string;
	tabId?: number;
	source: BrowserBridgeTargetSource;
	implicit: boolean;
	selectionVersionAtDispatch: number;
	selectionVersionAtResolve?: number;
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
	defaultTabId?: number;
	latestTabId?: number;
	selectionVersion: number;
	tabs: BrowserTabInfo[];
	leases?: BrowserTabLeaseInfo[];
	uiLock?: BrowserUiLockInfo;
	queues?: BrowserCommandQueueInfo[];
	operations?: BrowserActiveOperationInfo[];
	capabilityProfile?: BrowserToolCapabilityProfileInfo;
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
	timeoutMs?: number;
	accessMode?: "read" | "write";
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

export type BrowserBridgeExecutionResult<TData = unknown, TNewTabs = unknown[]> = {
	id: string;
	acknowledged: boolean;
	tabId?: number;
	data?: TData;
	newTabs?: TNewTabs;
	target?: BrowserBridgeTargetInfo;
};
