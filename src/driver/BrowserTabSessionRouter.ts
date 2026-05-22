import { WebSocket } from "ws";
import { BrowserBridgeError } from "./errors";
import { browserTabInfo, isOpen, tabSessionSummary, toTabId } from "./bridgeUtils";
import type { BrowserBridgeClientInfo, BrowserBridgeTargetInfo, BrowserBridgeTargetSource, BrowserTabInfo, BrowserTabSession } from "./types";
import type { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry";

const DISCONNECTED_SESSION_RETENTION_MS = 5 * 60_000;
const MAX_DISCONNECTED_SESSION_HISTORY = 128;

export class BrowserTabSessionRouter {
	readonly sessions = new Map<string, BrowserTabSession>();
	private readonly clients: BrowserBridgeClientRegistry;
	private defaultSessionId?: string;
	private latestSessionId?: string;
	private selectionVersionValue = 0;

	constructor(clients: BrowserBridgeClientRegistry) {
		this.clients = clients;
	}

	get selectionVersion(): number {
		return this.selectionVersionValue;
	}

	clear(): void {
		this.sessions.clear();
		this.setDefaultSessionId(undefined);
		this.setLatestSessionId(undefined);
	}

	targetInfo(source: BrowserBridgeTargetSource, tabId?: number, metadata: Partial<Omit<BrowserBridgeTargetInfo, "tabId" | "source" | "implicit" | "selectionVersionAtDispatch" | "selectionVersionAtResolve">> = {}): BrowserBridgeTargetInfo {
		return {
			tabId,
			...metadata,
			source,
			implicit: source === "default" || source === "latest",
			selectionVersionAtDispatch: this.selectionVersionValue,
		};
	}

	resolvedTarget(target: BrowserBridgeTargetInfo | undefined): BrowserBridgeTargetInfo | undefined {
		return target ? { ...target, selectionVersionAtResolve: this.selectionVersionValue } : undefined;
	}

	defaultTabId(): number | undefined {
		return this.tabIdForSessionId(this.defaultSessionId);
	}

	latestTabId(): number | undefined {
		return this.tabIdForSessionId(this.latestSessionId);
	}

	markClientDisconnected(ws: WebSocket): void {
		for (const session of this.sessions.values()) {
			if (session.client === ws && !session.disconnectedAt) session.disconnectedAt = Date.now();
		}
		this.refreshSelectedSessionRefs();
	}

	markTabDisconnected(tabId: number, browserId?: string): void {
		const session = this.liveSessionForTabTarget(tabId, browserId);
		if (session && !session.disconnectedAt) session.disconnectedAt = Date.now();
		this.refreshSelectedSessionRefs();
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
				groupId: toTabId(tab.groupId) ?? existing?.groupId,
				profileId: this.clients.info(ws)?.profileId || existing?.profileId,
				type: "ext_ws",
				connectedAt: existing?.connectedAt || now,
				bridge: this.clients.info(ws),
				client: ws,
			});
			if (tab.active === true || !this.defaultSessionId) this.setDefaultSessionId(id);
			this.setLatestSessionId(id);
		}
		for (const [id, session] of this.sessions) {
			if (!current.has(id) && session.client === ws && !session.disconnectedAt) session.disconnectedAt = now;
		}
		this.refreshSelectedSessionRefs();
	}

	selectBrowser(ws: WebSocket): string | undefined {
		const sessionId = this.firstActiveSessionIdForClient(ws);
		this.setDefaultSessionId(sessionId);
		this.setLatestSessionId(sessionId);
		return sessionId;
	}

	selectTab(tabId: number, browserId?: string): void {
		const selectedSession = this.liveSessionForTabTarget(tabId, browserId);
		if (selectedSession) this.setDefaultSessionId(selectedSession.id);
	}

	previousDefaultTabId(): number | undefined {
		return this.tabIdForSessionId(this.defaultSessionId);
	}

	liveSessionForTabTarget(tabId: number, browserId?: string, profileId?: string): BrowserTabSession | undefined {
		const live = Array.from(this.sessions.values()).filter((session) => session.tabId === tabId && !session.disconnectedAt && isOpen(session.client) && (!profileId || session.profileId === profileId));
		if (browserId) return live.find((session) => session.browserId === browserId || session.bridge?.extensionId === browserId || session.bridge?.id === browserId);
		const scopeClient = this.clients.selectedOpenClient();
		const scoped = scopeClient ? live.find((session) => session.client === scopeClient) : undefined;
		if (scoped) return scoped;
		if (live.length <= 1) return live[0];
		throw new BrowserBridgeError("AMBIGUOUS_TAB_ID", "Multiple connected browsers expose the same tabId; call browser_tabs selectBrowser before using this tabId", {
			tabId,
			tabs: live.map(tabSessionSummary),
		});
	}

	liveSessionForTabId(tabId: number): BrowserTabSession | undefined {
		return this.liveSessionForTabTarget(tabId);
	}

	socketForTabTarget(tabId: number, browserId?: string, profileId?: string): WebSocket | undefined {
		return this.liveSessionForTabTarget(tabId, browserId, profileId)?.client;
	}

	socketForTab(tabId: number): WebSocket | undefined {
		return this.socketForTabTarget(tabId);
	}

	fallbackExecutionTarget(): BrowserBridgeTargetInfo | undefined {
		this.refreshSelectedSessionRefs();
		const defaultTabId = this.tabIdForSessionId(this.defaultSessionId);
		if (defaultTabId) return this.targetInfo("default", defaultTabId);
		const latestTabId = this.tabIdForSessionId(this.latestSessionId);
		if (latestTabId) return this.targetInfo("latest", latestTabId);
		return undefined;
	}

	firstActiveSessionIdForClient(client: WebSocket): string | undefined {
		return this.preferredImplicitSessionId(Array.from(this.sessions.values()).filter((session) => session.client === client));
	}

	refreshSelectedSessionRefs(now = Date.now()): void {
		this.pruneDisconnectedSessions(now);
		const scopeClient = this.clients.selectedOpenClient();
		const firstActive = scopeClient ? this.firstActiveSessionIdForClient(scopeClient) : this.firstActiveSessionId();
		const isValid = (session: BrowserTabSession | undefined) => !!session && !session.disconnectedAt && (!scopeClient || session.client === scopeClient);
		const defaultSession = this.defaultSessionId ? this.sessions.get(this.defaultSessionId) : undefined;
		if (!this.defaultSessionId || !isValid(defaultSession)) this.setDefaultSessionId(firstActive);
		const latestSession = this.latestSessionId ? this.sessions.get(this.latestSessionId) : undefined;
		if (!this.latestSessionId || !isValid(latestSession)) this.setLatestSessionId(firstActive);
	}

	private setDefaultSessionId(id: string | undefined): void {
		if (this.defaultSessionId === id) return;
		this.defaultSessionId = id;
		this.selectionVersionValue += 1;
	}

	private setLatestSessionId(id: string | undefined): void {
		if (this.latestSessionId === id) return;
		this.latestSessionId = id;
		this.selectionVersionValue += 1;
	}

	private sessionIdForTab(client: WebSocket, tabId: number): string {
		return `${this.clients.browserIdForClient(client)}:${tabId}`;
	}

	private tabIdForSessionId(sessionId: string | undefined): number | undefined {
		if (!sessionId) return undefined;
		return this.sessions.get(sessionId)?.tabId;
	}

	private preferredImplicitSessionId(candidates: BrowserTabSession[]): string | undefined {
		const live = candidates.filter((session) => !session.disconnectedAt);
		return live.find((session) => session.active === true)?.id
			?? live.find((session) => session.id === this.latestSessionId)?.id
			?? live[0]?.id;
	}

	private firstActiveSessionId(): string | undefined {
		return this.preferredImplicitSessionId(Array.from(this.sessions.values()));
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
