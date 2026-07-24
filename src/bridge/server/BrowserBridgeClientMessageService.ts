import { WebSocket } from "ws";
import { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry.js";
import { BrowserTabSessionRouter } from "./BrowserTabSessionRouter.js";
import { BrowserBridgePendingRequests } from "./BrowserBridgePendingRequests.js";
import type { BrowserBridgeSessionRegistryPort } from "./BrowserBridgeSessionPorts.js";
import type { BrowserCommandQueueRegistry } from "./BrowserCommandQueueRegistry.js";
import { errorToPlain } from "../../utils/errors.js";
import { parseJsonOrThrow } from "../../utils/json.js";
import { recordValue } from "./bridgeUtils.js";

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
	[key: string]: unknown;
};

type BrowserBridgeClientMessageServiceDeps = {
	clients: BrowserBridgeClientRegistry;
	browserSessions: BrowserBridgeSessionRegistryPort;
	tabs: BrowserTabSessionRouter;
	pendingRequests: BrowserBridgePendingRequests;
	queues: BrowserCommandQueueRegistry;
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
		const info = this.deps.clients.info(ws);
		if (!info) return;
		this.clearHandshakeTimeout(ws);
		const instanceId = info.extensionInstanceId;
		this.deps.pendingRequests.rejectClient(ws);
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
		if (!this.deps.clients.info(ws)) return;
		const type = String(message.type || "");
		if (type === "ping") return;
		if (type === "ext_ready" && !this.isValidExtensionReady(message)) return;
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
			const replacesSelectedInstance = selectedClient !== undefined
				&& selectedInstanceId !== undefined
				&& selectedInstanceId === incomingInstanceId;
			if (type === "ext_ready") {
				this.clearHandshakeTimeout(ws);
				const upgradesStaleSelection = selectedInfo?.extensionStale === true && incomingInfo?.extensionStale === false;
				const downgradesCurrentSelection = selectedInfo?.extensionStale === false && incomingInfo?.extensionStale === true;
				if (selectedClient && selectedClient !== ws && (downgradesCurrentSelection || (!replacesSelectedInstance && !upgradesStaleSelection))) {
					this.unregisterClient(ws);
					if (ws.readyState === WebSocket.OPEN) ws.close(1008, "Another browser is already connected");
					return;
				}
				this.deps.browserSessions.selectClient(defaultSession, ws);
				// Classify before removing the previous owner so reconnect metrics retain context.
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
				const superseded = this.deps.clients.supersedeClients(ws);
				for (const stale of superseded) this.unregisterClient(stale, "superseded");
			}
			const replacements = Array.isArray(message.replaced) ? this.deps.tabs.applyTabReplacements(message.replaced, ws) : [];
			this.deps.tabs.updateTabs(Array.isArray(message.tabs) ? message.tabs : [], ws);
			this.deps.tabs.recordTabActivation(message.activation, ws);
			const affectedBrowserSessionId = this.deps.browserSessions.selectedOpenClient(defaultSession) === ws ? defaultSession.id : undefined;
			this.applyReplacementSideEffects(replacements, affectedBrowserSessionId);
			this.deps.notifyExtensionReady?.();
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
