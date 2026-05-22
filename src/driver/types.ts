import type { WebSocket } from "ws";

export type BrowserBridgeClientInfo = {
	id: string;
	extensionId?: string;
	name?: string;
	version?: string;
	userAgent?: string;
	workerBootId?: string;
	workerStartedAt?: number;
	profileId?: string;
	managedProfile?: { profileId?: string; profileDir?: string; extensionDir?: string; bridgePort?: number; debugPort?: number; owned?: boolean; cleanup?: string };
	connectedAt: number;
	lastSeenAt: number;
};

export type BrowserTabSession = {
	id: string;
	browserId: string;
	tabId: number;
	url: string;
	title: string;
	active?: boolean;
	windowId?: number;
	groupId?: number;
	profileId?: string;
	type: "ext_ws";
	connectedAt: number;
	disconnectedAt?: number;
	bridge?: BrowserBridgeClientInfo;
	client: WebSocket;
};

export type BrowserTabInfo = Omit<BrowserTabSession, "client">;

export type BrowserBridgeTargetSource = "explicit" | "default" | "latest" | "none" | "orchestration";

export type BrowserBridgeTargetInfo = {
	tabId?: number;
	browserId?: string;
	source: BrowserBridgeTargetSource;
	implicit: boolean;
	selectionVersionAtDispatch: number;
	selectionVersionAtResolve?: number;
	orchestrationId?: string;
	sessionTag?: string;
	tabRole?: string;
	profileId?: string;
};

export type BrowserToolTargetRef = {
	tabId?: number | string;
	browserId?: string;
	orchestrationId?: string;
	sessionTag?: string;
	tabRole?: string;
	windowId?: number | string;
	groupId?: number | string;
	profileId?: string;
	requireOwned?: boolean;
};

export type ResolveBrowserToolTargetInput = {
	toolName?: string;
	commandName?: string;
	topLevelTabId?: unknown;
	target?: unknown;
	commandBody?: Record<string, unknown>;
	allowEmptyTarget?: boolean;
};

export type BrowserBridgeSnapshot = {
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
	orchestration?: Record<string, unknown>;
	profiles?: unknown[];
	pending: Array<{
		id: string;
		tabId?: number;
		createdAt: number;
		acked: boolean;
		target?: BrowserBridgeTargetInfo;
	}>;
};

export type ExecuteOptions = {
	tabId?: number | string;
	target?: BrowserToolTargetRef | unknown;
	timeoutMs?: number;
	toolName?: string;
	commandName?: string;
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

export type BrowserBridgeExecutionResult = {
	id: string;
	acknowledged: boolean;
	tabId?: number;
	data?: unknown;
	newTabs?: unknown[];
	target?: BrowserBridgeTargetInfo;
};
