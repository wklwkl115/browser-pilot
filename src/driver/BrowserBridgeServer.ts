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
import { BrowserTemporalCoordinator, type TemporalProfileSampleInput } from "./BrowserTemporalCoordinator.js";
import { delay, normalizePort } from "./bridgeUtils.js";
import { BrowserBridgeCommandService } from "./BrowserBridgeCommandService.js";
import { BrowserBridgeClientMessageService } from "./BrowserBridgeClientMessageService.js";
import { BrowserBridgeConsentCoordinator } from "./BrowserBridgeConsentCoordinator.js";
import type { ConsentDecision, ConsentPort, PairedAgentSummary } from "./consentTypes.js";
import type { TemporalProfileSample } from "../temporal-core/types.js";
import { PerceptionLedger, type PerceptionLedgerFrame, type PerceptionLedgerKey, type PerceptionTraceSnapshot } from "../abml/perceptionLedger.js";
import { drainMemoryProfileFlushes } from "../memory/profileService.js";
import type { BrowserActiveOperationInfo, BrowserAutomationSession, BrowserAutomationSessionInfo, BrowserBridgeClientInfo, BrowserBridgeExecutionResult, BrowserBridgeSnapshot, BrowserBridgeTargetInfo, BrowserObservationSnapshotInfo, BrowserTabInfo, BrowserTabLeaseInfo, BrowserTabSession, BrowserUiLockInfo } from "./types.js";

export class BrowserBridgeServer implements ConsentPort {
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
	private readonly perceptionLedger: PerceptionLedger;
	private readonly runtimeRecoveryArtifacts: BrowserRuntimeRecoveryArtifacts;
	private readonly temporal: BrowserTemporalCoordinator;
	private readonly httpEndpoint: BrowserBridgeHttpServer;
	private readonly heartbeat: BrowserBridgeClientHeartbeat;
	private readonly commandService: BrowserBridgeCommandService;
	private readonly clientMessageService: BrowserBridgeClientMessageService;
	private readonly extensionReadyWaiters = new Set<() => void>();
	private readonly consentCoordinator: BrowserBridgeConsentCoordinator;

	constructor(options: { host?: string; port?: number; portRangeEnd?: number } = {}) {
		this.host = options.host || process.env.PI_BROWSER_BRIDGE_HOST || DEFAULT_BROWSER_BRIDGE_HOST;
		this.requestedPort = options.port || normalizePort(process.env.PI_BROWSER_BRIDGE_PORT);
		this.portRangeEnd = Math.max(this.requestedPort, options.portRangeEnd || normalizePort(process.env.PI_BROWSER_BRIDGE_PORT_RANGE_END, DEFAULT_BROWSER_BRIDGE_PORT_RANGE_END));
		this.clients = new BrowserBridgeClientRegistry(() => this.port);
		this.browserSessions = new BrowserSessionRegistry();
		this.consentCoordinator = new BrowserBridgeConsentCoordinator({
			// Use the browser-session's selected client, which is set when ext_ready
			// arrives in BrowserBridgeClientMessageService. BrowserBridgeClientRegistry
			// .selectedOpenClient() tracks a separate `extensionClient` field that is
			// never populated by the message handler, so we must go through browserSessions.
			getExtensionSocket: () => this.browserSessions.selectedOpenClient(this.browserSessions.defaultSession()),
		});
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
		this.perceptionLedger = new PerceptionLedger();
		this.runtimeRecoveryArtifacts = new BrowserRuntimeRecoveryArtifacts();
		this.temporal = new BrowserTemporalCoordinator();
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
			waitForExtensionReady: (browserSessionId, timeoutMs) => this.waitForExtensionReady(browserSessionId, timeoutMs),
		});
		this.clientMessageService = new BrowserBridgeClientMessageService({
			clients: this.clients,
			browserSessions: this.browserSessions,
			tabs: this.tabs,
			pendingRequests: this.pendingRequests,
			runtimeRecoveryArtifacts: this.runtimeRecoveryArtifacts,
			leases: this.leases,
			queues: this.queues,
			consent: this.consentCoordinator,
			migratePerceptionLedger: (fromTabId, toTabId, browserSessionIds) => {
				this.perceptionLedger.migrateTabId(fromTabId, toTabId, { browserSessionIds });
			},
			logLeaseCleanup: (details) => this.logLeaseCleanup(details),
			notifyExtensionReady: () => this.notifyExtensionReady(),
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
		await drainMemoryProfileFlushes();
		this.perceptionLedger.clear();
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
			defaultTabHandle: this.tabs.defaultTabHandle(options.browserSessionId),
			latestTabId: this.tabs.latestTabId(options.browserSessionId),
			latestTabHandle: this.tabs.latestTabHandle(options.browserSessionId),
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

	getLastTabSyncAt(): number | undefined {
		return this.tabs.lastTabSyncAt;
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
		const id = this.resolveAttachTargetTabId(tabId, options);
		const attached = this.tabs.attachTab(id, options.browserSessionId, options.browserId);
		if (!attached) throw tabNotFoundError({ tabId: id, browserSessionId: options.browserSessionId, tabs: this.getTabs(), latestTabId: this.tabs.latestTabId(options.browserSessionId), replacedByTabId: this.tabs.replacedByTabId(id, options.browserSessionId) });
		return this.tabInfo(attached);
	}

	detachTabFromBrowserSession(tabId: number | string, options: { browserSessionId?: string } = {}): BrowserAutomationSessionInfo {
		const id = this.resolveTargetTabId(tabId, options.browserSessionId);
		this.tabs.detachTab(id, options.browserSessionId);
		return this.browserSessionInfo(this.browserSession(options.browserSessionId));
	}

	leaseTab(tabId: number | string, options: { browserSessionId?: string } = {}): BrowserTabLeaseInfo {
		const id = this.resolveTargetTabId(tabId, options.browserSessionId);
		const browserSession = this.browserSession(options.browserSessionId);
		const tab = this.requireLiveTabSession(id, browserSession.id);
		return this.leases.leaseTab(browserSession.id, tab, true);
	}

	releaseTab(tabId: number | string, options: { browserSessionId?: string } = {}): BrowserTabLeaseInfo | undefined {
		const id = this.resolveTargetTabId(tabId, options.browserSessionId);
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

	/**
	 * Resolve true once an extension is connected for the session, or false after
	 * timeoutMs. Unlike waitForExtensionReconnect this never throws and accepts any
	 * connection (cold-start grace, not reconnect): callers use it to let an idle
	 * MV3 service worker dial in before a command fails with NO_BROWSER_EXTENSION.
	 */
	async waitForExtensionReady(browserSessionId: string | undefined, timeoutMs: number): Promise<boolean> {
		const waitMs = Math.max(0, Math.floor(timeoutMs));
		if (this.snapshot({ browserSessionId }).extensionConnected) return true;
		if (waitMs <= 0) return false;
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.extensionReadyWaiters.delete(finish);
				resolve();
			};
			const timer = setTimeout(finish, waitMs);
			this.extensionReadyWaiters.add(finish);
		});
		return this.snapshot({ browserSessionId }).extensionConnected;
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

	resolveTargetTabId(value: unknown, browserSessionId?: string): number {
		const target = this.tabs.resolveTargetRef(value, browserSessionId, "explicit");
		if (target?.tabId !== undefined) return target.tabId;
		throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId or targetRef is required", { tabId: value });
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

	getPerceptionLedgerFrame(key: PerceptionLedgerKey): PerceptionLedgerFrame | undefined {
		return this.perceptionLedger.get(key);
	}

	getRecentPerceptionLedgerFrames(key: PerceptionLedgerKey, limit = 3): PerceptionLedgerFrame[] {
		return this.perceptionLedger.recent(key, limit);
	}

	recordPerceptionLedgerFrame(frame: PerceptionLedgerFrame): PerceptionLedgerFrame {
		return this.perceptionLedger.record(frame);
	}

	recordPerceptionTraceTerms(browserSessionId: string | undefined, terms: Array<{ term: string; kind: string; weight?: number }>): PerceptionTraceSnapshot {
		return this.perceptionLedger.recordTraceTerms(browserSessionId, terms);
	}

	perceptionTraceSnapshot(browserSessionId?: string): PerceptionTraceSnapshot {
		return this.perceptionLedger.traceSnapshot(browserSessionId);
	}

	buildTemporalProfileSample(input: TemporalProfileSampleInput): TemporalProfileSample {
		return this.temporal.buildProfileSample(input);
	}

	recordTemporalProfileSample(sample: TemporalProfileSample, options: { cwd?: string; runId?: string; evalRunDir?: string; runnerSummaryPath?: string } = {}): Promise<unknown> {
		return this.temporal.recordProfileSample(sample, options);
	}

	temporalProfileSummary(): unknown {
		return this.temporal.profileSummary();
	}

	// ConsentPort implementation — delegated to the coordinator
	hasConsentSurface(): boolean {
		return this.consentCoordinator.hasConsentSurface();
	}

	sendConsentRequest(input: { pairingId: string; label: string; code: string; expiresAt: string; timeoutMs: number }): Promise<ConsentDecision> {
		return this.consentCoordinator.sendConsentRequest(input);
	}

	onRevokeRequest(handler: (pairingId: string) => void): void {
		this.consentCoordinator.onRevokeRequest(handler);
	}

	broadcastPairedAgents(agents: PairedAgentSummary[]): void {
		this.consentCoordinator.broadcastPairedAgents(agents);
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

	private notifyExtensionReady(): void {
		for (const resolve of Array.from(this.extensionReadyWaiters)) resolve();
	}

	private sweepLeases(now: number): void {
		const sweep = this.leases.sweepExpired(now);
		if (!sweep.releasedLeases.length && !sweep.releasedUiLocks.length) return;
		console.warn("[browser-pilot-bridge] Released expired lease/UI lock state", {
			reason: "ttl",
			releasedLeases: sweep.releasedLeases,
			releasedUiLocks: sweep.releasedUiLocks,
		});
	}

	private logLeaseCleanup(details: { reason: "disconnect"; releasedLeases: unknown[]; releasedUiLocks: unknown[]; disconnectedTabSessionIds: string[]; affectedBrowserSessionIds: string[] }): void {
		if (process.env.PI_BROWSER_LEASE_CLEANUP_LOG !== "1") return;
		console.warn("[browser-pilot-bridge] Released lease/UI lock state after client disconnect", details);
	}

	private browserSessionInfo(session: BrowserAutomationSession): BrowserAutomationSessionInfo {
		return this.tabs.describeBrowserSession(session, this.browserSessions.selectedInfo(session, this.clients));
	}

	private tabInfo(session: BrowserTabSession): BrowserTabInfo {
		const { client: _client, ...info } = session;
		return { ...info, targetRef: info.tabHandle };
	}

	private startHeartbeat(): void {
		this.heartbeat.start();
	}

	private stopHeartbeat(): void {
		this.heartbeat.stop();
	}

	private resolveAttachTargetTabId(value: unknown, options: { browserSessionId?: string; browserId?: string }): number {
		const numeric = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
		if (options.browserId && Number.isInteger(numeric) && numeric > 0) return numeric;
		return this.resolveTargetTabId(value, options.browserSessionId);
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
			replacedByTabId: this.tabs.replacedByTabId(tabId, browserSessionId),
		});
	}

	private browserSession(browserSessionId?: string): BrowserAutomationSession {
		return this.browserSessions.require(browserSessionId);
	}

}
