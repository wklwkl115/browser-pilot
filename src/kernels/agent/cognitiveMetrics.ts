/**
 * Pure cognitive metrics aggregation for agent fixture baselines.
 */

export type AgentCognitiveMetrics = {
	routineTaskSuccessRate: number;
	criticalActionableRecall: number;
	blockingControlRecall: number;
	expandedDownDrillRate: number;
	expertEscalationRate: number;
	visibleToolCount: number;
	publicCalls: number;
	schemaLookups: number;
	explicitReadinessCalls: number;
	opaqueMechanicalIdsCarried: number;
	rawJavaScriptFallbacks: number;
	lowLevelProgramFallbacks: number;
	artifactPathHops: number;
	mechanicalRecoveriesExposed: number;
	automaticSafeRecoveries: number;
	mutationReplayAttempts: number;
	defaultResponseChars: number;
	defaultResponseEstimatedTokens: number;
	tasks: number;
	steps: number;
	l0Hits: number;
	l0Required: number;
	blockingHits: number;
	blockingRequired: number;
};

export type FixtureStepLabel = {
	requiredActionableRefs?: string[];
	blockingControlRefs?: string[];
	surfaceClass?: string;
};

export type FixtureStepObservation = {
	returnedResourceRefs: string[];
	publicCalls: number;
	schemaLookups?: number;
	explicitReadinessCalls?: number;
	opaqueMechanicalIdsCarried?: number;
	rawJavaScriptFallbacks?: number;
	mutationReplayAttempts?: number;
	defaultResponseChars?: number;
	defaultResponseEstimatedTokens?: number;
	expandedDownDrill?: boolean;
	expertEscalation?: boolean;
	taskSuccess?: boolean;
};

export function emptyCognitiveMetrics(overrides: Partial<AgentCognitiveMetrics> = {}): AgentCognitiveMetrics {
	return {
		routineTaskSuccessRate: 0,
		criticalActionableRecall: 1,
		blockingControlRecall: 1,
		expandedDownDrillRate: 0,
		expertEscalationRate: 0,
		visibleToolCount: 3,
		publicCalls: 0,
		schemaLookups: 0,
		explicitReadinessCalls: 0,
		opaqueMechanicalIdsCarried: 1,
		rawJavaScriptFallbacks: 0,
		lowLevelProgramFallbacks: 0,
		artifactPathHops: 0,
		mechanicalRecoveriesExposed: 0,
		automaticSafeRecoveries: 0,
		mutationReplayAttempts: 0,
		defaultResponseChars: 0,
		defaultResponseEstimatedTokens: 0,
		tasks: 0,
		steps: 0,
		l0Hits: 0,
		l0Required: 0,
		blockingHits: 0,
		blockingRequired: 0,
		...overrides,
	};
}

export function accumulateFixtureStep(
	metrics: AgentCognitiveMetrics,
	label: FixtureStepLabel,
	obs: FixtureStepObservation,
): AgentCognitiveMetrics {
	const returned = new Set(obs.returnedResourceRefs);
	const required = label.requiredActionableRefs ?? [];
	const blocking = label.blockingControlRefs ?? [];
	const l0Hits = required.filter((ref) => returned.has(ref)).length;
	const blockingHits = blocking.filter((ref) => returned.has(ref)).length;

	const next: AgentCognitiveMetrics = {
		...metrics,
		publicCalls: metrics.publicCalls + obs.publicCalls,
		schemaLookups: metrics.schemaLookups + (obs.schemaLookups ?? 0),
		explicitReadinessCalls: metrics.explicitReadinessCalls + (obs.explicitReadinessCalls ?? 0),
		opaqueMechanicalIdsCarried: Math.max(metrics.opaqueMechanicalIdsCarried, obs.opaqueMechanicalIdsCarried ?? 1),
		rawJavaScriptFallbacks: metrics.rawJavaScriptFallbacks + (obs.rawJavaScriptFallbacks ?? 0),
		mutationReplayAttempts: metrics.mutationReplayAttempts + (obs.mutationReplayAttempts ?? 0),
		defaultResponseChars: Math.max(metrics.defaultResponseChars, obs.defaultResponseChars ?? 0),
		defaultResponseEstimatedTokens: Math.max(metrics.defaultResponseEstimatedTokens, obs.defaultResponseEstimatedTokens ?? 0),
		steps: metrics.steps + 1,
		l0Hits: metrics.l0Hits + l0Hits,
		l0Required: metrics.l0Required + required.length,
		blockingHits: metrics.blockingHits + blockingHits,
		blockingRequired: metrics.blockingRequired + blocking.length,
		tasks: metrics.tasks + (obs.taskSuccess !== undefined ? 1 : 0),
		routineTaskSuccessRate: metrics.routineTaskSuccessRate,
	};

	if (obs.expandedDownDrill) next.expandedDownDrillRate = metrics.expandedDownDrillRate + 1;
	if (obs.expertEscalation) next.expertEscalationRate = metrics.expertEscalationRate + 1;
	if (obs.taskSuccess === true) next.routineTaskSuccessRate = metrics.routineTaskSuccessRate + 1;

	return finalizeRates(next);
}

function finalizeRates(m: AgentCognitiveMetrics): AgentCognitiveMetrics {
	const steps = Math.max(1, m.steps);
	return {
		...m,
		criticalActionableRecall: m.l0Required === 0 ? 1 : m.l0Hits / m.l0Required,
		blockingControlRecall: m.blockingRequired === 0 ? 1 : m.blockingHits / m.blockingRequired,
		expandedDownDrillRate: m.expandedDownDrillRate > 1 ? m.expandedDownDrillRate / steps : m.expandedDownDrillRate / steps,
		expertEscalationRate: m.expertEscalationRate > 1 || m.expertEscalationRate === 0
			? m.expertEscalationRate / steps
			: m.expertEscalationRate / steps,
		routineTaskSuccessRate: m.tasks === 0 ? 0 : m.routineTaskSuccessRate / m.tasks,
	};
}

export function hardGatesPass(metrics: AgentCognitiveMetrics): { ok: boolean; failures: string[] } {
	const failures: string[] = [];
	if (metrics.mutationReplayAttempts !== 0) failures.push("mutationReplayAttempts!=0");
	if (metrics.blockingControlRecall < 1 && metrics.blockingRequired > 0) failures.push("blockingControlRecall<1");
	return { ok: failures.length === 0, failures };
}
