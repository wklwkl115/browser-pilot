import { WebSocket } from "ws";
import { BrowserBridgeError } from "./errors";
import { browserTabInfo, isOpen, tabSessionSummary, toTabId } from "./bridgeUtils";
import type { BrowserAutomationSession, BrowserAutomationSessionInfo, BrowserBridgeTargetInfo, BrowserBridgeTargetSource, BrowserTabInfo, BrowserTabSession } from "./types";
import type { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry";
import { DEFAULT_BROWSER_SESSION_ID, type BrowserSessionRegistry } from "./BrowserSessionRegistry";

const DISCONNECTED_SESSION_RETENTION_MS = 5 * 60_000;
const MAX_DISCONNECTED_SESSION_HISTORY = 128;

export class BrowserTabSessionRouter {
	readonly sessions = new Map<string, BrowserTabSession>();
	private readonly clients: BrowserBridgeClientRegistry;
	private readonly browserSessions: BrowserSessionRegistry;

	constructor(clients: BrowserBridgeClientRegistry, browserSessions: BrowserSessionRegistry) {
		this.clients = clients;
		this.browserSessions = browserSessions;
	}

	get selectionVersion(): number {
		return this.browserSession().selectionVersion;
	}

	clear(): void {
		this.sessions.clear();
		const session = this.browserSession();
		this.setDefaultSessionId(session, undefined);
		this.setLatestSessionId(session, undefined);
	}

	targetInfo(source: BrowserBridgeTargetSource, tabId?: number, session = this.browserSession()): BrowserBridgeTargetInfo {
		return {
			browserSessionId: session.id,
			tabId,
			source,
			implicit: source === "default" || source === "latest",
			selectionVersionAtDispatch: session.selectionVersion,
		};
	}

	resolvedTarget(target: BrowserBridgeTargetInfo | undefined): BrowserBridgeTargetInfo | undefined {
		const session = this.browserSession(target?.browserSessionId);
		return target ? { ...target, browserSessionId: session.id, selectionVersionAtResolve: session.selectionVersion } : undefined;
	}

	defaultTabId(browserSessionId?: string): number | undefined {
		return this.tabIdForSessionId(this.browserSession(browserSessionId).defaultSessionId);
	}

	latestTabId(browserSessionId?: string): number | undefined {
		return this.tabIdForSessionId(this.browserSession(browserSessionId).latestSessionId);
	}

	markClientDisconnected(ws: WebSocket): void {
		for (const session of this.sessions.values()) {
			if (session.client === ws && !session.disconnectedAt) session.disconnectedAt = Date.now();
		}
		this.browserSessions.markClientDisconnected(ws);
		this.refreshSelectedSessionRefs();
	}

	markTabDisconnected(tabId: number, browserSessionId?: string): void {
		const session = this.liveSessionForTabId(tabId, browserSessionId);
		if (session && !session.disconnectedAt) session.disconnectedAt = Date.now();
		this.refreshSelectedSessionRefs(undefined, browserSessionId);
	}

	getTabs(options: { includeDisconnected?: boolean } = {}): BrowserTabInfo[] {
		this.refreshSelectedSessionRefs();
		const tabs = Array.from(this.sessions.values());
		return tabs
			.filter((tab) => options.includeDisconnected || !tab.disconnectedAt)
			.sort((a, b) => a.tabId - b.tabId || a.browserId.localeCompare(b.browserId) || a.id.localeCompare(b.id))
			.map(browserTabInfo);
	}

	updateTabs(rawTabs: unknown[], ws: WebSocket): void {
		const now = Date.now();
		const current = new Set<string>();
		const browserId = this.clients.browserIdForClient(ws);
		for (const raw of rawTabs) {
			if (!raw || typeof raw !== "object") continue;
			const tab = raw as Record<string, unknown>;
			const tabId = toTabId(tab.id ?? tab.tabId);
			if (!tabId) continue;
			const id = this.sessionIdForTab(ws, tabId);
			current.add(id);
			const existing = this.sessions.get(id);
			this.sessions.set(id, {
				id,
				browserId,
				tabId,
				url: typeof tab.url === "string" ? tab.url : existing?.url || "",
				title: typeof tab.title === "string" ? tab.title : existing?.title || "",
				active: typeof tab.active === "boolean" ? tab.active : existing?.active,
				windowId: toTabId(tab.windowId) ?? existing?.windowId,
				type: "ext_ws",
				connectedAt: existing?.connectedAt || now,
				bridge: this.clients.info(ws),
				client: ws,
			});
			const browserSession = this.browserSessions.defaultSession();
			if (tab.active === true || !browserSession.defaultSessionId) this.setDefaultSessionId(browserSession, id);
			this.setLatestSessionId(browserSession, id);
		}
		for (const [id, session] of this.sessions) {
			if (!current.has(id) && session.client === ws && !session.disconnectedAt) session.disconnectedAt = now;
		}
		this.refreshSelectedSessionRefs();
	}

	selectBrowser(ws: WebSocket, browserSessionId?: string): string | undefined {
		const browserSession = this.browserSession(browserSessionId);
		this.browserSessions.selectClient(browserSession, ws);
		const sessionId = this.firstActiveSessionIdForClient(ws, browserSessionId);
		this.setDefaultSessionId(browserSession, sessionId);
		this.setLatestSessionId(browserSession, sessionId);
		return sessionId;
	}

	selectTab(tabId: number, browserSessionId?: string): void {
		const selectedSession = this.liveSessionForTabId(tabId, browserSessionId);
		if (selectedSession) this.setDefaultSessionId(this.browserSession(browserSessionId), selectedSession.id);
	}

	attachTab(tabId: number, browserSessionId: string | undefined, browserId?: string): BrowserTabSession | undefined {
		const selectedSession = browserId ? this.liveSessionForTabRef(tabId, browserId) : this.liveSessionForTabId(tabId, browserSessionId);
		if (!selectedSession) return undefined;
		const browserSession = this.browserSession(browserSessionId);
		this.browserSessions.selectClient(browserSession, selectedSession.client);
		this.setDefaultSessionId(browserSession, selectedSession.id);
		this.setLatestSessionId(browserSession, selectedSession.id);
		return selectedSession;
	}

	detachTab(tabId: number, browserSessionId?: string): void {
		const browserSession = this.browserSession(browserSessionId);
		const live = this.liveSessionForTabId(tabId, browserSessionId);
		if (live?.id && browserSession.defaultSessionId === live.id) this.setDefaultSessionId(browserSession, undefined);
		if (live?.id && browserSession.latestSessionId === live.id) this.setLatestSessionId(browserSession, undefined);
		if (live?.client && this.browserSessions.selectedOpenClient(browserSession) === live.client) this.browserSessions.selectClient(browserSession, undefined);
	}

	previousDefaultTabId(browserSessionId?: string): number | undefined {
		return this.tabIdForSessionId(this.browserSession(browserSessionId).defaultSessionId);
	}

	liveSessionForTabId(tabId: number, browserSessionId?: string): BrowserTabSession | undefined {
		const live = Array.from(this.sessions.values()).filter((session) => session.tabId === tabId && !session.disconnectedAt && isOpen(session.client));
		const scopeClient = this.browserSessions.selectedOpenClient(this.browserSession(browserSessionId));
		const scoped = scopeClient ? live.find((session) => session.client === scopeClient) : undefined;
		if (scoped) return scoped;
		if (live.length <= 1) return live[0];
		throw new BrowserBridgeError("AMBIGUOUS_TAB_ID", "Multiple connected browsers expose the same tabId; call browser_tabs selectBrowser before using this tabId", {
			tabId,
			tabs: live.map(tabSessionSummary),
		});
	}

	socketForTab(tabId: number, browserSessionId?: string): WebSocket | undefined {
		return this.liveSessionForTabId(tabId, browserSessionId)?.client;
	}

	describeBrowserSession(session: BrowserAutomationSession, selectedBrowser?: BrowserAutomationSessionInfo["selectedBrowser"]): BrowserAutomationSessionInfo {
		return {
			id: session.id,
			name: session.name,
			defaultTabId: this.tabIdForSessionId(session.defaultSessionId),
			latestTabId: this.tabIdForSessionId(session.latestSessionId),
			selectionVersion: session.selectionVersion,
			createdAt: session.createdAt,
			lastSeenAt: session.lastSeenAt,
			selectedBrowser,
		};
	}

	fallbackExecutionTarget(browserSessionId?: string): BrowserBridgeTargetInfo | undefined {
		this.refreshSelectedSessionRefs(undefined, browserSessionId);
		const browserSession = this.browserSession(browserSessionId);
		const defaultTabId = this.tabIdForSessionId(browserSession.defaultSessionId);
		if (defaultTabId) return this.targetInfo("default", defaultTabId, browserSession);
		const latestTabId = this.tabIdForSessionId(browserSession.latestSessionId);
		if (latestTabId) return this.targetInfo("latest", latestTabId, browserSession);
		return undefined;
	}

	firstActiveSessionIdForClient(client: WebSocket, browserSessionId?: string): string | undefined {
		return this.preferredImplicitSessionId(Array.from(this.sessions.values()).filter((session) => session.client === client), this.browserSession(browserSessionId));
	}

	refreshSelectedSessionRefs(now = Date.now(), browserSessionId?: string): void {
		this.pruneDisconnectedSessions(now);
		const browserSession = this.browserSession(browserSessionId);
		const scopeClient = this.browserSessions.selectedOpenClient(browserSession);
		const firstActive = scopeClient ? this.firstActiveSessionIdForClient(scopeClient, browserSessionId) : browserSession.id === DEFAULT_BROWSER_SESSION_ID ? this.firstActiveSessionId(browserSessionId) : undefined;
		const isValid = (session: BrowserTabSession | undefined) => !!session && !session.disconnectedAt && (!scopeClient || session.client === scopeClient);
		const defaultSession = browserSession.defaultSessionId ? this.sessions.get(browserSession.defaultSessionId) : undefined;
		if (!browserSession.defaultSessionId || !isValid(defaultSession)) this.setDefaultSessionId(browserSession, firstActive);
		const latestSession = browserSession.latestSessionId ? this.sessions.get(browserSession.latestSessionId) : undefined;
		if (!browserSession.latestSessionId || !isValid(latestSession)) this.setLatestSessionId(browserSession, firstActive);
	}

	private setDefaultSessionId(session: BrowserAutomationSession, id: string | undefined): void {
		this.browserSessions.setDefaultTabSessionId(session, id);
	}

	private setLatestSessionId(session: BrowserAutomationSession, id: string | undefined): void {
		this.browserSessions.setLatestTabSessionId(session, id);
	}

	private liveSessionForTabRef(tabId: number, browserId: string): BrowserTabSession | undefined {
		return Array.from(this.sessions.values()).find((session) => session.tabId === tabId && !session.disconnectedAt && isOpen(session.client) && (session.browserId === browserId || session.bridge?.extensionId === browserId || session.bridge?.id === browserId));
	}

	private sessionIdForTab(client: WebSocket, tabId: number): string {
		return `${this.clients.browserIdForClient(client)}:${tabId}`;
	}

	private tabIdForSessionId(sessionId: string | undefined): number | undefined {
		if (!sessionId) return undefined;
		return this.sessions.get(sessionId)?.tabId;
	}

	private preferredImplicitSessionId(candidates: BrowserTabSession[], browserSession: BrowserAutomationSession): string | undefined {
		const live = candidates.filter((session) => !session.disconnectedAt);
		return live.find((session) => session.active === true)?.id
			?? live.find((session) => session.id === browserSession.latestSessionId)?.id
			?? live[0]?.id;
	}

	private browserSession(browserSessionId?: string): BrowserAutomationSession {
		return browserSessionId ? this.browserSessions.get(browserSessionId) : this.browserSessions.selectedSession();
	}

	private firstActiveSessionId(browserSessionId?: string): string | undefined {
		return this.preferredImplicitSessionId(Array.from(this.sessions.values()), this.browserSession(browserSessionId));
	}

	private pruneDisconnectedSessions(now = Date.now()): void {
		const retained: Array<{ id: string; disconnectedAt: number }> = [];
		for (const [id, session] of this.sessions) {
			const disconnectedAt = session.disconnectedAt;
			if (typeof disconnectedAt !== "number") continue;
			if (now - disconnectedAt >= DISCONNECTED_SESSION_RETENTION_MS) {
				this.sessions.delete(id);
				continue;
			}
			retained.push({ id, disconnectedAt });
		}
		const overflow = retained.length - MAX_DISCONNECTED_SESSION_HISTORY;
		if (overflow <= 0) return;
		retained
			.sort((a, b) => a.disconnectedAt - b.disconnectedAt || a.id.localeCompare(b.id))
			.slice(0, overflow)
			.forEach((item) => this.sessions.delete(item.id));
	}
}
