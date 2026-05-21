import { ActualStateCollector } from "./ActualStateCollector";
import { DiffPlanner } from "./DiffPlanner";
import { OrchestrationStore, summarizePlan } from "./OrchestrationStore";
import { ReconcileExecutor } from "./ReconcileExecutor";
import { ResourceLocks } from "./ResourceLocks";
import { normalizeDesired } from "./normalizeDesired";
import { ORCHESTRATION_ERROR_CODES } from "./orchestrationErrors";
import { redactDesired } from "./orchestrationRedaction";
import type {
	BrowserOrchestrationApplyResult,
	BrowserOrchestrationPlanResult,
	BrowserOrchestrationRunOptions,
	BrowserOrchestrationServer,
	BrowserOrchestrationStatusResult,
	BrowserOrchestrationStopResult,
	BrowserOrchestrationWatchOptions,
	BrowserOrchestrationWatchResult,
	JsonRecord,
	OrchestrationFailure,
	OrchestrationRuntimeState,
	ReconcileOperation,
} from "./types";

function recoveryCount(result: BrowserOrchestrationApplyResult): number {
	return result.operationResults.filter((item) => item.status === "succeeded" && ["createWindow", "createTab", "groupTabs", "navigate", "startNetwork", "installPreNavigationHook", "installHook", "setCookie", "removeCookie"].includes(item.action)).length;
}

function firstFailure(result: Pick<BrowserOrchestrationApplyResult, "failures">, error?: unknown): OrchestrationFailure | undefined {
	if (result.failures[0]) return result.failures[0];
	if (!error) return undefined;
	return { code: error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "ORCHESTRATION_COMMAND_FAILED", message: error instanceof Error ? error.message : String(error), retryable: true };
}

export class BrowserOrchestrationCoordinator {
	private readonly server: BrowserOrchestrationServer;
	private readonly storeValue: OrchestrationStore;
	private readonly locks: ResourceLocks;
	private readonly collector: ActualStateCollector;
	private readonly planner: DiffPlanner;
	private readonly executor: ReconcileExecutor;
	private readonly watchTimers = new Map<string, NodeJS.Timeout>();

	constructor(server: BrowserOrchestrationServer, deps: { store?: OrchestrationStore; locks?: ResourceLocks } = {}) {
		this.server = server;
		this.storeValue = deps.store || new OrchestrationStore();
		this.locks = deps.locks || new ResourceLocks();
		this.collector = new ActualStateCollector(server, this.storeValue);
		this.planner = new DiffPlanner(this.storeValue);
		this.executor = new ReconcileExecutor(server, this.storeValue, this.locks);
	}

	get store(): OrchestrationStore {
		return this.storeValue;
	}

	async plan(desiredState: unknown, options: BrowserOrchestrationRunOptions = {}): Promise<BrowserOrchestrationPlanResult> {
		const desired = normalizeDesired(desiredState);
		const actual = await this.collector.collect(desired, { timeoutMs: options.timeoutMs || desired.defaults.timeoutMs });
		const plan = this.planner.plan(desired, actual);
		return { ok: true, action: "plan", orchestrationId: desired.orchestrationId, generation: desired.generation, desiredHash: desired.desiredHash, redactedDesired: redactDesired(desired), actual, plan };
	}

	async apply(desiredState: unknown, options: BrowserOrchestrationRunOptions = {}): Promise<BrowserOrchestrationApplyResult> {
		const desired = normalizeDesired(desiredState);
		return await this.locks.runExclusive(`orchestration:${desired.orchestrationId}`, "apply", async () => {
			this.storeValue.upsertDesired(desired);
			const actual = await this.collector.collect(desired, { timeoutMs: options.timeoutMs || desired.defaults.timeoutMs });
			const plan = this.planner.plan(desired, actual);
			this.storeValue.markActual(desired.orchestrationId, actual);
			this.storeValue.markPlan(desired.orchestrationId, plan);
			const result = await this.executor.executePlan(desired, plan, { timeoutMs: options.timeoutMs || desired.defaults.timeoutMs });
			const postActual = await this.collector.collect(this.storeValue.getDesired(desired.orchestrationId) || desired, { timeoutMs: Math.min(options.timeoutMs || desired.defaults.timeoutMs, 5_000) });
			const postPlan = this.planner.plan(this.storeValue.getDesired(desired.orchestrationId) || desired, postActual);
			result.actual = postActual;
			result.plan = summarizePlan(postPlan);
			result.converged = result.failures.length === 0 && postPlan.operations.length === 0;
			result.ok = result.converged;
			result.bindings = this.storeValue.get(desired.orchestrationId)?.bindings || [];
			this.storeValue.markActual(desired.orchestrationId, postActual);
			this.storeValue.markPlan(desired.orchestrationId, postPlan);
			this.storeValue.markResult(desired.orchestrationId, result);
			return result;
		});
	}

	async status(orchestrationId?: string, options: BrowserOrchestrationRunOptions = {}): Promise<BrowserOrchestrationStatusResult> {
		if (!orchestrationId) return { ok: true, action: "status", states: this.storeValue.list() };
		const state = this.storeValue.get(orchestrationId);
		if (!state) return { ok: false, action: "status", orchestrationId, failures: [{ code: "ORCHESTRATION_SESSION_NOT_FOUND", message: "Orchestration state is not found", retryable: false, details: { orchestrationId } }] };
		const desired = this.storeValue.getDesired(orchestrationId);
		if (!desired) return { ok: true, action: "status", orchestrationId, state, converged: state.lastResult?.converged, failures: state.lastFailures || [] };
		const actual = await this.collector.collect(desired, { timeoutMs: options.timeoutMs || desired.defaults.timeoutMs });
		const plan = this.planner.plan(desired, actual);
		this.storeValue.markActual(orchestrationId, actual);
		this.storeValue.markPlan(orchestrationId, plan);
		return { ok: plan.operations.length === 0, action: "status", orchestrationId, state: this.storeValue.get(orchestrationId), actual, plan: summarizePlan(plan), converged: plan.operations.length === 0, failures: state.lastFailures || [] };
	}

	async watch(desiredState: unknown, options: BrowserOrchestrationWatchOptions = {}): Promise<BrowserOrchestrationWatchResult> {
		const intervalMs = Math.max(1_000, Math.min(60 * 60_000, Math.floor(options.intervalMs || 5_000)));
		const ttlMs = Math.max(intervalMs, Math.min(24 * 60 * 60_000, Math.floor(options.ttlMs || 60_000)));
		const maxAttempts = Math.max(1, Math.min(100, Math.floor(options.maxAttempts || 3)));
		const applied = await this.apply(desiredState, options);
		const expiresAt = Date.now() + ttlMs;
		const failures = applied.ok ? 0 : 1;
		const active = failures < maxAttempts;
		const watch = { active, intervalMs, expiresAt, lastRunAt: Date.now(), nextRunAt: active ? Date.now() + intervalMs : undefined, failures, maxAttempts, paused: !active, pauseReason: active ? undefined : "max_attempts", lastFailure: firstFailure(applied), recoveries: recoveryCount(applied) };
		this.storeValue.updateWatch(applied.orchestrationId, watch);
		if (active) this.scheduleWatch(applied.orchestrationId, desiredState, { ...options, intervalMs, ttlMs, maxAttempts, expiresAt });
		return { ...applied, action: "watch", watch };
	}

	async stop(orchestrationId: string, options: BrowserOrchestrationRunOptions = {}): Promise<BrowserOrchestrationStopResult> {
		const stopped = this.stopWatch(orchestrationId);
		let state = this.storeValue.updateWatch(orchestrationId, stopped ? { active: false, paused: true, pauseReason: "stopped" } : this.storeValue.get(orchestrationId)?.watch ? { active: false, paused: true, pauseReason: "not_running" } : undefined);
		const operations = state ? this.preNavigationCleanupOperations(state, "uninstall pre-navigation hooks on stop") : [];
		const cleanup = operations.length ? await this.executor.executeOperations(operations, { timeoutMs: options.timeoutMs }) : { operationResults: [], failures: [] };
		state = this.storeValue.get(orchestrationId);
		return { ok: cleanup.failures.length === 0, action: "stop", orchestrationId, stopped, operationResults: cleanup.operationResults, failures: cleanup.failures, state };
	}

	async delete(orchestrationId: string, options: BrowserOrchestrationRunOptions = {}): Promise<BrowserOrchestrationApplyResult> {
		return await this.locks.runExclusive(`orchestration:${orchestrationId}`, "delete", async () => {
			const state = this.storeValue.get(orchestrationId);
			if (!state) return { ok: false, action: "delete", orchestrationId, generation: "missing", converged: false, bindings: [], operationResults: [], failures: [{ code: "ORCHESTRATION_SESSION_NOT_FOUND", message: "Orchestration state is not found", retryable: false, details: { orchestrationId } }] };
			this.stopWatch(orchestrationId);
			const operations = this.cleanupOperations(state);
			const result = await this.executor.executeCleanup(orchestrationId, operations, { timeoutMs: options.timeoutMs });
			this.storeValue.remove(orchestrationId);
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
			try {
				const result = await this.delete(state.orchestrationId, { timeoutMs: options.timeoutMs || 5_000 });
				if (result.ok) deleted.push(state.orchestrationId);
				else failures.push({ orchestrationId: state.orchestrationId, failures: result.failures });
			} catch (error) {
				failures.push({ orchestrationId: state.orchestrationId, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return { ok: failures.length === 0, deleted, failures };
	}

	snapshot(): JsonRecord {
		return {
			states: this.storeValue.snapshot(),
			stateCount: this.storeValue.list().length,
			watchCount: this.watchTimers.size,
			locks: this.locks.snapshot(),
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
		return operations;
	}
}

export { ORCHESTRATION_ERROR_CODES };
