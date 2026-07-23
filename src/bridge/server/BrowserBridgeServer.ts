import { WebSocket } from "ws";
import { DEFAULT_BROWSER_BRIDGE_HOST, DEFAULT_BROWSER_BRIDGE_PORT_RANGE_END } from "./browserBridgeConfig.js";
import { BrowserBridgeError, errorToPlain } from "../../utils/errors.js";
import { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry.js";
import { BrowserBridgeClientHeartbeat } from "./BrowserBridgeClientHeartbeat.js";
import { BrowserBridgeHttpServer } from "./BrowserBridgeHttpServer.js";
import { buildBridgeTimeoutDiagnostics } from "./BrowserBridgeDiagnostics.js";
import { BrowserBridgePendingRequests } from "./BrowserBridgePendingRequests.js";
import { BrowserCommandQueueRegistry } from "./BrowserCommandQueueRegistry.js";
import { BrowserTabSessionRouter } from "./BrowserTabSessionRouter.js";
import { BrowserBridgeSessionState } from "./BrowserBridgeSessionState.js";
import { delay, normalizePort } from "./bridgeUtils.js";
import { BrowserBridgeCommandService } from "./BrowserBridgeCommandService.js";
import { BrowserBridgeClientMessageService } from "./BrowserBridgeClientMessageService.js";
import type { BrowserCommandTargetTransactionInput, CommandPerceptionLedgerFrame, CommandPerceptionLedgerKey, CommandPerceptionTraceSnapshot } from "../../ports/BrowserCommandRuntimePort.js";
import type { BrowserAutomationSession, BrowserBridgeExecutionResult, BrowserBridgeSnapshot, BrowserBridgeTargetInfo, BrowserObservationSnapshotInfo, BrowserTabInfo, ExecuteOptions } from "./types.js";

const MAX_KNOWN_RECORDER_STATES = 128;

export class BrowserBridgeServer {
	readonly host: string;
	readonly requestedPort: number;
	readonly portRangeEnd: number;

	private readonly clients: BrowserBridgeClientRegistry;
	private readonly state: BrowserBridgeSessionState;
	private readonly queues: BrowserCommandQueueRegistry;
	private readonly tabs: BrowserTabSessionRouter;
	private readonly pendingRequests: BrowserBridgePendingRequests;
	private readonly httpEndpoint: BrowserBridgeHttpServer;
	private readonly heartbeat: BrowserBridgeClientHeartbeat;
	private readonly commandService: BrowserBridgeCommandService;
	private readonly clientMessageService: BrowserBridgeClientMessageService;
	private readonly extensionReadyWaiters = new Set<() => void>();
	private readonly knownRecorderStates = new Map<string, { active: boolean; lastSeq?: number }>();

	constructor(options: { host?: string; port?: number; portRangeEnd?: number; maxPayloadBytes?: number; handshakeTimeoutMs?: number } = {}) {
		this.host = options.host || process.env.BROWSER_PILOT_BRIDGE_HOST || DEFAULT_BROWSER_BRIDGE_HOST;
		this.requestedPort = options.port || normalizePort(process.env.BROWSER_PILOT_BRIDGE_PORT);
		this.portRangeEnd = Math.max(this.requestedPort, options.portRangeEnd || normalizePort(process.env.BROWSER_PILOT_BRIDGE_PORT_RANGE_END, DEFAULT_BROWSER_BRIDGE_PORT_RANGE_END));
		this.clients = new BrowserBridgeClientRegistry(() => this.port);
		this.state = new BrowserBridgeSessionState();
		this.queues = new BrowserCommandQueueRegistry();
		this.tabs = new BrowserTabSessionRouter(this.clients, this.state.browserSessions);
		this.pendingRequests = new BrowserBridgePendingRequests(
			(tabId, timeoutMs, acked, target) => this.timeoutDiagnostics(tabId, timeoutMs, acked, target),
			(target) => this.tabs.resolvedTarget(target),
		);
		this.commandService = new BrowserBridgeCommandService({
			clients: this.clients,
			browserSessions: this.state.browserSessions,
			queues: this.queues,
			tabs: this.tabs,
			pendingRequests: this.pendingRequests,
			isRunning: () => this.running,
			getPort: () => this.port,
			getTabs: (opts) => this.getTabs(opts),
			snapshot: (opts) => this.snapshot(opts),
			waitForExtensionReady: (browserSessionId, timeoutMs) => this.waitForExtensionReady(browserSessionId, timeoutMs),
		});
		this.clientMessageService = new BrowserBridgeClientMessageService({
			clients: this.clients,
			browserSessions: this.state.browserSessions,
			tabs: this.tabs,
			pendingRequests: this.pendingRequests,
			queues: this.queues,
			migratePerceptionLedger: (fromTabId, toTabId, browserSessionId) => {
				this.state.perceptionLedger.migrateTabId(fromTabId, toTabId, { browserSessionIds: [browserSessionId] });
			},
			clearRecorderStateForReplacement: (fromTabId, toTabId, browserSessionId) => {
				this.clearKnownRecorderStatesForReplacement(fromTabId, toTabId, browserSessionId);
			},
			notifyExtensionReady: () => this.notifyExtensionReady(),
			handshakeTimeoutMs: options.handshakeTimeoutMs,
		});
		this.heartbeat = new BrowserBridgeClientHeartbeat(this.clients, (ws, reason) => this.unregisterClient(ws, reason));
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
		this.state.clear();
		this.queues.clear();
		this.tabs.clear();
		this.knownRecorderStates.clear();
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
			queues: this.queues.snapshot(),
			pending: this.pendingRequests.snapshot(),
			connectionMetrics: this.clients.metrics(),
		};
	}

	getTabs(options: { includeDisconnected?: boolean } = {}): BrowserTabInfo[] {
		return this.tabs.getTabs(options);
	}

	getLastTabSyncAt(): number | undefined {
		return this.tabs.lastTabSyncAt;
	}

	async refreshTabs(timeoutMs = 5_000, options: { browserSessionId?: string; signal?: AbortSignal } = {}): Promise<BrowserTabInfo[]> {
		return await this.commandService.refreshTabs(timeoutMs, options);
	}

	/**
	 * Resolve true once a current extension build is selected for the session, or
	 * false after timeoutMs. A stale peer may wake the event-driven waiter but cannot
	 * complete it; this lets another browser instance with the current build dial in.
	 */
	async waitForExtensionReady(browserSessionId: string | undefined, timeoutMs: number): Promise<boolean> {
		const waitMs = Math.max(0, Math.floor(timeoutMs));
		const deadlineAt = Date.now() + waitMs;
		const isReady = () => {
			const snapshot = this.snapshot({ browserSessionId });
			return snapshot.extensionConnected && snapshot.extension?.extensionStale !== true;
		};
		while (!isReady()) {
			const remainingMs = deadlineAt - Date.now();
			if (remainingMs <= 0) return false;
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					this.extensionReadyWaiters.delete(finish);
					resolve();
				};
				const timer = setTimeout(finish, remainingMs);
				this.extensionReadyWaiters.add(finish);
				// Close the read-before-subscribe race if a current peer became selected
				// between the loop check and waiter registration.
				if (isReady()) finish();
			});
		}
		return true;
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

	async switchTab(tabId: number | string, timeoutMs = 5_000, options: { browserSessionId?: string; signal?: AbortSignal } = {}): Promise<BrowserBridgeExecutionResult> {
		return await this.commandService.switchTab(tabId, timeoutMs, options);
	}

	async createTab(url: string, active = true, timeoutMs = 5_000, options: { browserSessionId?: string; incognito?: boolean; signal?: AbortSignal } = {}): Promise<BrowserBridgeExecutionResult> {
		return await this.commandService.createTab(url, active, timeoutMs, options);
	}

	async closeTab(tabId: number | string, timeoutMs = 5_000, options: { browserSessionId?: string; signal?: AbortSignal } = {}): Promise<BrowserBridgeExecutionResult> {
		return await this.commandService.closeTab(tabId, timeoutMs, options);
	}

	async executeJavaScript(script: string, options: ExecuteOptions = {}): Promise<BrowserBridgeExecutionResult> {
		return await this.commandService.executeJavaScript(script, options);
	}

	async sendCommand(command: import("../../types/nativeProtocol.js").BridgeCommand, options: ExecuteOptions = {}): Promise<BrowserBridgeExecutionResult> {
		return await this.commandService.sendCommand(command, options);
	}

	async withTargetTransaction<T>(input: BrowserCommandTargetTransactionInput, run: () => Promise<T>): Promise<T> {
		const browserSession = this.browserSession(input.browserSessionId);
		const target = this.tabs.resolveTargetRef(input.targetRef ?? input.tabId, browserSession.id);
		return await this.queues.withTransaction(target?.browserId ?? browserSession.id, input.tabId, run, { signal: input.signal });
	}

	resolveTargetTabId(value: unknown, browserSessionId?: string): number {
		const target = this.tabs.resolveTargetRef(value, browserSessionId, "explicit");
		if (target?.tabId !== undefined) return target.tabId;
		throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId or targetRef is required", { tabId: value });
	}

	private recorderStateKey(kind: "network" | "hook", browserSessionId: string | undefined, tabId: number | undefined): string {
		return `${kind}:${browserSessionId ?? "default"}:${tabId ?? "selected"}`;
	}

	getKnownRecorderState(kind: "network" | "hook", browserSessionId: string | undefined, tabId: number | undefined): { active: boolean; lastSeq?: number } | undefined {
		const state = this.knownRecorderStates.get(this.recorderStateKey(kind, browserSessionId, tabId));
		return state ? { ...state } : undefined;
	}

	recordKnownRecorderState(kind: "network" | "hook", browserSessionId: string | undefined, tabId: number | undefined, state: { active: boolean; lastSeq?: number }): void {
		const key = this.recorderStateKey(kind, browserSessionId, tabId);
		this.knownRecorderStates.delete(key);
		this.knownRecorderStates.set(key, { ...state });
		while (this.knownRecorderStates.size > MAX_KNOWN_RECORDER_STATES) this.knownRecorderStates.delete(this.knownRecorderStates.keys().next().value!);
	}

	clearKnownRecorderStatesForReplacement(fromTabId: number, toTabId: number, browserSessionId: string): void {
		for (const kind of ["network", "hook"] as const) {
			this.knownRecorderStates.delete(this.recorderStateKey(kind, browserSessionId, fromTabId));
			this.knownRecorderStates.delete(this.recorderStateKey(kind, browserSessionId, toTabId));
		}
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

	recordPerceptionLedgerFrame(frame: CommandPerceptionLedgerFrame): CommandPerceptionLedgerFrame {
		return this.state.perceptionLedger.record(frame);
	}

	recordPerceptionTraceTerms(browserSessionId: string | undefined, terms: Array<{ term: string; kind: string; weight?: number }>): CommandPerceptionTraceSnapshot {
		return this.state.perceptionLedger.recordTraceTerms(browserSessionId, terms);
	}

	perceptionTraceSnapshot(browserSessionId?: string): CommandPerceptionTraceSnapshot {
		return this.state.perceptionLedger.traceSnapshot(browserSessionId);
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

	private startHeartbeat(): void {
		this.heartbeat.start();
	}

	private stopHeartbeat(): void {
		this.heartbeat.stop();
	}

	private browserSession(browserSessionId?: string): BrowserAutomationSession {
		return this.state.browserSessions.require(browserSessionId);
	}

}
