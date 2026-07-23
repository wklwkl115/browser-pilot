import { WebSocket } from "ws";
import { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry.js";
import { BrowserRuntimeRecoveryArtifacts } from "./BrowserRuntimeRecoveryArtifacts.js";
import { BrowserTabSessionRouter } from "./BrowserTabSessionRouter.js";
import { BrowserBridgePendingRequests, requestGraceMs } from "./BrowserBridgePendingRequests.js";
import type { BrowserBridgeSessionRegistryPort } from "./BrowserBridgeSessionPorts.js";
import type { BrowserCommandQueueRegistry } from "./BrowserCommandQueueRegistry.js";
import { errorToPlain } from "../../utils/errors.js";
import { parseJsonOrThrow } from "../../utils/json.js";
import { recordValue } from "./bridgeUtils.js";
import { CONSENT_MESSAGE_TYPES } from "../protocol/consentTypes.js";
import type { BrowserBridgeConsentCoordinator } from "./BrowserBridgeConsentCoordinator.js";

type IncomingMessage = {
	type?: unknown;
	id?: unknown;
	error?: unknown;
	result?: unknown;
	diagnostics?: unknown;
	newTabs?: unknown;
	tabs?: unknown;
	bridge?: unknown;
	extension?: unknown;
	pairingId?: unknown;
	decision?: unknown;
	[key: string]: unknown;
};

type BrowserBridgeClientMessageServiceDeps = {
	clients: BrowserBridgeClientRegistry;
	browserSessions: BrowserBridgeSessionRegistryPort;
	tabs: BrowserTabSessionRouter;
	pendingRequests: BrowserBridgePendingRequests;
	runtimeRecoveryArtifacts: BrowserRuntimeRecoveryArtifacts;
	queues: BrowserCommandQueueRegistry;
	consent: BrowserBridgeConsentCoordinator;
	migratePerceptionLedger?: (fromTabId: number, toTabId: number, browserSessionId: string) => void;
	clearRecorderStateForReplacement?: (fromTabId: number, toTabId: number, browserSessionId: string) => void;
	notifyExtensionReady?: () => void;
	handshakeTimeoutMs?: number;
};

type AppliedTabReplacement = ReturnType<BrowserTabSessionRouter["applyTabReplacements"]>[number];

export class BrowserBridgeClientMessageService {
	private readonly deps: BrowserBridgeClientMessageServiceDeps;
	private readonly handshakeTimeoutMs: number;
	private readonly handshakeTimers = new WeakMap<WebSocket, NodeJS.Timeout>();

	constructor(deps: BrowserBridgeClientMessageServiceDeps) {
		this.deps = deps;
		this.handshakeTimeoutMs = deps.handshakeTimeoutMs ?? 5_000;
	}

	registerClient(ws: WebSocket): void {
		this.deps.clients.register(ws);
		const timer = setTimeout(() => {
			this.handshakeTimers.delete(ws);
			if (ws.readyState === WebSocket.OPEN) ws.terminate();
		}, this.handshakeTimeoutMs);
		timer.unref();
		this.handshakeTimers.set(ws, timer);
		ws.on("message", (data) => void this.handleClientMessage(ws, data.toString()).catch((error) => {
			console.error("[browser-pilot-bridge] WebSocket message handler failed", this.redactMessageError(error, data.toString()));
		}));
		ws.on("pong", () => this.deps.clients.markPong(ws));
		ws.on("close", () => this.unregisterClient(ws, "ws_close"));
		ws.on("error", () => this.unregisterClient(ws, "ws_error"));
	}

	unregisterClient(ws: WebSocket, reason?: string): void {
		this.clearHandshakeTimeout(ws);
		// Hold in-flight requests in a grace window instead of failing them outright: a fast
		// reconnect (offscreen re-dial / SW restart) can still complete or reclaim them. Capture
		// the owning instance before unregister so a same-instance reconnect can correlate.
		const instanceId = this.deps.clients.info(ws)?.extensionInstanceId;
		this.deps.pendingRequests.drainClient(ws, instanceId, requestGraceMs());
		if (reason) this.deps.clients.recordDisconnect(reason, instanceId, !this.deps.clients.hasOpenInstanceClient(instanceId, ws));
		this.deps.clients.unregister(ws);
		this.deps.tabs.markClientDisconnected(ws);
	}

	private applyReplacementSideEffects(replacements: AppliedTabReplacement[], browserSessionId?: string): void {
		for (const replacement of replacements) {
			if (!replacement.sameTab) {
				this.deps.queues.migrateTabQueue(replacement.browserId, replacement.from, replacement.to);
				if (browserSessionId) this.deps.migratePerceptionLedger?.(replacement.from, replacement.to, browserSessionId);
			}
			if (browserSessionId) this.deps.clearRecorderStateForReplacement?.(replacement.from, replacement.to, browserSessionId);
		}
	}

	async handleClientMessage(ws: WebSocket, raw: string): Promise<void> {
		let message: IncomingMessage;
		try {
			message = parseJsonOrThrow<IncomingMessage>(raw, "Invalid WebSocket message JSON");
		} catch (error) {
			console.warn("[browser-pilot-bridge] Invalid WebSocket message JSON", this.redactMessageError(error, raw));
			return;
		}

		this.deps.clients.markSeen(ws);
		const type = String(message.type || "");
		if (type === "ping") return;
		if (type === CONSENT_MESSAGE_TYPES.response) {
			this.deps.consent.resolveConsent(String(message.pairingId || ""), message.decision as "approve" | "deny");
			return;
		}
		if (type === CONSENT_MESSAGE_TYPES.revoke) {
			this.deps.consent.fireRevoke(String(message.pairingId || ""));
			return;
		}
		if (type === "ext_ready" && !this.isValidExtensionReady(message)) return;
		if (type === "ext_ready" || type === "tabs_update") {
			if (type === "ext_ready") this.clearHandshakeTimeout(ws);
			const defaultSession = this.deps.browserSessions.defaultSession();
			const selectedClient = this.deps.browserSessions.selectedOpenClient(defaultSession);
			const selectedInfo = selectedClient ? this.deps.clients.info(selectedClient) : undefined;
			const selectedInstanceId = selectedInfo?.extensionInstanceId;
			const priorInfo = this.deps.clients.info(ws);
			const previousInstanceId = priorInfo?.extensionInstanceId;
			const previousWorkerBootId = priorInfo?.workerBootId;
			this.deps.clients.updateClientInfo(ws, message.bridge || message.extension);
			const incomingInfo = this.deps.clients.info(ws);
			const incomingInstanceId = incomingInfo?.extensionInstanceId;
			const replacesSelectedInstance = type === "ext_ready"
				&& selectedClient !== undefined
				&& selectedInstanceId !== undefined
				&& selectedInstanceId === incomingInstanceId;
			const upgradesStaleSelection = type === "ext_ready" && selectedInfo?.extensionStale === true && incomingInfo?.extensionStale === false;
			if (!selectedClient || selectedClient === ws || replacesSelectedInstance || upgradesStaleSelection) this.deps.browserSessions.selectClient(defaultSession, ws);
			if (type === "ext_ready") {
				// Classify against peers BEFORE collapsing, then enforce one live socket per
				// extension instance. Idempotent: a repeat ext_ready on the same socket finds
				// no peer to supersede and just refreshes selection/info.
				const info = this.deps.clients.info(ws);
				const sameSocketRestart = previousInstanceId !== undefined
					&& previousInstanceId === info?.extensionInstanceId
					&& previousWorkerBootId !== undefined
					&& info?.workerBootId !== undefined
					&& previousWorkerBootId !== info.workerBootId;
				const sameSocketDuplicate = previousInstanceId !== undefined
					&& previousInstanceId === info?.extensionInstanceId
					&& previousWorkerBootId !== undefined
					&& previousWorkerBootId === info?.workerBootId;
				const connectKind = sameSocketRestart ? "sw-restart" : sameSocketDuplicate ? "duplicate" : this.deps.clients.classifyConnect(ws, info?.extensionInstanceId, info?.workerBootId);
				if (info) info.connectKind = connectKind;
				this.deps.clients.recordConnect(connectKind, info?.extensionInstanceId, info?.workerBootId);
				this.deps.clients.recordHandshake();
				const graceMs = requestGraceMs();
				// Drain a superseded peer's in-flight requests synchronously (its async close would
				// otherwise race the reconcile below), then reconcile all draining requests for this
				// instance against the freshly-connected socket.
				const superseded = this.deps.clients.supersedeInstanceClients(info?.extensionInstanceId, ws);
				for (const stale of superseded) this.deps.pendingRequests.drainClient(stale, info?.extensionInstanceId, graceMs);
				this.deps.pendingRequests.reconnectInstance(info?.extensionInstanceId);
			}
			const replacements = Array.isArray(message.replaced) ? this.deps.tabs.applyTabReplacements(message.replaced, ws) : [];
			this.deps.tabs.updateTabs(Array.isArray(message.tabs) ? message.tabs : [], ws);
			this.deps.tabs.recordTabActivation(message.activation, ws);
			const affectedBrowserSessionId = this.deps.browserSessions.selectedOpenClient(defaultSession) === ws ? defaultSession.id : undefined;
			this.applyReplacementSideEffects(replacements, affectedBrowserSessionId);
			this.deps.notifyExtensionReady?.();
			if (type === "ext_ready") this.deps.runtimeRecoveryArtifacts.recordRuntimeRecovery(this.deps.clients.info(ws), recordValue(message.bridge));
			return;
		}

		if (type === "ack") {
			this.deps.pendingRequests.ack(String(message.id || ""));
			return;
		}
		if (type === "result" || type === "error") {
			const id = String(message.id || "");
			const diagnostics = recordValue(message.diagnostics);
			if (type === "error") {
				this.deps.pendingRequests.rejectBrowserError(id, message.error, message.result, diagnostics);
				return;
			}
			this.deps.pendingRequests.resolve(id, message.result, Array.isArray(message.newTabs) ? message.newTabs : [], diagnostics);
		}
	}

	private clearHandshakeTimeout(ws: WebSocket): void {
		const timer = this.handshakeTimers.get(ws);
		if (timer) clearTimeout(timer);
		this.handshakeTimers.delete(ws);
	}

	private isValidExtensionReady(message: IncomingMessage): boolean {
		const bridge = message.bridge;
		return !!bridge && typeof bridge === "object" && !Array.isArray(bridge)
			&& typeof (bridge as Record<string, unknown>).id === "string"
			&& (bridge as Record<string, unknown>).id !== "";
	}

	private redactMessageError(error: unknown, raw: string): Record<string, unknown> {
		return { error: errorToPlain(error), bytes: Buffer.byteLength(raw) };
	}
}
