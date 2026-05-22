import { asArray, isRecord, summaryTable, type Summary } from "./common";

function countBy<T extends Record<string, unknown>>(items: T[], key: keyof T): Record<string, number> {
	const out: Record<string, number> = {};
	for (const item of items) {
		const value = String(item[key] || "unknown");
		out[value] = (out[value] || 0) + 1;
	}
	return out;
}

function compactFailures(value: unknown): unknown[] {
	return asArray(value).slice(0, 8).map((item) => {
		if (!isRecord(item)) return item;
		return { operationId: item.operationId, code: item.code, message: item.message, retryable: item.retryable };
	});
}

function compactBindings(value: unknown): unknown {
	const bindings = asArray(value).filter(isRecord);
	return summaryTable(bindings, [
		{ key: "session", value: (item) => item.sessionTag },
		{ key: "role", value: (item) => item.tabRole },
		{ key: "tabId", value: (item) => item.tabId },
		{ key: "windowId", value: (item) => item.windowId },
		{ key: "windowOwned", value: (item) => item.windowOwned },
		{ key: "groupId", value: (item) => item.groupId },
		{ key: "tabGroupsStatus", value: (item) => item.tabGroupsStatus },
		{ key: "preNavigationHookCount", value: (item) => Array.isArray(item.preNavigationHooks) ? item.preNavigationHooks.length : undefined },
		{ key: "preNavigationHookDegradedCount", value: (item) => Array.isArray(item.preNavigationHookDegraded) ? item.preNavigationHookDegraded.length : undefined },
		{ key: "owned", value: (item) => item.owned },
		{ key: "url", value: (item) => item.desiredUrl },
	], 12);
}

function planSummary(plan: unknown): Record<string, unknown> {
	if (!isRecord(plan)) return {};
	const operations = asArray(plan.operations).filter(isRecord);
	return {
		operationCount: typeof plan.operationCount === "number" ? plan.operationCount : operations.length,
		operationsByPhase: isRecord(plan.operationsByPhase) ? plan.operationsByPhase : countBy(operations, "phase"),
		converged: plan.converged,
	};
}

function assertionSummary(actual: unknown): Record<string, unknown> {
	const sessions = isRecord(actual) ? asArray(actual.sessions).filter(isRecord) : [];
	const assertionStates = sessions.map((session) => session.sessionAssertions).filter(isRecord);
	const assertionCount = assertionStates.reduce((sum, item) => sum + (typeof item.total === "number" ? item.total : 0), 0);
	const assertionPassedCount = assertionStates.reduce((sum, item) => sum + (typeof item.passedCount === "number" ? item.passedCount : 0), 0);
	const assertionFailedCount = assertionStates.reduce((sum, item) => sum + (typeof item.failedCount === "number" ? item.failedCount : 0), 0);
	const assertionProbeFailedCount = assertionStates.reduce((sum, item) => sum + (typeof item.probeFailedCount === "number" ? item.probeFailedCount : 0), 0);
	return {
		assertionCount: assertionCount || undefined,
		assertionPassedCount: assertionPassedCount || undefined,
		assertionFailedCount: assertionFailedCount || undefined,
		assertionProbeFailedCount: assertionProbeFailedCount || undefined,
	};
}

export function summarizeOrchestrationData(value: unknown): Summary {
	const payload = isRecord(value) ? value : {};
	const result = isRecord(payload.data) ? payload.data : payload;
	const operations = asArray(result.operationResults ?? (isRecord(result.plan) ? result.plan.operations : undefined)).filter(isRecord);
	const failures = asArray(result.failures).filter(isRecord);
	const states = asArray(result.states).filter(isRecord);
	const state = isRecord(result.state) ? result.state : undefined;
	const plan = planSummary(result.plan);
	const lastResult = isRecord(state?.lastResult) ? state?.lastResult as Record<string, unknown> : undefined;
	const assertions = assertionSummary(result.actual ?? state?.lastActual);
	return {
		action: result.action,
		ok: result.ok,
		orchestrationId: result.orchestrationId ?? state?.orchestrationId,
		generation: result.generation ?? state?.generation,
		desiredHash: result.desiredHash ?? state?.desiredHash,
		converged: result.converged ?? plan.converged ?? lastResult?.converged,
		operationCount: operations.length || plan.operationCount,
		operationsByPhase: operations.length ? countBy(operations, "phase") : plan.operationsByPhase,
		operationsByStatus: operations.length ? countBy(operations, "status") : undefined,
		failureCount: failures.length || (Array.isArray(state?.lastFailures) ? state?.lastFailures.length : undefined),
		failures: compactFailures(failures.length ? failures : state?.lastFailures),
		bindings: compactBindings(result.bindings ?? state?.bindings),
		stateCount: states.length || undefined,
		watch: result.watch ?? state?.watch,
		actualObservedAt: isRecord(result.actual) ? result.actual.observedAt : undefined,
		...assertions,
	};
}
