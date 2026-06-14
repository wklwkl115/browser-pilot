import { WebSocket } from "ws";
import type { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry.js";
import { errorToPlain } from "./errors.js";

const CLIENT_HEARTBEAT_INTERVAL_MS = 15_000;
const CLIENT_STALE_TIMEOUT_MS = 75_000;

export class BrowserBridgeClientHeartbeat {
	private timer?: NodeJS.Timeout;
	private readonly clients: BrowserBridgeClientRegistry;
	private readonly onStale: (ws: WebSocket) => void;
	private readonly onTick?: (now: number) => void;

	constructor(clients: BrowserBridgeClientRegistry, onStale: (ws: WebSocket) => void, options: { onTick?: (now: number) => void } = {}) {
		this.clients = clients;
		this.onStale = onStale;
		this.onTick = options.onTick;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.probe(), CLIENT_HEARTBEAT_INTERVAL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	probe(now = Date.now()): void {
		this.onTick?.(now);
		for (const { ws, info, idleMs } of this.clients.staleClients(CLIENT_STALE_TIMEOUT_MS, now)) {
			console.warn("[browser-pilot-bridge] Closing stale WebSocket client", { clientId: info.id, extensionId: info.extensionId, idleMs, staleTimeoutMs: CLIENT_STALE_TIMEOUT_MS });
			this.onStale(ws);
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
				this.onStale(ws);
				try {
					ws.terminate();
				} catch {
					/* best-effort failed-ping termination */
				}
			}
		}
	}
}
