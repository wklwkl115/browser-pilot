import { WebSocket } from "ws";
import { noBrowserExtensionError, tabNotFoundError } from "../errors.js";
import { BrowserBridgeError } from "../../utils/errors.js";
import { getNativeCommandProtocolSchema, validateBridgeCommand } from "../../types/nativeProtocol.js";
import type { BridgeCommand } from "../../types/nativeProtocol.js";
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
import type { BrowserBridgeLeaseRegistryPort, BrowserBridgeSessionRegistryPort } from "./BrowserBridgeSessionPorts.js";
import type { BrowserRuntimeRecoveryArtifacts } from "./BrowserRuntimeRecoveryArtifacts.js";
import type { BrowserTabSessionRouter } from "./BrowserTabSessionRouter.js";
import { queueTemporalDiagnostics } from "./BrowserTemporalCoordinator.js";

type SendPayloadOptions = ExecuteOptions & { target?: BrowserBridgeTargetInfo };
type CommandExecutionPlan = { target?: BrowserBridgeTargetInfo; tabId?: number; accessMode: "read" | "write" };
type CreatedTabFields = Pick<BrowserBridgeExecutionResult, "createdTarget" | "createdTab">;

/**
 * Grace window to let a not-yet-connected extension dial into the bridge before a
 * command fails with NO_BROWSER_EXTENSION. The MV3 service worker is often merely
 * idle on a cold start (daemon just up, extension loaded) — a brief wait lets the
 * first `browser_tabs list` succeed transparently instead of hard-failing. Env
 * `BROWSER_PILOT_EXTENSION_WAIT_MS` overrides; `0` disables (used by hermetic tests).
 */
const DEFAULT_EXTENSION_WAIT_MS = 5_000;
const EXTENSION_WAIT_NEGATIVE_CACHE_MS = 500;
function extensionWaitMs(): number {
	const raw = process.env.BROWSER_PILOT_EXTENSION_WAIT_MS;
	if (raw === undefined) return DEFAULT_EXTENSION_WAIT_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_EXTENSION_WAIT_MS;
}

function commandName(code: unknown): string | undefined {
	if (typeof code === "string") return "javascript";
	const record = recordValue(code);
	return typeof record?.cmd === "string" ? record.cmd : undefined;
}

function mergeDiagnostics(result: BrowserBridgeExecutionResult, diagnostics: Record<string, unknown>): BrowserBridgeExecutionResult {
	return {
		...result,
		diagnostics: {
			...(result.diagnostics || {}),
			...diagnostics,
		},
	};
}

type BrowserBridgeCommandServiceDeps = {
	clients: BrowserBridgeClientRegistry;
	browserSessions: BrowserBridgeSessionRegistryPort;
	queues: BrowserCommandQueueRegistry;
	leases: BrowserBridgeLeaseRegistryPort;
	tabs: BrowserTabSessionRouter;
	pendingRequests: BrowserBridgePendingRequests;
	runtimeRecoveryArtifacts: BrowserRuntimeRecoveryArtifacts;
	isRunning: () => boolean;
	getPort: () => number;
	getTabs: (options?: { includeDisconnected?: boolean }) => BrowserTabInfo[];
	listBrowserSessions: () => BrowserAutomationSessionInfo[];
	snapshot: (options?: { browserSessionId?: string }) => BrowserBridgeSnapshot;
	/** Resolve once an extension is connected for the session, or after timeoutMs — never throws. */
	waitForExtensionReady: (browserSessionId: string | undefined, timeoutMs: number) => Promise<boolean>;
};

export class BrowserBridgeCommandService {
	private readonly deps: BrowserBridgeCommandServiceDeps;
	private extensionUnavailableUntil = 0;
	private lastConnectionWaitMs = 0;

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
		const browserSession = this.browserSession(options.browserSessionId);
		const target = this.requireTargetRef(tabId, options.browserSessionId);
		const id = this.requireTargetTabId(target, tabId);
		await this.deps.leases.acquireUiLock(browserSession.id, "browser_tabs.switch");
		try {
			const previousDefaultTabId = this.deps.tabs.previousDefaultTabId(options.browserSessionId);
			const result = await this.sendCommand({ cmd: "tabs", method: "switch", tabId: id }, { timeoutMs, tabId, browserSessionId: options.browserSessionId });
			const failure = bridgeResultFailure(result.data);
			if (failure) throw new BrowserBridgeError("BROWSER_COMMAND_FAILED", failure.message, { cmd: "tabs", method: "switch", tabId: id, ...failure.details });
			this.deps.tabs.selectTab(id, options.browserSessionId);
			const selection = { selectedTabId: id, selectedTabHandle: target.tabHandle, previousDefaultTabId, selectionVersion: this.deps.tabs.selectionVersion };
			const dataRecord = recordValue(result.data);
			const data = dataRecord ? { ...dataRecord, ...selection } : selection;
			return { ...result, data };
		} finally {
			this.deps.leases.releaseUiLock(browserSession.id);
		}
	}

	async createTab(url: string, active = true, timeoutMs = 5_000, options: { browserSessionId?: string; incognito?: boolean } = {}): Promise<BrowserBridgeExecutionResult> {
		return await this.sendCommand({ cmd: "tabs", method: "create", url, active, ...(options.incognito ? { incognito: true } : {}) }, { timeoutMs, browserSessionId: options.browserSessionId });
	}

	async closeTab(tabId: number | string, timeoutMs = 5_000, options: { browserSessionId?: string } = {}): Promise<BrowserBridgeExecutionResult> {
		const target = this.requireTargetRef(tabId, options.browserSessionId);
		const id = this.requireTargetTabId(target, tabId);
		const result = await this.sendCommand({ cmd: "tabs", method: "close", targetTabId: id }, { timeoutMs, tabId, browserSessionId: options.browserSessionId });
		this.deps.tabs.markTabDisconnected(id, options.browserSessionId);
		return result;
	}

	async executeJavaScript(script: string, options: ExecuteOptions = {}): Promise<BrowserBridgeExecutionResult> {
		const target = this.requireExecutionTarget(options.targetRef ?? options.tabId, options.browserSessionId);
		return this.sendPayload(script, { browserSessionId: options.browserSessionId, tabId: target.tabId, timeoutMs: options.timeoutMs, target, accessMode: options.accessMode ?? "write" });
	}

	/**
	 * Give a not-yet-connected extension a bounded grace to dial in before a command
	 * proceeds (and likely fails with the now-actionable NO_BROWSER_EXTENSION). Only
	 * waits when the bridge is up but no extension is connected for the session, so
	 * steady-state traffic pays nothing. Reused by sendCommand (the path every
	 * tab-list / native command flows through). Never throws — on timeout the call
	 * continues to the normal recovery-bearing error.
	 */
	private async ensureExtensionReady(browserSessionId?: string): Promise<void> {
		this.lastConnectionWaitMs = 0;
		if (!this.deps.isRunning()) return;
		if (this.deps.snapshot({ browserSessionId }).extensionConnected) return;
		const waitMs = extensionWaitMs();
		if (waitMs <= 0) return;
		const now = Date.now();
		if (now < this.extensionUnavailableUntil) return;
		const startedAt = Date.now();
		const ready = await this.deps.waitForExtensionReady(browserSessionId, waitMs);
		this.lastConnectionWaitMs = Date.now() - startedAt;
		this.extensionUnavailableUntil = ready ? 0 : Date.now() + EXTENSION_WAIT_NEGATIVE_CACHE_MS;
	}

	async sendCommand(command: BridgeCommand, options: ExecuteOptions = {}): Promise<BrowserBridgeExecutionResult> {
		await this.ensureExtensionReady(options.browserSessionId);
		const optionRef = options.targetRef ?? options.tabId;
		const hasOptionTabId = optionRef !== undefined;
		const hasCommandTabId = command.tabId !== undefined;
		const optionTarget = hasOptionTabId ? this.deps.tabs.resolveTargetRef(optionRef, options.browserSessionId, "explicit") : undefined;
		const commandTarget = hasCommandTabId ? this.deps.tabs.resolveTargetRef(command.tabId, options.browserSessionId, "explicit") : undefined;
		if (hasOptionTabId && !optionTarget) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId or targetRef is required", { cmd: command.cmd, tabId: optionRef, source: "options" });
		if (hasCommandTabId && !commandTarget) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid command tabId or targetRef is required", { cmd: command.cmd, tabId: command.tabId, source: "command" });
		if (optionTarget?.tabId !== undefined && commandTarget?.tabId !== undefined && optionTarget.tabId !== commandTarget.tabId) {
			throw new BrowserBridgeError("TAB_ID_CONFLICT", "Top-level targetRef/tabId conflicts with command tabId", { cmd: command.cmd, tabId: optionTarget.tabId, commandTabId: commandTarget.tabId, optionTarget, commandTarget });
		}
		const explicitTarget = optionTarget ?? commandTarget;
		const target = explicitTarget ?? this.optionalExecutionTarget(command, options.browserSessionId);
		const tabId = target?.tabId;
		const payload: BridgeCommand = tabId !== undefined ? { ...command, tabId } : command;
		const validation = validateBridgeCommand(payload, { allowMissingTabId: tabId === undefined });
		if (!validation.ok) throw new BrowserBridgeError("INVALID_BROWSER_COMMAND", validation.error, validation.details);
		if (validation.spec.internal === true && options.internal !== true) {
			throw new BrowserBridgeError("INVALID_BROWSER_COMMAND", "Bridge command is internal-only", { cmd: validation.command.cmd });
		}
		if (validation.spec.tabScoped && tabId === undefined) throw new BrowserBridgeError("NO_TAB", "No target browser tab is available", { cmd: validation.command.cmd, tabs: this.deps.getTabs() });
		const plan = this.commandExecutionPlan(validation.command, target, options.accessMode);
		const result = await this.sendPayload(validation.command, { browserSessionId: options.browserSessionId, tabId: plan.tabId, timeoutMs: options.timeoutMs, target: plan.target, accessMode: plan.accessMode });
		if (this.isCreateTabCommand(validation.canonicalCmd, validation.command)) {
			return await this.withCreatedTabTarget(result, options);
		}
		return result;
	}

	private isCreateTabCommand(canonicalCmd: string, command: BridgeCommand): boolean {
		return canonicalCmd === "tabs" && String(command.method || "list").toLowerCase() === "create";
	}

	private async withCreatedTabTarget(result: BrowserBridgeExecutionResult, options: ExecuteOptions = {}): Promise<BrowserBridgeExecutionResult> {
		const createdTabId = this.createdTabId(result);
		if (createdTabId === undefined) return result;
		// A newly created tab only becomes a live router session when the extension's ASYNC `tabs_update`
		// event arrives (chrome.tabs.onCreated -> sendTabsUpdate). Eagerly refresh (tabs.list ->
		// updateTabs) so follow-up tab-scoped calls can use the created targetRef without an extra list.
		// Best-effort: a refresh/resolution failure must not turn a successful create into a failure.
		try { await this.refreshTabs(options.timeoutMs ?? 5_000, { browserSessionId: options.browserSessionId }); } catch { /* keep the bridge create result usable by numeric tabId */ }
		return this.attachCreatedTabFields(result, createdTabId, options.browserSessionId);
	}

	private createdTabId(result: BrowserBridgeExecutionResult): number | undefined {
		const data = recordValue(result.data);
		return toTabId(data?.tabId ?? data?.id ?? result.tabId);
	}

	private attachCreatedTabFields(result: BrowserBridgeExecutionResult, tabId: number, browserSessionId: string | undefined): BrowserBridgeExecutionResult {
		const created = this.createdTabFields(tabId, browserSessionId);
		const dataRecord = recordValue(result.data);
		const data = dataRecord ? {
			...dataRecord,
			...(created.createdTarget?.targetRef ? { targetRef: created.createdTarget.targetRef } : {}),
			...(created.createdTarget?.tabHandle ? { tabHandle: created.createdTarget.tabHandle } : {}),
			...(created.createdTarget?.browserSessionId ? { browserSessionId: created.createdTarget.browserSessionId } : {}),
			...(created.createdTarget?.browserId ? { browserId: created.createdTarget.browserId } : {}),
		} : result.data;
		return {
			...result,
			data,
			...created,
		};
	}

	private createdTabFields(tabId: number, browserSessionId: string | undefined): CreatedTabFields {
		const browserSession = this.browserSession(browserSessionId);
		const fallbackTarget = this.deps.tabs.targetInfo("explicit", tabId, browserSession);
		try {
			const createdTarget = this.deps.tabs.resolveTargetRef(tabId, browserSessionId, "explicit") ?? fallbackTarget;
			const createdTab = createdTarget.targetRef
				? this.deps.getTabs().find((tab) => tab.targetRef === createdTarget.targetRef)
				: undefined;
			return {
				createdTarget,
				...(createdTab ? { createdTab } : {}),
			};
		} catch {
			return {
				createdTarget: fallbackTarget,
			};
		}
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
				const queuedAt = Date.now();
				const queueDepthAtEnqueue = this.deps.queues.depth(browserSession.id, tabId);
				return recordResult(this.deps.queues.enqueue(browserSession.id, tabId, async () => {
					const startedAt = Date.now();
					const queueDepthAtStart = this.deps.queues.depth(browserSession.id, tabId);
					const resolvedQueuedTarget = this.deps.tabs.resolveTargetRef(target.targetRef ?? target.tabHandle ?? target.tabId, browserSession.id, target.source);
					const queuedTarget = resolvedQueuedTarget ? {
						...resolvedQueuedTarget,
						...(target.requestedTabId !== undefined ? { requestedTabId: target.requestedTabId } : {}),
						...(target.replacedFrom !== undefined ? { replacedFrom: target.replacedFrom } : {}),
						...(target.replacedByTabId !== undefined ? { replacedByTabId: target.replacedByTabId } : {}),
						...(target.replacementHops !== undefined ? { replacementHops: target.replacementHops } : {}),
					} : target;
					const queuedTabId = queuedTarget.tabId ?? tabId;
					const queuedTab = this.requireLiveTabSession(queuedTabId, browserSession.id);
					this.assertWriteInvariants(browserSession.id, queuedTab, queuedTarget);
					const queuedCodeRecord = recordValue(code);
					const queuedCode = queuedTabId !== tabId && queuedCodeRecord ? { ...queuedCodeRecord, tabId: queuedTabId } : code;
					const result = await this.deps.leases.withAutoTabLease(browserSession.id, queuedTab, async () => {
						this.deps.leases.touchTabLease(browserSession.id, queuedTab);
						return await this.deps.pendingRequests.send(queuedTab.client, queuedCode, { tabId: queuedTabId, timeoutMs: options.timeoutMs, target: queuedTarget });
					});
					const completedAt = Date.now();
					const queueDelayMs = Math.max(0, startedAt - queuedAt);
					const temporalDiagnostics = queueTemporalDiagnostics({
						queueDepthAtEnqueue,
						queueDepthAtStart,
						queueDelayMs,
						deadlineMs: options.timeoutMs,
					});
					return mergeDiagnostics(result, {
						...(temporalDiagnostics.temporal ? { temporal: temporalDiagnostics.temporal } : {}),
						temporalProfile: {
							...temporalDiagnostics.temporalProfile,
							command: commandName(queuedCode),
							deadlineMs: options.timeoutMs,
							elapsedMs: Math.max(0, completedAt - queuedAt),
						},
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
			throw noBrowserExtensionError({
				port: this.deps.getPort(),
				everConnected: this.deps.clients.hasEverConnected(),
				extensionConnected: false,
				extensionWaitMs: extensionWaitMs(),
				connectionWaitMs: this.lastConnectionWaitMs,
				negativeCacheActive: Date.now() < this.extensionUnavailableUntil,
				negativeCacheRemainingMs: Math.max(0, this.extensionUnavailableUntil - Date.now()),
				browserSessionId: browserSession.id,
				sessions: this.deps.listBrowserSessions(),
			});
		}
		return this.deps.clients.requireExtensionClient();
	}

	private requireLiveTabSession(tabId: number, browserSessionId?: string): BrowserTabSession {
		const session = this.deps.tabs.liveSessionForTabId(tabId, browserSessionId);
		if (session) return session;
		const resolution = this.deps.tabs.replacementResolution(tabId, browserSessionId);
		throw tabNotFoundError({
			tabId,
			browserSessionId,
			selectedBrowser: this.deps.browserSessions.selectedInfo(this.browserSession(browserSessionId), (client) => this.deps.clients.info(client)),
			tabs: this.deps.getTabs(),
			latestTabId: this.deps.tabs.latestTabId(browserSessionId),
			replacedByTabId: resolution.tabId !== tabId ? resolution.tabId : undefined,
			replacementChainFailure: resolution.replacementChainFailure,
			replacementHops: resolution.replacementHops,
			replacementChainAge: resolution.replacementChainAge,
		});
	}

	private requireExecutionTarget(value: unknown, browserSessionId?: string): BrowserBridgeTargetInfo {
		const requested = this.deps.tabs.resolveTargetRef(value, browserSessionId, "explicit");
		if (requested) return requested;
		if (value !== undefined) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId or targetRef is required", { tabId: value, source: "options" });
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
				lease: this.deps.leases.describeTabLease(lease),
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

	private requireTargetRef(value: unknown, browserSessionId?: string): BrowserBridgeTargetInfo {
		const target = this.deps.tabs.resolveTargetRef(value, browserSessionId, "explicit");
		if (!target) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId or targetRef is required", { tabId: value });
		return target;
	}

	private requireTargetTabId(target: BrowserBridgeTargetInfo, value: unknown): number {
		if (target.tabId !== undefined) return target.tabId;
		throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId or targetRef is required", { tabId: value });
	}

	private browserSession(browserSessionId?: string): BrowserAutomationSession {
		return browserSessionId ? this.deps.browserSessions.require(browserSessionId) : this.deps.browserSessions.selectedSession();
	}
}
