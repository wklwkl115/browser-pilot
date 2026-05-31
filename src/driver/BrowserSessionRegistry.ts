import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { BrowserBridgeError } from "./errors.js";
import { isOpen } from "./bridgeUtils.js";
import type { BrowserAutomationSession, BrowserBridgeClientInfo } from "./types.js";
import type { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry.js";

export const DEFAULT_BROWSER_SESSION_ID = "default";

export class BrowserSessionRegistry {
	private readonly sessions = new Map<string, BrowserAutomationSession>();
	private selectedSessionId = DEFAULT_BROWSER_SESSION_ID;

	constructor() {
		this.ensureDefaultSession();
	}

	clear(): void {
		this.sessions.clear();
		this.selectedSessionId = DEFAULT_BROWSER_SESSION_ID;
		this.ensureDefaultSession();
	}

	defaultSession(): BrowserAutomationSession {
		return this.ensureDefaultSession();
	}

	selectedSession(): BrowserAutomationSession {
		return this.require(this.selectedSessionId);
	}

	selectSession(sessionId: string): BrowserAutomationSession {
		const session = this.require(sessionId);
		this.selectedSessionId = session.id;
		session.lastSeenAt = Date.now();
		return session;
	}

	create(name?: string): BrowserAutomationSession {
		const now = Date.now();
		const session: BrowserAutomationSession = {
			id: randomUUID(),
			name: typeof name === "string" && name.trim() ? name.trim() : undefined,
			createdAt: now,
			lastSeenAt: now,
			selectionVersion: 0,
		};
		this.sessions.set(session.id, session);
		return session;
	}

	close(sessionId: string): BrowserAutomationSession | undefined {
		const id = String(sessionId || "").trim();
		if (!id || id === DEFAULT_BROWSER_SESSION_ID) return undefined;
		const session = this.sessions.get(id);
		if (!session) return undefined;
		this.sessions.delete(id);
		if (this.selectedSessionId === id) this.selectedSessionId = DEFAULT_BROWSER_SESSION_ID;
		return session;
	}

	list(): BrowserAutomationSession[] {
		this.ensureDefaultSession();
		return Array.from(this.sessions.values()).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	require(sessionId = this.selectedSessionId): BrowserAutomationSession {
		const id = String(sessionId || this.selectedSessionId || DEFAULT_BROWSER_SESSION_ID).trim() || DEFAULT_BROWSER_SESSION_ID;
		if (id === DEFAULT_BROWSER_SESSION_ID) return this.ensureDefaultSession();
		const session = this.sessions.get(id);
		if (!session) throw new BrowserBridgeError("SESSION_NOT_FOUND", "Requested browser session was not found", { browserSessionId: id, sessions: this.list().map((item) => ({ id: item.id, name: item.name })) });
		session.lastSeenAt = Date.now();
		return session;
	}

	getIfExists(sessionId = this.selectedSessionId): BrowserAutomationSession | undefined {
		const id = String(sessionId || this.selectedSessionId || DEFAULT_BROWSER_SESSION_ID).trim() || DEFAULT_BROWSER_SESSION_ID;
		if (id === DEFAULT_BROWSER_SESSION_ID) return this.ensureDefaultSession();
		const session = this.sessions.get(id);
		if (!session) return undefined;
		session.lastSeenAt = Date.now();
		return session;
	}

	selectClient(session: BrowserAutomationSession, ws: WebSocket | undefined): void {
		session.selectedClient = ws;
		session.lastSeenAt = Date.now();
	}

	selectedOpenClient(session: BrowserAutomationSession): WebSocket | undefined {
		return isOpen(session.selectedClient) ? session.selectedClient : undefined;
	}

	selectedInfo(session: BrowserAutomationSession, clients: BrowserBridgeClientRegistry): BrowserBridgeClientInfo | undefined {
		return session.selectedClient ? clients.info(session.selectedClient) : undefined;
	}

	markClientDisconnected(ws: WebSocket): void {
		for (const session of this.sessions.values()) {
			if (session.selectedClient === ws) session.selectedClient = undefined;
		}
	}

	setDefaultTabSessionId(session: BrowserAutomationSession, id: string | undefined): void {
		if (session.defaultSessionId === id) return;
		session.defaultSessionId = id;
		session.selectionVersion += 1;
		session.lastSeenAt = Date.now();
	}

	setLatestTabSessionId(session: BrowserAutomationSession, id: string | undefined): void {
		if (session.latestSessionId === id) return;
		session.latestSessionId = id;
		session.selectionVersion += 1;
		session.lastSeenAt = Date.now();
	}

	private ensureDefaultSession(): BrowserAutomationSession {
		const existing = this.sessions.get(DEFAULT_BROWSER_SESSION_ID);
		if (existing) {
			existing.lastSeenAt = Date.now();
			return existing;
		}
		const now = Date.now();
		const session: BrowserAutomationSession = {
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
