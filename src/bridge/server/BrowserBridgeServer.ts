import { WebSocket } from "ws";
import { DEFAULT_BROWSER_BRIDGE_HOST, DEFAULT_BROWSER_BRIDGE_PORT_RANGE_END } from "./browserBridgeConfig.js";
import { tabNotFoundError } from "../errors.js";
import { BrowserBridgeError, errorToPlain } from "../../utils/errors.js";
import { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry.js";
import { BrowserBridgeClientHeartbeat } from "./BrowserBridgeClientHeartbeat.js";
import { BrowserBridgeHttpServer } from "./BrowserBridgeHttpServer.js";
import { buildBridgeTimeoutDiagnostics } from "./BrowserBridgeDiagnostics.js";
import { BrowserBridgePendingRequests } from "./BrowserBridgePendingRequests.js";
import { BrowserCommandQueueRegistry } from "./BrowserCommandQueueRegistry.js";
import { BrowserRuntimeRecoveryArtifacts } from "./BrowserRuntimeRecoveryArtifacts.js";
import { BrowserTabSessionRouter } from "./BrowserTabSessionRouter.js";
import { BrowserBridgeSessionState, type IntentRefRegistry } from "./BrowserBridgeSessionState.js";
import { delay, normalizePort } from "./bridgeUtils.js";
import { BrowserBridgeCommandService } from "./BrowserBridgeCommandService.js";
import { BrowserBridgeClientMessageService } from "./BrowserBridgeClientMessageService.js";
import { BrowserBridgeConsentCoordinator } from "./BrowserBridgeConsentCoordinator.js";
import type { ConsentDecision, ConsentPort, PairedAgentSummary } from "../protocol/consentTypes.js";
import type { CommandPerceptionLedgerFrame, CommandPerceptionLedgerKey, CommandPerceptionTraceSnapshot, CommandTemporalProfileSample, CommandTemporalProfileSampleInput } from "../../ports/BrowserCommandRuntimePort.js";
import type { BrowserActiveOperationInfo, BrowserAutomationSession, BrowserAutomationSessionInfo, BrowserBridgeClientInfo, BrowserBridgeExecutionResult, BrowserBridgeSnapshot, BrowserBridgeTargetInfo, BrowserObservationSnapshotInfo, BrowserTabInfo, BrowserTabLeaseInfo, BrowserTabSession, BrowserUiLockInfo } from "./types.js";
import type { SessionOperationBeginInput } from "../../kernels/session/operationRegistry.js";
import type { BrowserOperationEvent, BrowserOperationOutcome } from "../../kernels/session/browserOperation.js";

export class BrowserBridgeServer implements ConsentPort {
	readonly host: string;
	readonly requestedPort: number;
	readonly portRangeEnd: number;

	private readonly clients: BrowserBridgeClientRegistry;
	private readonly state: BrowserBridgeSessionState;
	private readonly queues: BrowserCommandQueueRegistry;
	private readonly tabs: BrowserTabSessionRouter;
	private readonly pendingRequests: BrowserBridgePendingRequests;
	private readonly runtimeRecoveryArtifacts: BrowserRuntimeRecoveryArtifacts;
	private readonly httpEndpoint: BrowserBridgeHttpServer;
	private readonly heartbeat: BrowserBridgeClientHeartbeat;
	private readonly commandService: BrowserBridgeCommandService;
	private readonly clientMessageService: BrowserBridgeClientMessageService;
	private readonly extensionReadyWaiters = new Set<() => void>();
	private readonly operationWaiters = new Map<string, Set<() => void>>();
	private readonly knownRecorderStates = new Map<string, { active: boolean; lastSeq?: number }>();
	private readonly consentCoordinator: BrowserBridgeConsentCoordinator;

	constructor(options: { host?: string; port?: number; portRangeEnd?: number; maxPayloadBytes?: number } = {}) {
		this.host = options.host || process.env.BROWSER_PILOT_BRIDGE_HOST || DEFAULT_BROWSER_BRIDGE_HOST;
		this.requestedPort = options.port || normalizePort(process.env.BROWSER_PILOT_BRIDGE_PORT);
		this.portRangeEnd = Math.max(this.requestedPort, options.portRangeEnd || normalizePort(process.env.BROWSER_PILOT_BRIDGE_PORT_RANGE_END, DEFAULT_BROWSER_BRIDGE_PORT_RANGE_END));
		this.clients = new BrowserBridgeClientRegistry(() => this.port);
		this.state = new BrowserBridgeSessionState();
		this.consentCoordinator = new BrowserBridgeConsentCoordinator({
			// Use the browser-session's selected client, which is set when ext_ready
			// arrives in BrowserBridgeClientMessageService. BrowserBridgeClientRegistry
			// .selectedOpenClient() tracks a separate `extensionClient` field that is
			// never populated by the message handler, so we must go through browserSessions.
			getExtensionSocket: () => this.state.browserSessions.selectedOpenClient(this.state.browserSessions.defaultSession()),
		});
		this.queues = new BrowserCommandQueueRegistry();
		this.tabs = new BrowserTabSessionRouter(this.clients, this.state.browserSessions);
		this.pendingRequests = new BrowserBridgePendingRequests(
			(tabId, timeoutMs, acked, target) => this.timeoutDiagnostics(tabId, timeoutMs, acked, target),
			(target) => this.tabs.resolvedTarget(target),
		);
		this.runtimeRecoveryArtifacts = new BrowserRuntimeRecoveryArtifacts();
		this.commandService = new BrowserBridgeCommandService({
			clients: this.clients,
			browserSessions: this.state.browserSessions,
			queues: this.queues,
			leases: this.state.leases,
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
			browserSessions: this.state.browserSessions,
			tabs: this.tabs,
			pendingRequests: this.pendingRequests,
			runtimeRecoveryArtifacts: this.runtimeRecoveryArtifacts,
			leases: this.state.leases,
			queues: this.queues,
			consent: this.consentCoordinator,
			recordOperationEvent: (operationId, event) => this.recordOperationEvent(operationId, event),
			migratePerceptionLedger: (fromTabId, toTabId, browserSessionIds) => {
				this.state.perceptionLedger.migrateTabId(fromTabId, toTabId, { browserSessionIds });
			},
			clearRecorderStateForReplacement: (fromTabId, toTabId, browserSessionIds) => {
				this.clearKnownRecorderStatesForReplacement(fromTabId, toTabId, browserSessionIds);
			},
			logLeaseCleanup: (details) => this.logLeaseCleanup(details),
			notifyExtensionReady: () => this.notifyExtensionReady(),
			notifyOperationTopologyChange: () => this.releaseAllOperationWaiters(),
			recordTargetReplacement: (fromTabId, toTabId) => {
				for (const operation of this.state.operations.snapshot({ includeTerminal: false })) {
					if (operation.tabId !== fromTabId) continue;
					this.recordOperationEvent(operation.operationId, { type: "target_lost", tabId: fromTabId, generation: operation.generation, data: { reason: "target_replaced", replacementTabId: toTabId } });
				}
			},
		});
		this.heartbeat = new BrowserBridgeClientHeartbeat(this.clients, (ws, reason) => this.unregisterClient(ws, reason), { onTick: (now) => this.sweepLeases(now) });
		this.httpEndpoint = new BrowserBridgeHttpServer(this.host, this.requestedPort, (ws) => this.registerClient(ws), { portRangeEnd: this.portRangeEnd, maxPayloadBytes: options.maxPayloadBytes });
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
		this.state.browserSessions.clear();
		this.queues.clear();
		this.state.leases.clear();
		this.tabs.clear();
		this.releaseAllOperationWaiters();
		this.knownRecorderStates.clear();
		this.state.operations.clear();
		this.state.observationSnapshots.clear();
		this.state.perceptionLedger.clear();
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
			extensionConnected: !!this.state.browserSessions.selectedOpenClient(browserSession),
			extension: this.state.browserSessions.selectedInfo(browserSession, (client) => this.clients.info(client)),
			clients: this.clients.connectedClientInfos(),
			lastDisconnectReason: this.clients.lastDisconnectReason,
			lastDisconnectAt: this.clients.lastDisconnectAt,
			defaultTabId: this.tabs.defaultTabId(options.browserSessionId),
			defaultTabHandle: this.tabs.defaultTabHandle(options.browserSessionId),
			latestTabId: this.tabs.latestTabId(options.browserSessionId),
			latestTabHandle: this.tabs.latestTabHandle(options.browserSessionId),
			selectionVersion: this.tabs.selectionVersion,
			tabs: this.getTabs({ includeDisconnected: true }),
			leases: this.state.leases.listTabLeases(),
			uiLock: this.state.leases.uiLockInfo(),
			queues: this.queues.snapshot(),
			operations: this.state.operations.snapshot(),
			pending: this.pendingRequests.snapshot(),
			connectionMetrics: this.clients.metrics(),
			requestMetrics: this.pendingRequests.metrics(),
		};
	}

	getTabs(options: { includeDisconnected?: boolean } = {}): BrowserTabInfo[] {
		return this.tabs.getTabs(options);
	}

	listBrowserSessions(): BrowserAutomationSessionInfo[] {
		return this.state.browserSessions.list().map((session) => this.browserSessionInfo(session));
	}

	getLastTabSyncAt(): number | undefined {
		return this.tabs.lastTabSyncAt;
	}

	createBrowserSession(name?: string): BrowserAutomationSessionInfo {
		return this.browserSessionInfo(this.state.browserSessions.create(name));
	}

	selectBrowserSession(browserSessionId: string): BrowserAutomationSessionInfo {
		return this.browserSessionInfo(this.state.browserSessions.selectSession(browserSessionId));
	}

	closeBrowserSession(browserSessionId: string): BrowserAutomationSessionInfo | undefined {
		const closed = this.state.browserSessions.close(browserSessionId);
		return closed ? this.browserSessionInfo(closed) : undefined;
	}

	attachTabToBrowserSession(tabId: number | string, options: { browserSessionId?: string; browserId?: string } = {}): BrowserTabInfo {
		const id = this.resolveAttachTargetTabId(tabId, options);
		const attached = this.tabs.attachTab(id, options.browserSessionId, options.browserId);
		if (!attached) {
			const resolution = this.tabs.replacementResolution(id, options.browserSessionId);
			throw tabNotFoundError({ tabId: id, browserSessionId: options.browserSessionId, tabs: this.getTabs(), latestTabId: this.tabs.latestTabId(options.browserSessionId), replacedByTabId: resolution.tabId !== id ? resolution.tabId : undefined, replacementChainFailure: resolution.replacementChainFailure, replacementHops: resolution.replacementHops, replacementChainAge: resolution.replacementChainAge });
		}
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
		return this.state.leases.leaseTab(browserSession.id, tab, true);
	}

	releaseTab(tabId: number | string, options: { browserSessionId?: string } = {}): BrowserTabLeaseInfo | undefined {
		const id = this.resolveTargetTabId(tabId, options.browserSessionId);
		const browserSession = this.browserSession(options.browserSessionId);
		const tab = this.requireLiveTabSession(id, browserSession.id);
		return this.state.leases.releaseTab(browserSession.id, tab);
	}

	async acquireUiLock(browserSessionId: string | undefined, commandName: string): Promise<BrowserUiLockInfo> {
		const resolvedId = this.browserSession(browserSessionId).id;
		const maxRetries = 5;
		const retryDelayMs = 100;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return this.state.leases.acquireUiLock(resolvedId, commandName);
			} catch (err: unknown) {
				const isLockConflict = err instanceof Error && "code" in err && (err as { code: string }).code === "UI_LOCK_CONFLICT";
				if (!isLockConflict || attempt === maxRetries) throw err;
				await delay(retryDelayMs);
			}
		}
		/* istanbul ignore next — unreachable; loop always returns or throws */
		return this.state.leases.acquireUiLock(resolvedId, commandName);
	}

	releaseUiLock(browserSessionId: string | undefined): BrowserUiLockInfo | undefined {
		return this.state.leases.releaseUiLock(this.browserSession(browserSessionId).id);
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

	async sendCommand(command: import("../../types/nativeProtocol.js").BridgeCommand, options = {}): Promise<BrowserBridgeExecutionResult> {
		return await this.commandService.sendCommand(command, options);
	}

	resolveTargetTabId(value: unknown, browserSessionId?: string): number {
		const target = this.tabs.resolveTargetRef(value, browserSessionId, "explicit");
		if (target?.tabId !== undefined) return target.tabId;
		throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId or targetRef is required", { tabId: value });
	}

	beginOperation(operation: SessionOperationBeginInput): BrowserActiveOperationInfo {
		const next = this.state.operations.begin(operation);
		this.releaseOperationWaiters(next.operationId);
		return next;
	}

	updateOperation(operationId: string, patch: Partial<Omit<BrowserActiveOperationInfo, "operationId" | "startedAt">>): BrowserActiveOperationInfo | undefined {
		const next = this.state.operations.update(operationId, patch);
		if (next) this.releaseOperationWaiters(operationId);
		return next;
	}

	finishOperation(operationId: string, outcome?: BrowserOperationOutcome): BrowserActiveOperationInfo | undefined {
		const next = this.state.operations.finish(operationId, outcome);
		if (next) this.releaseOperationWaiters(operationId);
		return next;
	}

	getOperation(operationId: string): BrowserActiveOperationInfo | undefined {
		return this.state.operations.get(operationId);
	}

	recordOperationEvent(operationId: string, event: Omit<BrowserOperationEvent, "operationId" | "sequence" | "timestamp"> & { sequence?: number; timestamp?: number }): BrowserActiveOperationInfo | undefined {
		const next = this.state.operations.recordEvent(operationId, event);
		if (next) this.releaseOperationWaiters(operationId);
		return next;
	}

	waitForOperationChange(operationId: string, afterRevision: number, timeoutMs: number, signal?: AbortSignal): Promise<BrowserActiveOperationInfo | undefined> {
		const current = this.state.operations.get(operationId);
		if (!current || current.revision > afterRevision || timeoutMs <= 0) return Promise.resolve(current);
		return new Promise((resolve, reject) => {
			let settled = false;
			const waiters = this.operationWaiters.get(operationId) ?? new Set<() => void>();
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				waiters.delete(wake);
				if (!waiters.size) this.operationWaiters.delete(operationId);
			};
			const finish = () => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(this.state.operations.get(operationId));
			};
			const wake = () => finish();
			const onAbort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				const error = new Error("operation wait aborted");
				error.name = "AbortError";
				reject(error);
			};
			const timer = setTimeout(finish, Math.max(0, Math.floor(timeoutMs)));
			waiters.add(wake);
			this.operationWaiters.set(operationId, waiters);
			if (signal?.aborted) return onAbort();
			signal?.addEventListener("abort", onAbort, { once: true });
			// Close the read-before-subscribe race: a mutation between the first
			// revision read and waiter registration resolves immediately.
			const registered = this.state.operations.get(operationId);
			if (!registered || registered.revision > afterRevision) finish();
		});
	}

	private releaseOperationWaiters(operationId: string): void {
		const waiters = this.operationWaiters.get(operationId);
		if (!waiters) return;
		this.operationWaiters.delete(operationId);
		for (const wake of [...waiters]) wake();
	}

	private releaseAllOperationWaiters(): void {
		for (const operationId of [...this.operationWaiters.keys()]) this.releaseOperationWaiters(operationId);
	}

	surfaceLateEffects(input: { ownerId?: string; browserSessionId?: string; excludeOperationId?: string }) {
		return this.state.operations.surfaceLateEffects(input);
	}

	private recorderStateKey(kind: "network" | "hook", browserSessionId: string | undefined, tabId: number | undefined): string {
		return `${kind}:${browserSessionId ?? "default"}:${tabId ?? "selected"}`;
	}

	getKnownRecorderState(kind: "network" | "hook", browserSessionId: string | undefined, tabId: number | undefined): { active: boolean; lastSeq?: number } | undefined {
		const state = this.knownRecorderStates.get(this.recorderStateKey(kind, browserSessionId, tabId));
		return state ? { ...state } : undefined;
	}

	recordKnownRecorderState(kind: "network" | "hook", browserSessionId: string | undefined, tabId: number | undefined, state: { active: boolean; lastSeq?: number }): void {
		this.knownRecorderStates.set(this.recorderStateKey(kind, browserSessionId, tabId), { ...state });
	}

	clearKnownRecorderStatesForReplacement(fromTabId: number, toTabId: number, browserSessionIds: string[] = []): void {
		const sessions = browserSessionIds.length ? browserSessionIds : [undefined];
		for (const kind of ["network", "hook"] as const) {
			for (const browserSessionId of sessions) {
				this.knownRecorderStates.delete(this.recorderStateKey(kind, browserSessionId, fromTabId));
				this.knownRecorderStates.delete(this.recorderStateKey(kind, browserSessionId, toTabId));
			}
		}
	}

	queueDepth(browserSessionId: string | undefined, tabId: number | undefined): number | undefined {
		if (!browserSessionId || !tabId) return undefined;
		return this.queues.depth(browserSessionId, tabId);
	}

	leaseOwnerHash(browserSessionId: string | undefined, tabId: number | undefined): string | undefined {
		if (!browserSessionId || !tabId) return undefined;
		const lease = this.state.leases.listTabLeases().find((item) => item.browserSessionId === browserSessionId && item.tabId === tabId);
		return lease?.browserSessionId;
	}

	createObservationSnapshot(snapshot: Omit<BrowserObservationSnapshotInfo, "snapshotId" | "expired" | "ttlMs"> & { snapshotId?: string; ttlMs?: number }): BrowserObservationSnapshotInfo {
		return this.state.observationSnapshots.create(snapshot);
	}

	getObservationSnapshot(snapshotId: string): BrowserObservationSnapshotInfo | undefined {
		return this.state.observationSnapshots.get(snapshotId, this.snapshot());
	}

	listObservationSnapshots(): BrowserObservationSnapshotInfo[] {
		return this.state.observationSnapshots.list(this.snapshot());
	}

	getPerceptionLedgerFrame(key: CommandPerceptionLedgerKey): CommandPerceptionLedgerFrame | undefined {
		return this.state.perceptionLedger.get(key);
	}

	getRecentPerceptionLedgerFrames(key: CommandPerceptionLedgerKey, limit = 3): CommandPerceptionLedgerFrame[] {
		return this.state.perceptionLedger.recent(key, limit);
	}

	recordPerceptionLedgerFrame(frame: CommandPerceptionLedgerFrame): CommandPerceptionLedgerFrame {
		return this.state.perceptionLedger.record(frame);
	}

	recordPerceptionTraceTerms(browserSessionId: string | undefined, terms: Array<{ term: string; kind: string; weight?: number }>): CommandPerceptionTraceSnapshot {
		return this.state.perceptionLedger.recordTraceTerms(browserSessionId, terms);
	}

	perceptionTraceSnapshot(browserSessionId?: string): CommandPerceptionTraceSnapshot {
		return this.state.perceptionLedger.traceSnapshot(browserSessionId);
	}

	getIntentRefRegistry(): IntentRefRegistry {
		return this.state.intentRefRegistry;
	}

	buildTemporalProfileSample(input: CommandTemporalProfileSampleInput): CommandTemporalProfileSample {
		return this.state.temporal.buildProfileSample(input);
	}

	recordTemporalProfileSample(sample: CommandTemporalProfileSample, options: { cwd?: string; runId?: string; evalRunDir?: string; runnerSummaryPath?: string } = {}): Promise<unknown> {
		return this.state.temporal.recordProfileSample(sample, options);
	}

	temporalProfileSummary(): unknown {
		return this.state.temporal.profileSummary();
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

	private unregisterClient(ws: WebSocket, reason?: string): void {
		this.clientMessageService.unregisterClient(ws, reason);
	}

	private notifyExtensionReady(): void {
		for (const resolve of Array.from(this.extensionReadyWaiters)) resolve();
	}

	private sweepLeases(now: number): void {
		const sweep = this.state.leases.sweepExpired(now);
		if (!sweep.releasedLeases.length && !sweep.releasedUiLocks.length) return;
		console.warn("[browser-pilot-bridge] Released expired lease/UI lock state", {
			reason: "ttl",
			releasedLeases: sweep.releasedLeases,
			releasedUiLocks: sweep.releasedUiLocks,
		});
	}

	private logLeaseCleanup(details: { reason: "disconnect"; releasedLeases: unknown[]; releasedUiLocks: unknown[]; disconnectedTabSessionIds: string[]; affectedBrowserSessionIds: string[] }): void {
		if (process.env.BROWSER_PILOT_LEASE_CLEANUP_LOG !== "1") return;
		console.warn("[browser-pilot-bridge] Released lease/UI lock state after client disconnect", details);
	}

	private browserSessionInfo(session: BrowserAutomationSession): BrowserAutomationSessionInfo {
		return this.tabs.describeBrowserSession(session, this.state.browserSessions.selectedInfo(session, (client) => this.clients.info(client)));
	}

	private tabInfo(session: BrowserTabSession): BrowserTabInfo {
		const { client: _client, ...info } = session;
		return { ...info, targetGeneration: info.generation, targetRef: info.tabHandle };
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
		const resolution = this.tabs.replacementResolution(tabId, browserSessionId);
		throw tabNotFoundError({
			tabId,
			browserSessionId,
			selectedBrowser: this.state.browserSessions.selectedInfo(this.browserSession(browserSessionId), (client) => this.clients.info(client)),
			tabs: this.getTabs(),
			latestTabId: this.tabs.latestTabId(browserSessionId),
			replacedByTabId: resolution.tabId !== tabId ? resolution.tabId : undefined,
			replacementChainFailure: resolution.replacementChainFailure,
			replacementHops: resolution.replacementHops,
			replacementChainAge: resolution.replacementChainAge,
		});
	}

	private browserSession(browserSessionId?: string): BrowserAutomationSession {
		return this.state.browserSessions.require(browserSessionId);
	}

}
