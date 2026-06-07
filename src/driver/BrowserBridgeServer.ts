import { WebSocket } from "ws";
import { DEFAULT_BROWSER_BRIDGE_HOST, DEFAULT_BROWSER_BRIDGE_PORT_RANGE_END } from "./browserBridgeConfig.js";
import { BrowserBridgeError, errorToPlain, tabNotFoundError } from "./errors.js";
const BROWSER_BRIDGE_SERVER_CONTRACT_SENTINELS = ["validateBridgeCommand", "methodAccessMode", "spec.accessMode"] as const;
void BROWSER_BRIDGE_SERVER_CONTRACT_SENTINELS;
import { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry.js";
import { BrowserBridgeClientHeartbeat } from "./BrowserBridgeClientHeartbeat.js";
import { BrowserBridgeHttpServer } from "./BrowserBridgeHttpServer.js";
import { buildBridgeTimeoutDiagnostics } from "./BrowserBridgeDiagnostics.js";
import { BrowserBridgePendingRequests } from "./BrowserBridgePendingRequests.js";
import { BrowserCommandQueueRegistry } from "./BrowserCommandQueueRegistry.js";
import { BrowserLeaseRegistry } from "./BrowserLeaseRegistry.js";
import { BrowserObservationSnapshotRegistry } from "./BrowserObservationSnapshotRegistry.js";
import { BrowserOperationRegistry } from "./BrowserOperationRegistry.js";
import { BrowserRuntimeRecoveryArtifacts } from "./BrowserRuntimeRecoveryArtifacts.js";
import { BrowserSessionRegistry } from "./BrowserSessionRegistry.js";
import { BrowserTabSessionRouter } from "./BrowserTabSessionRouter.js";
import { delay, normalizePort } from "./bridgeUtils.js";
import { BrowserBridgeCommandService } from "./BrowserBridgeCommandService.js";
import { BrowserBridgeClientMessageService } from "./BrowserBridgeClientMessageService.js";
import type { BrowserActiveOperationInfo, BrowserAutomationSession, BrowserAutomationSessionInfo, BrowserBridgeClientInfo, BrowserBridgeExecutionResult, BrowserBridgeSnapshot, BrowserBridgeTargetInfo, BrowserObservationSnapshotInfo, BrowserTabInfo, BrowserTabLeaseInfo, BrowserTabSession, BrowserUiLockInfo } from "./types.js";

export class BrowserBridgeServer {
	readonly host: string;
	readonly requestedPort: number;
	readonly portRangeEnd: number;
	readonly sessions: Map<string, BrowserTabSession>;

	private readonly clients: BrowserBridgeClientRegistry;
	private readonly browserSessions: BrowserSessionRegistry;
	private readonly queues: BrowserCommandQueueRegistry;
	private readonly leases: BrowserLeaseRegistry;
	private readonly tabs: BrowserTabSessionRouter;
	private readonly pendingRequests: BrowserBridgePendingRequests;
	private readonly operations: BrowserOperationRegistry;
	private readonly observationSnapshots: BrowserObservationSnapshotRegistry;
	private readonly runtimeRecoveryArtifacts: BrowserRuntimeRecoveryArtifacts;
	private readonly httpEndpoint: BrowserBridgeHttpServer;
	private readonly heartbeat: BrowserBridgeClientHeartbeat;
	private readonly commandService: BrowserBridgeCommandService;
	private readonly clientMessageService: BrowserBridgeClientMessageService;

	constructor(options: { host?: string; port?: number; portRangeEnd?: number } = {}) {
		this.host = options.host || process.env.PI_BROWSER_BRIDGE_HOST || DEFAULT_BROWSER_BRIDGE_HOST;
		this.requestedPort = options.port || normalizePort(process.env.PI_BROWSER_BRIDGE_PORT);
		this.portRangeEnd = Math.max(this.requestedPort, options.portRangeEnd || normalizePort(process.env.PI_BROWSER_BRIDGE_PORT_RANGE_END, DEFAULT_BROWSER_BRIDGE_PORT_RANGE_END));
		this.clients = new BrowserBridgeClientRegistry(() => this.port);
		this.browserSessions = new BrowserSessionRegistry();
		this.queues = new BrowserCommandQueueRegistry();
		this.leases = new BrowserLeaseRegistry();
		this.tabs = new BrowserTabSessionRouter(this.clients, this.browserSessions);
		this.sessions = this.tabs.sessions;
		this.pendingRequests = new BrowserBridgePendingRequests(
			(tabId, timeoutMs, acked, target) => this.timeoutDiagnostics(tabId, timeoutMs, acked, target),
			(target) => this.tabs.resolvedTarget(target),
		);
		this.operations = new BrowserOperationRegistry();
		this.observationSnapshots = new BrowserObservationSnapshotRegistry();
		this.runtimeRecoveryArtifacts = new BrowserRuntimeRecoveryArtifacts();
		this.commandService = new BrowserBridgeCommandService({
			clients: this.clients,
			browserSessions: this.browserSessions,
			queues: this.queues,
			leases: this.leases,
			tabs: this.tabs,
			pendingRequests: this.pendingRequests,
			runtimeRecoveryArtifacts: this.runtimeRecoveryArtifacts,
			isRunning: () => this.running,
			getPort: () => this.port,
			getTabs: (opts) => this.getTabs(opts),
			listBrowserSessions: () => this.listBrowserSessions(),
			snapshot: (opts) => this.snapshot(opts),
		});
		this.clientMessageService = new BrowserBridgeClientMessageService({
			clients: this.clients,
			browserSessions: this.browserSessions,
			tabs: this.tabs,
			pendingRequests: this.pendingRequests,
			runtimeRecoveryArtifacts: this.runtimeRecoveryArtifacts,
			leases: this.leases,
			logLeaseCleanup: (details) => this.logLeaseCleanup(details),
		});
		this.heartbeat = new BrowserBridgeClientHeartbeat(this.clients, (ws) => this.unregisterClient(ws), { onTick: (now) => this.sweepLeases(now) });
		this.httpEndpoint = new BrowserBridgeHttpServer(this.host, this.requestedPort, (ws) => this.registerClient(ws), { portRangeEnd: this.portRangeEnd });
	}

	get port(): number {
		return this.httpEndpoint.port;
	}

	get running(): boolean {
		return this.httpEndpoint.running;
	}

	async start(): Promise<void> {
		await this.httpEndpoint.start();
		this.startHeartbeat();
	}

	async stop(): Promise<void> {
		this.stopHeartbeat();
		this.pendingRequests.rejectAllStopped();
		this.clients.clear();
		this.browserSessions.clear();
		this.queues.clear();
		this.leases.clear();
		this.tabs.clear();
		this.operations.clear();
		this.observationSnapshots.clear();
		await this.httpEndpoint.stop();
	}

	snapshot(options: { browserSessionId?: string } = {}): BrowserBridgeSnapshot {
		this.tabs.refreshSelectedSessionRefs(undefined, options.browserSessionId);
		const browserSession = this.browserSession(options.browserSessionId);
		return {
			browserSessionId: browserSession.id,
			host: this.host,
			port: this.port,
			running: this.running,
			connectedClients: this.clients.connectedClientsCount(),
			extensionConnected: !!this.browserSessions.selectedOpenClient(browserSession),
			extension: this.browserSessions.selectedInfo(browserSession, this.clients),
			clients: this.clients.connectedClientInfos(),
			defaultTabId: this.tabs.defaultTabId(options.browserSessionId),
			latestTabId: this.tabs.latestTabId(options.browserSessionId),
			selectionVersion: this.tabs.selectionVersion,
			tabs: this.getTabs({ includeDisconnected: true }),
			leases: this.leases.listTabLeases(),
			uiLock: this.leases.uiLockInfo(),
			queues: this.queues.snapshot(),
			operations: this.operations.snapshot(),
			pending: this.pendingRequests.snapshot(),
		};
	}

	getTabs(options: { includeDisconnected?: boolean } = {}): BrowserTabInfo[] {
		return this.tabs.getTabs(options);
	}

	listBrowserSessions(): BrowserAutomationSessionInfo[] {
		return this.browserSessions.list().map((session) => this.browserSessionInfo(session));
	}

	createBrowserSession(name?: string): BrowserAutomationSessionInfo {
		return this.browserSessionInfo(this.browserSessions.create(name));
	}

	selectBrowserSession(browserSessionId: string): BrowserAutomationSessionInfo {
		return this.browserSessionInfo(this.browserSessions.selectSession(browserSessionId));
	}

	closeBrowserSession(browserSessionId: string): BrowserAutomationSessionInfo | undefined {
		const closed = this.browserSessions.close(browserSessionId);
		return closed ? this.browserSessionInfo(closed) : undefined;
	}

	attachTabToBrowserSession(tabId: number | string, options: { browserSessionId?: string; browserId?: string } = {}): BrowserTabInfo {
		const id = this.requireTabId(tabId);
		const attached = this.tabs.attachTab(id, options.browserSessionId, options.browserId);
		if (!attached) throw tabNotFoundError({ tabId: id, browserSessionId: options.browserSessionId, tabs: this.getTabs(), latestTabId: this.tabs.latestTabId(options.browserSessionId) });
		return this.tabInfo(attached);
	}

	detachTabFromBrowserSession(tabId: number | string, options: { browserSessionId?: string } = {}): BrowserAutomationSessionInfo {
		const id = this.requireTabId(tabId);
		this.tabs.detachTab(id, options.browserSessionId);
		return this.browserSessionInfo(this.browserSession(options.browserSessionId));
	}

	leaseTab(tabId: number | string, options: { browserSessionId?: string } = {}): BrowserTabLeaseInfo {
		const id = this.requireTabId(tabId);
		const browserSession = this.browserSession(options.browserSessionId);
		const tab = this.requireLiveTabSession(id, browserSession.id);
		return this.leases.leaseTab(browserSession.id, tab, true);
	}

	releaseTab(tabId: number | string, options: { browserSessionId?: string } = {}): BrowserTabLeaseInfo | undefined {
		const id = this.requireTabId(tabId);
		const browserSession = this.browserSession(options.browserSessionId);
		const tab = this.requireLiveTabSession(id, browserSession.id);
		return this.leases.releaseTab(browserSession.id, tab);
	}

	acquireUiLock(browserSessionId: string | undefined, toolName: string): BrowserUiLockInfo {
		return this.leases.acquireUiLock(this.browserSession(browserSessionId).id, toolName);
	}

	releaseUiLock(browserSessionId: string | undefined): BrowserUiLockInfo | undefined {
		return this.leases.releaseUiLock(this.browserSession(browserSessionId).id);
	}

	async refreshTabs(timeoutMs = 5_000, options: { browserSessionId?: string } = {}): Promise<BrowserTabInfo[]> {
		return await this.commandService.refreshTabs(timeoutMs, options);
	}

	async waitForExtensionReconnect(previousClientId: string | undefined, timeoutMs = 10_000): Promise<BrowserBridgeSnapshot> {
		const deadline = Date.now() + Math.max(100, Math.floor(timeoutMs));
		let last = this.snapshot();
		while (Date.now() <= deadline) {
			last = this.snapshot();
			const currentId = last.extension?.id;
			if (last.extensionConnected && currentId && currentId !== previousClientId) return last;
			await delay(100);
		}
		throw new BrowserBridgeError("BROWSER_EXTENSION_RECONNECT_TIMEOUT", `Browser extension did not reconnect in ${timeoutMs}ms`, { previousClientId, snapshot: last });
	}

	selectBrowser(browserId: string, options: { browserSessionId?: string } = {}): BrowserBridgeClientInfo {
		const id = String(browserId || "").trim();
		if (!id) throw new BrowserBridgeError("INVALID_BROWSER_ID", "A browser client id is required", { browserId });
		const selected = this.clients.findClient(id);
		if (!selected) throw new BrowserBridgeError("BROWSER_NOT_FOUND", "No connected browser bridge client matches browserId", { browserId: id, clients: this.snapshot().clients });
		const sessionId = this.tabs.selectBrowser(selected.ws, options.browserSessionId);
		if (!sessionId) throw new BrowserBridgeError("NO_TAB", "Selected browser has no active tabs", { browserId: id, selected: selected.info, clients: this.snapshot().clients });
		return selected.info;
	}

	async switchTab(tabId: number | string, timeoutMs = 5_000, options: { browserSessionId?: string } = {}): Promise<BrowserBridgeExecutionResult> {
		return await this.commandService.switchTab(tabId, timeoutMs, options);
	}

	async createTab(url: string, active = true, timeoutMs = 5_000, options: { browserSessionId?: string; incognito?: boolean } = {}): Promise<BrowserBridgeExecutionResult> {
		return await this.commandService.createTab(url, active, timeoutMs, options);
	}

	async closeTab(tabId: number | string, timeoutMs = 5_000, options: { browserSessionId?: string } = {}): Promise<BrowserBridgeExecutionResult> {
		return await this.commandService.closeTab(tabId, timeoutMs, options);
	}

	async executeJavaScript(script: string, options = {}): Promise<BrowserBridgeExecutionResult> {
		return await this.commandService.executeJavaScript(script, options);
	}

	async sendCommand(command: import("../protocol/nativeProtocol.js").BridgeCommand, options = {}): Promise<BrowserBridgeExecutionResult> {
		return await this.commandService.sendCommand(command, options);
	}

	beginOperation(operation: Omit<BrowserActiveOperationInfo, "operationId" | "startedAt" | "updatedAt"> & { operationId?: string }): BrowserActiveOperationInfo {
		return this.operations.begin(operation);
	}

	updateOperation(operationId: string, patch: Partial<Omit<BrowserActiveOperationInfo, "operationId" | "startedAt">>): BrowserActiveOperationInfo | undefined {
		return this.operations.update(operationId, patch);
	}

	finishOperation(operationId: string): BrowserActiveOperationInfo | undefined {
		return this.operations.finish(operationId);
	}

	queueDepth(browserSessionId: string | undefined, tabId: number | undefined): number | undefined {
		if (!browserSessionId || !tabId) return undefined;
		return this.queues.depth(browserSessionId, tabId);
	}

	leaseOwnerHash(browserSessionId: string | undefined, tabId: number | undefined): string | undefined {
		if (!browserSessionId || !tabId) return undefined;
		const lease = this.leases.listTabLeases().find((item) => item.browserSessionId === browserSessionId && item.tabId === tabId);
		return lease?.browserSessionId;
	}

	createObservationSnapshot(snapshot: Omit<BrowserObservationSnapshotInfo, "snapshotId" | "expired" | "ttlMs"> & { snapshotId?: string; ttlMs?: number }): BrowserObservationSnapshotInfo {
		return this.observationSnapshots.create(snapshot);
	}

	getObservationSnapshot(snapshotId: string): BrowserObservationSnapshotInfo | undefined {
		return this.observationSnapshots.get(snapshotId, this.snapshot());
	}

	listObservationSnapshots(): BrowserObservationSnapshotInfo[] {
		return this.observationSnapshots.list(this.snapshot());
	}

	formatError(error: unknown): string {
		return JSON.stringify(errorToPlain(error), null, 2);
	}

	private timeoutDiagnostics(tabId: number | undefined, timeoutMs: number, acked: boolean, target?: BrowserBridgeTargetInfo): Record<string, unknown> {
		return buildBridgeTimeoutDiagnostics(this.snapshot(), tabId, timeoutMs, acked, this.tabs.resolvedTarget(target));
	}

	private registerClient(ws: WebSocket): void {
		this.clientMessageService.registerClient(ws);
	}

	private unregisterClient(ws: WebSocket): void {
		this.clientMessageService.unregisterClient(ws);
	}

	private sweepLeases(now: number): void {
		const sweep = this.leases.sweepExpired(now);
		if (!sweep.releasedLeases.length && !sweep.releasedUiLocks.length) return;
		console.warn("[pi-browser-bridge] Released expired lease/UI lock state", {
			reason: "ttl",
			releasedLeases: sweep.releasedLeases,
			releasedUiLocks: sweep.releasedUiLocks,
		});
	}

	private logLeaseCleanup(details: { reason: "disconnect"; releasedLeases: unknown[]; releasedUiLocks: unknown[]; disconnectedTabSessionIds: string[]; affectedBrowserSessionIds: string[] }): void {
		console.warn("[pi-browser-bridge] Released lease/UI lock state after client disconnect", details);
	}

	private browserSessionInfo(session: BrowserAutomationSession): BrowserAutomationSessionInfo {
		return this.tabs.describeBrowserSession(session, this.browserSessions.selectedInfo(session, this.clients));
	}

	private tabInfo(session: BrowserTabSession): BrowserTabInfo {
		const { client: _client, ...info } = session;
		return info;
	}

	private startHeartbeat(): void {
		this.heartbeat.start();
	}

	private stopHeartbeat(): void {
		this.heartbeat.stop();
	}

	private requireTabId(value: unknown): number {
		const tabId = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
		if (!Number.isInteger(tabId) || tabId <= 0) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId is required", { tabId: value });
		return tabId;
	}

	private requireLiveTabSession(tabId: number, browserSessionId?: string): BrowserTabSession {
		const session = this.tabs.liveSessionForTabId(tabId, browserSessionId);
		if (session) return session;
		throw tabNotFoundError({
			tabId,
			browserSessionId,
			selectedBrowser: this.browserSessions.selectedInfo(this.browserSession(browserSessionId), this.clients),
			tabs: this.getTabs(),
			latestTabId: this.tabs.latestTabId(browserSessionId),
		});
	}

	private browserSession(browserSessionId?: string): BrowserAutomationSession {
		return this.browserSessions.require(browserSessionId);
	}

}
