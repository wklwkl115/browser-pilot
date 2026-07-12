export type OptionalObserveProvider = "causal" | "axe" | "readability";
export type RecorderKnowledge = "active" | "inactive" | "unknown";

export interface ObserveProviderPlanItem {
	provider: OptionalObserveProvider;
	planned: boolean;
	reservedMs: number;
	reason: "planned" | "not-required" | "budget-preflight";
}

export interface ObserveProviderPlan {
	deadlineAt: number;
	renderReserveMs: number;
	optionalBudgetMs: number;
	statusProbe: {
		planned: boolean;
		reservedMs: number;
		reason: "planned" | "not-required" | "known-state" | "budget-preflight";
	};
	items: Record<OptionalObserveProvider, ObserveProviderPlanItem>;
}

export function buildObserveProviderPlan(input: {
	now: number;
	startedAt: number;
	deadlineAt: number;
	mode: "scan" | "text" | "tabs";
	cacheHit: boolean;
	outputBudgetChars: number;
	hasBaseline: boolean;
	baselineHasNetworkSeq: boolean;
	baselineHasHookSeq: boolean;
	networkState: RecorderKnowledge;
	hookState: RecorderKnowledge;
	axeRequested: boolean;
	readabilityRequested: boolean;
}): ObserveProviderPlan {
	const totalMs = Math.max(0, input.deadlineAt - input.startedAt);
	const remainingMs = Math.max(0, input.deadlineAt - input.now);
	const renderReserveMs = Math.min(remainingMs, Math.max(500, Math.ceil(totalMs * 0.1)));
	const optionalBudgetMs = Math.max(0, remainingMs - renderReserveMs);
	const eligible = input.mode === "scan" && !input.cacheHit && input.outputBudgetChars > 0;
	const requested: Record<OptionalObserveProvider, boolean> = {
		causal: eligible && input.hasBaseline,
		axe: eligible && input.axeRequested,
		readability: eligible && input.readabilityRequested,
	};
	const weights: Record<OptionalObserveProvider, number> = { causal: 2, axe: 1, readability: 1 };
	const items = Object.fromEntries((Object.keys(requested) as OptionalObserveProvider[]).map((provider) => {
		const reservedMs = Math.max(0, Math.floor(optionalBudgetMs * weights[provider] / 4));
		const desired = requested[provider];
		const planned = desired && reservedMs >= 500;
		return [provider, {
			provider,
			planned,
			reservedMs,
			reason: !desired ? "not-required" : planned ? "planned" : "budget-preflight",
		} satisfies ObserveProviderPlanItem];
	})) as Record<OptionalObserveProvider, ObserveProviderPlanItem>;
	const statusUnknown = input.baselineHasNetworkSeq && input.networkState === "unknown"
		|| input.baselineHasHookSeq && input.hookState === "unknown";
	const causal = items.causal;
	const probePlanned = causal.planned && statusUnknown;
	const statusProbe = {
		planned: probePlanned,
		reservedMs: probePlanned ? Math.min(500, causal.reservedMs) : 0,
		reason: !requested.causal ? "not-required" as const
			: !causal.planned ? "budget-preflight" as const
				: statusUnknown ? "planned" as const : "known-state" as const,
	};
	return { deadlineAt: input.deadlineAt, renderReserveMs, optionalBudgetMs, statusProbe, items };
}
