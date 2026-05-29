import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { BrowserBridgeError } from "./errors";
import { DEFAULT_TIMEOUT_MS, normalizeErrorMessage } from "./bridgeUtils";
import type { BrowserBridgeExecutionResult, BrowserBridgeTargetInfo, PendingRequest } from "./types";

type TimeoutDiagnostics = (tabId: number | undefined, timeoutMs: number, acked: boolean, target?: BrowserBridgeTargetInfo) => Record<string, unknown>;
type ResolveTarget = (target: BrowserBridgeTargetInfo | undefined) => BrowserBridgeTargetInfo | undefined;

export class BrowserBridgePendingRequests {
	readonly pending = new Map<string, PendingRequest>();
	private readonly timeoutDiagnostics: TimeoutDiagnostics;
	private readonly resolvedTarget: ResolveTarget;

	constructor(timeoutDiagnostics: TimeoutDiagnostics, resolvedTarget: ResolveTarget) {
		this.timeoutDiagnostics = timeoutDiagnostics;
		this.resolvedTarget = resolvedTarget;
	}

	snapshot(): Array<{ id: string; tabId?: number; createdAt: number; acked: boolean; target?: BrowserBridgeTargetInfo }> {
		return Array.from(this.pending.values()).map((item) => ({ id: item.id, tabId: item.tabId, createdAt: item.createdAt, acked: item.acked, target: item.target }));
	}

	send(socket: WebSocket, code: unknown, options: { tabId?: number; timeoutMs?: number; target?: BrowserBridgeTargetInfo } = {}): Promise<BrowserBridgeExecutionResult> {
		const id = randomUUID();
		const timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
		const payload: Record<string, unknown> = { id, code };
		if (options.tabId !== undefined) payload.tabId = options.tabId;

		return new Promise<BrowserBridgeExecutionResult>((resolve, reject) => {
			const debugCodePreview = typeof code === "string" ? code.slice(0, 120) : JSON.stringify(code).slice(0, 120);
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const state = pending.acked ? "ACK received, script may still be running" : "no ACK, message may not have been delivered";
				reject(new BrowserBridgeError("BRIDGE_TIMEOUT", `No browser response in ${timeoutMs}ms (${state})`, { id, debugCodePreview, ...this.timeoutDiagnostics(options.tabId, timeoutMs, pending.acked, pending.target) }));
			}, timeoutMs);
			const pending: PendingRequest = { id, tabId: options.tabId, client: socket, createdAt: Date.now(), acked: false, target: options.target, timer, resolve, reject };
			this.pending.set(id, pending);
			try {
				socket.send(JSON.stringify(payload));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new BrowserBridgeError("BRIDGE_SEND_FAILED", normalizeErrorMessage(error), { id, tabId: options.tabId, target: this.resolvedTarget(options.target) }));
			}
		});
	}

	ack(id: string): void {
		const pending = this.pending.get(id);
		if (pending) {
			pending.acked = true;
			pending.ackAt = Date.now();
		}
	}

	resolve(id: string, result: unknown, newTabs: unknown[]): void {
		const pending = this.take(id);
		if (!pending) return;
		pending.resolve({ id, tabId: pending.tabId, acknowledged: pending.acked, data: result, newTabs, target: this.resolvedTarget(pending.target) });
	}

	rejectBrowserError(id: string, error: unknown, result: unknown): void {
		const pending = this.take(id);
		if (!pending) return;
		pending.reject(new BrowserBridgeError("BROWSER_EXECUTION_ERROR", normalizeErrorMessage(error), { id, tabId: pending.tabId, error, result, target: this.resolvedTarget(pending.target) }));
	}

	rejectForClient(ws: WebSocket): void {
		for (const pending of Array.from(this.pending.values())) {
			if (pending.client !== ws) continue;
			this.take(pending.id);
			pending.reject(new BrowserBridgeError("BRIDGE_CLIENT_DISCONNECTED", "Browser bridge client disconnected before request completed", { id: pending.id, tabId: pending.tabId, acked: pending.acked, target: this.resolvedTarget(pending.target) }));
		}
	}

	rejectAllStopped(): void {
		for (const pending of Array.from(this.pending.values())) {
			clearTimeout(pending.timer);
			this.pending.delete(pending.id);
			pending.reject(new BrowserBridgeError("BRIDGE_STOPPED", "Browser bridge stopped before request completed", { id: pending.id, tabId: pending.tabId, target: this.resolvedTarget(pending.target) }));
		}
	}

	private take(id: string): PendingRequest | undefined {
		const pending = this.pending.get(id);
		if (!pending) return undefined;
		clearTimeout(pending.timer);
		this.pending.delete(id);
		return pending;
	}
}
