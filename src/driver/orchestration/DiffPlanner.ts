import { hookSessionId, recorderSessionId } from "./ActualStateCollector";
import { targetConflict } from "./orchestrationErrors";
import { compactPreNavigationHookMetadata, preNavigationHookKey, preNavigationHooksForTab } from "./preNavigationHooks";
import { hashSensitiveString, redactedCookieParams, stableJson } from "./orchestrationRedaction";
import { ORCHESTRATION_PHASE_ORDER } from "./types";
import type { OrchestrationStore } from "./OrchestrationStore";
import type {
	ActualCookieState,
	ActualPreNavigationHookState,
	ActualTabState,
	BrowserOrchestrationActual,
	BrowserOrchestrationPlan,
	BrowserOrchestrationPhase,
	JsonRecord,
	NormalizedBrowserOrchestrationDesired,
	NormalizedDesiredCookie,
	NormalizedDesiredSession,
	NormalizedDesiredTab,
	NormalizedPreNavigationHookMetadata,
	ReconcileOperation,
} from "./types";

function urlsMatch(a: string | undefined, b: string): boolean {
	if (!a) return false;
	try { return new URL(a).href === new URL(b).href; }
	catch { return a === b; }
}

function planParamsForTab(tab: NormalizedDesiredTab, extra: JsonRecord = {}): JsonRecord {
	return { sessionTag: tab.sessionTag, role: tab.role, url: tab.url, active: tab.active, waitUntil: tab.waitUntil, reuse: tab.reuse, ...extra };
}

function cookieActual(actual: BrowserOrchestrationActual, cookie: NormalizedDesiredCookie): ActualCookieState | undefined {
	return actual.sessions.find((session) => session.tag === cookie.sessionTag)?.cookies.find((item) => item.key === cookie.key);
}

function actualForTab(actual: BrowserOrchestrationActual, sessionTag: string, role: string): ActualTabState | undefined {
	return actual.sessions.find((session) => session.tag === sessionTag)?.tabs.find((tab) => tab.role === role);
}

function actualPreNavigationHook(actualTab: ActualTabState | undefined, hook: NormalizedPreNavigationHookMetadata): ActualPreNavigationHookState | undefined {
	const key = preNavigationHookKey(hook);
	return actualTab?.preNavigationHooks?.find((item) => preNavigationHookKey(item) === key);
}

function addCount(counts: Record<string, number>, phase: BrowserOrchestrationPhase): void {
	counts[phase] = (counts[phase] || 0) + 1;
}

function expectedConfigHash(config: JsonRecord): string | undefined {
	return Object.keys(config || {}).length ? hashSensitiveString(stableJson(config)) : undefined;
}

function explicitConfigDrift(actualConfig: JsonRecord | undefined, desiredConfig: JsonRecord): boolean {
	for (const [key, expected] of Object.entries(desiredConfig || {})) {
		if (stableJson(actualConfig?.[key]) !== stableJson(expected)) return true;
	}
	return false;
}

export class DiffPlanner {
	private readonly store: OrchestrationStore;

	constructor(store: OrchestrationStore) {
		this.store = store;
	}

	plan(desired: NormalizedBrowserOrchestrationDesired, actual: BrowserOrchestrationActual): BrowserOrchestrationPlan {
		const operations: ReconcileOperation[] = [];
		const diagnostics: JsonRecord[] = [...actual.diagnostics];
		const previousActual = this.store.get(desired.orchestrationId)?.lastActual;
		const workerBootChanged = !!previousActual?.bridge.workerBootId && !!actual.bridge.workerBootId && previousActual.bridge.workerBootId !== actual.bridge.workerBootId;
		if (workerBootChanged) diagnostics.push({ source: "diff", reason: "service_worker_boot_changed", previousWorkerBootId: previousActual?.bridge.workerBootId, workerBootId: actual.bridge.workerBootId });
		const phaseCounts: Record<string, number> = {};
		let seq = 0;
		const push = (phase: BrowserOrchestrationPhase, action: ReconcileOperation["action"], session: NormalizedDesiredSession, tab: NormalizedDesiredTab, options: { reason: string; dependsOn?: string[]; required?: boolean; redactedParams?: JsonRecord; tabId?: number; browserId?: string; windowId?: number; groupId?: number; cookie?: NormalizedDesiredCookie; sessionId?: string; hook?: NormalizedPreNavigationHookMetadata; hookIdentifier?: string }): ReconcileOperation => {
			addCount(phaseCounts, phase);
			const id = `op-${++seq}-${phase}-${action}`;
			const hookKey = options.hook ? preNavigationHookKey(options.hook) : undefined;
			const op: ReconcileOperation = {
				id,
				phase,
				action,
				resourceRef: {
					orchestrationId: desired.orchestrationId,
					sessionTag: session.tag,
					tabRole: tab.role,
					tabId: options.tabId,
					browserId: options.browserId,
					windowId: options.windowId,
					groupId: options.groupId,
					cookieKey: options.cookie?.key,
					cookieName: options.cookie?.name,
					sessionId: options.sessionId,
					hookId: options.hook?.hookId,
					hookVersion: options.hook?.version,
					hookHash: options.hook?.hash,
					hookIdentifier: options.hookIdentifier,
				},
				reason: options.reason,
				dependsOn: options.dependsOn?.filter(Boolean),
				idempotencyKey: `${desired.orchestrationId}:${session.tag}:${tab.role}:${phase}:${action}:${options.cookie?.key || options.sessionId || hookKey || tab.url}`,
				required: options.required ?? tab.required,
				redactedParams: options.redactedParams || planParamsForTab(tab),
			};
			operations.push(op);
			return op;
		};

		for (const session of desired.sessions) {
			const sessionEnsureOps: ReconcileOperation[] = [];
			let createOwnedWindowOp: ReconcileOperation | undefined;
			const existingOwnedWindowId = this.store.get(desired.orchestrationId)?.bindings.find((binding) => binding.sessionTag === session.tag && binding.windowOwned && binding.windowId)?.windowId;
			for (const tab of session.tabs) {
				const desiredPreNavigationHooks = preNavigationHooksForTab(session.preNavigationHooks, tab);
				const actualTab = actualForTab(actual, session.tag, tab.role);
				const binding = this.store.binding(desired.orchestrationId, session.tag, tab.role);
				let ensureOp: ReconcileOperation | undefined;
				if (actualTab?.candidateTabIds && actualTab.candidateTabIds.length > 1) {
					throw targetConflict("Multiple matching tabs satisfy the same orchestration role", { orchestrationId: desired.orchestrationId, sessionTag: session.tag, tabRole: tab.role, candidateTabIds: actualTab.candidateTabIds });
				}
				if (!actualTab?.exists) {
					if (binding && (!binding.owned || !tab.recreateOnMissing)) {
						diagnostics.push({ source: "diff", reason: binding.owned ? "bound_tab_missing_recreate_disabled" : "non_owned_bound_tab_missing", sessionTag: session.tag, tabRole: tab.role, tabId: binding.tabId, browserId: binding.browserId });
						push("verify", "verifyStatus", session, tab, { reason: "bound tab is missing and cannot be recreated by policy", required: tab.required, tabId: binding.tabId, browserId: binding.browserId, redactedParams: planParamsForTab(tab, { missing: true, owned: binding.owned, recreateOnMissing: tab.recreateOnMissing }) });
					} else {
						const createParams = planParamsForTab(tab, { create: true, preNavigationHookCount: desiredPreNavigationHooks.length });
						const shouldCreateWindow = session.ownedWindow.enabled && !createOwnedWindowOp && (!existingOwnedWindowId || binding?.windowOwned) && session.tabs[0]?.role === tab.role;
						if (shouldCreateWindow) {
							ensureOp = push("window", "createWindow", session, tab, { reason: binding ? "owned window tab is missing" : "desired session requires an owned window", required: tab.required, browserId: binding?.browserId, redactedParams: { ...createParams, createWindow: true, ownedWindow: session.ownedWindow } });
							createOwnedWindowOp = ensureOp;
						} else {
							const dependsOn = createOwnedWindowOp ? [createOwnedWindowOp.id] : undefined;
							const targetWindowId = binding?.windowOwned ? binding.windowId : existingOwnedWindowId;
							ensureOp = push("tab", "createTab", session, tab, { reason: binding ? "owned bound tab is missing" : "desired tab has no binding", dependsOn, required: tab.required, browserId: binding?.browserId, windowId: targetWindowId, redactedParams: { ...createParams, browserId: binding?.browserId, windowId: targetWindowId } });
						}
						sessionEnsureOps.push(ensureOp);
					}
				} else if (!binding && tab.reuse === "matchingUrl") {
					const owner = this.store.findBindingByTab(actualTab.browserId, actualTab.tabId);
					if (owner && owner.orchestrationId !== desired.orchestrationId) throw targetConflict("Matching tab is already bound to another orchestration", { orchestrationId: desired.orchestrationId, ownerOrchestrationId: owner.orchestrationId, tabId: actualTab.tabId, browserId: actualTab.browserId });
					ensureOp = push("tab", "reuseTab", session, tab, { reason: "matching tab can be reused", required: tab.required, tabId: actualTab.tabId, browserId: actualTab.browserId, windowId: actualTab.windowId, groupId: actualTab.groupId, redactedParams: planParamsForTab(tab, { reuse: "matchingUrl", tabId: actualTab.tabId, windowId: actualTab.windowId, groupId: actualTab.groupId }) });
					sessionEnsureOps.push(ensureOp);
				}
				const tabId = actualTab?.tabId;
				const browserId = actualTab?.browserId;
				let navigateOp: ReconcileOperation | undefined;
				let needsVerify = !!ensureOp;
				const canTargetTab = !!actualTab?.exists || !!ensureOp;
				const preNavigationDeps = [ensureOp?.id].filter((item): item is string => !!item);
				const verifyDeps = [ensureOp?.id].filter((item): item is string => !!item);
				const network = session.networkRecorder;
				let recorderDrift = false;
				let networkSessionId: string | undefined;
				let networkConfigHash: string | undefined;
				if (network?.enabled && canTargetTab) {
					networkSessionId = recorderSessionId(desired.orchestrationId, session.tag, tab.role, network.sessionId);
					networkConfigHash = expectedConfigHash(network.config);
					recorderDrift = actualTab?.networkRecorder?.active !== true
						|| actualTab?.networkRecorder?.sessionId !== networkSessionId
						|| explicitConfigDrift(actualTab?.networkRecorder?.config, network.config)
						|| (workerBootChanged && !!binding?.networkSessionId);
					if (recorderDrift && network.startBeforeNavigate) {
						const op = push("recorder-pre-nav", "startNetwork", session, tab, { reason: workerBootChanged ? "service worker restarted; restart network recorder before navigation" : "network recorder drift before navigation", dependsOn: ensureOp ? [ensureOp.id] : undefined, required: network.required, tabId, browserId, sessionId: networkSessionId, redactedParams: { sessionId: networkSessionId, startBeforeNavigate: true, config: network.config, configHash: networkConfigHash } });
						preNavigationDeps.push(op.id);
						verifyDeps.push(op.id);
						needsVerify = true;
					}
				}
				const preNavigationOps: ReconcileOperation[] = [];
				if (canTargetTab && desiredPreNavigationHooks.length) {
					for (const desiredHook of desiredPreNavigationHooks) {
						const actualHook = actualPreNavigationHook(actualTab, desiredHook);
						const boundHook = binding?.preNavigationHooks?.find((item) => preNavigationHookKey(item) === preNavigationHookKey(desiredHook));
						const degraded = binding?.preNavigationHookDegraded?.find((item) => preNavigationHookKey(item) === preNavigationHookKey(desiredHook));
						if (degraded && !desiredHook.required) continue;
						const hookDrift = actualHook?.registered !== true || actualHook.stale === true || (workerBootChanged && !!boundHook);
						if (!hookDrift) continue;
						const op = push("hook-pre-nav", "installPreNavigationHook", session, tab, { reason: workerBootChanged ? "service worker restarted; reinstall pre-navigation hook" : "pre-navigation hook registration drift", dependsOn: preNavigationDeps, required: desiredHook.required, tabId, browserId, hook: desiredHook, redactedParams: { ...compactPreNavigationHookMetadata(desiredHook), sessionTag: session.tag, tabRole: tab.role } });
						preNavigationOps.push(op);
						verifyDeps.push(op.id);
						needsVerify = true;
					}
				}
				const preNavigationEffectMissing = desiredPreNavigationHooks.some((hook) => {
					const degraded = binding?.preNavigationHookDegraded?.find((item) => preNavigationHookKey(item) === preNavigationHookKey(hook));
					return !(degraded && !hook.required) && actualPreNavigationHook(actualTab, hook)?.effectActive !== true;
				});
				const needsPreNavigationDocument = desiredPreNavigationHooks.length > 0 && (!!ensureOp || preNavigationOps.length > 0 || preNavigationEffectMissing);
				const navigationDrift = actualTab?.exists && (!actualTab.navigation.urlMatchesDesired || actualTab.navigation.loadStateMatchesDesired === false);
				if (canTargetTab && (navigationDrift || needsPreNavigationDocument)) {
					const reason = navigationDrift ? (actualTab?.navigation.urlMatchesDesired ? "tab load state differs from desired waitUntil" : "tab URL differs from desired URL") : "navigate after pre-navigation hook registration";
					navigateOp = push("navigation", "navigate", session, tab, { reason, dependsOn: [...preNavigationDeps, ...preNavigationOps.map((op) => op.id)], required: tab.required, tabId, browserId, redactedParams: planParamsForTab(tab, { currentUrl: actualTab?.url, loadState: actualTab?.navigation.loadState, loadStateError: actualTab?.navigation.error, preNavigationHookCount: desiredPreNavigationHooks.length }) });
					verifyDeps.push(navigateOp.id);
					needsVerify = true;
				}
				if (network?.enabled && canTargetTab && recorderDrift && !network.startBeforeNavigate) {
					const op = push("recorder", "startNetwork", session, tab, { reason: workerBootChanged ? "service worker restarted; restart network recorder" : "network recorder drift", dependsOn: [ensureOp?.id, navigateOp?.id].filter((item): item is string => !!item), required: network.required, tabId, browserId, sessionId: networkSessionId, redactedParams: { sessionId: networkSessionId, config: network.config, configHash: networkConfigHash } });
					verifyDeps.push(op.id);
					needsVerify = true;
				}
				const hook = session.hookDispatcher;
				if (hook?.enabled && canTargetTab) {
					const sessionId = hookSessionId(desired.orchestrationId, session.tag, tab.role, hook.sessionId);
					const fingerprintDrift = !!hook.installFingerprint && actualTab?.hookDispatcher?.installFingerprint !== hook.installFingerprint;
					const hookDrift = actualTab?.hookDispatcher?.installed !== true || actualTab?.hookDispatcher?.sessionId !== sessionId || fingerprintDrift || (workerBootChanged && !!binding?.hookSessionId);
					if (hookDrift) {
						const op = push("hook", "installHook", session, tab, { reason: workerBootChanged ? "service worker restarted; reinstall hook dispatcher" : fingerprintDrift ? "hook fingerprint drift" : "hook dispatcher drift", dependsOn: [ensureOp?.id, navigateOp?.id].filter((item): item is string => !!item), required: hook.required, tabId, browserId, sessionId, redactedParams: { sessionId, targets: hook.targets, options: hook.options, bufferSize: hook.bufferSize, force: hook.force, installFingerprint: hook.installFingerprint } });
						verifyDeps.push(op.id);
						needsVerify = true;
					}
				}
				if (needsVerify) push("verify", "verifyStatus", session, tab, { reason: "verify desired tab state after reconcile operations", dependsOn: verifyDeps, required: tab.required, tabId, browserId, windowId: actualTab?.windowId || binding?.windowId, groupId: actualTab?.groupId || binding?.groupId, redactedParams: planParamsForTab(tab, { verify: true, preNavigationHookCount: desiredPreNavigationHooks.length }) });
			}
			const fallbackTab = session.tabs[0];
			if (fallbackTab && session.visualGrouping.enabled && session.tabs.length) {
				const actualTabs = session.tabs.map((tab) => actualForTab(actual, session.tag, tab.role));
				const bindings = session.tabs.map((tab) => this.store.binding(desired.orchestrationId, session.tag, tab.role));
				const degraded = bindings.length > 0 && bindings.every((binding) => String(binding?.tabGroupsStatus || "").startsWith("degraded_"));
				const actualGroupIds = actualTabs.map((tab) => tab?.groupId).filter((groupId): groupId is number => typeof groupId === "number" && groupId > 0);
				const sameGroup = actualTabs.every((tab) => tab?.exists) && actualGroupIds.length === session.tabs.length && new Set(actualGroupIds).size === 1;
				if (!degraded && (!sameGroup || bindings.some((binding) => binding?.tabGroupsStatus !== "available"))) {
					push("visual-grouping", "groupTabs", session, fallbackTab, { reason: "visual grouping requested for owned session tabs", dependsOn: sessionEnsureOps.map((op) => op.id), required: false, groupId: sameGroup ? actualGroupIds[0] : undefined, redactedParams: { sessionTag: session.tag, tabRoles: session.tabs.map((tab) => tab.role), title: session.visualGrouping.title, color: session.visualGrouping.color, collapsed: session.visualGrouping.collapsed } });
				}
			}
			for (const cookie of session.cookies) {
				const actualCookie = cookieActual(actual, cookie);
				const drift = actualCookie?.drift !== false;
				if (!drift) continue;
				push("cookie", cookie.action === "remove" ? "removeCookie" : "setCookie", session, fallbackTab || { sessionTag: session.tag, role: cookie.tabRole, url: cookie.url, origin: cookie.origin, reuse: "owned", active: false, waitUntil: "none", recreateOnMissing: false, required: cookie.required }, {
					reason: cookie.action === "remove" ? "cookie is present and must be removed" : "cookie is missing or differs from desired hash",
					required: cookie.required,
					cookie,
					redactedParams: redactedCookieParams(cookie),
				});
			}
		}
		return {
			orchestrationId: desired.orchestrationId,
			generation: desired.generation,
			desiredHash: desired.desiredHash,
			createdAt: Date.now(),
			actual,
			operations: operations.sort((a, b) => ORCHESTRATION_PHASE_ORDER.indexOf(a.phase) - ORCHESTRATION_PHASE_ORDER.indexOf(b.phase)),
			converged: operations.length === 0,
			diagnostics,
		};
	}
}
