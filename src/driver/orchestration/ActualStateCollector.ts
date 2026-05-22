import { browserNotFound } from "./orchestrationErrors";
import { preNavigationHookAppliesToTab, preNavigationHookKey, resolvePreNavigationHook } from "./preNavigationHooks";
import { hashSensitiveString, redactedErrorDetails, stableJson } from "./orchestrationRedaction";
import type { OrchestrationStore } from "./OrchestrationStore";
import type {
	ActualCookieState,
	ActualHookState,
	ActualPreNavigationHookState,
	ActualRecorderState,
	ActualSessionAssertionState,
	ActualSessionAssertionsState,
	ActualSessionState,
	ActualTabState,
	BrowserOrchestrationActual,
	BrowserOrchestrationServer,
	JsonRecord,
	NormalizedBrowserOrchestrationDesired,
	NormalizedDesiredCookie,
	NormalizedDesiredSession,
	NormalizedDesiredTab,
	NormalizedPreNavigationHookMetadata,
	NormalizedSessionAssertion,
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

function runtimeExceptionMessage(data: JsonRecord): string | undefined {
	const exceptionDetails = data.exceptionDetails;
	if (!isRecord(exceptionDetails)) return undefined;
	const exception = isRecord(exceptionDetails.exception) ? exceptionDetails.exception : undefined;
	return typeof exception?.description === "string" ? exception.description : typeof exceptionDetails.text === "string" ? exceptionDetails.text : "Runtime.evaluate failed";
}

function tabIsLive(tab: BrowserTabInfo): boolean {
	return !tab.disconnectedAt;
}

function tabMatchesBrowser(tab: BrowserTabInfo, browserId: string | undefined): boolean {
	if (!browserId) return true;
	return tab.browserId === browserId || tab.bridge?.extensionId === browserId || tab.bridge?.id === browserId;
}

function tabMatchesProfile(tab: BrowserTabInfo, profileId: string | undefined): boolean {
	return !profileId || tab.profileId === profileId || tab.bridge?.profileId === profileId;
}

function tabMatchesBinding(tab: BrowserTabInfo, binding: OrchestrationBinding): boolean {
	if (tab.tabId !== binding.tabId) return false;
	if (tab.browserId === binding.browserId) return true;
	return !!binding.browserExtensionId && tab.bridge?.extensionId === binding.browserExtensionId;
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
		if (targetBrowserId && typeof this.server.selectBrowser === "function") {
			try { this.server.selectBrowser(targetBrowserId); snapshot = this.server.snapshot(); }
			catch (error) { diagnostics.push({ source: "browser.select", error: error instanceof Error ? error.message : String(error), details: redactedErrorDetails(error) }); }
		}
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
		const profiles = Array.isArray(snapshot.profiles) ? snapshot.profiles.filter(isRecord) : [];
		const sessions: ActualSessionState[] = [];
		for (const session of desired.sessions) {
			const sessionTabs: ActualTabState[] = [];
			const sessionCookies: ActualCookieState[] = [];
			for (const tab of session.tabs) {
				const actualTab = await this.collectTab(desired, session, tab, tabs, targetBrowserId, diagnostics, options.timeoutMs);
				sessionTabs.push(actualTab);
			}
			for (const cookie of session.cookies) {
				const actualCookie = await this.collectCookie(desired, cookie, diagnostics, options.timeoutMs);
				sessionCookies.push(actualCookie);
			}
			const sessionAssertions = session.sessionAssertions ? await this.collectSessionAssertions(desired, session, sessionTabs, profiles, diagnostics, options.timeoutMs) : undefined;
			sessions.push({ tag: session.tag, tabs: sessionTabs, cookies: sessionCookies, sessionAssertions });
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
			profiles,
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
		if (desired.isolation.scope === "profile") {
			const profileId = desired.isolation.profile?.profileId;
			const found = snapshot.clients.find((client) => client.profileId === profileId);
			return found?.id;
		}
		const requested = desired.browser.browserId;
		const boundBrowserIds = Array.from(new Set((this.store.get(desired.orchestrationId)?.bindings || []).map((binding) => binding.browserExtensionId || binding.browserId).filter(Boolean)));
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
		const liveTabs = tabs.filter((item) => tabIsLive(item) && tabMatchesBrowser(item, targetBrowserId) && tabMatchesProfile(item, desired.isolation.profile?.profileId));
		const boundTab = binding ? liveTabs.find((item) => tabMatchesBinding(item, binding)) : undefined;
		const candidates = !boundTab && tab.reuse === "matchingUrl" ? liveTabs.filter((item) => urlsMatch(item.url, tab.url)) : [];
		const selected = boundTab || (candidates.length === 1 ? candidates[0] : undefined);
		const urlMatchesDesired = !!selected && urlsMatch(selected.url, tab.url);
		const actual: ActualTabState = {
			sessionTag: session.tag,
			role: tab.role,
			desiredUrl: tab.url,
			tabId: selected?.tabId,
			browserId: selected?.browserId || binding?.browserId,
			browserExtensionId: selected?.bridge?.extensionId || binding?.browserExtensionId,
			windowId: selected?.windowId || binding?.windowId,
			windowOwned: binding?.windowOwned,
			windowCloseOnDelete: binding?.windowCloseOnDelete,
			groupId: selected?.groupId || binding?.groupId,
			profileId: selected?.profileId || binding?.profileId,
			tabGroupsStatus: binding?.tabGroupsStatus,
			exists: !!selected,
			url: selected?.url,
			active: selected?.active,
			owned: !!binding?.owned,
			createdByOrchestrator: binding?.createdByOrchestrator,
			candidateTabIds: candidates.length > 1 ? candidates.map((item) => item.tabId) : undefined,
			browserMismatch: !!binding && !!selected && !tabMatchesBinding(selected, binding),
			navigation: { matchesDesired: urlMatchesDesired, urlMatchesDesired },
			cookies: [],
		};
		if (!selected) return actual;
		actual.navigation = await this.collectNavigation(tab, selected, actual.navigation.urlMatchesDesired, diagnostics, timeoutMs);
		if (session.networkRecorder?.enabled) actual.networkRecorder = await this.collectNetwork(desired, session, tab, selected, diagnostics, timeoutMs);
		const desiredPreNavigationHooks = session.preNavigationHooks.filter((hook) => preNavigationHookAppliesToTab(hook, tab));
		if (desiredPreNavigationHooks.length) actual.preNavigationHooks = await this.collectPreNavigationHooks(desired, session, tab, selected, binding, desiredPreNavigationHooks, diagnostics, timeoutMs);
		if (session.hookDispatcher?.enabled) actual.hookDispatcher = await this.collectHook(desired, session, tab, selected, diagnostics, timeoutMs);
		return actual;
	}

	private async collectNavigation(tab: NormalizedDesiredTab, actualTab: BrowserTabInfo, urlMatchesDesired: boolean, diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<ActualTabState["navigation"]> {
		if (tab.waitUntil === "none") return { matchesDesired: urlMatchesDesired, urlMatchesDesired, loadStateMatchesDesired: true };
		const waitTimeoutMs = Math.min(Math.max(250, Math.floor((timeoutMs || 1_000) / 4)), 1_000);
		const command = tab.waitUntil === "networkIdle"
			? { cmd: "wait.networkIdle" as const, timeoutMs: waitTimeoutMs }
			: { cmd: "wait.loadState" as const, state: tab.waitUntil === "domcontentloaded" ? "domcontentloaded" : "complete", timeoutMs: waitTimeoutMs };
		try {
			const result = await this.server.sendCommand(command, { tabId: actualTab.tabId, target: { tabId: actualTab.tabId, browserId: actualTab.browserId }, timeoutMs: waitTimeoutMs });
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

	private async collectPreNavigationHooks(desired: NormalizedBrowserOrchestrationDesired, session: NormalizedDesiredSession, tab: NormalizedDesiredTab, actualTab: BrowserTabInfo, binding: OrchestrationBinding | undefined, hooks: NormalizedPreNavigationHookMetadata[], diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<ActualPreNavigationHookState[]> {
		let scripts: JsonRecord[] = [];
		try {
			const result = await this.server.sendCommand({ cmd: "persistent_cdp", action: "listNewDocumentScripts", name: "new_document" }, { tabId: actualTab.tabId, target: { tabId: actualTab.tabId, browserId: actualTab.browserId }, timeoutMs: Math.min(timeoutMs || 2_000, 5_000) });
			const failure = failureData(result.data);
			if (failure) diagnostics.push({ source: "persistent_cdp.listNewDocumentScripts", tabId: actualTab.tabId, error: failure.message, details: failure.details });
			else {
				const data = isRecord(result.data) ? result.data : {};
				scripts = Array.isArray(data.scripts) ? data.scripts.filter(isRecord) : [];
			}
		} catch (error) {
			diagnostics.push({ source: "persistent_cdp.listNewDocumentScripts", tabId: actualTab.tabId, error: error instanceof Error ? error.message : String(error), details: redactedErrorDetails(error) });
		}
		return await Promise.all(hooks.map(async (hook): Promise<ActualPreNavigationHookState> => {
			const registration = binding?.preNavigationHooks?.find((item) => preNavigationHookKey(item) === preNavigationHookKey(hook));
			const script = registration ? scripts.find((item) => item.identifier === registration.identifier) : undefined;
			const stale = !!registration && (!script || (!!registration.workerBootId && !!desired && registration.workerBootId !== this.server.snapshot().extension?.workerBootId));
			const effect = registration && !stale ? await this.evaluatePreNavigationHookEffect(actualTab, hook, timeoutMs, diagnostics) : { active: false };
			return { desired: true, hookId: hook.hookId, version: hook.version, hash: hook.hash, registered: !!registration && !!script && !stale, identifier: registration?.identifier, sessionKey: registration?.sessionKey, cdpSessionName: registration?.cdpSessionName, workerBootId: registration?.workerBootId, stale, effectActive: effect.active, error: effect.error };
		}));
	}

	private async evaluatePreNavigationHookEffect(actualTab: BrowserTabInfo, hook: NormalizedPreNavigationHookMetadata, timeoutMs: number | undefined, diagnostics: JsonRecord[]): Promise<{ active: boolean; error?: string }> {
		try {
			const entry = resolvePreNavigationHook(hook);
			const result = await this.server.sendCommand({ cmd: "persistent_cdp", action: "send", cdpMethod: "Runtime.evaluate", params: { expression: entry.effectExpression, returnByValue: true, awaitPromise: true }, persistent: true, name: "new_document", timeoutMs: Math.min(timeoutMs || 2_000, 5_000) }, { tabId: actualTab.tabId, target: { tabId: actualTab.tabId, browserId: actualTab.browserId }, timeoutMs: Math.min(timeoutMs || 2_000, 5_000) });
			const failure = failureData(result.data);
			if (failure) return { active: false, error: failure.message };
			const data = isRecord(result.data) ? result.data : {};
			const cdpResult = isRecord(data.result) ? data.result : data;
			const value = isRecord(cdpResult.result) ? cdpResult.result.value : undefined;
			return { active: value === true };
		} catch (error) {
			diagnostics.push({ source: "persistent_cdp.Runtime.evaluate", tabId: actualTab.tabId, hookId: hook.hookId, error: error instanceof Error ? error.message : String(error), details: redactedErrorDetails(error) });
			return { active: false, error: error instanceof Error ? error.message : String(error) };
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

	private async collectSessionAssertions(desired: NormalizedBrowserOrchestrationDesired, session: NormalizedDesiredSession, sessionTabs: ActualTabState[], profiles: JsonRecord[], diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<ActualSessionAssertionsState> {
		const definition = session.sessionAssertions;
		if (!definition) return { mode: "all", passed: true, total: 0, passedCount: 0, failedCount: 0, probeFailedCount: 0, checks: [] };
		const checks = await Promise.all(definition.checks.map((assertion) => this.collectSessionAssertion(desired, session, assertion, sessionTabs, profiles, diagnostics, timeoutMs)));
		const passedCount = checks.filter((item) => item.status === "passed").length;
		const failedCount = checks.filter((item) => item.status === "failed").length;
		const probeFailedCount = checks.filter((item) => item.status === "probe_failed").length;
		const passed = definition.mode === "all" ? failedCount === 0 && probeFailedCount === 0 : passedCount > 0;
		return { mode: definition.mode, passed, total: checks.length, passedCount, failedCount, probeFailedCount, checks };
	}

	private async collectSessionAssertion(desired: NormalizedBrowserOrchestrationDesired, session: NormalizedDesiredSession, assertion: NormalizedSessionAssertion, sessionTabs: ActualTabState[], profiles: JsonRecord[], diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<ActualSessionAssertionState> {
		const target = sessionTabs.find((tab) => tab.role === assertion.tabRole);
		const desiredTab = session.tabs.find((tab) => tab.role === assertion.tabRole);
		const failed = (message: string, details: JsonRecord = {}): ActualSessionAssertionState => ({ id: assertion.id, kind: assertion.kind, tabRole: assertion.tabRole, status: "failed", passed: false, message, details });
		const probeFailed = (message: string, details: JsonRecord = {}): ActualSessionAssertionState => ({ id: assertion.id, kind: assertion.kind, tabRole: assertion.tabRole, status: "probe_failed", passed: false, message, details });
		const passed = (details: JsonRecord = {}): ActualSessionAssertionState => ({ id: assertion.id, kind: assertion.kind, tabRole: assertion.tabRole, status: "passed", passed: true, details });
		switch (assertion.kind) {
			case "url": {
				if (!target?.exists) return failed("assertion target tab is missing", { reason: "target_tab_missing" });
				const currentUrl = target.url;
				const matches = (!!assertion.equals && urlsMatch(currentUrl, assertion.equals)) || (!!assertion.includes && typeof currentUrl === "string" && currentUrl.includes(assertion.includes));
				return matches ? passed({ currentUrlHash: currentUrl ? hashSensitiveString(currentUrl) : undefined }) : failed("URL assertion is not satisfied", { currentUrlHash: currentUrl ? hashSensitiveString(currentUrl) : undefined, hasEquals: !!assertion.equals, hasIncludes: !!assertion.includes });
			}
			case "origin": {
				if (!target?.exists) return failed("assertion target tab is missing", { reason: "target_tab_missing" });
				const currentOrigin = target.url ? new URL(target.url).origin : undefined;
				return currentOrigin === assertion.equals ? passed({ currentOrigin }) : failed("origin assertion is not satisfied", { currentOrigin, expectedOrigin: assertion.equals });
			}
			case "loadState": {
				if (!target?.exists || !target.tabId || !target.browserId) return failed("assertion target tab is missing", { reason: "target_tab_missing" });
				const state = assertion.state === "networkIdle" ? "networkIdle" : assertion.state === "domcontentloaded" ? "domcontentloaded" : "complete";
				try {
					const command = assertion.state === "networkIdle" ? { cmd: "wait.networkIdle" as const, timeoutMs: Math.min(timeoutMs || 2_000, 5_000) } : { cmd: "wait.loadState" as const, state, timeoutMs: Math.min(timeoutMs || 2_000, 5_000) };
					const result = await this.server.sendCommand(command, { tabId: target.tabId, target: { tabId: target.tabId, browserId: target.browserId }, timeoutMs: Math.min(timeoutMs || 2_000, 5_000) });
					const failure = failureData(result.data);
					return failure ? failed("loadState assertion is not satisfied", { state, error: failure.message }) : passed({ state });
				} catch (error) {
					diagnostics.push({ source: "sessionAssertions.loadState", tabId: target.tabId, assertionId: assertion.id, error: error instanceof Error ? error.message : String(error), details: redactedErrorDetails(error) });
					return probeFailed("loadState assertion probe failed", { state, error: error instanceof Error ? error.message : String(error) });
				}
			}
			case "cookie": {
				if (!desiredTab) return failed("cookie assertion desired tab is not found", { reason: "desired_tab_missing" });
				const observed = await this.collectAssertionCookie(desired, desiredTab.url, assertion.name, diagnostics, timeoutMs);
				if (observed.error) return probeFailed("cookie assertion probe failed", { error: observed.error, name: assertion.name });
				const matched = assertion.present ? observed.present === true && (!assertion.valueHash || observed.valueHash === assertion.valueHash) : observed.present === false;
				return matched ? passed({ present: observed.present, valueLength: observed.valueLength, hasValueHash: !!assertion.valueHash }) : failed("cookie assertion is not satisfied", { present: observed.present, valueLength: observed.valueLength, hasValueHash: !!assertion.valueHash });
			}
			case "storage":
			case "selector":
			case "text":
			case "attribute": {
				if (!target?.exists || !target.tabId || !target.browserId) return failed("assertion target tab is missing", { reason: "target_tab_missing" });
				const observed = await this.evaluateReadOnlyAssertionProbe(target, assertion, diagnostics, timeoutMs);
				if (!observed.ok) return probeFailed(`${assertion.kind} assertion probe failed`, { error: observed.error, details: observed.details });
				return observed.passed ? passed(observed.details) : failed(`${assertion.kind} assertion is not satisfied`, observed.details);
			}
			case "hook": {
				if (!target?.exists || !target.tabId || !target.browserId) return failed("assertion target tab is missing", { reason: "target_tab_missing" });
				const hook = await this.collectHookAssertion(desired, session, assertion, target, diagnostics, timeoutMs);
				if (hook.error) return probeFailed("hook assertion probe failed", { error: hook.error, sessionId: hook.sessionId });
				return hook.installed ? passed({ sessionId: hook.sessionId, state: hook.state }) : failed("hook assertion is not satisfied", { sessionId: hook.sessionId, state: hook.state });
			}
			case "networkRecorder": {
				if (!target?.exists || !target.tabId || !target.browserId) return failed("assertion target tab is missing", { reason: "target_tab_missing" });
				const recorder = await this.collectNetworkAssertion(desired, session, assertion, target, diagnostics, timeoutMs);
				if (recorder.error && recorder.active === false) return probeFailed("network recorder assertion probe failed", { error: recorder.error, sessionId: recorder.sessionId });
				return recorder.active ? passed({ sessionId: recorder.sessionId }) : failed("network recorder assertion is not satisfied", { sessionId: recorder.sessionId, active: recorder.active });
			}
			case "profile": {
				const expectedProfileId = assertion.profileId || desired.isolation.profile?.profileId;
				const observedProfileId = target?.profileId;
				const profilePresent = !!expectedProfileId ? sessionTabs.some((tab) => tab.profileId === expectedProfileId) || profiles.some((profile) => profile.profileId === expectedProfileId) : sessionTabs.some((tab) => !!tab.profileId);
				const matched = assertion.present ? profilePresent : !profilePresent;
				return matched ? passed({ profileId: expectedProfileId || observedProfileId, present: profilePresent }) : failed("profile assertion is not satisfied", { profileId: expectedProfileId || observedProfileId, present: profilePresent });
			}
		}
	}

	private async collectAssertionCookie(desired: NormalizedBrowserOrchestrationDesired, url: string, name: string, diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<{ present: boolean; valueHash?: string; valueLength?: number; error?: string }> {
		try {
			if (desired.isolation.scope === "profile") {
				const profileId = desired.isolation.profile?.profileId;
				const client = this.server.snapshot().clients.find((item) => item.profileId === profileId);
				if (!client?.id) return { present: false, error: "managed profile is not connected" };
				if (typeof this.server.selectBrowser === "function") this.server.selectBrowser(client.id);
			}
			const result = await this.server.sendCommand({ cmd: "cookies", method: "get", url, name }, { timeoutMs: Math.min(timeoutMs || 2_000, 5_000) });
			const failure = failureData(result.data);
			if (failure) return { present: false, error: failure.message };
			const data = result.data;
			const present = isRecord(data) && typeof data.name === "string";
			const value = isRecord(data) && typeof data.value === "string" ? data.value : undefined;
			return { present, valueHash: value === undefined ? undefined : hashSensitiveString(value), valueLength: value?.length };
		} catch (error) {
			diagnostics.push({ source: "sessionAssertions.cookies.get", url, name, error: error instanceof Error ? error.message : String(error), details: redactedErrorDetails(error) });
			return { present: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async collectHookAssertion(desired: NormalizedBrowserOrchestrationDesired, session: NormalizedDesiredSession, assertion: Extract<NormalizedSessionAssertion, { kind: "hook" }>, actualTab: ActualTabState, diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<ActualHookState> {
		const sessionId = assertion.sessionId || hookSessionId(desired.orchestrationId, session.tag, assertion.tabRole, session.hookDispatcher?.sessionId);
		try {
			const result = await this.server.sendCommand({ cmd: "hook.status", sessionId }, { tabId: actualTab.tabId, target: { tabId: actualTab.tabId, browserId: actualTab.browserId }, timeoutMs: Math.min(timeoutMs || 2_000, 5_000) });
			const failure = failureData(result.data);
			if (failure) return { desired: true, installed: false, sessionId, error: failure.message, details: failure.details };
			const data = isRecord(result.data) ? result.data : {};
			const state = typeof data.state === "string" ? data.state : undefined;
			const installed = !!(data.session_id || data.sessionId || state) && !["CLOSED", "CREATED", "NO_SESSION"].includes(String(state || "").toUpperCase());
			return { desired: true, installed, state, sessionId: typeof data.session_id === "string" ? data.session_id : typeof data.sessionId === "string" ? data.sessionId : sessionId };
		} catch (error) {
			diagnostics.push({ source: "sessionAssertions.hook.status", tabId: actualTab.tabId, sessionId, error: error instanceof Error ? error.message : String(error), details: redactedErrorDetails(error) });
			return { desired: true, installed: false, sessionId, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async collectNetworkAssertion(desired: NormalizedBrowserOrchestrationDesired, session: NormalizedDesiredSession, assertion: Extract<NormalizedSessionAssertion, { kind: "networkRecorder" }>, actualTab: ActualTabState, diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<ActualRecorderState> {
		const sessionId = assertion.sessionId || recorderSessionId(desired.orchestrationId, session.tag, assertion.tabRole, session.networkRecorder?.sessionId);
		try {
			const result = await this.server.sendCommand({ cmd: "network.status", sessionId }, { tabId: actualTab.tabId, target: { tabId: actualTab.tabId, browserId: actualTab.browserId }, timeoutMs: Math.min(timeoutMs || 2_000, 5_000) });
			const failure = failureData(result.data);
			if (failure) return { desired: true, active: false, sessionId, error: failure.message, details: failure.details };
			const data = isRecord(result.data) ? result.data : {};
			const config = isRecord(data.config) ? data.config : undefined;
			return { desired: true, active: data.active === true, sessionId: typeof data.sessionId === "string" ? data.sessionId : sessionId, config, configHash: config ? hashSensitiveString(stableJson(config)) : undefined };
		} catch (error) {
			diagnostics.push({ source: "sessionAssertions.network.status", tabId: actualTab.tabId, sessionId, error: error instanceof Error ? error.message : String(error), details: redactedErrorDetails(error) });
			return { desired: true, active: false, sessionId, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async evaluateReadOnlyAssertionProbe(actualTab: ActualTabState, assertion: Extract<NormalizedSessionAssertion, { kind: "storage" | "selector" | "text" | "attribute" }>, diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<{ ok: boolean; passed?: boolean; error?: string; details?: JsonRecord }> {
		const expression = `(${String.raw`async (probe) => {
				const sha256 = async (input) => {
					const text = String(input ?? "");
					const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
					return Array.from(new Uint8Array(digest)).map((item) => item.toString(16).padStart(2, "0")).join("");
				};
				try {
					if (probe.kind === "storage") {
						const storage = probe.storageArea === "sessionStorage" ? window.sessionStorage : window.localStorage;
						const value = storage.getItem(probe.key);
						const present = value !== null;
						const valueHash = present ? await sha256(value) : undefined;
						const passed = probe.present ? present && (!probe.valueHash || valueHash === probe.valueHash) : !present;
						return { ok: true, passed, details: { present, valueLength: typeof value === "string" ? value.length : undefined, hasExpectedHash: !!probe.valueHash, hashMatched: probe.valueHash ? valueHash === probe.valueHash : undefined } };
					}
					const element = probe.selector ? document.querySelector(probe.selector) : (document.body || document.documentElement);
					if (probe.kind === "selector") {
						const present = !!element;
						return { ok: true, passed: present === probe.present, details: { present } };
					}
					if (!element) return { ok: true, passed: false, details: { present: false, reason: "selector_not_found" } };
					if (probe.kind === "text") {
						const text = String(element.textContent || "");
						const textHash = await sha256(text);
						const includesMatched = probe.includes ? text.includes(probe.includes) : undefined;
						const equalsHashMatched = probe.equalsHash ? textHash === probe.equalsHash : undefined;
						const passed = (probe.includes ? includesMatched === true : true) && (probe.equalsHash ? equalsHashMatched === true : true);
						return { ok: true, passed, details: { present: true, textLength: text.length, includesMatched, hasEqualsHash: !!probe.equalsHash, equalsHashMatched } };
					}
					if (probe.kind === "attribute") {
						const attributePresent = element.hasAttribute(probe.name);
						const value = attributePresent ? element.getAttribute(probe.name) : null;
						const valueHash = attributePresent ? await sha256(value || "") : undefined;
						const equalsMatched = probe.equals !== undefined ? value === probe.equals : undefined;
						const equalsHashMatched = probe.equalsHash ? valueHash === probe.equalsHash : undefined;
						const passed = probe.present ? attributePresent && (probe.equals !== undefined ? equalsMatched === true : true) && (probe.equalsHash ? equalsHashMatched === true : true) : attributePresent === false;
						return { ok: true, passed, details: { present: true, attributePresent, valueLength: typeof value === "string" ? value.length : undefined, equalsMatched, hasEqualsHash: !!probe.equalsHash, equalsHashMatched } };
					}
					return { ok: false, error: "unsupported assertion kind" };
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : String(error) };
				}
			}`})(${JSON.stringify(assertion)})`;
		try {
			const result = await this.server.sendCommand({ cmd: "cdp", method: "Runtime.evaluate", name: `sessionAssertion.${assertion.kind}`, persistent: false, timeoutMs: Math.min(timeoutMs || 2_000, 5_000), params: { expression, awaitPromise: true, returnByValue: true } }, { tabId: actualTab.tabId, target: { tabId: actualTab.tabId, browserId: actualTab.browserId }, timeoutMs: Math.min(timeoutMs || 2_000, 5_000) });
			const data = isRecord(result.data) ? result.data : {};
			const exceptionMessage = runtimeExceptionMessage(data);
			if (exceptionMessage) return { ok: false, error: exceptionMessage };
			const remote = isRecord(data.result) ? data.result : undefined;
			const value = remote && Object.prototype.hasOwnProperty.call(remote, "value") ? remote.value : undefined;
			if (!isRecord(value)) return { ok: false, error: "Runtime.evaluate did not return a by-value object" };
			return { ok: value.ok === true, passed: value.passed === true, error: typeof value.error === "string" ? value.error : undefined, details: isRecord(value.details) ? value.details : undefined };
		} catch (error) {
			diagnostics.push({ source: "sessionAssertions.Runtime.evaluate", tabId: actualTab.tabId, assertionId: assertion.id, kind: assertion.kind, error: error instanceof Error ? error.message : String(error), details: redactedErrorDetails(error) });
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async collectCookie(desired: NormalizedBrowserOrchestrationDesired, cookie: NormalizedDesiredCookie, diagnostics: JsonRecord[], timeoutMs: number | undefined): Promise<ActualCookieState> {
		try {
			if (desired.isolation.scope === "profile") {
				const profileId = desired.isolation.profile?.profileId;
				const client = this.server.snapshot().clients.find((item) => item.profileId === profileId);
				if (!client?.id) return { key: cookie.key, name: cookie.name, action: cookie.action, present: undefined, drift: true, error: "managed profile is not connected" };
				if (typeof this.server.selectBrowser === "function") this.server.selectBrowser(client.id);
			}
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
