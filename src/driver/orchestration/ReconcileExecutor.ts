import { executeBrowserWaitWithSupervisor } from "../BrowserWaitSupervisor";
import { bridgeResultFailure } from "../bridgeUtils";
import { BrowserOrchestrationError, ORCHESTRATION_ERROR_CODES, orchestrationFailure, orchestrationTimeout } from "./orchestrationErrors";
import { hashSensitiveString, redactedErrorDetails, redactOrchestrationValue, stableJson } from "./orchestrationRedaction";
import type { OrchestrationStore } from "./OrchestrationStore";
import type { ResourceLocks } from "./ResourceLocks";
import type {
	BrowserOrchestrationApplyResult,
	BrowserOrchestrationPlan,
	BrowserOrchestrationServer,
	BrowserOrchestrationRunOptions,
	JsonRecord,
	NormalizedBrowserOrchestrationDesired,
	NormalizedDesiredCookie,
	NormalizedDesiredSession,
	NormalizedDesiredTab,
	OrchestrationBinding,
	OrchestrationFailure,
	ReconcileOperation,
	ReconcileOperationResult,
} from "./types";
import type { BrowserBridgeExecutionResult, BrowserTabInfo } from "../types";
import type { BridgeCommand } from "../../protocol/nativeProtocol";

function isRecord(value: unknown): value is JsonRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function operationResultBase(operation: ReconcileOperation): Omit<ReconcileOperationResult, "status" | "finishedAt"> {
	return {
		operationId: operation.id,
		phase: operation.phase,
		action: operation.action,
		resourceRef: operation.resourceRef,
		startedAt: Date.now(),
		reason: operation.reason,
		required: operation.required,
		redactedParams: operation.redactedParams,
	};
}

function mapWaitUntil(waitUntil: NormalizedDesiredTab["waitUntil"]): string {
	if (waitUntil === "networkIdle") return "networkidle";
	if (waitUntil === "domcontentloaded") return "domcontentloaded";
	if (waitUntil === "none") return "complete";
	return "complete";
}

function remainingMs(deadline: number): number {
	return Math.max(0, deadline - Date.now());
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactedFailure(error: unknown, operationId?: string): OrchestrationFailure {
	const failure = orchestrationFailure(error, operationId);
	return { ...failure, details: failure.details ? redactedErrorDetails(failure.details) : undefined };
}

export class ReconcileExecutor {
	private readonly server: BrowserOrchestrationServer;
	private readonly store: OrchestrationStore;
	private readonly locks: ResourceLocks;

	constructor(server: BrowserOrchestrationServer, store: OrchestrationStore, locks: ResourceLocks) {
		this.server = server;
		this.store = store;
		this.locks = locks;
	}

	async executePlan(desired: NormalizedBrowserOrchestrationDesired, plan: BrowserOrchestrationPlan, options: BrowserOrchestrationRunOptions = {}): Promise<BrowserOrchestrationApplyResult> {
		const deadline = (options.now || Date.now()) + Math.max(100, Math.floor(options.timeoutMs || desired.defaults.timeoutMs));
		const operationResults: ReconcileOperationResult[] = [];
		const failures: OrchestrationFailure[] = [];
		const failedOrSkipped = new Set<string>();
		const createdBindings: OrchestrationBinding[] = [];
		let requiredFailure = false;
		for (const operation of plan.operations) {
			if ((operation.dependsOn || []).some((id) => failedOrSkipped.has(id))) {
				failedOrSkipped.add(operation.id);
				operationResults.push({ ...operationResultBase(operation), status: "skipped", finishedAt: Date.now(), result: { skippedReason: "dependency_failed" } });
				continue;
			}
			if (remainingMs(deadline) <= 0) {
				const failure = redactedFailure(orchestrationTimeout("Browser orchestration apply timed out", { orchestrationId: desired.orchestrationId, operationId: operation.id }), operation.id);
				failures.push(failure);
				failedOrSkipped.add(operation.id);
				requiredFailure = requiredFailure || operation.required;
				operationResults.push({ ...operationResultBase(operation), status: "failed", finishedAt: Date.now(), failure });
				continue;
			}
			try {
				const result = await this.withOperationLock(operation, () => this.executeOperation(desired, operation, Math.max(100, Math.min(remainingMs(deadline), desired.defaults.timeoutMs))));
				const status = result.status === "degraded" ? "degraded" : "succeeded";
				operationResults.push({ ...operationResultBase(operation), status, finishedAt: Date.now(), result });
				if (operation.action === "createTab" || operation.action === "createWindow") {
					const binding = this.store.binding(desired.orchestrationId, operation.resourceRef.sessionTag, operation.resourceRef.tabRole);
					if (binding?.createdByOrchestrator) createdBindings.push(binding);
				}
			} catch (error) {
				const failure = redactedFailure(error, operation.id);
				failures.push(failure);
				failedOrSkipped.add(operation.id);
				requiredFailure = requiredFailure || operation.required;
				operationResults.push({ ...operationResultBase(operation), status: "failed", finishedAt: Date.now(), failure });
			}
		}
		if (requiredFailure && desired.defaults.cleanupOnFailure && createdBindings.length) {
			const cleanupResults = await this.compensateCreatedBindings(desired, createdBindings, deadline);
			operationResults.push(...cleanupResults.results);
			failures.push(...cleanupResults.failures);
		}
		const currentState = this.store.get(desired.orchestrationId);
		return {
			ok: failures.length === 0,
			action: "apply",
			orchestrationId: desired.orchestrationId,
			generation: desired.generation,
			desiredHash: desired.desiredHash,
			converged: failures.length === 0,
			bindings: currentState?.bindings || [],
			operationResults,
			failures,
			plan: { operationCount: plan.operations.length, operationsByPhase: plan.operations.reduce((acc, op) => ({ ...acc, [op.phase]: (Number(acc[op.phase]) || 0) + 1 }), {} as Record<string, number>), converged: plan.converged },
		};
	}

	async executeCleanup(orchestrationId: string, operations: ReconcileOperation[], options: BrowserOrchestrationRunOptions = {}): Promise<BrowserOrchestrationApplyResult> {
		const deadline = (options.now || Date.now()) + Math.max(100, Math.floor(options.timeoutMs || 15_000));
		const operationResults: ReconcileOperationResult[] = [];
		const failures: OrchestrationFailure[] = [];
		for (const operation of operations) {
			try {
				const result = await this.withOperationLock(operation, () => this.executeOperation(undefined, operation, Math.max(100, remainingMs(deadline))));
				operationResults.push({ ...operationResultBase(operation), status: result.status === "degraded" ? "degraded" : "succeeded", finishedAt: Date.now(), result });
			} catch (error) {
				const failure = redactedFailure(error, operation.id);
				failures.push(failure);
				operationResults.push({ ...operationResultBase(operation), status: "failed", finishedAt: Date.now(), failure });
			}
		}
		return { ok: failures.length === 0, action: "delete", orchestrationId, generation: "deleted", converged: failures.length === 0, bindings: [], operationResults, failures };
	}

	private async withOperationLock<T>(operation: ReconcileOperation, fn: () => Promise<T>): Promise<T> {
		const binding = this.store.binding(operation.resourceRef.orchestrationId, operation.resourceRef.sessionTag, operation.resourceRef.tabRole);
		const tabId = operation.resourceRef.tabId ?? binding?.tabId;
		const browserId = operation.resourceRef.browserId ?? binding?.browserId;
		const windowId = operation.resourceRef.windowId ?? binding?.windowId;
		if ((operation.phase === "window" || operation.action === "closeWindow" || operation.action === "groupTabs") && windowId && browserId) return await this.locks.runExclusive(`browser:${browserId}:window:${windowId}`, operation.id, fn);
		if (tabId && browserId) return await this.locks.runExclusive(`browser:${browserId}:tab:${tabId}`, operation.id, fn);
		if (windowId && browserId) return await this.locks.runExclusive(`browser:${browserId}:window:${windowId}`, operation.id, fn);
		return await fn();
	}

	private async executeOperation(desired: NormalizedBrowserOrchestrationDesired | undefined, operation: ReconcileOperation, timeoutMs: number): Promise<JsonRecord> {
		switch (operation.action) {
			case "createWindow": return await this.createWindow(this.requireDesired(desired), operation, timeoutMs);
			case "createTab": return await this.createTab(this.requireDesired(desired), operation, timeoutMs);
			case "reuseTab": return this.reuseTab(this.requireDesired(desired), operation);
			case "groupTabs": return await this.groupTabs(this.requireDesired(desired), operation, timeoutMs);
			case "setCookie": return await this.setCookie(this.requireDesired(desired), operation, timeoutMs);
			case "removeCookie": return await this.removeCookie(this.requireDesired(desired), operation, timeoutMs);
			case "navigate": return await this.navigate(this.requireDesired(desired), operation, timeoutMs);
			case "startNetwork": return await this.startNetwork(this.requireDesired(desired), operation, timeoutMs);
			case "installHook": return await this.installHook(this.requireDesired(desired), operation, timeoutMs);
			case "verifyStatus": return await this.verifyStatus(this.requireDesired(desired), operation, timeoutMs);
			case "stopNetwork": return await this.stopNetwork(operation, timeoutMs);
			case "uninstallHook": return await this.uninstallHook(operation, timeoutMs);
			case "closeTab": return await this.closeTab(operation, timeoutMs);
			case "closeWindow": return await this.closeWindow(operation, timeoutMs);
		}
	}

	private requireDesired(desired: NormalizedBrowserOrchestrationDesired | undefined): NormalizedBrowserOrchestrationDesired {
		if (!desired) throw new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.INVALID_DESIRED, "Operation requires desired state", {}, { retryable: false });
		return desired;
	}

	private session(desired: NormalizedBrowserOrchestrationDesired, operation: ReconcileOperation): NormalizedDesiredSession {
		const session = desired.sessions.find((item) => item.tag === operation.resourceRef.sessionTag);
		if (!session) throw new BrowserOrchestrationError("ORCHESTRATION_SESSION_NOT_FOUND", "Desired session is not found", { sessionTag: operation.resourceRef.sessionTag }, { retryable: false });
		return session;
	}

	private tab(desired: NormalizedBrowserOrchestrationDesired, operation: ReconcileOperation): NormalizedDesiredTab {
		const session = this.session(desired, operation);
		const tab = session.tabs.find((item) => item.role === operation.resourceRef.tabRole);
		if (!tab) throw new BrowserOrchestrationError("ORCHESTRATION_SESSION_NOT_FOUND", "Desired tab role is not found", { sessionTag: session.tag, tabRole: operation.resourceRef.tabRole }, { retryable: false });
		return tab;
	}

	private cookie(desired: NormalizedBrowserOrchestrationDesired, operation: ReconcileOperation): NormalizedDesiredCookie {
		const session = this.session(desired, operation);
		const cookie = session.cookies.find((item) => item.key === operation.resourceRef.cookieKey);
		if (!cookie) throw new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.INVALID_DESIRED, "Desired cookie is not found", { cookieKey: operation.resourceRef.cookieKey }, { retryable: false });
		return cookie;
	}

	private binding(operation: ReconcileOperation): OrchestrationBinding {
		const binding = this.store.binding(operation.resourceRef.orchestrationId, operation.resourceRef.sessionTag, operation.resourceRef.tabRole);
		if (!binding) throw new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.TARGET_CONFLICT, "Operation has no tab binding", { resourceRef: operation.resourceRef }, { retryable: true });
		return binding;
	}

	private sessionOwnedWindowBinding(orchestrationId: string, sessionTag: string): OrchestrationBinding | undefined {
		return this.store.get(orchestrationId)?.bindings.find((binding) => binding.sessionTag === sessionTag && binding.windowOwned && binding.windowId !== undefined);
	}

	private async createWindow(desired: NormalizedBrowserOrchestrationDesired, operation: ReconcileOperation, timeoutMs: number): Promise<JsonRecord> {
		this.selectDesiredBrowser(desired, operation.resourceRef.browserId);
		const session = this.session(desired, operation);
		const tab = this.tab(desired, operation);
		const command: BridgeCommand = { cmd: "windows", method: "create", url: tab.url, focused: session.ownedWindow.focused, state: session.ownedWindow.state, left: session.ownedWindow.left, top: session.ownedWindow.top, width: session.ownedWindow.width, height: session.ownedWindow.height };
		const result = await this.assertCommand(await this.server.sendCommand(command, { timeoutMs }), "windows.create");
		const data = isRecord(result.data) ? result.data : {};
		const tabs = Array.isArray(data.tabs) ? data.tabs.filter(isRecord) : [];
		const firstTab = tabs[0] || {};
		const syntheticResult = { ...result, data: { ...data, id: firstTab.id ?? firstTab.tabId, tabId: firstTab.tabId ?? firstTab.id, url: firstTab.url ?? tab.url, windowId: data.windowId ?? data.id, groupId: firstTab.groupId } };
		const created = await this.resolveCreatedTab(syntheticResult, tab.url, timeoutMs);
		if (!created?.tabId || !created.browserId || !created.windowId) throw new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.TARGET_CONFLICT, "Created window tab could not be resolved", { url: tab.url, result: redactOrchestrationValue(result) as JsonRecord }, { retryable: true });
		this.store.setBinding(desired.orchestrationId, { sessionTag: operation.resourceRef.sessionTag, tabRole: operation.resourceRef.tabRole, browserId: created.browserId, tabId: created.tabId, windowId: created.windowId, windowOwned: true, windowCloseOnDelete: session.ownedWindow.closeOnDelete, groupId: created.groupId, owned: true, desiredUrl: tab.url, createdByOrchestrator: true, createdAt: Date.now(), updatedAt: Date.now(), workerBootId: this.server.snapshot().extension?.workerBootId });
		return { tabId: created.tabId, browserId: created.browserId, windowId: created.windowId, windowOwned: true, owned: true, url: created.url };
	}

	private async createTab(desired: NormalizedBrowserOrchestrationDesired, operation: ReconcileOperation, timeoutMs: number): Promise<JsonRecord> {
		this.selectDesiredBrowser(desired, operation.resourceRef.browserId);
		const session = this.session(desired, operation);
		const tab = this.tab(desired, operation);
		const windowBinding = this.sessionOwnedWindowBinding(desired.orchestrationId, session.tag);
		const windowId = operation.resourceRef.windowId || windowBinding?.windowId;
		const result = await this.assertCommand(windowId
			? await this.server.sendCommand({ cmd: "tabs", method: "create", url: tab.url, active: tab.active, windowId }, { timeoutMs })
			: await this.server.createTab(tab.url, tab.active, timeoutMs), "tabs.create");
		const created = await this.resolveCreatedTab(result, tab.url, timeoutMs);
		if (!created?.tabId || !created.browserId) throw new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.TARGET_CONFLICT, "Created tab could not be resolved", { url: tab.url, result: redactOrchestrationValue(result) as JsonRecord }, { retryable: true });
		this.store.setBinding(desired.orchestrationId, { sessionTag: operation.resourceRef.sessionTag, tabRole: operation.resourceRef.tabRole, browserId: created.browserId, tabId: created.tabId, windowId: created.windowId || windowId, windowOwned: windowBinding?.windowOwned, windowCloseOnDelete: windowBinding?.windowCloseOnDelete, groupId: created.groupId, owned: true, desiredUrl: tab.url, createdByOrchestrator: true, createdAt: Date.now(), updatedAt: Date.now(), workerBootId: this.server.snapshot().extension?.workerBootId });
		return { tabId: created.tabId, browserId: created.browserId, windowId: created.windowId || windowId, owned: true, url: created.url };
	}

	private reuseTab(desired: NormalizedBrowserOrchestrationDesired, operation: ReconcileOperation): JsonRecord {
		const tab = this.tab(desired, operation);
		const tabId = operation.resourceRef.tabId;
		const browserId = operation.resourceRef.browserId;
		if (!tabId || !browserId) throw new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.TARGET_CONFLICT, "reuseTab operation is missing tabId/browserId", { resourceRef: operation.resourceRef }, { retryable: false });
		this.store.setBinding(desired.orchestrationId, { sessionTag: operation.resourceRef.sessionTag, tabRole: operation.resourceRef.tabRole, browserId, tabId, windowId: operation.resourceRef.windowId, groupId: operation.resourceRef.groupId, windowOwned: false, owned: false, desiredUrl: tab.url, createdByOrchestrator: false, createdAt: Date.now(), updatedAt: Date.now(), workerBootId: this.server.snapshot().extension?.workerBootId });
		return { tabId, browserId, windowId: operation.resourceRef.windowId, groupId: operation.resourceRef.groupId, owned: false, url: tab.url };
	}

	private async groupTabs(desired: NormalizedBrowserOrchestrationDesired, operation: ReconcileOperation, timeoutMs: number): Promise<JsonRecord> {
		const session = this.session(desired, operation);
		const bindings = session.tabs
			.map((tab) => this.store.binding(desired.orchestrationId, session.tag, tab.role))
			.filter((binding): binding is OrchestrationBinding => !!binding);
		const tabIds = bindings.map((binding) => binding.tabId).filter((tabId) => Number.isInteger(tabId) && tabId > 0);
		if (!tabIds.length) return { status: "degraded", tabGroupsStatus: "degraded_operation_failed", reason: "no_bound_tabs_for_grouping" };
		const windowId = bindings.find((binding) => binding.windowId)?.windowId;
		const groupResult = await this.assertCommand(await this.server.sendCommand({ cmd: "tabGroups", method: "group", tabIds, windowId }, { timeoutMs }), "tabGroups.group");
		const groupData = isRecord(groupResult.data) ? groupResult.data : {};
		const tabGroupsStatus = String(groupData.tabGroupsStatus || "available") as OrchestrationBinding["tabGroupsStatus"];
		if (tabGroupsStatus !== "available") {
			for (const binding of bindings) this.store.setBinding(desired.orchestrationId, { ...binding, tabGroupsStatus });
			return { status: "degraded", tabGroupsStatus, tabIds, reason: groupData.reason || groupData.error || "tabGroups unavailable" };
		}
		const groupId = Number(groupData.groupId || operation.resourceRef.groupId || 0) || undefined;
		let updatedGroup: JsonRecord | undefined;
		if (groupId && (session.visualGrouping.title !== undefined || session.visualGrouping.color !== undefined || session.visualGrouping.collapsed !== undefined)) {
			const updateResult = await this.assertCommand(await this.server.sendCommand({ cmd: "tabGroups", method: "update", tabGroupId: groupId, title: session.visualGrouping.title, color: session.visualGrouping.color, collapsed: session.visualGrouping.collapsed }, { timeoutMs }), "tabGroups.update");
			const updateData = isRecord(updateResult.data) ? updateResult.data : {};
			const updateStatus = String(updateData.tabGroupsStatus || "available") as OrchestrationBinding["tabGroupsStatus"];
			if (updateStatus !== "available") {
				for (const binding of bindings) this.store.setBinding(desired.orchestrationId, { ...binding, groupId, tabGroupsStatus: updateStatus });
				return { status: "degraded", tabGroupsStatus: updateStatus, groupId, tabIds, reason: updateData.reason || updateData.error || "tabGroups update unavailable" };
			}
			updatedGroup = isRecord(updateData.group) ? updateData.group : undefined;
		}
		for (const binding of bindings) this.store.setBinding(desired.orchestrationId, { ...binding, groupId, tabGroupsStatus: "available" });
		return { tabGroupsStatus: "available", groupId, tabIds, group: updatedGroup };
	}

	private async setCookie(desired: NormalizedBrowserOrchestrationDesired, operation: ReconcileOperation, timeoutMs: number): Promise<JsonRecord> {
		const cookie = this.cookie(desired, operation);
		if (cookie.value === undefined) throw new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.INVALID_DESIRED, "setCookie requires a raw cookie value during apply", { cookieKey: cookie.key, name: cookie.name }, { retryable: false });
		const command: BridgeCommand = { cmd: "cookies", method: "set", url: cookie.url, name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, storeId: cookie.storeId, partitionKey: cookie.partitionKey, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, expirationDate: cookie.expirationDate };
		await this.assertCommand(await this.server.sendCommand(command, { timeoutMs }), "cookies.set");
		return { url: cookie.url, name: cookie.name, set: true, valueHash: cookie.valueHash, valueLength: cookie.value.length };
	}

	private async removeCookie(desired: NormalizedBrowserOrchestrationDesired, operation: ReconcileOperation, timeoutMs: number): Promise<JsonRecord> {
		const cookie = this.cookie(desired, operation);
		const command: BridgeCommand = { cmd: "cookies", method: "remove", url: cookie.url, name: cookie.name, storeId: cookie.storeId };
		await this.assertCommand(await this.server.sendCommand(command, { timeoutMs }), "cookies.remove");
		return { url: cookie.url, name: cookie.name, removed: true };
	}

	private async navigate(desired: NormalizedBrowserOrchestrationDesired, operation: ReconcileOperation, timeoutMs: number): Promise<JsonRecord> {
		const tab = this.tab(desired, operation);
		const binding = this.binding(operation);
		const waitUntil = mapWaitUntil(tab.waitUntil);
		const result = await this.assertCommand(await executeBrowserWaitWithSupervisor(this.server, { cmd: "wait.navigateAndWait", url: tab.url, waitUntil, timeoutMs: Math.min(timeoutMs, desired.defaults.navigationTimeoutMs) }, { tabId: binding.tabId, target: { tabId: binding.tabId, browserId: binding.browserId }, timeoutMs: Math.min(timeoutMs, desired.defaults.navigationTimeoutMs) }), "wait.navigateAndWait");
		const data = isRecord(result.data) ? result.data : {};
		this.assertNestedCommand(data.navigation, "wait.navigate");
		this.assertNestedCommand(data.wait, "wait." + waitUntil);
		return { tabId: binding.tabId, url: tab.url, waitUntil };
	}

	private async startNetwork(desired: NormalizedBrowserOrchestrationDesired, operation: ReconcileOperation, timeoutMs: number): Promise<JsonRecord> {
		const session = this.session(desired, operation);
		const binding = this.binding(operation);
		const sessionId = operation.resourceRef.sessionId || `orch:${desired.orchestrationId}:${operation.resourceRef.sessionTag}:${operation.resourceRef.tabRole}:network`;
		await this.assertCommand(await this.server.sendCommand({ ...(session.networkRecorder?.config || {}), cmd: "network.start", sessionId, reconfigure: true }, { tabId: binding.tabId, target: { tabId: binding.tabId, browserId: binding.browserId }, timeoutMs }), "network.start");
		const networkConfigHash = hashSensitiveString(stableJson(session.networkRecorder?.config || {}));
		this.store.setBinding(desired.orchestrationId, { ...binding, networkSessionId: sessionId, networkConfigHash, workerBootId: this.server.snapshot().extension?.workerBootId });
		return { tabId: binding.tabId, sessionId, active: true, configHash: networkConfigHash };
	}

	private async installHook(desired: NormalizedBrowserOrchestrationDesired, operation: ReconcileOperation, timeoutMs: number): Promise<JsonRecord> {
		const session = this.session(desired, operation);
		const binding = this.binding(operation);
		const hook = session.hookDispatcher;
		const sessionId = operation.resourceRef.sessionId || `orch:${desired.orchestrationId}:${operation.resourceRef.sessionTag}:${operation.resourceRef.tabRole}:hook`;
		await this.assertCommand(await this.server.sendCommand({ cmd: "hook.install", sessionId, targets: hook?.targets, options: hook?.options, buffer_size: hook?.bufferSize, force: hook?.force, expectedVersion: hook?.expectedVersion, installFingerprint: hook?.installFingerprint }, { tabId: binding.tabId, target: { tabId: binding.tabId, browserId: binding.browserId }, timeoutMs }), "hook.install");
		this.store.setBinding(desired.orchestrationId, { ...binding, hookSessionId: sessionId, hookFingerprint: hook?.installFingerprint, workerBootId: this.server.snapshot().extension?.workerBootId });
		return { tabId: binding.tabId, sessionId, installed: true };
	}

	private async verifyStatus(desired: NormalizedBrowserOrchestrationDesired, operation: ReconcileOperation, timeoutMs: number): Promise<JsonRecord> {
		const tab = this.tab(desired, operation);
		const binding = this.binding(operation);
		const tabs = await this.refreshTabs(timeoutMs);
		const current = tabs.find((item) => item.tabId === binding.tabId && item.browserId === binding.browserId && !item.disconnectedAt);
		if (!current) throw new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.TARGET_CONFLICT, "Bound tab is missing during verify", { tabId: binding.tabId, browserId: binding.browserId }, { retryable: true });
		if (tab.waitUntil !== "none") {
			const command: BridgeCommand = tab.waitUntil === "networkIdle"
				? { cmd: "wait.networkIdle", timeoutMs: Math.min(timeoutMs, desired.defaults.navigationTimeoutMs) }
				: { cmd: "wait.loadState", state: mapWaitUntil(tab.waitUntil), timeoutMs: Math.min(timeoutMs, desired.defaults.navigationTimeoutMs) };
			await this.assertCommand(await this.server.sendCommand(command, { tabId: binding.tabId, target: { tabId: binding.tabId, browserId: binding.browserId }, timeoutMs: Math.min(timeoutMs, desired.defaults.navigationTimeoutMs) }), command.cmd);
		}
		if (current.windowId !== binding.windowId || current.groupId !== binding.groupId) this.store.setBinding(desired.orchestrationId, { ...binding, windowId: current.windowId || binding.windowId, groupId: current.groupId || binding.groupId });
		return { tabId: binding.tabId, browserId: binding.browserId, windowId: current.windowId || binding.windowId, groupId: current.groupId || binding.groupId, url: current.url, waitUntil: tab.waitUntil };
	}

	private async stopNetwork(operation: ReconcileOperation, timeoutMs: number): Promise<JsonRecord> {
		const binding = this.binding(operation);
		const sessionId = operation.resourceRef.sessionId || binding.networkSessionId;
		if (!sessionId) return { skipped: true, reason: "no_network_session" };
		try {
			await this.assertCommand(await this.server.sendCommand({ cmd: "network.stop", sessionId, keepBuffer: false, remove: true, reason: "orchestration_cleanup" }, { tabId: binding.tabId, target: { tabId: binding.tabId, browserId: binding.browserId }, timeoutMs }), "network.stop");
		} catch (error) {
			const failure = redactedFailure(error, operation.id);
			if (!/NETWORK_RECORDER_NOT_STARTED|NO_SESSION|NOT_STARTED/i.test(failure.code + failure.message)) throw error;
		}
		this.store.setBinding(operation.resourceRef.orchestrationId, { ...binding, networkSessionId: undefined });
		return { tabId: binding.tabId, sessionId, stopped: true };
	}

	private async uninstallHook(operation: ReconcileOperation, timeoutMs: number): Promise<JsonRecord> {
		const binding = this.binding(operation);
		const sessionId = operation.resourceRef.sessionId || binding.hookSessionId;
		if (!sessionId) return { skipped: true, reason: "no_hook_session" };
		try {
			await this.assertCommand(await this.server.sendCommand({ cmd: "hook.uninstall", sessionId }, { tabId: binding.tabId, target: { tabId: binding.tabId, browserId: binding.browserId }, timeoutMs }), "hook.uninstall");
		} catch (error) {
			const failure = redactedFailure(error, operation.id);
			if (!/NO_SESSION|NOT_INSTALLED|INVALID_SESSION/i.test(failure.code + failure.message)) throw error;
		}
		this.store.setBinding(operation.resourceRef.orchestrationId, { ...binding, hookSessionId: undefined, hookFingerprint: undefined });
		return { tabId: binding.tabId, sessionId, uninstalled: true };
	}

	private async closeTab(operation: ReconcileOperation, timeoutMs: number): Promise<JsonRecord> {
		const binding = this.binding(operation);
		if (!binding.owned && operation.required !== false) throw new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.TARGET_CONFLICT, "Refusing to close a non-owned tab", { tabId: binding.tabId, browserId: binding.browserId }, { retryable: false });
		await this.assertCommand(await this.server.closeTab(binding.tabId, timeoutMs, { browserId: binding.browserId }), "tabs.close");
		this.store.removeBinding(operation.resourceRef.orchestrationId, operation.resourceRef.sessionTag, operation.resourceRef.tabRole);
		return { tabId: binding.tabId, browserId: binding.browserId, windowId: binding.windowId, closed: true };
	}

	private async closeWindow(operation: ReconcileOperation, timeoutMs: number): Promise<JsonRecord> {
		const binding = this.binding(operation);
		const windowId = operation.resourceRef.windowId || binding.windowId;
		if (!windowId) return { skipped: true, reason: "no_window_id" };
		if (!binding.windowOwned && operation.required !== false) throw new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.WINDOW_OWNERSHIP_REQUIRED, "Refusing to close a non-owned window", { windowId, tabId: binding.tabId, browserId: binding.browserId }, { retryable: false });
		await this.assertCommand(await this.server.sendCommand({ cmd: "windows", method: "close", windowId }, { timeoutMs }), "windows.close");
		const state = this.store.get(operation.resourceRef.orchestrationId);
		for (const item of state?.bindings || []) {
			if (item.windowId === windowId && item.browserId === binding.browserId) this.store.removeBinding(operation.resourceRef.orchestrationId, item.sessionTag, item.tabRole);
		}
		return { windowId, browserId: binding.browserId, closed: true };
	}

	private selectDesiredBrowser(desired: NormalizedBrowserOrchestrationDesired, operationBrowserId?: string): void {
		const browserId = operationBrowserId || desired.browser.browserId;
		if (browserId && browserId !== "selected" && typeof this.server.selectBrowser === "function") this.server.selectBrowser(browserId);
	}

	private async resolveCreatedTab(result: BrowserBridgeExecutionResult, url: string, timeoutMs: number): Promise<BrowserTabInfo | undefined> {
		const data = isRecord(result.data) ? result.data : {};
		const candidates: unknown[] = [data, ...(Array.isArray(result.newTabs) ? result.newTabs : [])];
		const candidateRecords = candidates.filter(isRecord);
		const candidateIds = candidateRecords
			.map((item) => Number(item.tabId ?? item.id))
			.filter((tabId) => Number.isInteger(tabId) && tabId > 0);
		const urlMatches = (tabUrl: string) => tabUrl === url || (() => { try { return new URL(tabUrl).href === new URL(url).href; } catch { return false; } })();
		const deadline = Date.now() + Math.max(250, Math.min(timeoutMs, 2_000));
		let tabs: BrowserTabInfo[] = [];
		do {
			tabs = await this.refreshTabs(Math.max(100, Math.min(timeoutMs, remainingMs(deadline) || 100))).catch(() => []);
			const byId = tabs.find((tab) => candidateIds.includes(tab.tabId) && !tab.disconnectedAt);
			if (byId) return byId;
			const byUrl = tabs.filter((tab) => !tab.disconnectedAt).reverse().find((tab) => urlMatches(tab.url));
			if (byUrl && candidateIds.length === 0) return byUrl;
			if (Date.now() < deadline) await sleep(100);
		} while (Date.now() < deadline);
		const fallbackRecord = candidateRecords.find((item) => candidateIds.includes(Number(item.tabId ?? item.id)));
		if (fallbackRecord) {
			const tabId = Number(fallbackRecord.tabId ?? fallbackRecord.id);
			const snapshotBrowserId = this.server.snapshot().extension?.id;
			const windowId = Number(fallbackRecord.windowId || 0) || undefined;
			const groupId = Number(fallbackRecord.groupId || 0) || undefined;
			return { tabId, browserId: String(fallbackRecord.browserId || snapshotBrowserId || ""), windowId, groupId, url: String(fallbackRecord.url || url), title: String(fallbackRecord.title || ""), type: "ext_ws", connectedAt: Date.now() };
		}
		return tabs.filter((tab) => !tab.disconnectedAt).reverse().find((tab) => urlMatches(tab.url));
	}

	private async refreshTabs(timeoutMs: number): Promise<BrowserTabInfo[]> {
		if (typeof this.server.refreshTabs === "function") return await this.server.refreshTabs(Math.min(timeoutMs, 5_000));
		return typeof this.server.getTabs === "function" ? this.server.getTabs({ includeDisconnected: true }) : this.server.snapshot().tabs;
	}

	private async assertCommand(result: BrowserBridgeExecutionResult, command: string): Promise<BrowserBridgeExecutionResult> {
		const failure = bridgeResultFailure(result.data);
		if (failure) throw new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.COMMAND_FAILED, failure.message, { command, ...redactedErrorDetails(failure.details) }, { retryable: false });
		return result;
	}

	private assertNestedCommand(data: unknown, command: string): void {
		const failure = bridgeResultFailure(data);
		if (failure) throw new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.COMMAND_FAILED, failure.message, { command, ...redactedErrorDetails(failure.details) }, { retryable: false });
	}

	private async compensateCreatedBindings(desired: NormalizedBrowserOrchestrationDesired, bindings: OrchestrationBinding[], deadline: number): Promise<{ results: ReconcileOperationResult[]; failures: OrchestrationFailure[] }> {
		const results: ReconcileOperationResult[] = [];
		const failures: OrchestrationFailure[] = [];
		let seq = 0;
		const closedWindows = new Set<string>();
		for (const binding of bindings) {
			const closeWindow = binding.windowOwned && binding.windowCloseOnDelete !== false && binding.windowId !== undefined;
			const windowKey = closeWindow ? `${binding.browserId}:${binding.windowId}` : undefined;
			if (windowKey && closedWindows.has(windowKey)) continue;
			if (windowKey) closedWindows.add(windowKey);
			const action: ReconcileOperation["action"] = closeWindow ? "closeWindow" : "closeTab";
			const operation: ReconcileOperation = {
				id: `cleanup-${++seq}-${action}`,
				phase: "cleanup",
				action,
				resourceRef: { orchestrationId: desired.orchestrationId, sessionTag: binding.sessionTag, tabRole: binding.tabRole, tabId: binding.tabId, browserId: binding.browserId, windowId: binding.windowId },
				reason: closeWindow ? "cleanup newly created owned window after required operation failure" : "cleanup newly created owned tab after required operation failure",
				idempotencyKey: `${desired.orchestrationId}:${binding.sessionTag}:${binding.tabRole}:cleanup:${action}:${binding.windowId || binding.tabId}`,
				required: false,
				redactedParams: { tabId: binding.tabId, browserId: binding.browserId, windowId: binding.windowId, windowOwned: binding.windowOwned, owned: binding.owned },
			};
			try {
				const result = closeWindow ? await this.closeWindow(operation, Math.max(100, remainingMs(deadline))) : await this.closeTab(operation, Math.max(100, remainingMs(deadline)));
				results.push({ ...operationResultBase(operation), status: "succeeded", finishedAt: Date.now(), result });
			} catch (error) {
				const failure = redactedFailure(error, operation.id);
				failures.push(failure);
				results.push({ ...operationResultBase(operation), status: "failed", finishedAt: Date.now(), failure });
			}
		}
		return { results, failures };
	}
}
