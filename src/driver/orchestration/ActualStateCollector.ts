import { browserNotFound } from "./orchestrationErrors";
import { hashSensitiveString, redactedErrorDetails, stableJson } from "./orchestrationRedaction";
import type { OrchestrationStore } from "./OrchestrationStore";
import type {
	ActualCookieState,
	ActualHookState,
	ActualRecorderState,
	ActualTabState,
	BrowserOrchestrationActual,
	BrowserOrchestrationServer,
	JsonRecord,
	NormalizedBrowserOrchestrationDesired,
	NormalizedDesiredCookie,
	NormalizedDesiredSession,
	NormalizedDesiredTab,
	OrchestrationBinding,
} from "./types";
import type { BrowserBridgeSnapshot, BrowserTabInfo } from "../types";

function isRecord(value: unknown): value is JsonRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function failureData(value: unknown): { code: string; message: string; details?: JsonRecord } | undefined {
	if (!isRecord(value) || value.ok !== false) return undefined;
	return {
		code: typeof value.error_code === "string" ? value.error_code : typeof value.code === "string" ? value.code : "BROWSER_COMMAND_FAILED",
		message: typeof value.error === "string" ? value.error : typeof value.message === "string" ? value.message : "Browser command failed",
		details: isRecord(value.details) ? redactedErrorDetails(value.details) : undefined,
	};
}

function tabIsLive(tab: BrowserTabInfo): boolean {
	return !tab.disconnectedAt;
}

function tabMatchesBrowser(tab: BrowserTabInfo, browserId: string | undefined): boolean {
	if (!browserId) return true;
	return tab.browserId === browserId || tab.bridge?.extensionId === browserId || tab.bridge?.id === browserId;
}

function urlsMatch(a: string | undefined, b: string): boolean {
	if (!a) return false;
	try { return new URL(a).href === new URL(b).href; }
	catch { return a === b; }
}

function recorderSessionId(orchestrationId: string, sessionTag: string, tabRole: string, explicit: string | undefined): string {
	return explicit || `orch:${orchestrationId}:${sessionTag}:${tabRole}:network`;
}

function hookSessionId(orchestrationId: string, sessionTag: string, tabRole: string, explicit: string | undefined): string {
	return explicit || `orch:${orchestrationId}:${sessionTag}:${tabRole}:hook`;
}

export class ActualStateCollector {
	private readonly server: BrowserOrchestrationServer;
	private readonly store: OrchestrationStore;

	constructor(server: BrowserOrchestrationServer, store: OrchestrationStore) {
		this.server = server;
		this.store = store;
	}

	async collect(desired: NormalizedBrowserOrchestrationDesired, options: { timeoutMs?: number } = {}): Promise<BrowserOrchestrationActual> {
		const diagnostics: JsonRecord[] = [];
		let snapshot = this.server.snapshot();
		const targetBrowserId = this.resolveTargetBrowser(desired, snapshot);
		let tabs = snapshot.tabs || [];
		if (snapshot.running && snapshot.extensionConnected && typeof this.server.refreshTabs === "function") {
			try {
				tabs = await this.server.refreshTabs(Math.min(options.timeoutMs || 2_500, 5_000));
				snapshot = this.server.snapshot();
			} catch (error) {
				diagnostics.push({ source: "refreshTabs", error: error instanceof Error ? error.message : String(error), details: redactedErrorDetails(error) });
				tabs = snapshot.tabs || [];
			}
		}
		if (targetBrowserId && snapshot.extension?.id && snapshot.extension.id !== targetBrowserId) diagnostics.push({ source: "browser", reason: "selected_browser_differs_from_orchestration_binding", selectedBrowserId: snapshot.extension.id, targetBrowserId });
		const windows = await this.collectWindows(desired, diagnostics, options.timeoutMs);
		const tabGroups = await this.collectTabGroups(desired, diagnostics, options.timeoutMs);
		const sessions = [];
		for (const session of desired.sessions) {
			const sessionTabs: ActualTabState[] = [];
			const sessionCookies: ActualCookieState[] = [];
			for (const tab of session.tabs) {
				const actualTab = await this.collectTab(desired, session, tab, tabs, targetBrowserId, diagnostics, options.timeoutMs);
				sessionTabs.push(actualTab);
			}
			for (const cookie of session.cookies) {
				const actualCookie = await this.collectCookie(cookie, diagnostics, options.timeoutMs);
				sessionCookies.push(actualCookie);
			}
			sessions.push({ tag: session.tag, tabs: sessionTabs, cookies: sessionCookies });
		}
		return {
			observedAt: Date.now(),
			bridge: {
				running: snapshot.running,
				extensionConnected: snapshot.extensionConnected,
				selectedBrowserId: snapshot.extension?.id,
				selectedExtensionId: snapshot.extension?.extensionId,
				workerBootId: snapshot.extension?.workerBootId,
			},
			tabs,
			windows,
			tabGroups,
			sessions,
			diagnostics,
		};
	}

	private async collectWindows(desired: NormalizedBrowserOrchestrationDesired, diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<JsonRecord[] | undefined> {
		const wantsWindows = desired.sessions.some((session) => session.ownedWindow.enabled) || (this.store.get(desired.orchestrationId)?.bindings || []).some((binding) => binding.windowId !== undefined);
		if (!wantsWindows) return undefined;
		try {
			const result = await this.server.sendCommand({ cmd: "windows", method: "list", populate: true }, { timeoutMs: Math.min(timeoutMs || 2_000, 5_000) });
			const failure = failureData(result.data);
			if (failure) {
				diagnostics.push({ source: "windows.list", error: failure.message, details: failure.details });
				return undefined;
			}
			return Array.isArray(result.data) ? result.data.filter(isRecord) : undefined;
		} catch (error) {
			diagnostics.push({ source: "windows.list", error: error instanceof Error ? error.message : String(error), details: redactedErrorDetails(error) });
			return undefined;
		}
	}

	private async collectTabGroups(desired: NormalizedBrowserOrchestrationDesired, diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<JsonRecord | undefined> {
		if (!desired.sessions.some((session) => session.visualGrouping.enabled)) return undefined;
		try {
			const result = await this.server.sendCommand({ cmd: "tabGroups", method: "status" }, { timeoutMs: Math.min(timeoutMs || 2_000, 5_000) });
			const failure = failureData(result.data);
			if (failure) {
				diagnostics.push({ source: "tabGroups.status", error: failure.message, details: failure.details });
				return { tabGroupsStatus: "degraded_not_supported", supported: false, reason: failure.message };
			}
			return isRecord(result.data) ? result.data : undefined;
		} catch (error) {
			diagnostics.push({ source: "tabGroups.status", error: error instanceof Error ? error.message : String(error), details: redactedErrorDetails(error) });
			return { tabGroupsStatus: "degraded_not_supported", supported: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	private resolveTargetBrowser(desired: NormalizedBrowserOrchestrationDesired, snapshot: BrowserBridgeSnapshot): string | undefined {
		const requested = desired.browser.browserId;
		const boundBrowserIds = Array.from(new Set((this.store.get(desired.orchestrationId)?.bindings || []).map((binding) => binding.browserId).filter(Boolean)));
		if (!requested || requested === "selected") {
			if (boundBrowserIds.length === 1) return boundBrowserIds[0];
			if (desired.browser.requireSelected && !snapshot.extension?.id) throw browserNotFound("Browser orchestration requires a selected browser", { orchestrationId: desired.orchestrationId });
			return snapshot.extension?.id;
		}
		const found = snapshot.clients.find((client) => client.id === requested || client.extensionId === requested);
		if (!found) throw browserNotFound("Requested browser is not connected", { orchestrationId: desired.orchestrationId, browserId: requested, clients: snapshot.clients.map((client) => ({ id: client.id, extensionId: client.extensionId, name: client.name })) });
		return found.id;
	}

	private async collectTab(desired: NormalizedBrowserOrchestrationDesired, session: NormalizedDesiredSession, tab: NormalizedDesiredTab, tabs: BrowserTabInfo[], targetBrowserId: string | undefined, diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<ActualTabState> {
		const binding = this.store.binding(desired.orchestrationId, session.tag, tab.role);
		const liveTabs = tabs.filter((item) => tabIsLive(item) && tabMatchesBrowser(item, targetBrowserId));
		const boundTab = binding ? liveTabs.find((item) => item.tabId === binding.tabId && item.browserId === binding.browserId) : undefined;
		const candidates = !boundTab && tab.reuse === "matchingUrl" ? liveTabs.filter((item) => urlsMatch(item.url, tab.url)) : [];
		const selected = boundTab || (candidates.length === 1 ? candidates[0] : undefined);
		const urlMatchesDesired = !!selected && urlsMatch(selected.url, tab.url);
		const actual: ActualTabState = {
			sessionTag: session.tag,
			role: tab.role,
			desiredUrl: tab.url,
			tabId: selected?.tabId,
			browserId: selected?.browserId || binding?.browserId,
			windowId: selected?.windowId || binding?.windowId,
			windowOwned: binding?.windowOwned,
			windowCloseOnDelete: binding?.windowCloseOnDelete,
			groupId: selected?.groupId || binding?.groupId,
			tabGroupsStatus: binding?.tabGroupsStatus,
			exists: !!selected,
			url: selected?.url,
			active: selected?.active,
			owned: !!binding?.owned,
			createdByOrchestrator: binding?.createdByOrchestrator,
			candidateTabIds: candidates.length > 1 ? candidates.map((item) => item.tabId) : undefined,
			browserMismatch: !!binding && !!selected && binding.browserId !== selected.browserId,
			navigation: { matchesDesired: urlMatchesDesired, urlMatchesDesired },
			cookies: [],
		};
		if (!selected) return actual;
		actual.navigation = await this.collectNavigation(tab, selected, actual.navigation.urlMatchesDesired, diagnostics, timeoutMs);
		if (session.networkRecorder?.enabled) actual.networkRecorder = await this.collectNetwork(desired, session, tab, selected, diagnostics, timeoutMs);
		if (session.hookDispatcher?.enabled) actual.hookDispatcher = await this.collectHook(desired, session, tab, selected, diagnostics, timeoutMs);
		return actual;
	}

	private async collectNavigation(tab: NormalizedDesiredTab, actualTab: BrowserTabInfo, urlMatchesDesired: boolean, diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<ActualTabState["navigation"]> {
		if (tab.waitUntil === "none") return { matchesDesired: urlMatchesDesired, urlMatchesDesired, loadStateMatchesDesired: true };
		const command = tab.waitUntil === "networkIdle"
			? { cmd: "wait.networkIdle" as const, timeoutMs: 0 }
			: { cmd: "wait.loadState" as const, state: tab.waitUntil === "domcontentloaded" ? "domcontentloaded" : "complete", timeoutMs: 0 };
		try {
			const result = await this.server.sendCommand(command, { tabId: actualTab.tabId, target: { tabId: actualTab.tabId, browserId: actualTab.browserId }, timeoutMs: Math.min(timeoutMs || 1_000, 2_000) });
			const failure = failureData(result.data);
			if (failure) return { matchesDesired: false, urlMatchesDesired, loadState: command.cmd === "wait.networkIdle" ? "networkIdle" : command.state, loadStateMatchesDesired: false, error: failure.message };
			return { matchesDesired: urlMatchesDesired, urlMatchesDesired, loadState: command.cmd === "wait.networkIdle" ? "networkIdle" : command.state, loadStateMatchesDesired: true };
		} catch (error) {
			diagnostics.push({ source: command.cmd, tabId: actualTab.tabId, error: error instanceof Error ? error.message : String(error), details: redactedErrorDetails(error) });
			return { matchesDesired: false, urlMatchesDesired, loadState: command.cmd === "wait.networkIdle" ? "networkIdle" : command.state, loadStateMatchesDesired: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async collectNetwork(desired: NormalizedBrowserOrchestrationDesired, session: NormalizedDesiredSession, tab: NormalizedDesiredTab, actualTab: BrowserTabInfo, diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<ActualRecorderState> {
		const sessionId = recorderSessionId(desired.orchestrationId, session.tag, tab.role, session.networkRecorder?.sessionId);
		try {
			const result = await this.server.sendCommand({ cmd: "network.status", sessionId }, { tabId: actualTab.tabId, target: { tabId: actualTab.tabId, browserId: actualTab.browserId }, timeoutMs: Math.min(timeoutMs || 2_000, 5_000) });
			const failure = failureData(result.data);
			if (failure) return { desired: true, active: false, sessionId, error: failure.message, details: failure.details };
			const data = isRecord(result.data) ? result.data : {};
			const config = isRecord(data.config) ? data.config : undefined;
			return { desired: true, active: data.active === true, sessionId: typeof data.sessionId === "string" ? data.sessionId : sessionId, config, configHash: config ? hashSensitiveString(stableJson(config)) : undefined, details: data.active === true ? { recorderId: data.recorderId, total: data.total, config } : undefined };
		} catch (error) {
			diagnostics.push({ source: "network.status", tabId: actualTab.tabId, sessionId, error: error instanceof Error ? error.message : String(error), details: redactedErrorDetails(error) });
			return { desired: true, active: false, sessionId, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async collectHook(desired: NormalizedBrowserOrchestrationDesired, session: NormalizedDesiredSession, tab: NormalizedDesiredTab, actualTab: BrowserTabInfo, diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<ActualHookState> {
		const sessionId = hookSessionId(desired.orchestrationId, session.tag, tab.role, session.hookDispatcher?.sessionId);
		try {
			const result = await this.server.sendCommand({ cmd: "hook.status", sessionId }, { tabId: actualTab.tabId, target: { tabId: actualTab.tabId, browserId: actualTab.browserId }, timeoutMs: Math.min(timeoutMs || 2_000, 5_000) });
			const failure = failureData(result.data);
			if (failure) return { desired: true, installed: false, sessionId, error: failure.message, details: failure.details };
			const data = isRecord(result.data) ? result.data : {};
			const state = typeof data.state === "string" ? data.state : undefined;
			const installed = !!(data.session_id || data.sessionId || state) && !["CLOSED", "CREATED", "NO_SESSION"].includes(String(state || "").toUpperCase());
			return { desired: true, installed, state, sessionId: typeof data.session_id === "string" ? data.session_id : typeof data.sessionId === "string" ? data.sessionId : sessionId, installFingerprint: typeof data.install_fingerprint === "string" ? data.install_fingerprint : undefined };
		} catch (error) {
			diagnostics.push({ source: "hook.status", tabId: actualTab.tabId, sessionId, error: error instanceof Error ? error.message : String(error), details: redactedErrorDetails(error) });
			return { desired: true, installed: false, sessionId, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async collectCookie(cookie: NormalizedDesiredCookie, diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<ActualCookieState> {
		try {
			const result = await this.server.sendCommand({ cmd: "cookies", method: "get", url: cookie.url, name: cookie.name }, { timeoutMs: Math.min(timeoutMs || 2_000, 5_000) });
			const failure = failureData(result.data);
			if (failure) return { key: cookie.key, name: cookie.name, action: cookie.action, present: undefined, drift: true, error: failure.message };
			const data = result.data;
			const present = isRecord(data) && typeof data.name === "string";
			const value = isRecord(data) && typeof data.value === "string" ? data.value : undefined;
			const valueHash = value === undefined ? undefined : hashSensitiveString(value);
			const drift = cookie.action === "remove" ? present : !present || (cookie.valueHash !== undefined && valueHash !== cookie.valueHash);
			return { key: cookie.key, name: cookie.name, action: cookie.action, present, valueHash, drift };
		} catch (error) {
			diagnostics.push({ source: "cookies.get", url: cookie.url, name: cookie.name, error: error instanceof Error ? error.message : String(error), details: redactedErrorDetails(error) });
			return { key: cookie.key, name: cookie.name, action: cookie.action, present: undefined, drift: true, error: error instanceof Error ? error.message : String(error) };
		}
	}
}

export { recorderSessionId, hookSessionId };
