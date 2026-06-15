import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { BrowserBridgeError, targetHandleNotFoundError } from "../protocol/errors.js";
import { browserTabInfo, isOpen, recordValue, tabSessionSummary, toTabId } from "./bridgeUtils.js";
import type { BrowserAutomationSession, BrowserAutomationSessionInfo, BrowserBridgeTargetInfo, BrowserBridgeTargetSource, BrowserTabInfo, BrowserTabSession } from "./types.js";
import type { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry.js";
import { DEFAULT_BROWSER_SESSION_ID, type SessionRegistry } from "../../kernels/session/index.js";

const DISCONNECTED_SESSION_RETENTION_MS = 5 * 60_000;
const MAX_DISCONNECTED_SESSION_HISTORY = 128;
const MAX_REPLACEMENT_RECORDS = 64;
const REPLACEMENT_TTL_MS = 5 * 60_000;
const MAX_REPLACEMENT_HOPS = 3;

type ReplacementRecord = {
	browserId: string;
	from: number;
	to: number;
	at: number;
	fromSessionId: string;
	toSessionId: string;
	tabHandle?: string;
};

type ReplacementResolution = {
	tabId: number;
	replacedFrom?: number;
	replacedByTabId?: number;
	replacementHops?: number;
	tabHandle?: string;
};

type ReconnectIdentity = Pick<BrowserTabSession, "logicalTabId" | "tabHandle" | "generation" | "openerTabId"> & {
	previousSessionId: string;
	previousClient: WebSocket;
};

type TargetInfoExtras = Partial<Pick<BrowserBridgeTargetInfo, "tabHandle" | "targetRef" | "requestedTabId" | "replacedFrom" | "replacedByTabId" | "replacementHops" | "browserId" | "openerTabId">>;

export class BrowserTabSessionRouter {
	readonly sessions = new Map<string, BrowserTabSession>();
	private readonly clients: BrowserBridgeClientRegistry;
	private readonly browserSessions: SessionRegistry<WebSocket>;
	private lastTabSyncAtValue?: number;
	private readonly replacements = new Map<string, ReplacementRecord>();
	private readonly pendingReplacementIdentities = new Map<string, Pick<BrowserTabSession, "logicalTabId" | "tabHandle" | "generation" | "openerTabId"> & { replacedFromTabId: number; replacedAt: number }>();

	constructor(clients: BrowserBridgeClientRegistry, browserSessions: SessionRegistry<WebSocket>) {
		this.clients = clients;
		this.browserSessions = browserSessions;
	}

	get selectionVersion(): number {
		return this.browserSession().selectionVersion;
	}

	get lastTabSyncAt(): number | undefined {
		return this.lastTabSyncAtValue;
	}

	clear(): void {
		this.sessions.clear();
		this.replacements.clear();
		this.pendingReplacementIdentities.clear();
		this.lastTabSyncAtValue = undefined;
		const session = this.browserSession();
		this.setDefaultSessionId(session, undefined);
		this.setLatestSessionId(session, undefined);
	}

	targetInfo(source: BrowserBridgeTargetSource, tabId?: number, session = this.browserSession(), extras: TargetInfoExtras = {}): BrowserBridgeTargetInfo {
		const tab = this.targetSession(tabId, session);
		const url = tab?.url ?? this.targetUrl(tabId, session);
		return {
			browserSessionId: session.id,
			tabId,
			...(tab?.tabHandle ? { tabHandle: tab.tabHandle, targetRef: tab.tabHandle } : {}),
			...(tab?.browserId ? { browserId: tab.browserId } : {}),
			...(tab?.openerTabId !== undefined ? { openerTabId: tab.openerTabId } : {}),
			...extras,
			...(url ? { url } : {}),
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

	defaultTabHandle(browserSessionId?: string): string | undefined {
		return this.tabHandleForSessionId(this.browserSession(browserSessionId).defaultSessionId);
	}

	latestTabId(browserSessionId?: string): number | undefined {
		return this.tabIdForSessionId(this.browserSession(browserSessionId).latestSessionId);
	}

	latestTabHandle(browserSessionId?: string): string | undefined {
		return this.tabHandleForSessionId(this.browserSession(browserSessionId).latestSessionId);
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

	applyTabReplacements(rawReplacements: unknown[], ws: WebSocket, now = Date.now()): ReplacementRecord[] {
		this.pruneReplacements(now);
		const browserId = this.clients.browserIdForClient(ws);
		const applied: ReplacementRecord[] = [];
		for (const raw of rawReplacements) {
			const record = recordValue(raw);
			if (!record) continue;
			const from = toTabId(record.from ?? record.removedTabId ?? record.oldTabId);
			const to = toTabId(record.to ?? record.addedTabId ?? record.newTabId);
			if (!from || !to || from === to) continue;
			const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : now;
			const fromSessionId = this.sessionIdForTab(ws, from);
			const toSessionId = this.sessionIdForTab(ws, to);
			const oldSession = this.sessions.get(fromSessionId);
			const existingNewSession = this.sessions.get(toSessionId);
			const identity = oldSession ? {
				logicalTabId: oldSession.logicalTabId,
				tabHandle: oldSession.tabHandle,
				generation: oldSession.generation,
				openerTabId: oldSession.openerTabId,
				replacedFromTabId: from,
				replacedAt: at,
			} : undefined;
			if (identity) this.pendingReplacementIdentities.set(toSessionId, identity);
			if (oldSession && !oldSession.disconnectedAt) oldSession.disconnectedAt = now;
			if (existingNewSession && identity) {
				this.sessions.set(toSessionId, {
					...existingNewSession,
					logicalTabId: identity.logicalTabId,
					tabHandle: identity.tabHandle,
					generation: identity.generation,
					openerTabId: existingNewSession.openerTabId ?? identity.openerTabId,
					replacedFromTabId: from,
					replacedAt: at,
				});
			}
			const replacement: ReplacementRecord = { browserId, from, to, at, fromSessionId, toSessionId, ...(identity?.tabHandle ? { tabHandle: identity.tabHandle } : {}) };
			this.replacements.set(this.replacementKey(browserId, from), replacement);
			applied.push(replacement);
			for (const browserSession of this.browserSessions.list()) {
				if (browserSession.defaultSessionId === fromSessionId) this.setDefaultSessionId(browserSession, toSessionId);
				if (browserSession.latestSessionId === fromSessionId) this.setLatestSessionId(browserSession, toSessionId);
			}
		}
		this.pruneReplacements(now);
		this.refreshSelectedSessionRefs(now);
		return applied;
	}

	updateTabs(rawTabs: unknown[], ws: WebSocket): void {
		const now = Date.now();
		this.lastTabSyncAtValue = now;
		const current = new Set<string>();
		const browserId = this.clients.browserIdForClient(ws);
		const clientInfo = this.clients.info(ws);
		for (const raw of rawTabs) {
			const tab = recordValue(raw);
			if (!tab) continue;
			const tabId = toTabId(tab.id ?? tab.tabId);
			if (!tabId) continue;
			const id = this.sessionIdForTab(ws, tabId);
			current.add(id);
			const existing = this.sessions.get(id);
			const replacementIdentity = this.pendingReplacementIdentities.get(id);
			const reconnectIdentity = (!existing && !replacementIdentity) ? this.findReconnectIdentity(tabId, clientInfo?.extensionId, tab, now) : undefined;
			const identity = replacementIdentity ?? existing ?? reconnectIdentity ?? this.newIdentity(browserId);
			this.pendingReplacementIdentities.delete(id);
			this.sessions.set(id, {
				id,
				browserId,
				tabId,
				logicalTabId: identity.logicalTabId,
				tabHandle: identity.tabHandle,
				generation: identity.generation,
				url: typeof tab.url === "string" ? tab.url : existing?.url || "",
				title: typeof tab.title === "string" ? tab.title : existing?.title || "",
				active: typeof tab.active === "boolean" ? tab.active : existing?.active,
				windowId: toTabId(tab.windowId) ?? existing?.windowId,
				openerTabId: toTabId(tab.openerTabId) ?? replacementIdentity?.openerTabId ?? reconnectIdentity?.openerTabId ?? existing?.openerTabId,
				...(replacementIdentity ? { replacedFromTabId: replacementIdentity.replacedFromTabId, replacedAt: replacementIdentity.replacedAt } : existing?.replacedFromTabId ? { replacedFromTabId: existing.replacedFromTabId, replacedAt: existing.replacedAt } : {}),
				incognito: typeof tab.incognito === "boolean" ? tab.incognito : existing?.incognito,
				type: "ext_ws",
				connectedAt: existing?.connectedAt || now,
				bridge: this.clients.info(ws),
				client: ws,
			});
			if (reconnectIdentity && reconnectIdentity.previousSessionId !== id) {
				const previous = this.sessions.get(reconnectIdentity.previousSessionId);
				if (previous && !previous.disconnectedAt) previous.disconnectedAt = now;
				for (const browserSession of this.browserSessions.list()) {
					if (browserSession.selectedClient === reconnectIdentity.previousClient) this.browserSessions.selectClient(browserSession, ws);
					if (browserSession.defaultSessionId === reconnectIdentity.previousSessionId) this.setDefaultSessionId(browserSession, id);
					if (browserSession.latestSessionId === reconnectIdentity.previousSessionId) this.setLatestSessionId(browserSession, id);
				}
			}
			for (const browserSession of this.browserSessions.list()) {
				const selected = this.browserSessions.selectedOpenClient(browserSession);
				if (selected && selected !== ws) continue;
				if (tab.active === true || !browserSession.defaultSessionId) this.setDefaultSessionId(browserSession, id);
				this.setLatestSessionId(browserSession, id);
			}
		}
		for (const [id, session] of this.sessions) {
			if (!current.has(id) && session.client === ws && !session.disconnectedAt) session.disconnectedAt = now;
		}
		this.refreshSelectedSessionRefs();
	}

	recordTabActivation(rawActivation: unknown, ws: WebSocket, now = Date.now()): void {
		const activation = recordValue(rawActivation);
		if (!activation) return;
		const tabId = toTabId(activation.tabId);
		if (!tabId) return;
		const session = this.sessions.get(this.sessionIdForTab(ws, tabId));
		if (!session || session.disconnectedAt) return;
		session.active = true;
		session.windowId = toTabId(activation.windowId) ?? session.windowId;
		session.activatedAt = typeof activation.at === "number" && Number.isFinite(activation.at) ? activation.at : now;
		for (const other of this.sessions.values()) {
			if (other.id !== session.id && other.client === ws && other.windowId === session.windowId) other.active = false;
		}
		for (const browserSession of this.browserSessions.list()) {
			const selected = this.browserSessions.selectedOpenClient(browserSession);
			if (selected && selected !== ws) continue;
			this.setDefaultSessionId(browserSession, session.id);
			this.setLatestSessionId(browserSession, session.id);
		}
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
			defaultTabHandle: this.tabHandleForSessionId(session.defaultSessionId),
			latestTabId: this.tabIdForSessionId(session.latestSessionId),
			latestTabHandle: this.tabHandleForSessionId(session.latestSessionId),
			selectionVersion: session.selectionVersion,
			createdAt: session.createdAt,
			lastSeenAt: session.lastSeenAt,
			selectedBrowser,
		};
	}

	resolveTargetRef(value: unknown, browserSessionId?: string, source: BrowserBridgeTargetSource = "explicit"): BrowserBridgeTargetInfo | undefined {
		if (value === undefined) return undefined;
		const normalizedValue = this.targetRefValue(value);
		const browserSession = this.browserSession(browserSessionId);
		const handle = this.normalizeTabHandle(normalizedValue);
		if (handle) {
			const session = this.liveSessionForHandle(handle, browserSessionId);
			if (!session) {
				throw targetHandleNotFoundError({
					tabHandle: handle,
					browserSessionId: browserSession.id,
					tabs: this.getTabs(),
				});
			}
			return this.targetInfo(source, session.tabId, browserSession, { tabHandle: session.tabHandle, targetRef: session.tabHandle });
		}
		const sessionId = this.normalizeTabSessionId(normalizedValue);
		if (sessionId) {
			const session = this.liveSessionForTabSessionId(sessionId, browserSessionId);
			if (!session) {
				throw targetHandleNotFoundError({
					tabHandle: sessionId,
					browserSessionId: browserSession.id,
					tabs: this.getTabs(),
				});
			}
			return this.targetInfo(source, session.tabId, browserSession, { tabHandle: session.tabHandle, targetRef: session.tabHandle });
		}
		const requestedTabId = toTabId(normalizedValue);
		if (!requestedTabId) return undefined;
		const resolved = this.resolveNumericTabId(requestedTabId, browserSessionId);
		return this.targetInfo(source, resolved.tabId, browserSession, {
			...(requestedTabId !== resolved.tabId ? { requestedTabId } : {}),
			...(resolved.replacedFrom !== undefined ? { replacedFrom: resolved.replacedFrom } : {}),
			...(resolved.replacedByTabId !== undefined ? { replacedByTabId: resolved.replacedByTabId } : {}),
			...(resolved.replacementHops !== undefined ? { replacementHops: resolved.replacementHops } : {}),
			...(resolved.tabHandle ? { tabHandle: resolved.tabHandle, targetRef: resolved.tabHandle } : {}),
		});
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
		const isDefaultValid = (session: BrowserTabSession | undefined) => !!session && !session.disconnectedAt && (!scopeClient || session.client === scopeClient);
		const isLatestValid = (session: BrowserTabSession | undefined) => !!session && !session.disconnectedAt;
		const defaultSession = browserSession.defaultSessionId ? this.sessions.get(browserSession.defaultSessionId) : undefined;
		if (!browserSession.defaultSessionId || !isDefaultValid(defaultSession)) this.setDefaultSessionId(browserSession, firstActive);
		const latestSession = browserSession.latestSessionId ? this.sessions.get(browserSession.latestSessionId) : undefined;
		if (!browserSession.latestSessionId || !isLatestValid(latestSession)) this.setLatestSessionId(browserSession, firstActive);
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

	private tabHandleForSessionId(sessionId: string | undefined): string | undefined {
		if (!sessionId) return undefined;
		return this.sessions.get(sessionId)?.tabHandle;
	}

	private newIdentity(browserId: string): Pick<BrowserTabSession, "logicalTabId" | "tabHandle" | "generation"> {
		const logicalTabId = randomUUID().replace(/-/g, "").slice(0, 16);
		const browserPart = String(browserId || "browser").replace(/[^a-zA-Z0-9]+/g, "").slice(0, 24) || "browser";
		return {
			logicalTabId,
			tabHandle: `tabh_${browserPart}_${logicalTabId}_g1`,
			generation: 1,
		};
	}

	/**
	 * When an extension reconnects (new browserId, same extensionId, same numeric tabId),
	 * attempt to rebind the logical identity from previous sessions that match
	 * the same extensionId and tabId. The previous socket may still be open when the new
	 * ready message wins the race; in that overlap case require matching tab facts before
	 * updateTabs marks it disconnected after adopting its handle. Returns undefined when
	 * extensionId is unknown, or when candidates disagree on the logical handle — mint
	 * fresh in those cases.
	 */
	private findReconnectIdentity(
		tabId: number,
		extensionId: string | undefined,
		tab: Record<string, unknown>,
		now = Date.now(),
	): ReconnectIdentity | undefined {
		if (!extensionId) return undefined;
		const candidates = Array.from(this.sessions.values()).filter(
			(session) =>
				session.tabId === tabId &&
				session.bridge?.extensionId === extensionId,
		).filter((session) => this.reconnectCandidateMatches(session, tab, now));
		if (!candidates.length) return undefined;
		if (new Set(candidates.map((session) => session.tabHandle)).size !== 1) return undefined;
		const liveCandidates = candidates.filter((session) => session.disconnectedAt === undefined);
		if (liveCandidates.length > 1) return undefined;
		const c = liveCandidates[0] ?? candidates
			.slice()
			.sort((a, b) => (b.disconnectedAt ?? 0) - (a.disconnectedAt ?? 0) || b.connectedAt - a.connectedAt)[0]!;
		return {
			logicalTabId: c.logicalTabId,
			tabHandle: c.tabHandle,
			generation: c.generation,
			openerTabId: c.openerTabId,
			previousSessionId: c.id,
			previousClient: c.client,
		};
	}

	private reconnectCandidateMatches(session: BrowserTabSession, tab: Record<string, unknown>, now: number): boolean {
		if (session.disconnectedAt !== undefined) return now - session.disconnectedAt < DISCONNECTED_SESSION_RETENTION_MS;
		if (!isOpen(session.client)) return false;
		const incomingUrl = typeof tab.url === "string" ? tab.url : "";
		if (!incomingUrl || !session.url || session.url !== incomingUrl) return false;
		const incomingWindowId = toTabId(tab.windowId);
		if (incomingWindowId !== undefined && session.windowId !== undefined && incomingWindowId !== session.windowId) return false;
		return true;
	}

	private normalizeTabHandle(value: unknown): string | undefined {
		if (typeof value !== "string") return undefined;
		const trimmed = value.trim();
		return /^tabh_[A-Za-z0-9]+_[A-Za-z0-9]+_g\d+$/.test(trimmed) ? trimmed : undefined;
	}

	private targetRefValue(value: unknown): unknown {
		const record = recordValue(value);
		if (!record) return value;
		const createdTarget = recordValue(record.createdTarget);
		const createdTab = recordValue(record.createdTab);
		const target = recordValue(record.target);
		const tab = recordValue(record.tab);
		const data = recordValue(record.data);
		return record.targetRef ?? record.tabHandle
			?? createdTarget?.targetRef ?? createdTarget?.tabHandle ?? createdTarget?.tabId
			?? createdTab?.targetRef ?? createdTab?.tabHandle ?? createdTab?.tabId
			?? target?.targetRef ?? target?.tabHandle ?? target?.tabId
			?? tab?.targetRef ?? tab?.tabHandle ?? tab?.tabId
			?? data?.targetRef ?? data?.tabHandle ?? data?.tabId
			?? record.tabId
			?? record.id
			?? value;
	}

	private normalizeTabSessionId(value: unknown): string | undefined {
		if (typeof value !== "string") return undefined;
		const trimmed = value.trim();
		return /^[^:\s]+:\d+$/.test(trimmed) ? trimmed : undefined;
	}

	private liveSessionForHandle(tabHandle: string, browserSessionId?: string): BrowserTabSession | undefined {
		const live = Array.from(this.sessions.values()).filter((session) => session.tabHandle === tabHandle && !session.disconnectedAt && isOpen(session.client));
		const scopeClient = this.browserSessions.selectedOpenClient(this.browserSession(browserSessionId));
		const scoped = scopeClient ? live.find((session) => session.client === scopeClient) : undefined;
		if (scoped) return scoped;
		if (live.length <= 1) return live[0];
		throw new BrowserBridgeError("AMBIGUOUS_TAB_ID", "Multiple connected browsers expose the same tabHandle; call browser_tabs selectBrowser before using this target reference", {
			tabHandle,
			tabs: live.map(tabSessionSummary),
		});
	}

	private liveSessionForTabSessionId(tabSessionId: string, browserSessionId?: string): BrowserTabSession | undefined {
		const live = Array.from(this.sessions.values()).filter((session) => session.id === tabSessionId && !session.disconnectedAt && isOpen(session.client));
		const scopeClient = this.browserSessions.selectedOpenClient(this.browserSession(browserSessionId));
		const scoped = scopeClient ? live.find((session) => session.client === scopeClient) : undefined;
		return scoped ?? live[0];
	}

	private targetSession(tabId: number | undefined, browserSession: BrowserAutomationSession): BrowserTabSession | undefined {
		if (tabId === undefined) return undefined;
		const live = Array.from(this.sessions.values()).filter((session) => session.tabId === tabId && !session.disconnectedAt && isOpen(session.client));
		const scopeClient = this.browserSessions.selectedOpenClient(browserSession);
		const scoped = scopeClient ? live.find((session) => session.client === scopeClient) : undefined;
		return scoped ?? (live.length === 1 ? live[0] : undefined);
	}

	private targetUrl(tabId: number | undefined, browserSession: BrowserAutomationSession): string | undefined {
		if (tabId === undefined) return undefined;
		return this.targetSession(tabId, browserSession)?.url || undefined;
	}

	private preferredImplicitSessionId(candidates: BrowserTabSession[], browserSession: BrowserAutomationSession): string | undefined {
		const live = candidates.filter((session) => !session.disconnectedAt);
		return live.find((session) => session.id === browserSession.latestSessionId)?.id
			?? live.find((session) => session.active === true)?.id
			?? live[0]?.id;
	}

	private browserSession(browserSessionId?: string): BrowserAutomationSession {
		return browserSessionId ? this.browserSessions.require(browserSessionId) : this.browserSessions.selectedSession();
	}

	private firstActiveSessionId(browserSessionId?: string): string | undefined {
		return this.preferredImplicitSessionId(Array.from(this.sessions.values()), this.browserSession(browserSessionId));
	}

	private replacementKey(browserId: string, tabId: number): string {
		return `${browserId}:${tabId}`;
	}

	private replacementCandidates(tabId: number, browserSessionId?: string): ReplacementRecord[] {
		const browserSession = this.browserSession(browserSessionId);
		const selected = this.browserSessions.selectedOpenClient(browserSession);
		return Array.from(this.replacements.values()).filter((replacement) => {
			if (replacement.from !== tabId) return false;
			if (!selected) return true;
			const session = this.sessions.get(replacement.toSessionId) ?? this.sessions.get(replacement.fromSessionId);
			return session?.client === selected;
		});
	}

	private resolveNumericTabId(tabId: number, browserSessionId?: string): ReplacementResolution {
		const live = this.liveSessionForTabId(tabId, browserSessionId);
		if (live) return { tabId, tabHandle: live.tabHandle };
		let current = tabId;
		let hops = 0;
		let handle: string | undefined;
		while (hops < MAX_REPLACEMENT_HOPS) {
			const candidates = this.replacementCandidates(current, browserSessionId);
			if (candidates.length !== 1) break;
			const next = candidates[0]!;
			hops += 1;
			current = next.to;
			handle = next.tabHandle ?? handle;
			const liveNext = this.liveSessionForTabId(current, browserSessionId);
			if (liveNext) {
				return {
					tabId: liveNext.tabId,
					replacedFrom: tabId,
					replacedByTabId: liveNext.tabId,
					replacementHops: hops,
					tabHandle: liveNext.tabHandle ?? handle,
				};
			}
		}
		return { tabId };
	}

	replacedByTabId(tabId: number, browserSessionId?: string): number | undefined {
		const resolved = this.resolveNumericTabId(tabId, browserSessionId);
		return resolved.tabId !== tabId ? resolved.tabId : undefined;
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

	private pruneReplacements(now = Date.now()): void {
		for (const [key, replacement] of this.replacements) {
			if (now - replacement.at >= REPLACEMENT_TTL_MS) this.replacements.delete(key);
		}
		for (const [key, identity] of this.pendingReplacementIdentities) {
			if (now - identity.replacedAt >= REPLACEMENT_TTL_MS) this.pendingReplacementIdentities.delete(key);
		}
		const overflow = this.replacements.size - MAX_REPLACEMENT_RECORDS;
		if (overflow > 0) {
			Array.from(this.replacements.entries())
				.sort((a, b) => a[1].at - b[1].at || a[0].localeCompare(b[0]))
				.slice(0, overflow)
				.forEach(([key]) => this.replacements.delete(key));
		}
		const pendingOverflow = this.pendingReplacementIdentities.size - MAX_REPLACEMENT_RECORDS;
		if (pendingOverflow > 0) {
			Array.from(this.pendingReplacementIdentities.entries())
				.sort((a, b) => a[1].replacedAt - b[1].replacedAt || a[0].localeCompare(b[0]))
				.slice(0, pendingOverflow)
				.forEach(([key]) => this.pendingReplacementIdentities.delete(key));
		}
	}
}
