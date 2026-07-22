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
	private readonly _metrics: BridgeRequestMetrics = { drained: 0, graceExpired: 0, reconciledNotDelivered: 0, reconciledInflightUnknown: 0 };

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

	send(socket: WebSocket, code: unknown, options: { tabId?: number; timeoutMs?: number; target?: BrowserBridgeTargetInfo; signal?: AbortSignal } = {}): Promise<BrowserBridgeExecutionResult> {
		const id = randomUUID();
		const timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
		if (options.signal?.aborted) {
			return Promise.reject(new BrowserBridgeError("BRIDGE_TIMEOUT", "Browser command was cancelled before bridge dispatch", {
				id,
				tabId: options.tabId,
				acked: false,
				dispatchStarted: false,
				aborted: true,
				target: this.resolvedTarget(options.target),
			}));
		}
		return new Promise<BrowserBridgeExecutionResult>((resolve, reject) => {
			let dispatched = false;
			const pending: PendingRequest = {
					id,
					tabId: options.tabId,
					client: socket,
					code,
				timeoutMs,
				createdAt: Date.now(),
				acked: false,
				target: options.target,
				signal: options.signal,
				timer: undefined as unknown as NodeJS.Timeout,
				resolve,
				reject,
			};
			this.pending.set(id, pending);
			this.armTimeout(pending);
			pending.abortListener = () => {
				const cancelled = this.take(id);
				if (!cancelled) return;
				cancelled.reject(new BrowserBridgeError("BRIDGE_TIMEOUT", dispatched ? "Browser command was cancelled after bridge dispatch" : "Browser command was cancelled before bridge dispatch", {
					id,
					tabId: options.tabId,
					acked: cancelled.acked,
					dispatchStarted: dispatched,
					aborted: true,
					target: this.resolvedTarget(options.target),
				}));
			};
			options.signal?.addEventListener("abort", pending.abortListener, { once: true });
			if (options.signal?.aborted) {
				pending.abortListener();
				return;
			}
			try {
					socket.send(JSON.stringify({ id, code, timeoutMs, ...(options.tabId !== undefined ? { tabId: options.tabId } : {}) }));
				dispatched = true;
			} catch (error) {
				this.clearTimers(pending);
				this.pending.delete(id);
				reject(new BrowserBridgeError("BRIDGE_SEND_FAILED", normalizeErrorMessage(error), { id, tabId: options.tabId, target: this.resolvedTarget(options.target) }));
			}
		});
	}

	/** (Re)arm the per-request timeout. Replaces any existing timer. */
	private armTimeout(pending: PendingRequest): void {
		const sentAt = Date.now();
		const debugCodePreview = typeof pending.code === "string" ? pending.code.slice(0, 120) : JSON.stringify(pending.code).slice(0, 120);
		clearTimeout(pending.timer);
		pending.timer = setTimeout(() => {
			this.clearTimers(pending);
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
		if (pending.signal && pending.abortListener) pending.signal.removeEventListener("abort", pending.abortListener);
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
		const detailsFrom = (value: unknown): Record<string, unknown> | undefined => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
			const details = (value as { details?: unknown }).details;
			return details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : undefined;
		};
		const code = normalizeNativeErrorCode(codeFrom(result) ?? codeFrom(error), "BROWSER_EXECUTION_ERROR");
		const dispatchDetails = detailsFrom(error) ?? detailsFrom(result);
		const acked = typeof dispatchDetails?.acked === "boolean" ? dispatchDetails.acked : pending.acked;
		const dispatchStarted = typeof dispatchDetails?.dispatchStarted === "boolean" ? dispatchDetails.dispatchStarted : pending.acked;
		pending.reject(new BrowserBridgeError(code, normalizeErrorMessage(error), {
			id,
			tabId: pending.tabId,
			error,
			result,
			dispatchStarted,
			acked,
			target: this.resolvedTarget(pending.target),
			diagnostics: { ...(diagnostics || {}), latency },
		}));
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
	 * An extension instance reconnected. Fail draining requests honestly without
	 * silent replay: not-acked requests are safe to retry; acked requests have an
	 * unknown outcome and must not be replayed automatically.
		 * No-op when `instanceId` is absent: those requests keep draining
	 * until grace expiry. Returns the number of reconciled requests.
	 */
	reconnectInstance(instanceId: string | undefined): number {
		if (!instanceId) return 0;
		let reconciled = 0;
		for (const pending of Array.from(this.pending.values())) {
			if (!pending.draining || pending.instanceId !== instanceId) continue;
			if (pending.graceTimer) {
				clearTimeout(pending.graceTimer);
				pending.graceTimer = undefined;
			}
			reconciled += 1;
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
