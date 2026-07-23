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
	private readonly isOpenClient: (client: TClient) => boolean;
	private session: SessionAutomationSession<TClient>;

	constructor(options: { isOpenClient?: (client: TClient) => boolean } = {}) {
		this.isOpenClient = options.isOpenClient ?? (() => true);
		this.session = this.newSession();
	}

	clear(): void {
		this.session = this.newSession();
	}

	defaultSession(): SessionAutomationSession<TClient> {
		return this.session;
	}

	require(sessionId?: string): SessionAutomationSession<TClient> {
		const id = String(sessionId || DEFAULT_BROWSER_SESSION_ID).trim() || DEFAULT_BROWSER_SESSION_ID;
		if (id !== DEFAULT_BROWSER_SESSION_ID) throw new SessionKernelError("SESSION_NOT_FOUND", "Browser Pilot supports one browser session", { browserSessionId: id });
		this.session.lastSeenAt = Date.now();
		return this.session;
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
		if (this.session.selectedClient === client) this.session.selectedClient = undefined;
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

	private newSession(): SessionAutomationSession<TClient> {
		const now = Date.now();
		return {
			id: DEFAULT_BROWSER_SESSION_ID,
			name: "default",
			createdAt: now,
			lastSeenAt: now,
			selectionVersion: 0,
		};
	}
}
