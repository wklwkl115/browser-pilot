import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { BrowserBridgeError } from "./errors";
import { CLOSED_STATES, isOpen } from "./bridgeUtils";
import type { BrowserBridgeClientInfo } from "./types";

export class BrowserBridgeClientRegistry {
	private readonly clients = new Set<WebSocket>();
	private readonly clientInfo = new Map<WebSocket, BrowserBridgeClientInfo>();
	private extensionClient?: WebSocket;
	private readonly getPort: () => number;

	constructor(port: number | (() => number)) {
		this.getPort = typeof port === "function" ? port : () => port;
	}

	register(ws: WebSocket): BrowserBridgeClientInfo {
		const now = Date.now();
		const info = { id: randomUUID(), connectedAt: now, lastSeenAt: now };
		this.clients.add(ws);
		this.clientInfo.set(ws, info);
		return info;
	}

	unregister(ws: WebSocket): void {
		this.clients.delete(ws);
		this.clientInfo.delete(ws);
		if (this.extensionClient === ws) this.extensionClient = undefined;
	}

	clear(): void {
		for (const client of this.clients) {
			try { client.close(); } catch {}
		}
		this.clients.clear();
		this.clientInfo.clear();
		this.extensionClient = undefined;
	}

	markSeen(ws: WebSocket): void {
		const info = this.clientInfo.get(ws);
		if (info) info.lastSeenAt = Date.now();
	}

	markPingSent(ws: WebSocket): void {
		const info = this.clientInfo.get(ws);
		if (info) info.lastPingAt = Date.now();
	}

	markPong(ws: WebSocket): void {
		const info = this.clientInfo.get(ws);
		if (info) {
			const now = Date.now();
			info.lastSeenAt = now;
			info.lastPongAt = now;
		}
	}

	staleClients(maxIdleMs: number, now = Date.now()): Array<{ ws: WebSocket; info: BrowserBridgeClientInfo; idleMs: number }> {
		return Array.from(this.clientInfo.entries())
			.map(([ws, info]) => ({ ws, info, idleMs: now - info.lastSeenAt }))
			.filter(({ ws, idleMs }) => !CLOSED_STATES.has(ws.readyState as 2 | 3) && idleMs > maxIdleMs);
	}

	updateClientInfo(ws: WebSocket, bridgeOrExtension: unknown): void {
		const current = this.clientInfo.get(ws);
		if (!current || !bridgeOrExtension || typeof bridgeOrExtension !== "object" || Array.isArray(bridgeOrExtension)) return;
		const raw = bridgeOrExtension as Record<string, unknown>;
		if (typeof raw.id === "string") current.extensionId = raw.id;
		if (typeof raw.name === "string") current.name = raw.name;
		if (typeof raw.version === "string") current.version = raw.version;
		if (typeof raw.userAgent === "string") current.userAgent = raw.userAgent;
		if (typeof raw.workerBootId === "string") current.workerBootId = raw.workerBootId;
		if (typeof raw.workerStartedAt === "number" && Number.isFinite(raw.workerStartedAt)) current.workerStartedAt = raw.workerStartedAt;
	}

	select(ws: WebSocket | undefined): void {
		this.extensionClient = ws;
	}

	selectedClient(): WebSocket | undefined {
		return this.extensionClient;
	}

	selectedOpenClient(): WebSocket | undefined {
		return isOpen(this.extensionClient) ? this.extensionClient : undefined;
	}

	selectedInfo(): BrowserBridgeClientInfo | undefined {
		return this.extensionClient ? this.clientInfo.get(this.extensionClient) : undefined;
	}

	connectedClientsCount(): number {
		return Array.from(this.clients).filter((ws) => !CLOSED_STATES.has(ws.readyState as 2 | 3)).length;
	}

	connectedClientInfos(): BrowserBridgeClientInfo[] {
		return Array.from(this.clients).filter((ws) => !CLOSED_STATES.has(ws.readyState as 2 | 3)).map((ws) => this.clientInfo.get(ws)).filter((item): item is BrowserBridgeClientInfo => !!item);
	}

	info(ws: WebSocket): BrowserBridgeClientInfo | undefined {
		return this.clientInfo.get(ws);
	}

	entries(): IterableIterator<[WebSocket, BrowserBridgeClientInfo]> {
		return this.clientInfo.entries();
	}

	findClient(id: string): { ws: WebSocket; info: BrowserBridgeClientInfo } | undefined {
		for (const [ws, info] of this.clientInfo.entries()) {
			if (CLOSED_STATES.has(ws.readyState as 2 | 3)) continue;
			if (info.id === id || info.extensionId === id) return { ws, info };
		}
		return undefined;
	}

	requireExtensionClient(): WebSocket {
		if (isOpen(this.extensionClient)) return this.extensionClient;
		const open = Array.from(this.clients).find(isOpen);
		if (open) return open;
		throw new BrowserBridgeError("NO_BROWSER_EXTENSION", "No connected browser bridge extension", { port: this.getPort() });
	}

	browserIdForClient(client: WebSocket): string {
		const info = this.clientInfo.get(client);
		if (!info?.id) throw new BrowserBridgeError("UNKNOWN_BROWSER_CLIENT", "Browser bridge client is not registered", { port: this.getPort() });
		return info.id;
	}
}
