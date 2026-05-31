import { WebSocket } from "ws";
import { BrowserBridgeError } from "./errors.js";
import { getNativeCommandProtocolSchema, validateBridgeCommand } from "../protocol/nativeProtocol.js";
import type { BridgeCommand } from "../protocol/nativeProtocol.js";
import { bridgeResultFailure, recordValue, toTabId } from "./bridgeUtils.js";
import type {
	BrowserAutomationSession,
	BrowserAutomationSessionInfo,
	BrowserBridgeExecutionResult,
	BrowserBridgeSnapshot,
	BrowserBridgeTargetInfo,
	BrowserTabInfo,
	BrowserTabSession,
	ExecuteOptions,
} from "./types.js";
import type { BrowserBridgeClientRegistry } from "./BrowserBridgeClientRegistry.js";
import type { BrowserBridgePendingRequests } from "./BrowserBridgePendingRequests.js";
import type { BrowserCommandQueueRegistry } from "./BrowserCommandQueueRegistry.js";
import type { BrowserLeaseRegistry } from "./BrowserLeaseRegistry.js";
import type { BrowserRuntimeRecoveryArtifacts } from "./BrowserRuntimeRecoveryArtifacts.js";
import type { BrowserSessionRegistry } from "./BrowserSessionRegistry.js";
import type { BrowserTabSessionRouter } from "./BrowserTabSessionRouter.js";

type SendPayloadOptions = ExecuteOptions & { target?: BrowserBridgeTargetInfo };
type CommandExecutionPlan = { target?: BrowserBridgeTargetInfo; tabId?: number; accessMode: "read" | "write" };

type BrowserBridgeCommandServiceDeps = {
	clients: BrowserBridgeClientRegistry;
	browserSessions: BrowserSessionRegistry;
	queues: BrowserCommandQueueRegistry;
	leases: BrowserLeaseRegistry;
	tabs: BrowserTabSessionRouter;
	pendingRequests: BrowserBridgePendingRequests;
	runtimeRecoveryArtifacts: BrowserRuntimeRecoveryArtifacts;
	isRunning: () => boolean;
	getPort: () => number;
	getTabs: (options?: { includeDisconnected?: boolean }) => BrowserTabInfo[];
	listBrowserSessions: () => BrowserAutomationSessionInfo[];
	snapshot: (options?: { browserSessionId?: string }) => BrowserBridgeSnapshot;
};

export class BrowserBridgeCommandService {
	private readonly deps: BrowserBridgeCommandServiceDeps;

	constructor(deps: BrowserBridgeCommandServiceDeps) {
		this.deps = deps;
	}

	async refreshTabs(timeoutMs = 5_000, options: { browserSessionId?: string } = {}): Promise<BrowserTabInfo[]> {
		const result = await this.sendCommand({ cmd: "tabs", method: "list" }, { timeoutMs, browserSessionId: options.browserSessionId });
		const data = Array.isArray(result.data) ? result.data : [];
		this.deps.tabs.updateTabs(data, this.socketForBrowserSessionCommand(options.browserSessionId));
		return this.deps.getTabs();
	}

	async switchTab(tabId: number | string, timeoutMs = 5_000, options: { browserSessionId?: string } = {}): Promise<BrowserBridgeExecutionResult> {
		const id = this.requireTabId(tabId);
		const browserSession = this.browserSession(options.browserSessionId);
		this.deps.leases.acquireUiLock(browserSession.id, "browser_tabs.switch");
		try {
			const previousDefaultTabId = this.deps.tabs.previousDefaultTabId(options.browserSessionId);
			const result = await this.sendCommand({ cmd: "tabs", method: "switch", tabId: id }, { timeoutMs, tabId: id, browserSessionId: options.browserSessionId });
			const failure = bridgeResultFailure(result.data);
			if (failure) throw new BrowserBridgeError("BROWSER_COMMAND_FAILED", failure.message, { cmd: "tabs", method: "switch", tabId: id, ...failure.details });
			this.deps.tabs.selectTab(id, options.browserSessionId);
			const selection = { selectedTabId: id, previousDefaultTabId, selectionVersion: this.deps.tabs.selectionVersion };
			const dataRecord = recordValue(result.data);
			const data = dataRecord ? { ...dataRecord, ...selection } : selection;
			return { ...result, data };
		} finally {
			this.deps.leases.releaseUiLock(browserSession.id);
		}
	}

	async createTab(url: string, active = true, timeoutMs = 5_000, options: { browserSessionId?: string } = {}): Promise<BrowserBridgeExecutionResult> {
		return this.sendCommand({ cmd: "tabs", method: "create", url, active }, { timeoutMs, browserSessionId: options.browserSessionId });
	}

	async closeTab(tabId: number | string, timeoutMs = 5_000, options: { browserSessionId?: string } = {}): Promise<BrowserBridgeExecutionResult> {
		const id = this.requireTabId(tabId);
		const result = await this.sendCommand({ cmd: "tabs", method: "close", targetTabId: id }, { timeoutMs, tabId: id, browserSessionId: options.browserSessionId });
		this.deps.tabs.markTabDisconnected(id, options.browserSessionId);
		return result;
	}

	async executeJavaScript(script: string, options: ExecuteOptions = {}): Promise<BrowserBridgeExecutionResult> {
		const target = this.requireExecutionTarget(options.tabId, options.browserSessionId);
		return this.sendPayload(script, { browserSessionId: options.browserSessionId, tabId: target.tabId, timeoutMs: options.timeoutMs, target, accessMode: options.accessMode ?? "write" });
	}

	async sendCommand(command: BridgeCommand, options: ExecuteOptions = {}): Promise<BrowserBridgeExecutionResult> {
		const hasOptionTabId = options.tabId !== undefined;
		const hasCommandTabId = command.tabId !== undefined;
		const optionTabId = toTabId(options.tabId);
		const commandTabId = toTabId(command.tabId);
		if (hasOptionTabId && optionTabId === undefined) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId is required", { cmd: command.cmd, tabId: options.tabId, source: "options" });
		if (hasCommandTabId && commandTabId === undefined) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid command tabId is required", { cmd: command.cmd, tabId: command.tabId, source: "command" });
		if (optionTabId !== undefined && commandTabId !== undefined && optionTabId !== commandTabId) {
			throw new BrowserBridgeError("TAB_ID_CONFLICT", "Top-level tabId conflicts with command tabId", { cmd: command.cmd, tabId: optionTabId, commandTabId });
		}
		const browserSession = this.browserSession(options.browserSessionId);
		const requestedTabId = optionTabId ?? commandTabId;
		const explicitTarget = requestedTabId !== undefined ? this.deps.tabs.targetInfo("explicit", requestedTabId, browserSession) : undefined;
		const target = explicitTarget ?? this.optionalExecutionTarget(command, options.browserSessionId);
		const tabId = target?.tabId;
		const payload: BridgeCommand = tabId !== undefined ? { ...command, tabId } : command;
		const validation = validateBridgeCommand(payload, { allowMissingTabId: tabId === undefined });
		if (!validation.ok) throw new BrowserBridgeError("INVALID_BROWSER_COMMAND", validation.error, validation.details);
		if (validation.spec.tabScoped && tabId === undefined) throw new BrowserBridgeError("NO_TAB", "No target browser tab is available", { cmd: validation.command.cmd, tabs: this.deps.getTabs() });
		const plan = this.commandExecutionPlan(validation.command, target, options.accessMode);
		return this.sendPayload(validation.command, { browserSessionId: options.browserSessionId, tabId: plan.tabId, timeoutMs: options.timeoutMs, target: plan.target, accessMode: plan.accessMode });
	}

	private sendPayload(code: unknown, options: SendPayloadOptions = {}): Promise<BrowserBridgeExecutionResult> {
		if (!this.deps.isRunning()) throw new BrowserBridgeError("BRIDGE_NOT_RUNNING", "Browser bridge server is not running", { port: this.deps.getPort() });
		const tabId = toTabId(options.tabId);
		const target = options.target ?? this.deps.tabs.targetInfo(tabId !== undefined ? "explicit" : "none", tabId, this.browserSession(options.browserSessionId));
		const recordResult = (promise: Promise<BrowserBridgeExecutionResult>) => promise.then((result) => {
			this.deps.runtimeRecoveryArtifacts.recordCommandResult(code, result, { browserSessionId: options.browserSessionId, target, snapshot: this.deps.snapshot({ browserSessionId: options.browserSessionId }) });
			return result;
		});
		if (tabId !== undefined) {
			const browserSession = this.browserSession(options.browserSessionId);
			const tab = this.requireLiveTabSession(tabId, browserSession.id);
			if (options.accessMode === "write") {
				this.assertWriteInvariants(browserSession.id, tab, target);
				return recordResult(this.deps.queues.enqueue(browserSession.id, tabId, async () => {
					this.assertWriteInvariants(browserSession.id, tab, target);
					return await this.deps.leases.withAutoTabLease(browserSession.id, tab, async () => {
						this.deps.leases.touchTabLease(browserSession.id, tab);
						return await this.deps.pendingRequests.send(tab.client, code, { tabId, timeoutMs: options.timeoutMs, target });
					});
				}));
			}
			this.deps.leases.touchTabLease(browserSession.id, tab);
			return recordResult(this.deps.pendingRequests.send(tab.client, code, { tabId, timeoutMs: options.timeoutMs, target }));
		}
		const socket = this.socketForBrowserSessionCommand(options.browserSessionId);
		return recordResult(this.deps.pendingRequests.send(socket, code, { tabId, timeoutMs: options.timeoutMs, target }));
	}

	private socketForBrowserSessionCommand(browserSessionId?: string): WebSocket {
		const browserSession = this.browserSession(browserSessionId);
		const selected = this.deps.browserSessions.selectedOpenClient(browserSession);
		if (selected) return selected;
		if (browserSession.id !== "default") {
			throw new BrowserBridgeError("NO_BROWSER_EXTENSION", "Requested browser session has no selected browser extension client", {
				browserSessionId: browserSession.id,
				sessions: this.deps.listBrowserSessions(),
			});
		}
		return this.deps.clients.requireExtensionClient();
	}

	private requireLiveTabSession(tabId: number, browserSessionId?: string): BrowserTabSession {
		const session = this.deps.tabs.liveSessionForTabId(tabId, browserSessionId);
		if (session) return session;
		throw new BrowserBridgeError("TAB_NOT_FOUND", "Target browser tab is not connected", {
			tabId,
			browserSessionId,
			selectedBrowser: this.deps.browserSessions.selectedInfo(this.browserSession(browserSessionId), this.deps.clients),
			tabs: this.deps.getTabs(),
		});
	}

	private requireExecutionTarget(value: unknown, browserSessionId?: string): BrowserBridgeTargetInfo {
		const browserSession = this.browserSession(browserSessionId);
		const requested = toTabId(value);
		if (requested) return this.deps.tabs.targetInfo("explicit", requested, browserSession);
		if (value !== undefined) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId is required", { tabId: value, source: "options" });
		const fallback = this.deps.tabs.fallbackExecutionTarget(browserSessionId);
		if (fallback) return fallback;
		throw new BrowserBridgeError("NO_TAB", "No target browser tab is available", { tabs: this.deps.getTabs() });
	}

	private optionalExecutionTarget(command: BridgeCommand, browserSessionId?: string): BrowserBridgeTargetInfo | undefined {
		const browserSession = this.browserSession(browserSessionId);
		const currentSchema = getNativeCommandProtocolSchema();
		const canonical = currentSchema.commands[String(command.cmd || "")]?.canonical || currentSchema.aliases?.[String(command.cmd || "")] || String(command.cmd || "");
		const spec = currentSchema.commands[canonical];
		if (!spec?.tabScoped) return this.deps.tabs.targetInfo("none", undefined, browserSession);
		return this.deps.tabs.fallbackExecutionTarget(browserSessionId);
	}

	private commandExecutionPlan(command: BridgeCommand, target: BrowserBridgeTargetInfo | undefined, preferred?: "read" | "write"): CommandExecutionPlan {
		const currentSchema = getNativeCommandProtocolSchema();
		const canonical = currentSchema.commands[String(command.cmd || "")]?.canonical || currentSchema.aliases?.[String(command.cmd || "")] || String(command.cmd || "");
		const spec = currentSchema.commands[canonical];
		const method = String(command.method || command.action || spec?.defaultMethod || "").toLowerCase();
		const tabId = target?.tabId;
		if (!spec) return { target, tabId, accessMode: preferred ?? "read" };
		const requiresTransportTab = spec.tabScoped || (canonical === "tabs" && ["switch", "close"].includes(method));
		const noneTarget = !requiresTransportTab;
		const accessMode = preferred ?? this.commandAccessMode(spec, method);
		return {
			target: noneTarget ? this.deps.tabs.targetInfo("none", undefined, this.browserSession(target?.browserSessionId)) : target,
			tabId: noneTarget ? undefined : tabId,
			accessMode,
		};
	}

	private commandAccessMode(spec: { accessMode?: "read" | "write"; methodSpecs?: Record<string, { accessMode?: "read" | "write" }> }, method: string): "read" | "write" {
		const methodAccessMode = spec.methodSpecs?.[method]?.accessMode;
		if (methodAccessMode === "read" || methodAccessMode === "write") return methodAccessMode;
		return spec.accessMode === "write" ? "write" : "read";
	}

	private assertWriteInvariants(browserSessionId: string, tab: BrowserTabSession, target?: BrowserBridgeTargetInfo): void {
		const lease = this.deps.leases.peekTabLease(tab);
		if (lease && lease.browserSessionId !== browserSessionId) {
			throw new BrowserBridgeError("TAB_LEASE_CONFLICT", "Target tab is leased by another browser session", {
				requestedBrowserSessionId: browserSessionId,
				lease,
				target,
				invariant: "write_target_foreign_lease",
			});
		}
		if (target?.browserSessionId && target.browserSessionId !== browserSessionId) {
			throw new BrowserBridgeError("TAB_LEASE_CONFLICT", "Write target browser session is inconsistent with resolved target", {
				requestedBrowserSessionId: browserSessionId,
				target,
				invariant: "write_target_session_mismatch",
			});
		}
	}

	private requireTabId(value: unknown): number {
		const tabId = toTabId(value);
		if (!tabId) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId is required", { tabId: value });
		return tabId;
	}

	private browserSession(browserSessionId?: string): BrowserAutomationSession {
		return browserSessionId ? this.deps.browserSessions.require(browserSessionId) : this.deps.browserSessions.selectedSession();
	}
}
