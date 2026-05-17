import type { WebSocket } from "ws";

export type BrowserBridgeClientInfo = {
	id: string;
	extensionId?: string;
	name?: string;
	version?: string;
	userAgent?: string;
	connectedAt: number;
	lastSeenAt: number;
};

export type BrowserTabSession = {
	id: string;
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
	tabs: BrowserTabInfo[];
	pending: Array<{
		id: string;
		tabId?: number;
		createdAt: number;
		acked: boolean;
	}>;
};

export type ExecuteOptions = {
	tabId?: number | string;
	timeoutMs?: number;
};

export type PendingRequest = {
	id: string;
	tabId?: number;
	createdAt: number;
	acked: boolean;
	ackAt?: number;
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
};
