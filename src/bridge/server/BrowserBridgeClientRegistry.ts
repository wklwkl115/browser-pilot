import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { BrowserBridgeError } from "../../utils/errors.js";
import { CLOSED_STATES, isOpen } from "./bridgeUtils.js";
import { compareExtensionBuild, readExpectedExtensionBuild, type ExpectedExtensionBuild } from "./extensionBuild.js";
import type { BridgeConnectionMetrics, BrowserBridgeClientInfo } from "./types.js";

function stableBrowserId(extensionInstanceId: string): string {
	return `browser_${createHash("sha256").update(extensionInstanceId).digest("hex").slice(0, 16)}`;
}

function updateExtensionInstanceIdentity(current: BrowserBridgeClientInfo, value: unknown): void {
	if (typeof value !== "string" || !value) return;
	current.extensionInstanceId = value;
	current.id = stableBrowserId(value);
}

export class BrowserBridgeClientRegistry {
	private readonly clients = new Set<WebSocket>();
	private readonly clientInfo = new Map<WebSocket, BrowserBridgeClientInfo>();
	private everConnected = false;
	private everHandshaked = false;
	private _lastDisconnectReason?: string;
	private _lastDisconnectAt?: number;
	private pendingReconnectAt?: number;
	private readonly pendingReconnectAtByInstance = new Map<string, number>();
	private readonly lastWorkerBootByInstance = new Map<string, string>();
	private readonly _metrics: BridgeConnectionMetrics = { connects: 0, reconnects: 0, swRestarts: 0, duplicates: 0, disconnects: 0 };
	private readonly getPort: () => number;
	private readonly expectedBuild: ExpectedExtensionBuild;

	constructor(port: number | (() => number)) {
		this.getPort = typeof port === "function" ? port : () => port;
		this.expectedBuild = readExpectedExtensionBuild();
	}

	register(ws: WebSocket): BrowserBridgeClientInfo {
		const now = Date.now();
		const info = { id: randomUUID(), connectedAt: now, lastSeenAt: now };
		this.clients.add(ws);
		this.clientInfo.set(ws, info);
		this.everConnected = true;
		return info;
	}

	/** True if any extension client has connected during this bridge's lifetime — distinguishes a cold start from a dropped service worker for recovery hints. */
	hasEverConnected(): boolean {
		return this.everConnected;
	}

	unregister(ws: WebSocket): void {
		this.clients.delete(ws);
		this.clientInfo.delete(ws);
	}

	recordDisconnect(reason: string, instanceId?: string, reconnectEligible = true): void {
		const now = Date.now();
		this._lastDisconnectReason = reason;
		this._lastDisconnectAt = now;
		this._metrics.disconnects += 1;
		if (!reconnectEligible) return;
		if (instanceId) this.pendingReconnectAtByInstance.set(instanceId, now);
		else this.pendingReconnectAt = now;
	}

	/** Tally an ext_ready handshake by its classified kind, and record reconnect latency. */
	recordConnect(kind: "cold" | "reconnect" | "sw-restart" | "duplicate", instanceId?: string, workerBootId?: string): void {
		this._metrics.connects += 1;
		if (kind === "reconnect" || kind === "sw-restart") {
			this._metrics.reconnects += 1;
			const disconnectedAt = instanceId ? this.pendingReconnectAtByInstance.get(instanceId) : this.pendingReconnectAt;
			if (typeof disconnectedAt === "number") this._metrics.lastReconnectLatencyMs = Math.max(0, Date.now() - disconnectedAt);
			if (instanceId) this.pendingReconnectAtByInstance.delete(instanceId);
			else this.pendingReconnectAt = undefined;
		}
		if (kind === "sw-restart") this._metrics.swRestarts += 1;
		if (kind === "duplicate") this._metrics.duplicates += 1;
		if (instanceId && workerBootId) this.lastWorkerBootByInstance.set(instanceId, workerBootId);
	}

	metrics(): BridgeConnectionMetrics {
		return { ...this._metrics };
	}

	get lastDisconnectReason(): string | undefined {
		return this._lastDisconnectReason;
	}

	get lastDisconnectAt(): number | undefined {
		return this._lastDisconnectAt;
	}

	clear(): void {
		for (const client of this.clients) {
			try {
				client.close();
			} catch {
				/* best-effort client close during registry clear */
			}
		}
		this.clients.clear();
		this.clientInfo.clear();
		this.pendingReconnectAt = undefined;
		this.pendingReconnectAtByInstance.clear();
		this.lastWorkerBootByInstance.clear();
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
		if (raw.build !== undefined) current.build = raw.build;
		const buildComparison = compareExtensionBuild(raw, this.expectedBuild);
		if (buildComparison.extensionStale !== undefined) current.extensionStale = buildComparison.extensionStale;
		if (buildComparison.expectedBuild !== undefined) current.expectedBuild = buildComparison.expectedBuild;
		if (buildComparison.reportedBuild !== undefined) current.reportedBuild = buildComparison.reportedBuild;
		else delete current.reportedBuild;
		if (buildComparison.manifestPath !== undefined) current.buildManifestPath = buildComparison.manifestPath;
		if (typeof raw.userAgent === "string") current.userAgent = raw.userAgent;
		if (typeof raw.workerBootId === "string") current.workerBootId = raw.workerBootId;
		if (typeof raw.workerStartedAt === "number" && Number.isFinite(raw.workerStartedAt)) current.workerStartedAt = raw.workerStartedAt;
		if (typeof raw.captureContractVersion === "number" && Number.isInteger(raw.captureContractVersion)) current.captureContractVersion = raw.captureContractVersion;
		updateExtensionInstanceIdentity(current, raw.extensionInstanceId);
	}

	/**
	 * Classify a fresh ext_ready handshake against currently-connected clients so callers
	 * (reconnect reconciliation, diagnostics) can tell apart the lifecycle that produced it:
	 *   duplicate   — another open socket already reports this same instance + worker boot;
	 *   sw-restart  — another open socket reports this instance but a different worker boot;
	 *   reconnect   — no peer socket, but the bridge has handshaked before (instance re-dialing);
	 *   cold        — the very first handshake of this bridge's lifetime.
	 * Pure read — call recordHandshake() separately to advance the everHandshaked flag.
	 */
	classifyConnect(keep: WebSocket, instanceId: string | undefined, workerBootId: string | undefined): "cold" | "reconnect" | "sw-restart" | "duplicate" {
		if (instanceId) {
			for (const [ws, info] of this.clientInfo.entries()) {
				if (ws === keep || CLOSED_STATES.has(ws.readyState as 2 | 3)) continue;
				if (info.extensionInstanceId !== instanceId) continue;
				return info.workerBootId && workerBootId && info.workerBootId === workerBootId ? "duplicate" : "sw-restart";
			}
			const previousWorkerBootId = this.lastWorkerBootByInstance.get(instanceId);
			if (previousWorkerBootId && workerBootId && previousWorkerBootId !== workerBootId) return "sw-restart";
		}
		return this.everHandshaked ? "reconnect" : "cold";
	}

	hasOpenInstanceClient(instanceId: string | undefined, exclude?: WebSocket): boolean {
		if (!instanceId) return false;
		return Array.from(this.clientInfo.entries()).some(([ws, info]) => ws !== exclude && info.extensionInstanceId === instanceId && isOpen(ws));
	}

	recordHandshake(): void {
		this.everHandshaked = true;
	}

	/**
	 * Enforce one live socket per extension instance: close any *other* open client
	 * reporting the same extensionInstanceId, keeping the newest socket. A reconnect
	 * (SW restart / offscreen re-dial) can briefly leave the stale socket registered;
	 * collapsing avoids split-brain selection and double delivery. Returns the
		 * superseded sockets (already told to close). No-op when instanceId is absent.
	 */
	supersedeInstanceClients(instanceId: string | undefined, keep: WebSocket): WebSocket[] {
		if (!instanceId) return [];
		const superseded: WebSocket[] = [];
		for (const [ws, info] of this.clientInfo.entries()) {
			if (ws === keep || info.extensionInstanceId !== instanceId) continue;
			superseded.push(ws);
		}
		for (const ws of superseded) {
			try {
				ws.close();
			} catch {
				/* best-effort supersede close — the close handler still unregisters it */
			}
		}
		return superseded;
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

	browserIdForClient(client: WebSocket): string {
		const info = this.clientInfo.get(client);
		if (!info?.id) throw new BrowserBridgeError("UNKNOWN_BROWSER_CLIENT", "Browser bridge client is not registered", { port: this.getPort() });
		return info.id;
	}
}
