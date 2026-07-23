import type { WebSocket } from "ws";
import type { SessionObservationSnapshotInfo } from "../../kernels/session/observationSnapshotRegistry.js";
import type { BrowserBridgeExecutionResult, BrowserBridgeTargetInfo } from "../../ports/BrowserRuntimeTypes.js";
import type { BrowserCommandQueueInfo } from "./BrowserCommandQueueRegistry.js";

export type { BrowserBridgeExecutionResult, BrowserBridgeTargetInfo, BrowserBridgeTargetSource } from "../../ports/BrowserRuntimeTypes.js";
export type { BrowserCommandQueueInfo } from "./BrowserCommandQueueRegistry.js";

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
	captureContractVersion?: number;
	/** Stable per-installation id (survives SW restarts); used to dedupe sockets and reconcile reconnects. */
	extensionInstanceId?: string;
	/** How the most recent ext_ready was classified: cold | reconnect | sw-restart | duplicate. */
	connectKind?: string;
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
	pageEpoch?: string;
	documentId?: string;
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
	targetGeneration: number;
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

export type BrowserObservationSnapshotInfo = SessionObservationSnapshotInfo;

export type BridgeConnectionMetrics = {
	connects: number;
	reconnects: number;
	swRestarts: number;
	duplicates: number;
	disconnects: number;
	lastReconnectLatencyMs?: number;
};

export type BridgeRequestMetrics = {
	drained: number;
	graceExpired: number;
	reconciledNotDelivered: number;
	reconciledInflightUnknown: number;
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
	queues?: BrowserCommandQueueInfo[];
	pending: Array<{
		id: string;
		tabId?: number;
		createdAt: number;
		acked: boolean;
		target?: BrowserBridgeTargetInfo;
	}>;
	connectionMetrics?: BridgeConnectionMetrics;
	requestMetrics?: BridgeRequestMetrics;
};

export type ExecuteOptions = {
	browserSessionId?: string;
	tabId?: number | string;
	targetRef?: string;
	timeoutMs?: number;
	accessMode?: "read" | "write";
	internal?: boolean;
	signal?: AbortSignal;
};

export type PendingRequest = {
	id: string;
	tabId?: number;
	client: WebSocket;
	/** Command payload retained only for bounded timeout diagnostics. */
	code: unknown;
	/** Effective per-request timeout. */
	timeoutMs: number;
	/** Owning extension instance, tagged when the request enters the draining state. */
	instanceId?: string;
	/** True while held after a client disconnect, awaiting reconnect or grace expiry. */
	draining?: boolean;
	/** Grace-window timer that fails the request if no reconnect reclaims it. */
	graceTimer?: NodeJS.Timeout;
	signal?: AbortSignal;
	abortListener?: () => void;
	createdAt: number;
	acked: boolean;
	ackAt?: number;
	target?: BrowserBridgeTargetInfo;
	timer: NodeJS.Timeout;
	resolve: (value: BrowserBridgeExecutionResult) => void;
	reject: (error: Error) => void;
};
