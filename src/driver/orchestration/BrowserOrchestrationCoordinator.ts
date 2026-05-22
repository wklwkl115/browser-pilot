import { ActualStateCollector } from "./ActualStateCollector";
import { DiffPlanner } from "./DiffPlanner";
import { OrchestrationStore, summarizePlan } from "./OrchestrationStore";
import { PersistentOrchestrationStore } from "./PersistentOrchestrationStore";
import { ReconcileExecutor } from "./ReconcileExecutor";
import { ResourceLocks } from "./ResourceLocks";
import { normalizeDesired } from "./normalizeDesired";
import { BrowserOrchestrationError, ORCHESTRATION_ERROR_CODES } from "./orchestrationErrors";
import { redactDesired } from "./orchestrationRedaction";
import type {
	BrowserOrchestrationActual,
	BrowserOrchestrationApplyResult,
	BrowserOrchestrationPlanResult,
	BrowserOrchestrationRunOptions,
	BrowserOrchestrationServer,
	BrowserOrchestrationStatusResult,
	BrowserOrchestrationStopResult,
	BrowserOrchestrationWatchOptions,
	BrowserOrchestrationWatchResult,
	JsonRecord,
	NormalizedBrowserOrchestrationDesired,
	OrchestrationFailure,
	OrchestrationPersistenceMetadata,
	OrchestrationRuntimeState,
	ReconcileOperation,
} from "./types";

function canonicalUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try { return new URL(value).href; }
	catch { return value; }
}

function urlOrigin(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try { return new URL(value).origin; }
	catch { return undefined; }
}

function recoveryCount(result: BrowserOrchestrationApplyResult): number {
	return result.operationResults.filter((item) => item.status === "succeeded" && ["createWindow", "createTab", "groupTabs", "navigate", "startNetwork", "installPreNavigationHook", "installHook", "setCookie", "removeCookie"].includes(item.action)).length;
}

function firstFailure(result: Pick<BrowserOrchestrationApplyResult, "failures">, error?: unknown): OrchestrationFailure | undefined {
	if (result.failures[0]) return result.failures[0];
	if (!error) return undefined;
	return { code: error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "ORCHESTRATION_COMMAND_FAILED", message: error instanceof Error ? error.message : String(error), retryable: true };
}

function assertionFailures(actual: BrowserOrchestrationActual | undefined): OrchestrationFailure[] {
	if (!actual) return [];
	const failures: OrchestrationFailure[] = [];
	for (const session of actual.sessions) {
		const assertions = session.sessionAssertions;
		if (!assertions || !assertions.total) continue;
		if (assertions.mode === "any") {
			if (assertions.passed) continue;
			const allProbeFailed = assertions.probeFailedCount === assertions.total;
			failures.push({
				code: allProbeFailed ? "ORCHESTRATION_ASSERTION_PROBE_FAILED" : "ORCHESTRATION_ASSERTION_FAILED",
				message: allProbeFailed ? "Session assertions could not be probed" : "No session assertion passed under any-mode readiness checks",
				retryable: allProbeFailed,
				details: {
					sessionTag: session.tag,
					mode: assertions.mode,
					total: assertions.total,
					failedIds: assertions.checks.filter((item) => item.status === "failed").map((item) => item.id),
					probeFailedIds: assertions.checks.filter((item) => item.status === "probe_failed").map((item) => item.id),
				},
			});
			continue;
		}
		for (const check of assertions.checks) {
			if (check.status === "passed") continue;
			failures.push({
				code: check.status === "probe_failed" ? "ORCHESTRATION_ASSERTION_PROBE_FAILED" : "ORCHESTRATION_ASSERTION_FAILED",
				message: check.message || `${check.kind} assertion failed`,
				retryable: check.status === "probe_failed",
				details: { sessionTag: session.tag, assertionId: check.id, kind: check.kind, tabRole: check.tabRole, ...(check.details || {}) },
			});
		}
	}
	return failures;
}

export class BrowserOrchestrationCoordinator {
	private readonly server: BrowserOrchestrationServer;
	private readonly storeValue: OrchestrationStore;
	private readonly locks: ResourceLocks;
	private readonly collector: ActualStateCollector;
	private readonly planner: DiffPlanner;
	private readonly executor: ReconcileExecutor;
	private readonly persistence?: PersistentOrchestrationStore;
	private readonly watchTimers = new Map<string, NodeJS.Timeout>();
	private persistenceLoaded = false;
	private lastPersistence?: JsonRecord;

	constructor(server: BrowserOrchestrationServer, deps: { store?: OrchestrationStore; locks?: ResourceLocks; persistence?: PersistentOrchestrationStore | false } = {}) {
		this.server = server;
		this.storeValue = deps.store || new OrchestrationStore();
		this.locks = deps.locks || new ResourceLocks();
		this.collector = new ActualStateCollector(server, this.storeValue);
		this.planner = new DiffPlanner(this.storeValue);
		this.executor = new ReconcileExecutor(server, this.storeValue, this.locks);
		this.persistence = deps.persistence === false ? undefined : deps.persistence;
	}

	get store(): OrchestrationStore {
		return this.storeValue;
	}

	async loadPersistentState(): Promise<JsonRecord> {
		if (!this.persistence) return { enabled: false };
		if (this.persistenceLoaded) return { enabled: true, alreadyLoaded: true, ...this.lastPersistence };
		const loaded = await this.persistence.loadInto(this.storeValue);
		this.persistenceLoaded = true;
		this.lastPersistence = { enabled: true, action: "load", ...loaded };
		return this.lastPersistence;
	}

	async savePersistentState(reason = "manual"): Promise<JsonRecord> {
		if (!this.persistence) return { enabled: false, reason };
		try {
			const saved = await this.persistence.save(this.storeValue.list());
			this.lastPersistence = { enabled: true, action: "save", reason, ...saved };
		} catch (error) {
			this.lastPersistence = { enabled: true, action: "save", reason, ok: false, path: this.persistence.statePath, error: error instanceof Error ? error.message : String(error) };
		}
		return this.lastPersistence;
	}

	async plan(desiredState: unknown, options: BrowserOrchestrationRunOptions = {}): Promise<BrowserOrchestrationPlanResult> {
		const desired = normalizeDesired(desiredState);
		const actual = await this.collector.collect(desired, { timeoutMs: options.timeoutMs || desired.defaults.timeoutMs });
		const plan = this.planner.plan(desired, actual);
		return { ok: true, action: "plan", orchestrationId: desired.orchestrationId, generation: desired.generation, desiredHash: desired.desiredHash, redactedDesired: redactDesired(desired), actual, plan };
	}

	async apply(desiredState: unknown, options: BrowserOrchestrationRunOptions = {}): Promise<BrowserOrchestrationApplyResult> {
		const desired = normalizeDesired(desiredState);
		return await this.applyDesired(desired, options);
	}

	private async applyDesired(desired: NormalizedBrowserOrchestrationDesired, options: BrowserOrchestrationRunOptions = {}): Promise<BrowserOrchestrationApplyResult> {
		return await this.locks.runExclusive(`orchestration:${desired.orchestrationId}`, "apply", async () => {
			const existing = this.storeValue.get(desired.orchestrationId);
			if (this.requiresAdoption(existing)) {
				if (!desired.adoption) return this.readOnlyApplyResult("apply", desired.orchestrationId, desired.generation, desired.desiredHash, existing, "Orchestration state requires explicit adoption before apply");
				const adoptionFailure = await this.adoptReadOnlyState(desired, existing, options);
				if (adoptionFailure) return adoptionFailure;
			}
			this.storeValue.upsertDesired(desired);
			const actual = await this.collector.collect(desired, { timeoutMs: options.timeoutMs || desired.defaults.timeoutMs });
			const plan = this.planner.plan(desired, actual);
			this.storeValue.markActual(desired.orchestrationId, actual);
			this.storeValue.markPlan(desired.orchestrationId, plan);
			const result = await this.executor.executePlan(desired, plan, { timeoutMs: options.timeoutMs || desired.defaults.timeoutMs });
			const postActual = await this.collector.collect(this.storeValue.getDesired(desired.orchestrationId) || desired, { timeoutMs: Math.min(options.timeoutMs || desired.defaults.timeoutMs, 5_000) });
			const postPlan = this.planner.plan(this.storeValue.getDesired(desired.orchestrationId) || desired, postActual);
			const postAssertionFailures = result.failures.length === 0 && postPlan.operations.length === 0 ? assertionFailures(postActual) : [];
			result.actual = postActual;
			result.plan = summarizePlan(postPlan);
			result.failures = [...result.failures, ...postAssertionFailures];
			result.converged = result.failures.length === 0 && postPlan.operations.length === 0;
			result.ok = result.converged;
			result.bindings = this.storeValue.get(desired.orchestrationId)?.bindings || [];
			this.storeValue.markActual(desired.orchestrationId, postActual);
			this.storeValue.markPlan(desired.orchestrationId, postPlan);
			this.storeValue.markResult(desired.orchestrationId, result);
			result.persistence = await this.savePersistentState("apply");
			return result;
		});
	}

	async status(orchestrationId?: string, options: BrowserOrchestrationRunOptions = {}): Promise<BrowserOrchestrationStatusResult> {
		if (!orchestrationId) return { ok: true, action: "status", states: this.storeValue.list(), persistence: this.lastPersistence };
		const state = this.storeValue.get(orchestrationId);
		if (!state) return { ok: false, action: "status", orchestrationId, failures: [{ code: "ORCHESTRATION_SESSION_NOT_FOUND", message: "Orchestration state is not found", retryable: false, details: { orchestrationId } }] };
		const desired = this.storeValue.getDesired(orchestrationId);
		if (this.requiresAdoption(state) || !desired) return { ok: true, action: "status", orchestrationId, state, converged: state.lastResult?.converged, failures: state.lastFailures || [], persistence: this.persistenceForState(state) };
		const actual = await this.collector.collect(desired, { timeoutMs: options.timeoutMs || desired.defaults.timeoutMs });
		const plan = this.planner.plan(desired, actual);
		const failures = plan.operations.length === 0 ? assertionFailures(actual) : [];
		this.storeValue.markActual(orchestrationId, actual);
		this.storeValue.markPlan(orchestrationId, plan);
		return { ok: plan.operations.length === 0 && failures.length === 0, action: "status", orchestrationId, state: this.storeValue.get(orchestrationId), actual, plan: summarizePlan(plan), converged: plan.operations.length === 0 && failures.length === 0, failures, persistence: this.persistenceForState(this.storeValue.get(orchestrationId)) };
	}

	async watch(desiredState: unknown, options: BrowserOrchestrationWatchOptions = {}): Promise<BrowserOrchestrationWatchResult> {
		const desired = normalizeDesired(desiredState);
		const existing = this.storeValue.get(desired.orchestrationId);
		if (this.requiresAdoption(existing) && !desired.adoption) {
			const watch = { active: false, intervalMs: Math.max(1_000, Math.floor(options.intervalMs || 5_000)), expiresAt: Date.now(), failures: 1, maxAttempts: Math.max(1, Math.floor(options.maxAttempts || 3)), paused: true, pauseReason: "adoption_required", lastFailure: this.adoptionRequiredFailure(existing, "watch") };
			return { ...this.readOnlyApplyResult("apply", desired.orchestrationId, desired.generation, desired.desiredHash, existing, "Orchestration state requires explicit adoption before watch"), action: "watch", watch };
		}
		const intervalMs = Math.max(1_000, Math.min(60 * 60_000, Math.floor(options.intervalMs || 5_000)));
		const ttlMs = Math.max(intervalMs, Math.min(24 * 60 * 60_000, Math.floor(options.ttlMs || 60_000)));
		const maxAttempts = Math.max(1, Math.min(100, Math.floor(options.maxAttempts || 3)));
		const applied = await this.applyDesired(desired, options);
		const expiresAt = Date.now() + ttlMs;
		const failures = applied.ok ? 0 : 1;
		const active = failures < maxAttempts && applied.persistence?.adoptionRequired !== true;
		const watch = { active, intervalMs, expiresAt, lastRunAt: Date.now(), nextRunAt: active ? Date.now() + intervalMs : undefined, failures, maxAttempts, paused: !active, pauseReason: active ? undefined : "max_attempts", lastFailure: firstFailure(applied), recoveries: recoveryCount(applied) };
		this.storeValue.updateWatch(applied.orchestrationId, watch);
		if (active) this.scheduleWatch(applied.orchestrationId, desiredState, { ...options, intervalMs, ttlMs, maxAttempts, expiresAt });
		return { ...applied, action: "watch", watch };
	}

	async stop(orchestrationId: string, options: BrowserOrchestrationRunOptions = {}): Promise<BrowserOrchestrationStopResult> {
		const before = this.storeValue.get(orchestrationId);
		if (this.requiresAdoption(before)) return { ok: false, action: "stop", orchestrationId, stopped: false, operationResults: [], failures: [this.adoptionRequiredFailure(before, "stop")], state: before, persistence: this.persistenceForState(before) };
		const stopped = this.stopWatch(orchestrationId);
		let state = this.storeValue.updateWatch(orchestrationId, stopped ? { active: false, paused: true, pauseReason: "stopped" } : this.storeValue.get(orchestrationId)?.watch ? { active: false, paused: true, pauseReason: "not_running" } : undefined);
		const operations = state ? this.preNavigationCleanupOperations(state, "uninstall pre-navigation hooks on stop") : [];
		const cleanup = operations.length ? await this.executor.executeOperations(operations, { timeoutMs: options.timeoutMs }) : { operationResults: [], failures: [] };
		state = this.storeValue.get(orchestrationId);
		return { ok: cleanup.failures.length === 0, action: "stop", orchestrationId, stopped, operationResults: cleanup.operationResults, failures: cleanup.failures, state, persistence: await this.savePersistentState("stop") };
	}

	async delete(orchestrationId: string, options: BrowserOrchestrationRunOptions = {}): Promise<BrowserOrchestrationApplyResult> {
		return await this.locks.runExclusive(`orchestration:${orchestrationId}`, "delete", async () => {
			const state = this.storeValue.get(orchestrationId);
			if (!state) return { ok: false, action: "delete", orchestrationId, generation: "missing", converged: false, bindings: [], operationResults: [], failures: [{ code: "ORCHESTRATION_SESSION_NOT_FOUND", message: "Orchestration state is not found", retryable: false, details: { orchestrationId } }] };
			if (this.requiresAdoption(state)) return this.readOnlyApplyResult("delete", orchestrationId, state.generation, state.desiredHash, state, "Orchestration state requires explicit adoption before delete");
			this.stopWatch(orchestrationId);
			const operations = this.cleanupOperations(state);
			const result = await this.executor.executeCleanup(orchestrationId, operations, { timeoutMs: options.timeoutMs });
			this.storeValue.remove(orchestrationId);
			result.persistence = await this.savePersistentState("delete");
			return result;
		});
	}

	stopWatch(orchestrationId: string): boolean {
		const timer = this.watchTimers.get(orchestrationId);
		if (!timer) return false;
		clearTimeout(timer);
		this.watchTimers.delete(orchestrationId);
		return true;
	}

	private scheduleWatch(orchestrationId: string, desiredState: unknown, options: BrowserOrchestrationWatchOptions & { expiresAt: number }): void {
		this.stopWatch(orchestrationId);
		const run = async () => {
			if (Date.now() >= options.expiresAt) {
				this.watchTimers.delete(orchestrationId);
				this.storeValue.updateWatch(orchestrationId, { active: false, paused: true, pauseReason: "expired", nextRunAt: undefined });
				return;
			}
			const current = this.storeValue.get(orchestrationId);
			if (!current?.watch?.active || current.watch.paused) {
				this.watchTimers.delete(orchestrationId);
				return;
			}
			try {
				const result = await this.apply(desiredState, { timeoutMs: options.timeoutMs });
				const failures = result.ok ? 0 : (current.watch.failures || 0) + 1;
				const recoveries = (current.watch.recoveries || 0) + recoveryCount(result);
				if (failures >= (options.maxAttempts || 3)) {
					this.watchTimers.delete(orchestrationId);
					this.storeValue.updateWatch(orchestrationId, { active: false, paused: true, pauseReason: "max_attempts", failures, maxAttempts: options.maxAttempts, lastFailure: firstFailure(result), recoveries, lastRunAt: Date.now(), nextRunAt: undefined });
					return;
				}
				this.storeValue.updateWatch(orchestrationId, { active: true, paused: false, pauseReason: undefined, failures, maxAttempts: options.maxAttempts, lastFailure: firstFailure(result), recoveries, lastRunAt: Date.now(), nextRunAt: Date.now() + (options.intervalMs || 5_000) });
			} catch (error) {
				const failures = (current.watch.failures || 0) + 1;
				const pause = failures >= (options.maxAttempts || 3);
				this.storeValue.updateWatch(orchestrationId, { active: !pause, paused: pause, pauseReason: pause ? (error instanceof Error ? error.message : String(error)) : undefined, failures, maxAttempts: options.maxAttempts, lastFailure: firstFailure({ failures: [] }, error), lastRunAt: Date.now(), nextRunAt: pause ? undefined : Date.now() + (options.intervalMs || 5_000) });
				if (pause) {
					this.watchTimers.delete(orchestrationId);
					return;
				}
			}
			const next = this.storeValue.get(orchestrationId)?.watch;
			if (next?.active && !next.paused) this.watchTimers.set(orchestrationId, setTimeout(run, Math.max(1_000, Math.min(options.intervalMs || 5_000, options.expiresAt - Date.now()))));
		};
		this.watchTimers.set(orchestrationId, setTimeout(run, Math.max(1_000, options.intervalMs || 5_000)));
	}

	async shutdown(options: { cleanup?: boolean; timeoutMs?: number } = {}): Promise<{ ok: boolean; deleted: string[]; failures: JsonRecord[] }> {
		for (const timer of this.watchTimers.values()) clearTimeout(timer);
		this.watchTimers.clear();
		if (!options.cleanup) return { ok: true, deleted: [], failures: [] };
		const deleted: string[] = [];
		const failures: JsonRecord[] = [];
		for (const state of this.storeValue.list()) {
			if (this.requiresAdoption(state)) continue;
			try {
				const result = await this.delete(state.orchestrationId, { timeoutMs: options.timeoutMs || 5_000 });
				if (result.ok) deleted.push(state.orchestrationId);
				else failures.push({ orchestrationId: state.orchestrationId, failures: result.failures });
			} catch (error) {
				failures.push({ orchestrationId: state.orchestrationId, error: error instanceof Error ? error.message : String(error) });
			}
		}
		await this.savePersistentState("shutdown");
		return { ok: failures.length === 0, deleted, failures };
	}

	snapshot(): JsonRecord {
		return {
			states: this.storeValue.snapshot(),
			stateCount: this.storeValue.list().length,
			watchCount: this.watchTimers.size,
			locks: this.locks.snapshot(),
			persistence: this.lastPersistence,
		};
	}

	private requiresAdoption(state: OrchestrationRuntimeState | undefined): state is OrchestrationRuntimeState {
		return !!state?.persistence?.readOnly || !!state?.persistence?.adoptionRequired;
	}

	private adoptionRequiredFailure(state: OrchestrationRuntimeState | undefined, action: string): OrchestrationFailure {
		return {
			code: ORCHESTRATION_ERROR_CODES.TARGET_STALE,
			message: `Orchestration state requires explicit adoption before ${action}`,
			retryable: false,
			details: { orchestrationId: state?.orchestrationId, adoptionRequired: true, persistence: this.persistenceForState(state) },
		};
	}

	private readOnlyApplyResult(action: "apply" | "delete", orchestrationId: string, generation: string, desiredHash: string | undefined, state: OrchestrationRuntimeState | undefined, message: string): BrowserOrchestrationApplyResult {
		const failure = this.adoptionRequiredFailure(state, action);
		return { ok: false, action, orchestrationId, generation, desiredHash, converged: false, bindings: state?.bindings || [], operationResults: [], failures: [{ ...failure, message }], persistence: this.persistenceForState(state) };
	}

	private persistenceForState(state: OrchestrationRuntimeState | undefined): JsonRecord | undefined {
		const persistence = state?.persistence;
		return persistence ? { status: persistence.status, readOnly: persistence.readOnly, adoptionRequired: persistence.adoptionRequired, driverRunId: persistence.driverRunId, piSessionId: persistence.piSessionId, loadedAt: persistence.loadedAt, adoptedAt: persistence.adoptedAt, path: persistence.path } : this.lastPersistence;
	}

	private async adoptReadOnlyState(desired: NormalizedBrowserOrchestrationDesired, state: OrchestrationRuntimeState, options: BrowserOrchestrationRunOptions): Promise<BrowserOrchestrationApplyResult | undefined> {
		if (!desired.adoption) return this.readOnlyApplyResult("apply", desired.orchestrationId, desired.generation, desired.desiredHash, state, "Orchestration adoption policy is required");
		const actual = await this.collector.collect(desired, { timeoutMs: options.timeoutMs || desired.defaults.timeoutMs });
		const failures = this.validateAdoption(desired, state, actual);
		if (failures.length) return { ok: false, action: "apply", orchestrationId: desired.orchestrationId, generation: desired.generation, desiredHash: desired.desiredHash, converged: false, bindings: state.bindings, operationResults: [], failures, actual, persistence: this.persistenceForState(state) };
		for (const binding of state.bindings) this.storeValue.setBinding(state.orchestrationId, this.bindingForAdoption(binding, desired.adoption.resourceTypes, this.actualTabForBinding(actual, binding)));
		const metadata = this.currentPersistenceMetadata(state.persistence);
		this.storeValue.markAdopted(state.orchestrationId, metadata);
		return undefined;
	}

	private validateAdoption(desired: NormalizedBrowserOrchestrationDesired, state: OrchestrationRuntimeState, actual: BrowserOrchestrationActual): OrchestrationFailure[] {
		const policy = desired.adoption;
		if (!policy) return [this.adoptionFailure("Adoption policy is missing", { orchestrationId: desired.orchestrationId })];
		const failures: OrchestrationFailure[] = [];
		const resourceTypes = new Set(policy.resourceTypes);
		if (!resourceTypes.has("tab")) failures.push(this.adoptionFailure("adoption.resourceTypes must include tab", { resourceTypes: policy.resourceTypes }));
		const verifiedUrls = new Set(policy.verifyUrls.map(canonicalUrl).filter((item): item is string => !!item));
		const verifiedOrigins = new Set(policy.verifyOrigins);
		const actualSession = (sessionTag: string) => actual.sessions.find((session) => session.tag === sessionTag);
		const desiredSession = (sessionTag: string) => desired.sessions.find((session) => session.tag === sessionTag);
		for (const binding of state.bindings) {
			const tab = actualSession(binding.sessionTag)?.tabs.find((item) => item.role === binding.tabRole);
			const details = { orchestrationId: state.orchestrationId, sessionTag: binding.sessionTag, tabRole: binding.tabRole, browserId: binding.browserId, tabId: binding.tabId };
			if (!tab?.exists) {
				failures.push(this.adoptionFailure("Persisted tab is not live", details));
				continue;
			}
			const browserMatches = tab.browserId === binding.browserId || (!!binding.browserExtensionId && tab.browserExtensionId === binding.browserExtensionId);
			if (tab.tabId !== binding.tabId || !browserMatches) failures.push(this.adoptionFailure("Live tab does not match persisted tab fingerprint", { ...details, browserExtensionId: binding.browserExtensionId, liveTabId: tab.tabId, liveBrowserId: tab.browserId, liveBrowserExtensionId: tab.browserExtensionId }));
			const href = canonicalUrl(tab.url);
			const origin = urlOrigin(tab.url);
			if (!href || !verifiedUrls.has(href)) failures.push(this.adoptionFailure("Live tab URL is outside adoption.verifyUrls", { ...details, url: tab.url, verifyUrls: policy.verifyUrls }));
			if (!origin || !verifiedOrigins.has(origin)) failures.push(this.adoptionFailure("Live tab origin is outside adoption.verifyOrigins", { ...details, origin, verifyOrigins: policy.verifyOrigins }));
			if (policy.verifyBrowserIds?.length && !policy.verifyBrowserIds.includes(binding.browserId)) failures.push(this.adoptionFailure("Persisted browserId is outside adoption.verifyBrowserIds", { ...details, verifyBrowserIds: policy.verifyBrowserIds }));
			if (policy.verifyWindowIds?.length && (binding.windowId === undefined || !policy.verifyWindowIds.includes(binding.windowId))) failures.push(this.adoptionFailure("Persisted windowId is outside adoption.verifyWindowIds", { ...details, windowId: binding.windowId, verifyWindowIds: policy.verifyWindowIds }));
			const profileId = (binding as { profileId?: string }).profileId;
			if (policy.verifyProfileIds?.length && (!profileId || !policy.verifyProfileIds.includes(profileId))) failures.push(this.adoptionFailure("Persisted profileId is outside adoption.verifyProfileIds or unavailable", { ...details, profileId, verifyProfileIds: policy.verifyProfileIds }));
			if (policy.requireOwnedFingerprint && (!binding.owned || !binding.createdByOrchestrator)) failures.push(this.adoptionFailure("Persisted tab lacks owned/createdByOrchestrator fingerprint", { ...details, owned: binding.owned, createdByOrchestrator: binding.createdByOrchestrator }));
			if (resourceTypes.has("window") && binding.windowId !== undefined && tab.windowId !== binding.windowId) failures.push(this.adoptionFailure("Live windowId does not match persisted window fingerprint", { ...details, liveWindowId: tab.windowId }));
			if (resourceTypes.has("networkRecorder") && binding.networkSessionId && (tab.networkRecorder?.active !== true || tab.networkRecorder.sessionId !== binding.networkSessionId)) failures.push(this.adoptionFailure("Persisted network recorder is not active on the live tab", { ...details, sessionId: binding.networkSessionId, actual: tab.networkRecorder }));
			if (resourceTypes.has("hookDispatcher") && binding.hookSessionId && (tab.hookDispatcher?.installed !== true || tab.hookDispatcher.sessionId !== binding.hookSessionId)) failures.push(this.adoptionFailure("Persisted hook dispatcher is not installed on the live tab", { ...details, sessionId: binding.hookSessionId, actual: tab.hookDispatcher }));
			if (resourceTypes.has("preNavigationHook")) {
				for (const hook of binding.preNavigationHooks || []) {
					const actualHook = tab.preNavigationHooks?.find((item) => item.hookId === hook.hookId && item.version === hook.version && item.hash === hook.hash);
					if (actualHook?.registered !== true || actualHook.effectActive !== true) failures.push(this.adoptionFailure("Persisted pre-navigation hook is not registered/effective on the live tab", { ...details, hookId: hook.hookId, version: hook.version, hash: hook.hash }));
				}
			}
		}
		if (resourceTypes.has("cookie")) {
			for (const session of desired.sessions) {
				const actualCookies = actualSession(session.tag)?.cookies || [];
				for (const cookie of session.cookies) {
					const actualCookie = actualCookies.find((item) => item.key === cookie.key);
					if (actualCookie?.drift !== false) failures.push(this.adoptionFailure("Desired cookie fingerprint is not present on adoption target", { orchestrationId: desired.orchestrationId, sessionTag: session.tag, cookieKey: cookie.key, name: cookie.name }));
				}
			}
		}
		for (const session of desired.sessions) {
			for (const tab of session.tabs) {
				if (!state.bindings.some((binding) => binding.sessionTag === session.tag && binding.tabRole === tab.role)) failures.push(this.adoptionFailure("Desired tab has no persisted binding to adopt", { orchestrationId: desired.orchestrationId, sessionTag: session.tag, tabRole: tab.role }));
			}
			if (desiredSession(session.tag) === undefined) failures.push(this.adoptionFailure("Desired session is not present during adoption", { orchestrationId: desired.orchestrationId, sessionTag: session.tag }));
		}
		return failures;
	}

	private adoptionFailure(message: string, details: JsonRecord): OrchestrationFailure {
		const error = new BrowserOrchestrationError(ORCHESTRATION_ERROR_CODES.TARGET_STALE, message, { ...details, adoptionRequired: true }, { retryable: false });
		return { code: error.code, message: error.message, retryable: error.retryable, details: error.details };
	}

	private actualTabForBinding(actual: BrowserOrchestrationActual, binding: OrchestrationRuntimeState["bindings"][number]) {
		return actual.sessions.find((session) => session.tag === binding.sessionTag)?.tabs.find((tab) => tab.role === binding.tabRole && tab.exists);
	}

	private bindingForAdoption(binding: OrchestrationRuntimeState["bindings"][number], resourceTypes: string[], actualTab?: ReturnType<BrowserOrchestrationCoordinator["actualTabForBinding"]>): OrchestrationRuntimeState["bindings"][number] {
		const adopted = {
			...binding,
			browserId: actualTab?.browserId || binding.browserId,
			browserExtensionId: actualTab?.browserExtensionId || binding.browserExtensionId,
			windowId: actualTab?.windowId || binding.windowId,
			groupId: actualTab?.groupId || binding.groupId,
		};
		if (!resourceTypes.includes("window")) {
			adopted.windowOwned = false;
			adopted.windowCloseOnDelete = false;
		}
		if (!resourceTypes.includes("networkRecorder")) {
			delete adopted.networkSessionId;
			delete adopted.networkConfigHash;
		}
		if (!resourceTypes.includes("hookDispatcher")) {
			delete adopted.hookSessionId;
			delete adopted.hookFingerprint;
		}
		if (!resourceTypes.includes("preNavigationHook")) delete adopted.preNavigationHooks;
		return adopted;
	}

	private currentPersistenceMetadata(previous: OrchestrationPersistenceMetadata | undefined): Omit<OrchestrationPersistenceMetadata, "status" | "readOnly" | "adoptionRequired"> {
		const current = this.persistence?.currentMetadata();
		return {
			schemaVersion: current?.schemaVersion || previous?.schemaVersion || "pi.browser.orchestration.state/v1",
			driverRunId: current?.driverRunId || previous?.driverRunId || "memory",
			piSessionId: current?.piSessionId || previous?.piSessionId || "unknown",
			loadedAt: previous?.loadedAt,
			path: current?.path || previous?.path,
		};
	}

	private preNavigationCleanupOperations(state: OrchestrationRuntimeState, reason: string): ReconcileOperation[] {
		const operations: ReconcileOperation[] = [];
		let seq = 0;
		for (const binding of state.bindings) {
			for (const registration of binding.preNavigationHooks || []) {
				operations.push({
					id: `pre-nav-cleanup-${++seq}-uninstallPreNavigationHook`,
					phase: "cleanup",
					action: "uninstallPreNavigationHook",
					resourceRef: { orchestrationId: state.orchestrationId, sessionTag: binding.sessionTag, tabRole: binding.tabRole, tabId: binding.tabId, browserId: binding.browserId, windowId: binding.windowId, groupId: binding.groupId, hookId: registration.hookId, hookVersion: registration.version, hookHash: registration.hash, hookIdentifier: registration.identifier },
					reason,
					idempotencyKey: `${state.orchestrationId}:${binding.sessionTag}:${binding.tabRole}:cleanup:uninstallPreNavigationHook:${registration.identifier}`,
					required: false,
					redactedParams: { tabId: binding.tabId, browserId: binding.browserId, windowId: binding.windowId, hookId: registration.hookId, version: registration.version, hash: registration.hash, identifier: registration.identifier },
				});
			}
		}
		return operations;
	}

	private cleanupOperations(state: OrchestrationRuntimeState): ReconcileOperation[] {
		const operations: ReconcileOperation[] = [...this.preNavigationCleanupOperations(state, "uninstall pre-navigation hooks on delete")];
		let seq = operations.length;
		const push = (action: ReconcileOperation["action"], binding: OrchestrationRuntimeState["bindings"][number], sessionId: string | undefined, reason: string, required: boolean) => {
			operations.push({
				id: `delete-${++seq}-${action}`,
				phase: "cleanup",
				action,
				resourceRef: { orchestrationId: state.orchestrationId, sessionTag: binding.sessionTag, tabRole: binding.tabRole, tabId: binding.tabId, browserId: binding.browserId, windowId: binding.windowId, groupId: binding.groupId, sessionId },
				reason,
				idempotencyKey: `${state.orchestrationId}:${binding.sessionTag}:${binding.tabRole}:cleanup:${action}:${sessionId || binding.windowId || binding.tabId}`,
				required,
				redactedParams: { tabId: binding.tabId, browserId: binding.browserId, windowId: binding.windowId, groupId: binding.groupId, sessionId, owned: binding.owned, windowOwned: binding.windowOwned, windowCloseOnDelete: binding.windowCloseOnDelete, tabGroupsStatus: binding.tabGroupsStatus },
			});
		};
		for (const binding of state.bindings) {
			if (binding.networkSessionId) push("stopNetwork", binding, binding.networkSessionId, "stop owned network recorder", false);
			if (binding.hookSessionId) push("uninstallHook", binding, binding.hookSessionId, "uninstall owned hook dispatcher", false);
		}
		const closeWindows = new Set<string>();
		for (const binding of state.bindings) {
			const windowKey = binding.windowOwned && binding.windowCloseOnDelete !== false && binding.windowId !== undefined ? `${binding.browserId}:${binding.windowId}` : undefined;
			if (windowKey) {
				if (!closeWindows.has(windowKey)) {
					closeWindows.add(windowKey);
					push("closeWindow", binding, undefined, "close owned window on delete", true);
				}
				continue;
			}
			if (state.closeOwnedTabsOnDelete && binding.owned) push("closeTab", binding, undefined, "close owned tab on delete", true);
		}
		const stoppedProfiles = new Set<string>();
		for (const binding of state.bindings) {
			if (!binding.profileId || stoppedProfiles.has(binding.profileId)) continue;
			stoppedProfiles.add(binding.profileId);
			operations.push({
				id: `delete-${++seq}-stopProfile`,
				phase: "cleanup",
				action: "stopProfile",
				resourceRef: { orchestrationId: state.orchestrationId, sessionTag: binding.sessionTag, tabRole: binding.tabRole, profileId: binding.profileId },
				reason: "stop owned managed profile process on delete",
				idempotencyKey: `${state.orchestrationId}:cleanup:stopProfile:${binding.profileId}`,
				required: false,
				redactedParams: { profileId: binding.profileId, owned: true },
			});
		}
		return operations;
	}
}

export { ORCHESTRATION_ERROR_CODES };
