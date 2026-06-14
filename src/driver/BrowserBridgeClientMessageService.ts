import { WebSocket } from "ws";
import { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry.js";
import { BrowserRuntimeRecoveryArtifacts } from "./BrowserRuntimeRecoveryArtifacts.js";
import { BrowserSessionRegistry } from "./BrowserSessionRegistry.js";
import { BrowserTabSessionRouter } from "./BrowserTabSessionRouter.js";
import { BrowserBridgePendingRequests } from "./BrowserBridgePendingRequests.js";
import type { BrowserLeaseRegistry } from "./BrowserLeaseRegistry.js";
import type { BrowserCommandQueueRegistry } from "./BrowserCommandQueueRegistry.js";
import { errorToPlain } from "./errors.js";
import { parseJsonOrThrow } from "../utils/json.js";
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
	browserSessions: BrowserSessionRegistry;
	tabs: BrowserTabSessionRouter;
	pendingRequests: BrowserBridgePendingRequests;
	runtimeRecoveryArtifacts: BrowserRuntimeRecoveryArtifacts;
	leases: BrowserLeaseRegistry;
	queues: BrowserCommandQueueRegistry;
	migratePerceptionLedger?: (fromTabId: number, toTabId: number, browserSessionIds?: string[]) => void;
	logLeaseCleanup?: (details: { reason: "disconnect"; releasedLeases: unknown[]; releasedUiLocks: unknown[]; disconnectedTabSessionIds: string[]; affectedBrowserSessionIds: string[] }) => void;
	notifyExtensionReady?: () => void;
};

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
		ws.on("close", () => this.unregisterClient(ws));
		ws.on("error", () => this.unregisterClient(ws));
	}

	unregisterClient(ws: WebSocket): void {
		const disconnectedTabSessionIds = Array.from(this.deps.tabs.sessions.values()).filter((session) => session.client === ws && !session.disconnectedAt).map((session) => session.id);
		const affectedBrowserSessionIds = this.deps.browserSessions.list().filter((session) => session.selectedClient === ws).map((session) => session.id);
		this.deps.pendingRequests.rejectForClient(ws);
		this.deps.clients.unregister(ws);
		this.deps.tabs.markClientDisconnected(ws);
		const releasedLeases = this.deps.leases.releaseLeasesForTabSessions(disconnectedTabSessionIds, "disconnect");
		const releasedUiLocks = this.deps.leases.releaseUiLocksForBrowserSessions(affectedBrowserSessionIds, "disconnect");
		if ((releasedLeases.length || releasedUiLocks.length) && this.deps.logLeaseCleanup) {
			this.deps.logLeaseCleanup({ reason: "disconnect", releasedLeases, releasedUiLocks, disconnectedTabSessionIds, affectedBrowserSessionIds });
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
		if (type === "ext_ready" || type === "tabs_update") {
			this.deps.browserSessions.selectClient(this.deps.browserSessions.defaultSession(), ws);
			this.deps.clients.updateClientInfo(ws, message.bridge || message.extension);
			const replacements = Array.isArray(message.replaced) ? this.deps.tabs.applyTabReplacements(message.replaced, ws) : [];
			this.deps.tabs.updateTabs(Array.isArray(message.tabs) ? message.tabs : [], ws);
			this.deps.tabs.recordTabActivation(message.activation, ws);
			const affectedBrowserSessionIds = this.deps.browserSessions.list()
				.filter((session) => this.deps.browserSessions.selectedOpenClient(session) === ws)
				.map((session) => session.id);
			for (const replacement of replacements) {
				const next = this.deps.tabs.sessions.get(replacement.toSessionId);
				if (next) this.deps.leases.migrateTabLeaseForReplacement(replacement.fromSessionId, next);
				for (const session of this.deps.browserSessions.list()) this.deps.queues.migrateTabQueue(session.id, replacement.from, replacement.to);
				this.deps.migratePerceptionLedger?.(replacement.from, replacement.to, affectedBrowserSessionIds);
			}
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
