import { redactDesired, stripCookieValuesFromDesired } from "./orchestrationRedaction";
import type {
	BrowserOrchestrationActual,
	BrowserOrchestrationApplyResult,
	BrowserOrchestrationPlan,
	BrowserOrchestrationPlanSummary,
	BrowserOrchestrationResultSummary,
	NormalizedBrowserOrchestrationDesired,
	OrchestrationBinding,
	OrchestrationRuntimeState,
} from "./types";

function nowMs(): number {
	return Date.now();
}

export function bindingKey(sessionTag: string, tabRole: string): string {
	return `${sessionTag}:${tabRole}`;
}

export function summarizePlan(plan: BrowserOrchestrationPlan): BrowserOrchestrationPlanSummary {
	const operationsByPhase: Record<string, number> = {};
	for (const op of plan.operations) operationsByPhase[op.phase] = (operationsByPhase[op.phase] || 0) + 1;
	return { operationCount: plan.operations.length, operationsByPhase, converged: plan.converged };
}

export function summarizeResult(result: BrowserOrchestrationApplyResult): BrowserOrchestrationResultSummary {
	return { ok: result.ok, converged: result.converged, operationCount: result.operationResults.length, failureCount: result.failures.length, updatedAt: nowMs() };
}

export class OrchestrationStore {
	private readonly states = new Map<string, OrchestrationRuntimeState>();
	private readonly desiredById = new Map<string, NormalizedBrowserOrchestrationDesired>();

	list(): OrchestrationRuntimeState[] {
		return Array.from(this.states.values()).map((state) => this.cloneState(state));
	}

	get(orchestrationId: string): OrchestrationRuntimeState | undefined {
		const state = this.states.get(orchestrationId);
		return state ? this.cloneState(state) : undefined;
	}

	getDesired(orchestrationId: string): NormalizedBrowserOrchestrationDesired | undefined {
		const desired = this.desiredById.get(orchestrationId);
		return desired ? structuredClone(desired) : undefined;
	}

	upsertDesired(desired: NormalizedBrowserOrchestrationDesired): OrchestrationRuntimeState {
		const current = this.states.get(desired.orchestrationId);
		const now = nowMs();
		const state: OrchestrationRuntimeState = current ? {
			...current,
			generation: desired.generation,
			desiredHash: desired.desiredHash,
			updatedAt: now,
			deletedAt: undefined,
			cleanupOnFailure: desired.defaults.cleanupOnFailure,
			closeOwnedTabsOnDelete: desired.isolation.closeOwnedTabsOnDelete,
			redactedDesired: redactDesired(desired),
		} : {
			orchestrationId: desired.orchestrationId,
			generation: desired.generation,
			desiredHash: desired.desiredHash,
			createdAt: now,
			updatedAt: now,
			cleanupOnFailure: desired.defaults.cleanupOnFailure,
			closeOwnedTabsOnDelete: desired.isolation.closeOwnedTabsOnDelete,
			bindings: [],
			redactedDesired: redactDesired(desired),
		};
		this.states.set(desired.orchestrationId, state);
		this.desiredById.set(desired.orchestrationId, stripCookieValuesFromDesired(desired));
		return this.cloneState(state);
	}

	setBinding(orchestrationId: string, binding: OrchestrationBinding): void {
		const state = this.states.get(orchestrationId);
		if (!state) return;
		const key = bindingKey(binding.sessionTag, binding.tabRole);
		const updated = { ...binding, updatedAt: nowMs() };
		const index = state.bindings.findIndex((item) => bindingKey(item.sessionTag, item.tabRole) === key);
		if (index >= 0) state.bindings.splice(index, 1, updated);
		else state.bindings.push(updated);
		state.updatedAt = nowMs();
	}

	removeBinding(orchestrationId: string, sessionTag: string, tabRole: string): void {
		const state = this.states.get(orchestrationId);
		if (!state) return;
		const key = bindingKey(sessionTag, tabRole);
		state.bindings = state.bindings.filter((item) => bindingKey(item.sessionTag, item.tabRole) !== key);
		state.updatedAt = nowMs();
	}

	binding(orchestrationId: string, sessionTag: string, tabRole: string): OrchestrationBinding | undefined {
		return this.states.get(orchestrationId)?.bindings.find((item) => item.sessionTag === sessionTag && item.tabRole === tabRole);
	}

	findBindingByTab(browserId: string | undefined, tabId: number | undefined): { orchestrationId: string; binding: OrchestrationBinding } | undefined {
		if (!browserId || !tabId) return undefined;
		for (const [orchestrationId, state] of this.states.entries()) {
			for (const binding of state.bindings) {
				if (binding.browserId === browserId && binding.tabId === tabId) return { orchestrationId, binding };
			}
		}
		return undefined;
	}

	markActual(orchestrationId: string, actual: BrowserOrchestrationActual): void {
		const state = this.states.get(orchestrationId);
		if (!state) return;
		state.lastActual = actual;
		state.workerBootId = actual.bridge.workerBootId;
		state.updatedAt = nowMs();
	}

	markPlan(orchestrationId: string, plan: BrowserOrchestrationPlan): void {
		const state = this.states.get(orchestrationId);
		if (!state) return;
		state.lastPlan = summarizePlan(plan);
		state.updatedAt = nowMs();
	}

	markResult(orchestrationId: string, result: BrowserOrchestrationApplyResult): void {
		const state = this.states.get(orchestrationId);
		if (!state) return;
		state.lastResult = summarizeResult(result);
		state.lastFailures = result.failures;
		state.updatedAt = nowMs();
	}

	updateWatch(orchestrationId: string, update: Partial<NonNullable<OrchestrationRuntimeState["watch"]>> | undefined): OrchestrationRuntimeState | undefined {
		const state = this.states.get(orchestrationId);
		if (!state) return undefined;
		state.watch = update ? { active: true, intervalMs: 0, expiresAt: 0, failures: 0, ...(state.watch || {}), ...update } : undefined;
		state.updatedAt = nowMs();
		return this.cloneState(state);
	}

	remove(orchestrationId: string): OrchestrationRuntimeState | undefined {
		const state = this.states.get(orchestrationId);
		if (!state) return undefined;
		this.states.delete(orchestrationId);
		this.desiredById.delete(orchestrationId);
		return this.cloneState({ ...state, deletedAt: nowMs(), updatedAt: nowMs() });
	}

	snapshot(): Array<Record<string, unknown>> {
		return Array.from(this.states.values()).map((state) => ({
			orchestrationId: state.orchestrationId,
			generation: state.generation,
			desiredHash: state.desiredHash,
			createdAt: state.createdAt,
			updatedAt: state.updatedAt,
			workerBootId: state.workerBootId,
			watch: state.watch ? { active: state.watch.active, paused: state.watch.paused, intervalMs: state.watch.intervalMs, expiresAt: state.watch.expiresAt, nextRunAt: state.watch.nextRunAt, failures: state.watch.failures, maxAttempts: state.watch.maxAttempts, pauseReason: state.watch.pauseReason, lastFailure: state.watch.lastFailure, recoveries: state.watch.recoveries } : undefined,
			bindings: state.bindings.map((binding) => ({ sessionTag: binding.sessionTag, tabRole: binding.tabRole, browserId: binding.browserId, tabId: binding.tabId, windowId: binding.windowId, windowOwned: binding.windowOwned, groupId: binding.groupId, tabGroupsStatus: binding.tabGroupsStatus, owned: binding.owned, desiredUrl: binding.desiredUrl, networkSessionId: binding.networkSessionId, hookSessionId: binding.hookSessionId, preNavigationHooks: binding.preNavigationHooks?.map((hook) => ({ hookId: hook.hookId, version: hook.version, hash: hook.hash, identifier: hook.identifier, cdpSessionName: hook.cdpSessionName, effectVerifiedAt: hook.effectVerifiedAt, workerBootId: hook.workerBootId })), preNavigationHookDegraded: binding.preNavigationHookDegraded?.map((hook) => ({ hookId: hook.hookId, version: hook.version, hash: hook.hash, code: hook.code, updatedAt: hook.updatedAt })), workerBootId: binding.workerBootId })),
			lastResult: state.lastResult,
		}));
	}

	clear(): void {
		this.states.clear();
		this.desiredById.clear();
	}

	private cloneState(state: OrchestrationRuntimeState): OrchestrationRuntimeState {
		return structuredClone(state);
	}
}
