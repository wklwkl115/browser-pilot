import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { BrowserBridgeError } from "../../utils/errors.js";
import { normalizeNativeErrorCode } from "../../types/nativeErrorCodes.js";
import { DEFAULT_TIMEOUT_MS, normalizeErrorMessage } from "./bridgeUtils.js";
import type { BrowserBridgeExecutionResult, BrowserBridgeTargetInfo, PendingRequest } from "./types.js";

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

	rejectClient(ws: WebSocket): number {
		let rejected = 0;
		for (const pending of Array.from(this.pending.values())) {
			if (pending.client !== ws) continue;
			const disconnected = this.take(pending.id);
			if (!disconnected) continue;
			rejected += 1;
			const outcome = disconnected.acked ? "inflight-unknown" : "delivery-unknown";
			const message = disconnected.acked
				? "Browser command was acknowledged but its outcome was lost when the extension disconnected"
				: "Browser command delivery could not be confirmed before the extension disconnected; retry may duplicate an operation received before disconnect";
			disconnected.reject(new BrowserBridgeError("BRIDGE_CLIENT_DISCONNECTED", message, { id: disconnected.id, tabId: disconnected.tabId, acked: disconnected.acked, outcome, target: this.resolvedTarget(disconnected.target) }));
		}
		return rejected;
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
