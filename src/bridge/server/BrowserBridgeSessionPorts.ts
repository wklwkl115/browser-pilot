import type { WebSocket } from "ws";
import type { BrowserAutomationSession, BrowserReleasedTabLeaseInfo, BrowserReleasedUiLockInfo, BrowserTabLeaseInfo, BrowserTabSession, BrowserUiLockInfo } from "./types.js";

export type BrowserBridgeSessionRegistryPort = {
	list(): BrowserAutomationSession[];
	defaultSession(): BrowserAutomationSession;
	selectedSession(): BrowserAutomationSession;
	require(sessionId?: string): BrowserAutomationSession;
	selectClient(session: BrowserAutomationSession, client: WebSocket | undefined): void;
	selectedOpenClient(session: BrowserAutomationSession): WebSocket | undefined;
	selectedInfo<TInfo>(session: BrowserAutomationSession, describe: (client: WebSocket) => TInfo | undefined): TInfo | undefined;
};

export type BrowserBridgeLeaseRegistryPort = {
	acquireUiLock(browserSessionId: string, commandName: string): BrowserUiLockInfo | Promise<BrowserUiLockInfo>;
	releaseUiLock(browserSessionId: string): BrowserUiLockInfo | undefined;
	withAutoTabLease<T>(browserSessionId: string, tab: BrowserTabSession, fn: () => Promise<T>): Promise<T>;
	touchTabLease(browserSessionId: string, tab: BrowserTabSession): BrowserTabLeaseInfo | undefined;
	peekTabLease(tab: BrowserTabSession): BrowserTabLeaseInfo | undefined;
	describeTabLease(lease: BrowserTabLeaseInfo): Record<string, unknown>;
	releaseLeasesForTabSessions(tabSessionIds: string[], reason: "ttl" | "disconnect"): BrowserReleasedTabLeaseInfo[];
	releaseUiLocksForBrowserSessions(browserSessionIds: string[], reason: "ttl" | "disconnect"): BrowserReleasedUiLockInfo[];
	migrateTabLeaseForReplacement(fromTabSessionId: string, toTab: BrowserTabSession): BrowserTabLeaseInfo | undefined;
};
