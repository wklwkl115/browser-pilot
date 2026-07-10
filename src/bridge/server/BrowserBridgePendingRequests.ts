import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { BrowserBridgeError } from "../../utils/errors.js";
import { normalizeNativeErrorCode } from "../../types/nativeErrorCodes.js";
import { DEFAULT_TIMEOUT_MS, normalizeErrorMessage } from "./bridgeUtils.js";
import type { BridgeRequestMetrics, BrowserBridgeExecutionResult, BrowserBridgeTargetInfo, PendingRequest } from "./types.js";

type TimeoutDiagnostics = (tabId: number | undefined, timeoutMs: number, acked: boolean, target?: BrowserBridgeTargetInfo) => Record<string, unknown>;
type ResolveTarget = (target: BrowserBridgeTargetInfo | undefined) => BrowserBridgeTargetInfo | undefined;

/**
 * How long an in-flight request is held after its client socket drops before it fails,
 * giving a reconnecting extension (offscreen re-dial / SW restart) a window to complete
 * or reclaim it. `0` disables the grace window. Env `BROWSER_PILOT_REQUEST_GRACE_MS`.
 */
export function requestGraceMs(): number {
	const raw = process.env.BROWSER_PILOT_REQUEST_GRACE_MS;
	const parsed = raw === undefined ? NaN : Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 10_000;
}

export class BrowserBridgePendingRequests {
	readonly pending = new Map<string, PendingRequest>();
	private readonly timeoutDiagnostics: TimeoutDiagnostics;
	private readonly resolvedTarget: ResolveTarget;
	private readonly _metrics: BridgeRequestMetrics = { drained: 0, graceExpired: 0, redelivered: 0, reconciledNotDelivered: 0, reconciledInflightUnknown: 0 };

	metrics(): BridgeRequestMetrics {
		return { ...this._metrics };
	}

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
		return new Promise<BrowserBridgeExecutionResult>((resolve, reject) => {
			const pending: PendingRequest = {
				id,
				tabId: options.tabId,
				client: socket,
				code,
				timeoutMs,
				createdAt: Date.now(),
				acked: false,
				target: options.target,
				timer: undefined as unknown as NodeJS.Timeout,
				resolve,
				reject,
			};
			this.pending.set(id, pending);
			this.armTimeout(pending);
			try {
				socket.send(JSON.stringify(this.buildPayload(pending)));
			} catch (error) {
				this.clearTimers(pending);
				this.pending.delete(id);
				reject(new BrowserBridgeError("BRIDGE_SEND_FAILED", normalizeErrorMessage(error), { id, tabId: options.tabId, target: this.resolvedTarget(options.target) }));
			}
		});
	}

	/** Serialize the wire payload for a pending request; `extra` carries redelivery flags. */
	private buildPayload(pending: PendingRequest, extra?: Record<string, unknown>): Record<string, unknown> {
		const payload: Record<string, unknown> = { id: pending.id, code: pending.code, timeoutMs: pending.timeoutMs };
		if (pending.tabId !== undefined) payload.tabId = pending.tabId;
		return extra ? { ...payload, ...extra } : payload;
	}

	/** (Re)arm the per-request timeout. Replaces any existing timer. */
	private armTimeout(pending: PendingRequest): void {
		const sentAt = Date.now();
		const debugCodePreview = typeof pending.code === "string" ? pending.code.slice(0, 120) : JSON.stringify(pending.code).slice(0, 120);
		clearTimeout(pending.timer);
		pending.timer = setTimeout(() => {
			this.pending.delete(pending.id);
			const state = pending.acked ? "ACK received, script may still be running" : "no ACK, message may not have been delivered";
			pending.reject(new BrowserBridgeError("BRIDGE_TIMEOUT", `No browser response in ${pending.timeoutMs}ms (${state})`, {
				id: pending.id,
				debugCodePreview,
				acked: pending.acked,
				ackAt: pending.ackAt,
				elapsedMs: Date.now() - sentAt,
				pendingRequestCount: this.pending.size,
				...this.timeoutDiagnostics(pending.tabId, pending.timeoutMs, pending.acked, pending.target),
			}));
		}, pending.timeoutMs);
	}

	private clearTimers(pending: PendingRequest): void {
		clearTimeout(pending.timer);
		if (pending.graceTimer) {
			clearTimeout(pending.graceTimer);
			pending.graceTimer = undefined;
		}
	}

	ack(id: string): void {
		const pending = this.pending.get(id);
		if (pending) {
			pending.acked = true;
			pending.ackAt = Date.now();
		}
	}

	private latency(pending: PendingRequest, now = Date.now()) {
		return {
			totalMs: Math.max(0, now - pending.createdAt),
			clientMs: pending.ackAt ? Math.max(0, now - pending.ackAt) : undefined,
			ackMs: pending.ackAt ? Math.max(0, pending.ackAt - pending.createdAt) : undefined,
			deadlineMs: pending.timeoutMs,
			acked: pending.acked,
		};
	}

	resolve(id: string, result: unknown, newTabs: unknown[], diagnostics?: Record<string, unknown>): void {
		const pending = this.take(id);
		if (!pending) return;
		const latency = this.latency(pending);
		pending.resolve({ id, tabId: pending.tabId, acknowledged: pending.acked, data: result, newTabs, target: this.resolvedTarget(pending.target), diagnostics: { ...(diagnostics || {}), latency } });
	}

	rejectBrowserError(id: string, error: unknown, result: unknown, diagnostics?: Record<string, unknown>): void {
		const pending = this.take(id);
		if (!pending) return;
		const latency = this.latency(pending);
		// Preserve the extension's structured error code (carried on the command result, e.g.
		// SELECTOR_NOT_FOUND) instead of flattening every bridge error to BROWSER_EXECUTION_ERROR —
		// keeps recovery hints routable. Falls back to BROWSER_EXECUTION_ERROR when no code is present.
		const codeFrom = (value: unknown): unknown => (value && typeof value === "object" ? (value as { error_code?: unknown; code?: unknown }).error_code ?? (value as { code?: unknown }).code : undefined);
		const code = normalizeNativeErrorCode(codeFrom(result) ?? codeFrom(error), "BROWSER_EXECUTION_ERROR");
		pending.reject(new BrowserBridgeError(code, normalizeErrorMessage(error), { id, tabId: pending.tabId, error, result, target: this.resolvedTarget(pending.target), diagnostics: { ...(diagnostics || {}), latency } }));
	}

	/**
	 * A client socket dropped. Instead of failing its in-flight requests immediately, hold
	 * them in a draining state for `graceMs` so a fast reconnect can complete them (the result
	 * still settles via resolve/reject) or reclaim them (reconnectInstance). Each drained
	 * request is tagged with the owning `instanceId` so a reconnect can correlate it. On grace
	 * expiry the request fails with the same BRIDGE_CLIENT_DISCONNECTED as before. Idempotent:
	 * already-draining requests are skipped. Returns the number newly drained.
	 */
	drainClient(ws: WebSocket, instanceId: string | undefined, graceMs: number): number {
		let drained = 0;
		for (const pending of this.pending.values()) {
			if (pending.client !== ws || pending.draining) continue;
			clearTimeout(pending.timer);
			pending.draining = true;
			pending.instanceId = instanceId;
			pending.graceTimer = setTimeout(() => {
				this.pending.delete(pending.id);
				this._metrics.graceExpired += 1;
				pending.reject(new BrowserBridgeError("BRIDGE_CLIENT_DISCONNECTED", "Browser bridge client disconnected before request completed", { id: pending.id, tabId: pending.tabId, acked: pending.acked, target: this.resolvedTarget(pending.target), draining: true }));
			}, Math.max(0, graceMs));
			drained += 1;
		}
		this._metrics.drained += drained;
		return drained;
	}

	/**
	 * An extension instance reconnected. Reconcile its draining requests:
	 *  - durable extension (advertises request dedupe): redeliver each with the stable id so
	 *    the extension can replay a cached result or safely re-run a provably-undelivered
	 *    command; the new socket's result/error then settles the original promise.
	 *  - otherwise: fail honestly without silent replay — not-acked requests as not-delivered
	 *    (safe to retry), acked requests as outcome-unknown (may have run; do not auto-retry).
	 * No-op when `instanceId` is absent (older extension build): those requests keep draining
	 * until grace expiry. Returns the number of reconciled requests.
	 */
	reconnectInstance(instanceId: string | undefined, socket: WebSocket, opts: { durable: boolean }): number {
		if (!instanceId) return 0;
		let reconciled = 0;
		for (const pending of Array.from(this.pending.values())) {
			if (!pending.draining || pending.instanceId !== instanceId) continue;
			if (pending.graceTimer) {
				clearTimeout(pending.graceTimer);
				pending.graceTimer = undefined;
			}
			reconciled += 1;
			if (opts.durable) {
				pending.draining = false;
				pending.client = socket;
				this._metrics.redelivered += 1;
				this.armTimeout(pending);
				try {
					socket.send(JSON.stringify(this.buildPayload(pending, { redelivered: true, priorAck: pending.acked })));
				} catch (error) {
					this.clearTimers(pending);
					this.pending.delete(pending.id);
					pending.reject(new BrowserBridgeError("BRIDGE_SEND_FAILED", normalizeErrorMessage(error), { id: pending.id, tabId: pending.tabId, target: this.resolvedTarget(pending.target) }));
				}
				continue;
			}
			this.pending.delete(pending.id);
			if (pending.acked) this._metrics.reconciledInflightUnknown += 1;
			else this._metrics.reconciledNotDelivered += 1;
			const outcome = pending.acked ? "inflight-unknown" : "not-delivered";
			const message = pending.acked
				? "Browser command was acknowledged but its outcome was lost when the extension reconnected"
				: "Browser command was not delivered before the extension reconnected; safe to retry";
			pending.reject(new BrowserBridgeError("BRIDGE_CLIENT_DISCONNECTED", message, { id: pending.id, tabId: pending.tabId, acked: pending.acked, outcome, reconnected: true, target: this.resolvedTarget(pending.target) }));
		}
		return reconciled;
	}

	rejectAllStopped(): void {
		for (const pending of Array.from(this.pending.values())) {
			this.clearTimers(pending);
			this.pending.delete(pending.id);
			pending.reject(new BrowserBridgeError("BRIDGE_STOPPED", "Browser bridge stopped before request completed", { id: pending.id, tabId: pending.tabId, target: this.resolvedTarget(pending.target) }));
		}
	}

	private take(id: string): PendingRequest | undefined {
		const pending = this.pending.get(id);
		if (!pending) return undefined;
		this.clearTimers(pending);
		this.pending.delete(id);
		return pending;
	}
}
