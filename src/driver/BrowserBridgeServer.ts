import { WebSocket } from "ws";
import { DEFAULT_BROWSER_BRIDGE_HOST, DEFAULT_BROWSER_BRIDGE_PORT_RANGE_END } from "./browserBridgeConfig";
import { BrowserBridgeError, errorToPlain } from "./errors";
import { getNativeCommandProtocolSchema, validateBridgeCommand } from "../protocol/nativeProtocol";
import { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry";
import { BrowserBridgeClientHeartbeat } from "./BrowserBridgeClientHeartbeat";
import { BrowserBridgeHttpServer } from "./BrowserBridgeHttpServer";
import { buildBridgeTimeoutDiagnostics } from "./BrowserBridgeDiagnostics";
import { BrowserBridgePendingRequests } from "./BrowserBridgePendingRequests";
import { BrowserCommandQueueRegistry } from "./BrowserCommandQueueRegistry";
import { BrowserLeaseRegistry } from "./BrowserLeaseRegistry";
import { BrowserObservationSnapshotRegistry } from "./BrowserObservationSnapshotRegistry";
import { BrowserOperationRegistry } from "./BrowserOperationRegistry";
import { BrowserRuntimeRecoveryArtifacts } from "./BrowserRuntimeRecoveryArtifacts";
import { BrowserSessionRegistry } from "./BrowserSessionRegistry";
import { BrowserTabSessionRouter } from "./BrowserTabSessionRouter";
import { bridgeResultFailure, delay, normalizePort, recordValue, toTabId } from "./bridgeUtils";
import type { BrowserActiveOperationInfo, BrowserAutomationSession, BrowserAutomationSessionInfo, BrowserBridgeClientInfo, BrowserBridgeExecutionResult, BrowserBridgeSnapshot, BrowserBridgeTargetInfo, BrowserObservationSnapshotInfo, BrowserTabInfo, BrowserTabLeaseInfo, BrowserTabSession, BrowserToolCapabilityProfileInfo, BrowserUiLockInfo, ExecuteOptions } from "./types";
import type { BridgeCommand } from "../protocol/nativeProtocol";

type IncomingMessage = {
	type?: unknown;
	id?: unknown;
	error?: unknown;
	result?: unknown;
	newTabs?: unknown;
	tabs?: unknown;
	bridge?: unknown;
	extension?: unknown;
	[key: string]: unknown;
};

type SendPayloadOptions = ExecuteOptions & { target?: BrowserBridgeTargetInfo };

type CommandExecutionPlan = { target?: BrowserBridgeTargetInfo; tabId?: number; accessMode: "read" | "write" };

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
	private capabilityProfile: BrowserToolCapabilityProfileInfo = {
		name: "core",
		source: "default",
		envVar: "PI_BROWSER_TOOL_PROFILE",
		securityToolsEnabled: false,
		enableHint: "PI_BROWSER_TOOL_PROFILE=security then /reload",
	};

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
		this.heartbeat = new BrowserBridgeClientHeartbeat(this.clients, (ws) => this.unregisterClient(ws));
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
		const browserSession = this.browserSessions.get(options.browserSessionId);
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
			capabilityProfile: this.capabilityProfileInfo(),
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
		if (!attached) throw new BrowserBridgeError("TAB_NOT_FOUND", "Target browser tab is not connected", { tabId: id, browserId: options.browserId, browserSessionId: options.browserSessionId, tabs: this.getTabs() });
		return this.tabInfo(attached);
	}

	detachTabFromBrowserSession(tabId: number | string, options: { browserSessionId?: string } = {}): BrowserAutomationSessionInfo {
		const id = this.requireTabId(tabId);
		this.tabs.detachTab(id, options.browserSessionId);
		return this.browserSessionInfo(this.browserSessions.get(options.browserSessionId));
	}

	leaseTab(tabId: number | string, options: { browserSessionId?: string } = {}): BrowserTabLeaseInfo {
		const id = this.requireTabId(tabId);
		const browserSession = this.browserSessions.get(options.browserSessionId);
		const tab = this.requireLiveTabSession(id, browserSession.id);
		return this.leases.leaseTab(browserSession.id, tab, true);
	}

	releaseTab(tabId: number | string, options: { browserSessionId?: string } = {}): BrowserTabLeaseInfo | undefined {
		const id = this.requireTabId(tabId);
		const browserSession = this.browserSessions.get(options.browserSessionId);
		const tab = this.requireLiveTabSession(id, browserSession.id);
		return this.leases.releaseTab(browserSession.id, tab);
	}

	acquireUiLock(browserSessionId: string | undefined, toolName: string): BrowserUiLockInfo {
		return this.leases.acquireUiLock(this.browserSessions.get(browserSessionId).id, toolName);
	}

	releaseUiLock(browserSessionId: string | undefined): BrowserUiLockInfo | undefined {
		return this.leases.releaseUiLock(this.browserSessions.get(browserSessionId).id);
	}

	async refreshTabs(timeoutMs = 5_000, options: { browserSessionId?: string } = {}): Promise<BrowserTabInfo[]> {
		const result = await this.sendCommand({ cmd: "tabs", method: "list" }, { timeoutMs, browserSessionId: options.browserSessionId });
		const data = Array.isArray(result.data) ? result.data : [];
		this.tabs.updateTabs(data, this.socketForBrowserSessionCommand(options.browserSessionId));
		return this.getTabs();
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
		const id = this.requireTabId(tabId);
		const browserSession = this.browserSessions.get(options.browserSessionId);
		this.leases.acquireUiLock(browserSession.id, "browser_tabs.switch");
		try {
			const previousDefaultTabId = this.tabs.previousDefaultTabId(options.browserSessionId);
			const result = await this.sendCommand({ cmd: "tabs", method: "switch", tabId: id }, { timeoutMs, tabId: id, browserSessionId: options.browserSessionId });
			const failure = bridgeResultFailure(result.data);
			if (failure) throw new BrowserBridgeError("BROWSER_COMMAND_FAILED", failure.message, { cmd: "tabs", method: "switch", tabId: id, ...failure.details });
			this.tabs.selectTab(id, options.browserSessionId);
			const selection = { selectedTabId: id, previousDefaultTabId, selectionVersion: this.tabs.selectionVersion };
			const dataRecord = recordValue(result.data);
			const data = dataRecord ? { ...dataRecord, ...selection } : selection;
			return { ...result, data };
		} finally {
			this.leases.releaseUiLock(browserSession.id);
		}
	}

	async createTab(url: string, active = true, timeoutMs = 5_000, options: { browserSessionId?: string } = {}): Promise<BrowserBridgeExecutionResult> {
		return this.sendCommand({ cmd: "tabs", method: "create", url, active }, { timeoutMs, browserSessionId: options.browserSessionId });
	}

	async closeTab(tabId: number | string, timeoutMs = 5_000, options: { browserSessionId?: string } = {}): Promise<BrowserBridgeExecutionResult> {
		const id = this.requireTabId(tabId);
		const result = await this.sendCommand({ cmd: "tabs", method: "close", targetTabId: id }, { timeoutMs, tabId: id, browserSessionId: options.browserSessionId });
		this.tabs.markTabDisconnected(id, options.browserSessionId);
		return result;
	}

	async executeJavaScript(script: string, options: ExecuteOptions = {}): Promise<BrowserBridgeExecutionResult> {
		const target = this.requireExecutionTarget(options.tabId, options.browserSessionId);
		return this.sendPayload(script, { browserSessionId: options.browserSessionId, tabId: target.tabId, timeoutMs: options.timeoutMs, target, accessMode: options.accessMode ?? "write" });
	}

	async sendCommand(command: BridgeCommand, options: ExecuteOptions = {}): Promise<BrowserBridgeExecutionResult> {
		const hasOptionTabId = options.tabId !== undefined;
		const hasCommandTabId = command.tabId !== undefined;
		const optionTabId = toTabId(options.tabId);
		const commandTabId = toTabId(command.tabId);
		if (hasOptionTabId && optionTabId === undefined) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId is required", { cmd: command.cmd, tabId: options.tabId, source: "options" });
		if (hasCommandTabId && commandTabId === undefined) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid command tabId is required", { cmd: command.cmd, tabId: command.tabId, source: "command" });
		if (optionTabId !== undefined && commandTabId !== undefined && optionTabId !== commandTabId) {
			throw new BrowserBridgeError("TAB_ID_CONFLICT", "Top-level tabId conflicts with command tabId", { cmd: command.cmd, tabId: optionTabId, commandTabId });
		}
		const browserSession = this.browserSessions.get(options.browserSessionId);
		const requestedTabId = optionTabId ?? commandTabId;
		const explicitTarget = requestedTabId !== undefined ? this.tabs.targetInfo("explicit", requestedTabId, browserSession) : undefined;
		const target = explicitTarget ?? this.optionalExecutionTarget(command, options.browserSessionId);
		const tabId = target?.tabId;
		const payload: BridgeCommand = tabId !== undefined ? { ...command, tabId } : command;
		const validation = validateBridgeCommand(payload, { allowMissingTabId: tabId === undefined });
		if (!validation.ok) throw new BrowserBridgeError("INVALID_BROWSER_COMMAND", validation.error, validation.details);
		if (validation.spec.tabScoped && tabId === undefined) throw new BrowserBridgeError("NO_TAB", "No target browser tab is available", { cmd: validation.command.cmd, tabs: this.getTabs() });
		const plan = this.commandExecutionPlan(validation.command, target, options.accessMode);
		return this.sendPayload(validation.command, { browserSessionId: options.browserSessionId, tabId: plan.tabId, timeoutMs: options.timeoutMs, target: plan.target, accessMode: plan.accessMode });
	}

	setCapabilityProfile(profile: BrowserToolCapabilityProfileInfo): void {
		this.capabilityProfile = { ...profile };
	}

	capabilityProfileInfo(): BrowserToolCapabilityProfileInfo {
		return { ...this.capabilityProfile };
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

	private sendPayload(code: unknown, options: SendPayloadOptions = {}): Promise<BrowserBridgeExecutionResult> {
		if (!this.running) throw new BrowserBridgeError("BRIDGE_NOT_RUNNING", "Browser bridge server is not running", { port: this.port });
		const tabId = toTabId(options.tabId);
		const target = options.target ?? this.tabs.targetInfo(tabId !== undefined ? "explicit" : "none", tabId, this.browserSessions.get(options.browserSessionId));
		const recordResult = (promise: Promise<BrowserBridgeExecutionResult>) => promise.then((result) => {
			this.runtimeRecoveryArtifacts.recordCommandResult(code, result, { browserSessionId: options.browserSessionId, target, snapshot: this.snapshot({ browserSessionId: options.browserSessionId }) });
			return result;
		});
		if (tabId !== undefined) {
			const browserSession = this.browserSessions.get(options.browserSessionId);
			const tab = this.requireLiveTabSession(tabId, browserSession.id);
			if (options.accessMode === "write") {
				return recordResult(this.queues.enqueue(browserSession.id, tabId, async () => await this.leases.withAutoTabLease(browserSession.id, tab, () => this.pendingRequests.send(tab.client, code, { tabId, timeoutMs: options.timeoutMs, target }))));
			}
			return recordResult(this.pendingRequests.send(tab.client, code, { tabId, timeoutMs: options.timeoutMs, target }));
		}
		const socket = this.socketForBrowserSessionCommand(options.browserSessionId);
		return recordResult(this.pendingRequests.send(socket, code, { tabId, timeoutMs: options.timeoutMs, target }));
	}

	private registerClient(ws: WebSocket): void {
		this.clients.register(ws);
		ws.on("message", (data) => this.handleClientMessage(ws, data.toString()).catch((error) => {
			console.error("[pi-browser-bridge] WebSocket message handler failed", this.redactMessageError(error, data.toString()));
		}));
		ws.on("pong", () => this.clients.markPong(ws));
		ws.on("close", () => this.unregisterClient(ws));
		ws.on("error", () => this.unregisterClient(ws));
	}

	private unregisterClient(ws: WebSocket): void {
		this.pendingRequests.rejectForClient(ws);
		this.clients.unregister(ws);
		this.tabs.markClientDisconnected(ws);
	}

	private async handleClientMessage(ws: WebSocket, raw: string): Promise<void> {
		let message: IncomingMessage;
		try { message = JSON.parse(raw) as IncomingMessage; }
		catch (error) {
			console.warn("[pi-browser-bridge] Invalid WebSocket message JSON", this.redactMessageError(error, raw));
			return;
		}

		this.clients.markSeen(ws);
		const type = String(message.type || "");
		if (type === "ping") return;
		if (type === "ext_ready" || type === "tabs_update") {
			this.browserSessions.selectClient(this.browserSessions.defaultSession(), ws);
			this.clients.updateClientInfo(ws, message.bridge || message.extension);
			this.tabs.updateTabs(Array.isArray(message.tabs) ? message.tabs : [], ws);
			if (type === "ext_ready") this.runtimeRecoveryArtifacts.recordRuntimeRecovery(this.clients.info(ws), recordValue(message.bridge));
			return;
		}
		if (type === "ack") {
			this.pendingRequests.ack(String(message.id || ""));
			return;
		}
		if (type === "result" || type === "error") {
			const id = String(message.id || "");
			if (type === "error") {
				this.pendingRequests.rejectBrowserError(id, message.error, message.result);
				return;
			}
			this.pendingRequests.resolve(id, message.result, Array.isArray(message.newTabs) ? message.newTabs : []);
		}
	}

	private browserSessionInfo(session: BrowserAutomationSession): BrowserAutomationSessionInfo {
		return this.tabs.describeBrowserSession(session, this.browserSessions.selectedInfo(session, this.clients));
	}

	private tabInfo(session: BrowserTabSession): BrowserTabInfo {
		const { client: _client, ...info } = session;
		return info;
	}

	private socketForBrowserSessionCommand(browserSessionId?: string): WebSocket {
		const browserSession = this.browserSessions.get(browserSessionId);
		const selected = this.browserSessions.selectedOpenClient(browserSession);
		if (selected) return selected;
		if (browserSession.id !== "default") {
			throw new BrowserBridgeError("NO_BROWSER_EXTENSION", "Requested browser session has no selected browser extension client", {
				browserSessionId: browserSession.id,
				sessions: this.listBrowserSessions(),
			});
		}
		return this.clients.requireExtensionClient();
	}

	private requireLiveTabSession(tabId: number, browserSessionId?: string): BrowserTabSession {
		const session = this.tabs.liveSessionForTabId(tabId, browserSessionId);
		if (session) return session;
		throw new BrowserBridgeError("TAB_NOT_FOUND", "Target browser tab is not connected", { tabId, browserSessionId, selectedBrowser: this.browserSessions.selectedInfo(this.browserSessions.get(browserSessionId), this.clients), tabs: this.getTabs() });
	}

	private requireExecutionTarget(value: unknown, browserSessionId?: string): BrowserBridgeTargetInfo {
		const browserSession = this.browserSessions.get(browserSessionId);
		const requested = toTabId(value);
		if (requested) return this.tabs.targetInfo("explicit", requested, browserSession);
		if (value !== undefined) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId is required", { tabId: value, source: "options" });
		const fallback = this.tabs.fallbackExecutionTarget(browserSessionId);
		if (fallback) return fallback;
		throw new BrowserBridgeError("NO_TAB", "No target browser tab is available", { tabs: this.getTabs() });
	}

	private optionalExecutionTarget(command: BridgeCommand, browserSessionId?: string): BrowserBridgeTargetInfo | undefined {
		const browserSession = this.browserSessions.get(browserSessionId);
		const currentSchema = getNativeCommandProtocolSchema();
		const canonical = currentSchema.commands[String(command.cmd || "")]?.canonical || currentSchema.aliases?.[String(command.cmd || "")] || String(command.cmd || "");
		const spec = currentSchema.commands[canonical];
		if (!spec?.tabScoped) return this.tabs.targetInfo("none", undefined, browserSession);
		return this.tabs.fallbackExecutionTarget(browserSessionId);
	}

	private commandExecutionPlan(command: BridgeCommand, target: BrowserBridgeTargetInfo | undefined, preferred?: "read" | "write"): CommandExecutionPlan {
		const currentSchema = getNativeCommandProtocolSchema();
		const canonical = currentSchema.commands[String(command.cmd || "")]?.canonical || currentSchema.aliases?.[String(command.cmd || "")] || String(command.cmd || "");
		const spec = currentSchema.commands[canonical];
		const method = String(command.method || command.action || spec?.defaultMethod || "").toLowerCase();
		const tabId = target?.tabId;
		if (!spec) return { target, tabId, accessMode: preferred ?? "read" };
		const requiresTransportTab = spec.tabScoped || (canonical === "tabs" && ["switch", "close"].includes(method));
		const noneTarget = !requiresTransportTab;
		const write = preferred ?? this.commandAccessMode(command);
		return {
			target: noneTarget ? this.tabs.targetInfo("none", undefined, this.browserSessions.get(target?.browserSessionId)) : target,
			tabId: noneTarget ? undefined : tabId,
			accessMode: write,
		};
	}

	private commandAccessMode(command: BridgeCommand): "read" | "write" {
		const cmd = String(command.cmd || "");
		const method = String(command.method || command.action || "").toLowerCase();
		if (cmd === "tabs" && ["switch", "create", "close"].includes(method)) return "write";
		if (cmd === "wait.navigate" || cmd === "wait.navigateAndWait") return "write";
		if (cmd === "transfer.upload" || cmd === "transfer.download") return "write";
		if (cmd.startsWith("hook.") && !["hook.status", "hook.collect", "hook.list_sessions", "hook.getPerformanceEntries", "hook.evaluate"].includes(cmd)) return "write";
		if (cmd.startsWith("network.") && ["network.start", "network.stop", "network.clear"].includes(cmd)) return "write";
		if (cmd.startsWith("intercept.") && !["intercept.status", "intercept.listRules", "intercept.collect"].includes(cmd)) return "write";
		return this.schemaDrivenCommandAccessMode(cmd, method);
	}

	private startHeartbeat(): void {
		this.heartbeat.start();
	}

	private stopHeartbeat(): void {
		this.heartbeat.stop();
	}

	private redactMessageError(error: unknown, raw: string): Record<string, unknown> {
		return { error: errorToPlain(error), bytes: Buffer.byteLength(raw) };
	}

	private schemaDrivenCommandAccessMode(canonicalCmd: string, method: string): "read" | "write" {
		const writeActions = new Set([
			"tabs.switch",
			"tabs.create",
			"tabs.close",
			"management.reload",
			"management.disable",
			"management.enable",
			"wait.navigate",
			"wait.navigateandwait",
			"network.start",
			"network.stop",
			"network.clear",
			"transfer.download",
			"transfer.upload",
			"hook.install_targets",
			"hook.install",
			"hook.clear",
			"hook.clear_buffer",
			"hook.pause",
			"hook.resume",
			"hook.uninstall",
			"hook.addeventlistener",
			"hook.removeeventlistener",
			"frame.evaluate",
			"frame.addnewdocumentscript",
			"frame.removenewdocumentscript",
		]);
		if (canonicalCmd.startsWith("intercept.")) {
			if (["intercept.status", "intercept.listRules", "intercept.collect"].includes(canonicalCmd)) return "read";
			return "write";
		}
		return writeActions.has(`${canonicalCmd}.${method}`.toLowerCase()) || writeActions.has(canonicalCmd.toLowerCase()) ? "write" : "read";
	}

	private requireTabId(value: unknown): number {
		const tabId = toTabId(value);
		if (!tabId) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId is required", { tabId: value });
		return tabId;
	}
}
