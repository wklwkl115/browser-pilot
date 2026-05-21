import { WebSocket } from "ws";
import { DEFAULT_BROWSER_BRIDGE_HOST } from "./browserBridgeConfig";
import { BrowserBridgeError, errorToPlain } from "./errors";
import { validateBridgeCommand } from "../protocol/nativeProtocol";
import { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry";
import { BrowserBridgeHttpServer } from "./BrowserBridgeHttpServer";
import { buildBridgeTimeoutDiagnostics } from "./BrowserBridgeDiagnostics";
import { BrowserBridgePendingRequests } from "./BrowserBridgePendingRequests";
import { BrowserTabSessionRouter } from "./BrowserTabSessionRouter";
import { bridgeResultFailure, delay, normalizePort, recordValue, toTabId } from "./bridgeUtils";
import type { BrowserBridgeClientInfo, BrowserBridgeExecutionResult, BrowserBridgeSnapshot, BrowserBridgeTargetInfo, BrowserTabInfo, BrowserTabSession, ExecuteOptions } from "./types";
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

export class BrowserBridgeServer {
	readonly host: string;
	readonly port: number;
	readonly sessions: Map<string, BrowserTabSession>;

	private readonly clients: BrowserBridgeClientRegistry;
	private readonly tabs: BrowserTabSessionRouter;
	private readonly pendingRequests: BrowserBridgePendingRequests;
	private readonly httpEndpoint: BrowserBridgeHttpServer;

	constructor(options: { host?: string; port?: number } = {}) {
		this.host = options.host || process.env.PI_BROWSER_BRIDGE_HOST || DEFAULT_BROWSER_BRIDGE_HOST;
		this.port = options.port || normalizePort(process.env.PI_BROWSER_BRIDGE_PORT);
		this.clients = new BrowserBridgeClientRegistry(this.port);
		this.tabs = new BrowserTabSessionRouter(this.clients);
		this.sessions = this.tabs.sessions;
		this.pendingRequests = new BrowserBridgePendingRequests(
			(tabId, timeoutMs, acked, target) => this.timeoutDiagnostics(tabId, timeoutMs, acked, target),
			(target) => this.tabs.resolvedTarget(target),
		);
		this.httpEndpoint = new BrowserBridgeHttpServer(this.host, this.port, (ws) => this.registerClient(ws));
	}

	get running(): boolean {
		return this.httpEndpoint.running;
	}

	async start(): Promise<void> {
		return this.httpEndpoint.start();
	}

	async stop(): Promise<void> {
		this.pendingRequests.rejectAllStopped();
		this.clients.clear();
		this.tabs.clear();
		await this.httpEndpoint.stop();
	}

	snapshot(): BrowserBridgeSnapshot {
		this.tabs.refreshSelectedSessionRefs();
		return {
			host: this.host,
			port: this.port,
			running: this.running,
			connectedClients: this.clients.connectedClientsCount(),
			extensionConnected: !!this.clients.selectedOpenClient(),
			extension: this.clients.selectedInfo(),
			clients: this.clients.connectedClientInfos(),
			defaultTabId: this.tabs.defaultTabId(),
			latestTabId: this.tabs.latestTabId(),
			selectionVersion: this.tabs.selectionVersion,
			tabs: this.getTabs({ includeDisconnected: true }),
			pending: this.pendingRequests.snapshot(),
		};
	}

	getTabs(options: { includeDisconnected?: boolean } = {}): BrowserTabInfo[] {
		return this.tabs.getTabs(options);
	}

	async refreshTabs(timeoutMs = 5_000): Promise<BrowserTabInfo[]> {
		const result = await this.sendCommand({ cmd: "tabs", method: "list" }, { timeoutMs });
		const data = Array.isArray(result.data) ? result.data : [];
		this.tabs.updateTabs(data, this.clients.requireExtensionClient());
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

	selectBrowser(browserId: string): BrowserBridgeClientInfo {
		const id = String(browserId || "").trim();
		if (!id) throw new BrowserBridgeError("INVALID_BROWSER_ID", "A browser client id is required", { browserId });
		const selected = this.clients.findClient(id);
		if (!selected) throw new BrowserBridgeError("BROWSER_NOT_FOUND", "No connected browser bridge client matches browserId", { browserId: id, clients: this.snapshot().clients });
		this.clients.select(selected.ws);
		const sessionId = this.tabs.selectBrowser(selected.ws);
		if (!sessionId) throw new BrowserBridgeError("NO_TAB", "Selected browser has no active tabs", { browserId: id, selected: selected.info, clients: this.snapshot().clients });
		return selected.info;
	}

	async switchTab(tabId: number | string, timeoutMs = 5_000): Promise<BrowserBridgeExecutionResult> {
		const id = this.requireTabId(tabId);
		const previousDefaultTabId = this.tabs.previousDefaultTabId();
		const result = await this.sendCommand({ cmd: "tabs", method: "switch", tabId: id }, { timeoutMs, tabId: id });
		const failure = bridgeResultFailure(result.data);
		if (failure) throw new BrowserBridgeError("BROWSER_COMMAND_FAILED", failure.message, { cmd: "tabs", method: "switch", tabId: id, ...failure.details });
		this.tabs.selectTab(id);
		const selection = { selectedTabId: id, previousDefaultTabId, selectionVersion: this.tabs.selectionVersion };
		const dataRecord = recordValue(result.data);
		const data = dataRecord ? { ...dataRecord, ...selection } : selection;
		return { ...result, data };
	}

	async createTab(url: string, active = true, timeoutMs = 5_000): Promise<BrowserBridgeExecutionResult> {
		return this.sendCommand({ cmd: "tabs", method: "create", url, active }, { timeoutMs });
	}

	async closeTab(tabId: number | string, timeoutMs = 5_000): Promise<BrowserBridgeExecutionResult> {
		const id = this.requireTabId(tabId);
		const result = await this.sendCommand({ cmd: "tabs", method: "close", targetTabId: id }, { timeoutMs, tabId: id });
		this.tabs.markTabDisconnected(id);
		return result;
	}

	async executeJavaScript(script: string, options: ExecuteOptions = {}): Promise<BrowserBridgeExecutionResult> {
		const target = this.requireExecutionTarget(options.tabId);
		return this.sendPayload(script, { tabId: target.tabId, timeoutMs: options.timeoutMs, target });
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
		const requestedTabId = optionTabId ?? commandTabId;
		const explicitTarget = requestedTabId !== undefined ? this.tabs.targetInfo("explicit", requestedTabId) : undefined;
		const target = explicitTarget ?? this.optionalExecutionTarget(command);
		const tabId = target?.tabId;
		const payload: BridgeCommand = tabId !== undefined ? { ...command, tabId } : command;
		const validation = validateBridgeCommand(payload, { allowMissingTabId: tabId === undefined });
		if (!validation.ok) throw new BrowserBridgeError("INVALID_BROWSER_COMMAND", validation.error, validation.details);
		if (validation.spec.tabScoped && tabId === undefined) throw new BrowserBridgeError("NO_TAB", "No target browser tab is available", { cmd: validation.command.cmd, tabs: this.getTabs() });
		return this.sendPayload(validation.command, { tabId, timeoutMs: options.timeoutMs, target });
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
		const socket = tabId !== undefined ? this.socketForTab(tabId) : this.clients.requireExtensionClient();
		const target = options.target ?? this.tabs.targetInfo(tabId !== undefined ? "explicit" : "none", tabId);
		return this.pendingRequests.send(socket, code, { tabId, timeoutMs: options.timeoutMs, target });
	}

	private registerClient(ws: WebSocket): void {
		this.clients.register(ws);
		ws.on("message", (data) => this.handleClientMessage(ws, data.toString()).catch(() => {}));
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
		catch { return; }

		this.clients.markSeen(ws);
		const type = String(message.type || "");
		if (type === "ping") return;
		if (type === "ext_ready" || type === "tabs_update") {
			this.clients.select(ws);
			this.clients.updateClientInfo(ws, message.bridge || message.extension);
			this.tabs.updateTabs(Array.isArray(message.tabs) ? message.tabs : [], ws);
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

	private socketForTab(tabId: number): WebSocket {
		const socket = this.tabs.socketForTab(tabId);
		if (socket) return socket;
		throw new BrowserBridgeError("TAB_NOT_FOUND", "Target browser tab is not connected", {
			tabId,
			selectedBrowser: this.clients.selectedInfo(),
			tabs: this.getTabs(),
		});
	}

	private requireExecutionTarget(value: unknown): BrowserBridgeTargetInfo {
		const requested = toTabId(value);
		if (requested) return this.tabs.targetInfo("explicit", requested);
		if (value !== undefined) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId is required", { tabId: value, source: "options" });
		const fallback = this.tabs.fallbackExecutionTarget();
		if (fallback) return fallback;
		throw new BrowserBridgeError("NO_TAB", "No target browser tab is available", { tabs: this.getTabs() });
	}

	private optionalExecutionTarget(command: BridgeCommand): BrowserBridgeTargetInfo | undefined {
		const cmd = String(command.cmd || "");
		if (cmd === "tabs" && (!command.method || command.method === "list" || command.method === "create")) return this.tabs.targetInfo("none");
		if (cmd === "management") return this.tabs.targetInfo("none");
		return this.tabs.fallbackExecutionTarget();
	}

	private requireTabId(value: unknown): number {
		const tabId = toTabId(value);
		if (!tabId) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId is required", { tabId: value });
		return tabId;
	}
}
