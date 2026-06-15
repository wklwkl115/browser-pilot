import { randomUUID } from "node:crypto";
import { SessionKernelError } from "./errors.js";

export const DEFAULT_BROWSER_SESSION_ID = "default";

export type SessionAutomationSession<TClient = unknown> = {
	id: string;
	name?: string;
	selectedClient?: TClient;
	defaultSessionId?: string;
	latestSessionId?: string;
	selectionVersion: number;
	createdAt: number;
	lastSeenAt: number;
};

export class SessionRegistry<TClient = unknown> {
	private readonly sessions = new Map<string, SessionAutomationSession<TClient>>();
	private readonly isOpenClient: (client: TClient) => boolean;
	private selectedSessionId = DEFAULT_BROWSER_SESSION_ID;

	constructor(options: { isOpenClient?: (client: TClient) => boolean } = {}) {
		this.isOpenClient = options.isOpenClient ?? (() => true);
		this.ensureDefaultSession();
	}

	clear(): void {
		this.sessions.clear();
		this.selectedSessionId = DEFAULT_BROWSER_SESSION_ID;
		this.ensureDefaultSession();
	}

	defaultSession(): SessionAutomationSession<TClient> {
		return this.ensureDefaultSession();
	}

	selectedSession(): SessionAutomationSession<TClient> {
		return this.require(this.selectedSessionId);
	}

	selectSession(sessionId: string): SessionAutomationSession<TClient> {
		const session = this.require(sessionId);
		this.selectedSessionId = session.id;
		session.lastSeenAt = Date.now();
		return session;
	}

	create(name?: string): SessionAutomationSession<TClient> {
		const now = Date.now();
		const session: SessionAutomationSession<TClient> = {
			id: randomUUID(),
			name: typeof name === "string" && name.trim() ? name.trim() : undefined,
			createdAt: now,
			lastSeenAt: now,
			selectionVersion: 0,
		};
		this.sessions.set(session.id, session);
		return session;
	}

	close(sessionId: string): SessionAutomationSession<TClient> | undefined {
		const id = String(sessionId || "").trim();
		if (!id || id === DEFAULT_BROWSER_SESSION_ID) return undefined;
		const session = this.sessions.get(id);
		if (!session) return undefined;
		this.sessions.delete(id);
		if (this.selectedSessionId === id) this.selectedSessionId = DEFAULT_BROWSER_SESSION_ID;
		return session;
	}

	list(): Array<SessionAutomationSession<TClient>> {
		this.ensureDefaultSession();
		return Array.from(this.sessions.values()).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	require(sessionId = this.selectedSessionId): SessionAutomationSession<TClient> {
		const id = String(sessionId || this.selectedSessionId || DEFAULT_BROWSER_SESSION_ID).trim() || DEFAULT_BROWSER_SESSION_ID;
		if (id === DEFAULT_BROWSER_SESSION_ID) return this.ensureDefaultSession();
		const session = this.sessions.get(id);
		if (!session) throw new SessionKernelError("SESSION_NOT_FOUND", "Requested browser session was not found", { browserSessionId: id, sessions: this.list().map((item) => ({ id: item.id, name: item.name })) });
		session.lastSeenAt = Date.now();
		return session;
	}

	getIfExists(sessionId = this.selectedSessionId): SessionAutomationSession<TClient> | undefined {
		const id = String(sessionId || this.selectedSessionId || DEFAULT_BROWSER_SESSION_ID).trim() || DEFAULT_BROWSER_SESSION_ID;
		if (id === DEFAULT_BROWSER_SESSION_ID) return this.ensureDefaultSession();
		const session = this.sessions.get(id);
		if (!session) return undefined;
		session.lastSeenAt = Date.now();
		return session;
	}

	selectClient(session: SessionAutomationSession<TClient>, client: TClient | undefined): void {
		session.selectedClient = client;
		session.lastSeenAt = Date.now();
	}

	selectedOpenClient(session: SessionAutomationSession<TClient>): TClient | undefined {
		return session.selectedClient && this.isOpenClient(session.selectedClient) ? session.selectedClient : undefined;
	}

	selectedInfo<TInfo>(session: SessionAutomationSession<TClient>, describe: (client: TClient) => TInfo | undefined): TInfo | undefined {
		return session.selectedClient ? describe(session.selectedClient) : undefined;
	}

	markClientDisconnected(client: TClient): void {
		for (const session of this.sessions.values()) {
			if (session.selectedClient === client) session.selectedClient = undefined;
		}
	}

	setDefaultTabSessionId(session: SessionAutomationSession<TClient>, id: string | undefined): void {
		if (session.defaultSessionId === id) return;
		session.defaultSessionId = id;
		session.selectionVersion += 1;
		session.lastSeenAt = Date.now();
	}

	setLatestTabSessionId(session: SessionAutomationSession<TClient>, id: string | undefined): void {
		if (session.latestSessionId === id) return;
		session.latestSessionId = id;
		session.selectionVersion += 1;
		session.lastSeenAt = Date.now();
	}

	private ensureDefaultSession(): SessionAutomationSession<TClient> {
		const existing = this.sessions.get(DEFAULT_BROWSER_SESSION_ID);
		if (existing) {
			existing.lastSeenAt = Date.now();
			return existing;
		}
		const now = Date.now();
		const session: SessionAutomationSession<TClient> = {
			id: DEFAULT_BROWSER_SESSION_ID,
			name: "default",
			createdAt: now,
			lastSeenAt: now,
			selectionVersion: 0,
		};
		this.sessions.set(session.id, session);
		return session;
	}
}
