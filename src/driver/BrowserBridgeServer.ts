import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { DEFAULT_BROWSER_BRIDGE_HOST, DEFAULT_BROWSER_BRIDGE_PORT } from "./browserBridgeConfig";
import { BrowserBridgeError, errorToPlain } from "./errors";
import { validateBridgeCommand } from "../protocol/nativeProtocol";
import type { BrowserBridgeClientInfo, BrowserBridgeExecutionResult, BrowserBridgeSnapshot, BrowserTabInfo, BrowserTabSession, ExecuteOptions, PendingRequest } from "./types";
import type { BridgeCommand } from "../protocol/nativeProtocol";

const DEFAULT_TIMEOUT_MS = 15_000;
const CLOSED_STATES = new Set([WebSocket.CLOSED, WebSocket.CLOSING]);

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

function normalizePort(value: string | undefined): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return DEFAULT_BROWSER_BRIDGE_PORT;
	return parsed;
}

function isOpen(ws: WebSocket | undefined): ws is WebSocket {
	return !!ws && ws.readyState === WebSocket.OPEN;
}

function toTabId(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

function normalizeErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object") {
		const item = error as { message?: unknown; error?: unknown; name?: unknown };
		if (typeof item.message === "string") return item.message;
		if (typeof item.error === "string") return item.error;
		if (typeof item.name === "string") return item.name;
	}
	return String(error);
}

function browserTabInfo(session: BrowserTabSession): BrowserTabInfo {
	const { client: _client, ...info } = session;
	return info;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BrowserBridgeServer {
	readonly host: string;
	readonly port: number;

	private httpServer?: http.Server;
	private wss?: WebSocketServer;
	private clients = new Set<WebSocket>();
	private clientInfo = new Map<WebSocket, BrowserBridgeClientInfo>();
	private extensionClient?: WebSocket;
	private sessions = new Map<string, BrowserTabSession>();
	private pending = new Map<string, PendingRequest>();
	private defaultSessionId?: string;
	private latestSessionId?: string;
	private starting?: Promise<void>;

	constructor(options: { host?: string; port?: number } = {}) {
		this.host = options.host || process.env.PI_BROWSER_BRIDGE_HOST || DEFAULT_BROWSER_BRIDGE_HOST;
		this.port = options.port || normalizePort(process.env.PI_BROWSER_BRIDGE_PORT);
	}

	get running(): boolean {
		return !!this.httpServer?.listening;
	}

	async start(): Promise<void> {
		if (this.running) return;
		if (this.starting) return this.starting;
		this.starting = new Promise<void>((resolve, reject) => {
			const server = http.createServer((req, res) => {
				if (req.url === "/health" || req.url === "/") {
					res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ ok: true, name: "pi-browser-tools", port: this.port }));
					return;
				}
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				res.end("not found");
			});

			const wss = new WebSocketServer({ noServer: true });
			server.on("upgrade", (req, socket, head) => {
				wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
			});
			wss.on("connection", (ws) => this.registerClient(ws));

			server.once("error", (error) => {
				this.starting = undefined;
				reject(new BrowserBridgeError("BRIDGE_START_FAILED", normalizeErrorMessage(error), { host: this.host, port: this.port }));
			});
			server.listen(this.port, this.host, () => {
				this.httpServer = server;
				this.wss = wss;
				this.starting = undefined;
				resolve();
			});
		});
		return this.starting;
	}

	async stop(): Promise<void> {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new BrowserBridgeError("BRIDGE_STOPPED", "Browser bridge stopped before request completed", { id: pending.id, tabId: pending.tabId }));
		}
		this.pending.clear();
		for (const client of this.clients) {
			try { client.close(); } catch {}
		}
		this.clients.clear();
		this.clientInfo.clear();
		this.extensionClient = undefined;
		this.sessions.clear();
		this.defaultSessionId = undefined;
		this.latestSessionId = undefined;
		await new Promise<void>((resolve) => {
			if (!this.wss && !this.httpServer) { resolve(); return; }
			try { this.wss?.close(); } catch {}
			const server = this.httpServer;
			this.wss = undefined;
			this.httpServer = undefined;
			if (!server?.listening) { resolve(); return; }
			server.close(() => resolve());
		});
	}

	snapshot(): BrowserBridgeSnapshot {
		return {
			host: this.host,
			port: this.port,
			running: this.running,
			connectedClients: Array.from(this.clients).filter((ws) => !CLOSED_STATES.has(ws.readyState)).length,
			extensionConnected: isOpen(this.extensionClient),
			extension: this.extensionClient ? this.clientInfo.get(this.extensionClient) : undefined,
			clients: Array.from(this.clients).filter((ws) => !CLOSED_STATES.has(ws.readyState)).map((ws) => this.clientInfo.get(ws)).filter((item): item is BrowserBridgeClientInfo => !!item),
			defaultTabId: toTabId(this.defaultSessionId),
			latestTabId: toTabId(this.latestSessionId),
			tabs: this.getTabs({ includeDisconnected: true }),
			pending: Array.from(this.pending.values()).map((item) => ({ id: item.id, tabId: item.tabId, createdAt: item.createdAt, acked: item.acked })),
		};
	}

	getTabs(options: { includeDisconnected?: boolean } = {}): BrowserTabInfo[] {
		const tabs = Array.from(this.sessions.values());
		return tabs
			.filter((tab) => options.includeDisconnected || !tab.disconnectedAt)
			.sort((a, b) => a.tabId - b.tabId)
			.map(browserTabInfo);
	}

	async refreshTabs(timeoutMs = 5_000): Promise<BrowserTabInfo[]> {
		const result = await this.sendCommand({ cmd: "tabs", method: "list" }, { timeoutMs });
		const data = Array.isArray(result.data) ? result.data : [];
		this.updateTabs(data, this.requireExtensionClient());
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
		for (const [ws, info] of this.clientInfo.entries()) {
			if (CLOSED_STATES.has(ws.readyState)) continue;
			if (info.id !== id && info.extensionId !== id) continue;
			this.extensionClient = ws;
			this.defaultSessionId = this.firstActiveSessionIdForClient(ws) ?? this.defaultSessionId;
			return info;
		}
		throw new BrowserBridgeError("BROWSER_NOT_FOUND", "No connected browser bridge client matches browserId", { browserId: id, clients: this.snapshot().clients });
	}

	async switchTab(tabId: number | string, timeoutMs = 5_000): Promise<BrowserBridgeExecutionResult> {
		const id = this.requireTabId(tabId);
		const result = await this.sendCommand({ cmd: "tabs", method: "switch", tabId: id }, { timeoutMs, tabId: id });
		this.defaultSessionId = String(id);
		return result;
	}

	async createTab(url: string, active = true, timeoutMs = 5_000): Promise<BrowserBridgeExecutionResult> {
		return this.sendCommand({ cmd: "tabs", method: "create", url, active }, { timeoutMs });
	}

	async closeTab(tabId: number | string, timeoutMs = 5_000): Promise<BrowserBridgeExecutionResult> {
		const id = this.requireTabId(tabId);
		const result = await this.sendCommand({ cmd: "tabs", method: "close", targetTabId: id }, { timeoutMs, tabId: id });
		const session = this.sessions.get(String(id));
		if (session && !session.disconnectedAt) session.disconnectedAt = Date.now();
		if (this.defaultSessionId === String(id)) this.defaultSessionId = this.firstActiveSessionId();
		return result;
	}

	async executeJavaScript(script: string, options: ExecuteOptions = {}): Promise<BrowserBridgeExecutionResult> {
		const tabId = this.requireExecutionTabId(options.tabId);
		return this.sendPayload(script, { tabId, timeoutMs: options.timeoutMs });
	}

	async sendCommand(command: BridgeCommand, options: ExecuteOptions = {}): Promise<BrowserBridgeExecutionResult> {
		const requestedTabId = toTabId(options.tabId ?? command.tabId);
		const tabId = requestedTabId ?? this.optionalExecutionTabId(command);
		const payload: BridgeCommand = tabId !== undefined && command.tabId === undefined ? { ...command, tabId } : command;
		const validation = validateBridgeCommand(payload, { allowMissingTabId: false });
		if (!validation.ok) throw new BrowserBridgeError("INVALID_BROWSER_COMMAND", validation.error, validation.details);
		return this.sendPayload(validation.command, { tabId, timeoutMs: options.timeoutMs });
	}

	private timeoutDiagnostics(tabId: number | undefined, timeoutMs: number, acked: boolean): Record<string, unknown> {
		const snapshot = this.snapshot();
		return {
			tabId,
			timeoutMs,
			acked,
			running: snapshot.running,
			extensionConnected: snapshot.extensionConnected,
			connectedClients: snapshot.connectedClients,
			defaultTabId: snapshot.defaultTabId,
			latestTabId: snapshot.latestTabId,
			tabCount: snapshot.tabs.filter((tab) => !tab.disconnectedAt).length,
			pendingCount: snapshot.pending.length,
		};
	}

	private sendPayload(code: unknown, options: ExecuteOptions = {}): Promise<BrowserBridgeExecutionResult> {
		if (!this.running) throw new BrowserBridgeError("BRIDGE_NOT_RUNNING", "Browser bridge server is not running", { port: this.port });
		const tabId = toTabId(options.tabId);
		const socket = tabId !== undefined ? this.socketForTab(tabId) : this.requireExtensionClient();
		const id = randomUUID();
		const timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
		const payload: Record<string, unknown> = { id, code };
		if (tabId !== undefined) payload.tabId = tabId;

		return new Promise<BrowserBridgeExecutionResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const state = pending.acked ? "ACK received, script may still be running" : "no ACK, message may not have been delivered";
				reject(new BrowserBridgeError("BRIDGE_TIMEOUT", `No browser response in ${timeoutMs}ms (${state})`, { id, ...this.timeoutDiagnostics(tabId, timeoutMs, pending.acked) }));
			}, timeoutMs);
			const pending: PendingRequest = { id, tabId, createdAt: Date.now(), acked: false, timer, resolve, reject };
			this.pending.set(id, pending);
			try {
				socket.send(JSON.stringify(payload));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new BrowserBridgeError("BRIDGE_SEND_FAILED", normalizeErrorMessage(error), { id, tabId }));
			}
		});
	}

	private registerClient(ws: WebSocket): void {
		this.clients.add(ws);
		const now = Date.now();
		this.clientInfo.set(ws, { id: randomUUID(), connectedAt: now, lastSeenAt: now });
		ws.on("message", (data) => this.handleClientMessage(ws, data.toString()).catch(() => {}));
		ws.on("close", () => this.unregisterClient(ws));
		ws.on("error", () => this.unregisterClient(ws));
	}

	private unregisterClient(ws: WebSocket): void {
		this.clients.delete(ws);
		this.clientInfo.delete(ws);
		if (this.extensionClient === ws) this.extensionClient = undefined;
		for (const session of this.sessions.values()) {
			if (session.client === ws && !session.disconnectedAt) session.disconnectedAt = Date.now();
		}
	}

	private async handleClientMessage(ws: WebSocket, raw: string): Promise<void> {
		let message: IncomingMessage;
		try { message = JSON.parse(raw) as IncomingMessage; }
		catch { return; }

		const info = this.clientInfo.get(ws);
		if (info) info.lastSeenAt = Date.now();
		const type = String(message.type || "");
		if (type === "ping") return;
		if (type === "ext_ready" || type === "tabs_update") {
			this.extensionClient = ws;
			this.updateClientInfo(ws, message);
			this.updateTabs(Array.isArray(message.tabs) ? message.tabs : [], ws);
			return;
		}
		if (type === "ack") {
			const id = String(message.id || "");
			const pending = this.pending.get(id);
			if (pending) {
				pending.acked = true;
				pending.ackAt = Date.now();
			}
			return;
		}
		if (type === "result" || type === "error") {
			const id = String(message.id || "");
			const pending = this.pending.get(id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.pending.delete(id);
			if (type === "error") {
				pending.reject(new BrowserBridgeError("BROWSER_EXECUTION_ERROR", normalizeErrorMessage(message.error), { id, tabId: pending.tabId, error: message.error }));
				return;
			}
			pending.resolve({ id, tabId: pending.tabId, acknowledged: pending.acked, data: message.result, newTabs: Array.isArray(message.newTabs) ? message.newTabs : [] });
		}
	}

	private updateClientInfo(ws: WebSocket, message: IncomingMessage): void {
		const current = this.clientInfo.get(ws);
		if (!current) return;
		const raw = (message.bridge || message.extension) as Record<string, unknown> | undefined;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
		if (typeof raw.id === "string") current.extensionId = raw.id;
		if (typeof raw.name === "string") current.name = raw.name;
		if (typeof raw.version === "string") current.version = raw.version;
		if (typeof raw.userAgent === "string") current.userAgent = raw.userAgent;
	}

	private updateTabs(rawTabs: unknown[], ws: WebSocket): void {
		const now = Date.now();
		const current = new Set<string>();
		for (const raw of rawTabs) {
			if (!raw || typeof raw !== "object") continue;
			const tab = raw as Record<string, unknown>;
			const tabId = toTabId(tab.id ?? tab.tabId);
			if (!tabId) continue;
			const id = String(tabId);
			current.add(id);
			const existing = this.sessions.get(id);
			this.sessions.set(id, {
				id,
				tabId,
				url: typeof tab.url === "string" ? tab.url : existing?.url || "",
				title: typeof tab.title === "string" ? tab.title : existing?.title || "",
				active: typeof tab.active === "boolean" ? tab.active : existing?.active,
				windowId: toTabId(tab.windowId) ?? existing?.windowId,
				type: "ext_ws",
				connectedAt: existing?.connectedAt || now,
				bridge: this.clientInfo.get(ws),
				client: ws,
			});
			if (tab.active === true || !this.defaultSessionId) this.defaultSessionId = id;
			this.latestSessionId = id;
		}
		for (const [id, session] of this.sessions) {
			if (!current.has(id) && session.client === ws && !session.disconnectedAt) session.disconnectedAt = now;
		}
		if (!this.defaultSessionId || this.sessions.get(this.defaultSessionId)?.disconnectedAt) this.defaultSessionId = this.firstActiveSessionId();
	}

	private firstActiveSessionId(): string | undefined {
		return Array.from(this.sessions.values()).find((session) => !session.disconnectedAt)?.id;
	}

	private firstActiveSessionIdForClient(client: WebSocket): string | undefined {
		return Array.from(this.sessions.values()).find((session) => session.client === client && !session.disconnectedAt)?.id;
	}

	private requireExtensionClient(): WebSocket {
		if (isOpen(this.extensionClient)) return this.extensionClient;
		const open = Array.from(this.clients).find(isOpen);
		if (open) return open;
		throw new BrowserBridgeError("NO_BROWSER_EXTENSION", "No connected browser bridge extension", { port: this.port });
	}

	private socketForTab(tabId: number): WebSocket {
		const session = this.sessions.get(String(tabId));
		if (session && !session.disconnectedAt && isOpen(session.client)) return session.client;
		return this.requireExtensionClient();
	}

	private requireExecutionTabId(value: unknown): number {
		const tabId = toTabId(value) ?? toTabId(this.defaultSessionId) ?? toTabId(this.latestSessionId);
		if (tabId) return tabId;
		throw new BrowserBridgeError("NO_TAB", "No target browser tab is available", { tabs: this.getTabs() });
	}

	private optionalExecutionTabId(command: BridgeCommand): number | undefined {
		const cmd = String(command.cmd || "");
		if (cmd === "tabs" && (!command.method || command.method === "list" || command.method === "create")) return undefined;
		if (cmd === "management") return undefined;
		return toTabId(this.defaultSessionId) ?? toTabId(this.latestSessionId);
	}

	private requireTabId(value: unknown): number {
		const tabId = toTabId(value);
		if (!tabId) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId is required", { tabId: value });
		return tabId;
	}

	formatError(error: unknown): string {
		return JSON.stringify(errorToPlain(error), null, 2);
	}
}
