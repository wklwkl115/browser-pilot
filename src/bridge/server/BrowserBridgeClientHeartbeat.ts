import { WebSocket } from "ws";
import type { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry.js";
import { errorToPlain } from "../../utils/errors.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const MIN_HEARTBEAT_INTERVAL_MS = 5_000;

const DEFAULT_STALE_TIMEOUT_MS = 75_000;
const MIN_STALE_TIMEOUT_MS = 30_000;

function heartbeatIntervalMs(): number {
	const raw = process.env.BROWSER_PILOT_HEARTBEAT_INTERVAL_MS;
	if (raw === undefined) return DEFAULT_HEARTBEAT_INTERVAL_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= MIN_HEARTBEAT_INTERVAL_MS ? parsed : DEFAULT_HEARTBEAT_INTERVAL_MS;
}

function staleTimeoutMs(): number {
	const raw = process.env.BROWSER_PILOT_STALE_TIMEOUT_MS;
	if (raw === undefined) return DEFAULT_STALE_TIMEOUT_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= MIN_STALE_TIMEOUT_MS ? parsed : DEFAULT_STALE_TIMEOUT_MS;
}

export class BrowserBridgeClientHeartbeat {
	private timer?: NodeJS.Timeout;
	private readonly clients: BrowserBridgeClientRegistry;
	private readonly onStale: (ws: WebSocket, reason: string) => void;
	private readonly onTick?: (now: number) => void;

	constructor(clients: BrowserBridgeClientRegistry, onStale: (ws: WebSocket, reason: string) => void, options: { onTick?: (now: number) => void } = {}) {
		this.clients = clients;
		this.onStale = onStale;
		this.onTick = options.onTick;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.probe(), heartbeatIntervalMs());
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	probe(now = Date.now()): void {
		this.onTick?.(now);
		const timeout = staleTimeoutMs();
		for (const { ws, info, idleMs } of this.clients.staleClients(timeout, now)) {
			console.warn("[browser-pilot-bridge] Closing stale WebSocket client", { clientId: info.id, extensionId: info.extensionId, idleMs, staleTimeoutMs: timeout });
			this.onStale(ws, "stale_timeout");
			try {
				ws.terminate();
			} catch {
				/* best-effort stale client termination */
			}
		}
		for (const [ws, info] of this.clients.entries()) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			try {
				this.clients.markPingSent(ws);
				ws.ping();
			} catch (error) {
				console.warn("[browser-pilot-bridge] WebSocket heartbeat ping failed", { clientId: info.id, extensionId: info.extensionId, error: errorToPlain(error) });
				this.onStale(ws, "ping_failed");
				try {
					ws.terminate();
				} catch {
					/* best-effort failed-ping termination */
				}
			}
		}
	}
}
