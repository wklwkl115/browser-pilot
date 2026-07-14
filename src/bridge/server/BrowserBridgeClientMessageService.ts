import { WebSocket } from "ws";
import { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry.js";
import { BrowserRuntimeRecoveryArtifacts } from "./BrowserRuntimeRecoveryArtifacts.js";
import { BrowserTabSessionRouter } from "./BrowserTabSessionRouter.js";
import { BrowserBridgePendingRequests, requestGraceMs } from "./BrowserBridgePendingRequests.js";
import type { BrowserBridgeLeaseRegistryPort, BrowserBridgeSessionRegistryPort } from "./BrowserBridgeSessionPorts.js";
import type { BrowserCommandQueueRegistry } from "./BrowserCommandQueueRegistry.js";
import { errorToPlain } from "../../utils/errors.js";
import { parseJsonOrThrow } from "../../utils/json.js";
import { recordValue } from "./bridgeUtils.js";
import { CONSENT_MESSAGE_TYPES } from "../protocol/consentTypes.js";
import type { BrowserBridgeConsentCoordinator } from "./BrowserBridgeConsentCoordinator.js";
import type { SessionActiveOperationInfo } from "../../kernels/session/operationRegistry.js";
import type { BrowserOperationEvent } from "../../kernels/session/browserOperation.js";

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
	leases: BrowserBridgeLeaseRegistryPort;
	queues: BrowserCommandQueueRegistry;
	consent: BrowserBridgeConsentCoordinator;
	recordOperationEvent: (operationId: string, event: Omit<BrowserOperationEvent, "operationId" | "sequence" | "ledgerRevision" | "timestamp"> & { sequence?: number; sourceSequence?: number; timestamp?: number }) => SessionActiveOperationInfo | undefined;
	migratePerceptionLedger?: (fromTabId: number, toTabId: number, browserSessionIds?: string[]) => void;
	clearRecorderStateForReplacement?: (fromTabId: number, toTabId: number, browserSessionIds?: string[]) => void;
	logLeaseCleanup?: (details: { reason: "disconnect"; releasedLeases: unknown[]; releasedUiLocks: unknown[]; disconnectedTabSessionIds: string[]; affectedBrowserSessionIds: string[] }) => void;
	notifyExtensionReady?: () => void;
	notifyOperationTopologyChange?: () => void;
	recordTargetReplacement?: (fromTabId: number, toTabId: number) => void;
	recordOperationWorkerRestart?: (details: { extensionInstanceId?: string; previousWorkerBootId?: string; workerBootId?: string }) => void;
};

type AppliedTabReplacement = ReturnType<BrowserTabSessionRouter["applyTabReplacements"]>[number];

export class BrowserBridgeClientMessageService {
	private readonly deps: BrowserBridgeClientMessageServiceDeps;

	constructor(deps: BrowserBridgeClientMessageServiceDeps) {
		this.deps = deps;
	}

	registerClient(ws: WebSocket): void {
		this.deps.clients.register(ws);
		ws.on("message", (data) => void this.handleClientMessage(ws, data.toString()).catch((error) => {
			console.error("[browser-pilot-bridge] WebSocket message handler failed", this.redactMessageError(error, data.toString()));
		}));
		ws.on("pong", () => this.deps.clients.markPong(ws));
		ws.on("close", () => this.unregisterClient(ws, "ws_close"));
		ws.on("error", () => this.unregisterClient(ws, "ws_error"));
	}

	unregisterClient(ws: WebSocket, reason?: string): void {
		const disconnectedTabSessionIds = Array.from(this.deps.tabs.sessions.values()).filter((session) => session.client === ws && !session.disconnectedAt).map((session) => session.id);
		const affectedBrowserSessionIds = this.deps.browserSessions.list().filter((session) => session.selectedClient === ws).map((session) => session.id);
		// Hold in-flight requests in a grace window instead of failing them outright: a fast
		// reconnect (offscreen re-dial / SW restart) can still complete or reclaim them. Capture
		// the owning instance before unregister so a same-instance reconnect can correlate.
		const instanceId = this.deps.clients.info(ws)?.extensionInstanceId;
		this.deps.pendingRequests.drainClient(ws, instanceId, requestGraceMs());
		if (reason) this.deps.clients.recordDisconnect(reason, instanceId, !this.deps.clients.hasOpenInstanceClient(instanceId, ws));
		this.deps.clients.unregister(ws);
		this.deps.tabs.markClientDisconnected(ws);
		const releasedLeases = this.deps.leases.releaseLeasesForTabSessions(disconnectedTabSessionIds, "disconnect");
		const releasedUiLocks = this.deps.leases.releaseUiLocksForBrowserSessions(affectedBrowserSessionIds, "disconnect");
		if ((releasedLeases.length || releasedUiLocks.length) && this.deps.logLeaseCleanup) {
			this.deps.logLeaseCleanup({ reason: "disconnect", releasedLeases, releasedUiLocks, disconnectedTabSessionIds, affectedBrowserSessionIds });
		}
		this.deps.notifyOperationTopologyChange?.();
	}

	private applyReplacementSideEffects(replacements: AppliedTabReplacement[], affectedBrowserSessionIds: string[]): void {
		for (const replacement of replacements) {
			const next = this.deps.tabs.sessions.get(replacement.toSessionId);
			if (next && !replacement.sameTab) this.deps.leases.migrateTabLeaseForReplacement(replacement.fromSessionId, next);
			if (!replacement.sameTab) {
				for (const session of this.deps.browserSessions.list()) this.deps.queues.migrateTabQueue(session.id, replacement.from, replacement.to);
				this.deps.migratePerceptionLedger?.(replacement.from, replacement.to, affectedBrowserSessionIds);
			}
			this.deps.clearRecorderStateForReplacement?.(replacement.from, replacement.to, affectedBrowserSessionIds);
			this.deps.recordTargetReplacement?.(replacement.from, replacement.to);
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
		if (type === "operation_event") {
			const operationId = typeof message.operationId === "string" ? message.operationId : "";
			if (!operationId) return;
			const event = recordValue(message.event) || message;
			this.deps.recordOperationEvent(operationId, {
				type: typeof event.type === "string" ? event.type : "unknown",
				sequence: typeof event.sequence === "number" ? event.sequence : undefined,
				sourceSequence: typeof event.sequence === "number" ? event.sequence : undefined,
				timestamp: typeof event.timestamp === "number" ? event.timestamp : undefined,
				targetRef: typeof event.targetRef === "string" ? event.targetRef : undefined,
				tabId: typeof event.tabId === "number" ? event.tabId : undefined,
				generation: typeof event.generation === "number" ? event.generation : undefined,
				progress: event.progress !== false,
				data: recordValue(event.data),
			});
			return;
		}
		if (type === CONSENT_MESSAGE_TYPES.response) {
			this.deps.consent.resolveConsent(String(message.pairingId || ""), message.decision as "approve" | "deny");
			return;
		}
		if (type === CONSENT_MESSAGE_TYPES.revoke) {
			this.deps.consent.fireRevoke(String(message.pairingId || ""));
			return;
		}
		if (type === "ext_ready" || type === "tabs_update") {
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
				if (connectKind === "sw-restart") this.deps.recordOperationWorkerRestart?.({ extensionInstanceId: info?.extensionInstanceId, previousWorkerBootId, workerBootId: info?.workerBootId });
				const graceMs = requestGraceMs();
				// Drain a superseded peer's in-flight requests synchronously (its async close would
				// otherwise race the reconcile below), then reconcile all draining requests for this
				// instance against the freshly-connected socket.
				const superseded = this.deps.clients.supersedeInstanceClients(info?.extensionInstanceId, ws);
				for (const stale of superseded) this.deps.pendingRequests.drainClient(stale, info?.extensionInstanceId, graceMs);
				const durable = recordValue(message.bridge)?.durableRequests === true;
				this.deps.pendingRequests.reconnectInstance(info?.extensionInstanceId, ws, { durable });
			}
			const replacements = Array.isArray(message.replaced) ? this.deps.tabs.applyTabReplacements(message.replaced, ws) : [];
			this.deps.tabs.updateTabs(Array.isArray(message.tabs) ? message.tabs : [], ws);
			this.deps.tabs.recordTabActivation(message.activation, ws);
			const affectedBrowserSessionIds = this.deps.browserSessions.list()
				.filter((session) => this.deps.browserSessions.selectedOpenClient(session) === ws)
				.map((session) => session.id);
			this.applyReplacementSideEffects(replacements, affectedBrowserSessionIds);
			this.deps.notifyOperationTopologyChange?.();
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

	private redactMessageError(error: unknown, raw: string): Record<string, unknown> {
		return { error: errorToPlain(error), bytes: Buffer.byteLength(raw) };
	}
}
