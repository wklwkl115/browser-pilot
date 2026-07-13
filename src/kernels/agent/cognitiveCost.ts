import { jsonCost, type CostVector } from "../evidence/cost.js";
import { AGENT_CONTEXT_BOUNDS } from "./agentTypes.js";

export function measureAgentPayloadCost(value: unknown): CostVector {
	return jsonCost(value);
}

export function withinL0Budget(cost: CostVector, maxChars = AGENT_CONTEXT_BOUNDS.l0MaxChars): boolean {
	return cost.chars <= maxChars;
}

export type AgentCognitiveMetrics = {
	visibleToolCount: number;
	publicCalls: number;
	schemaLookups: number;
	explicitReadinessCalls: number;
	opaqueMechanicalIdsCarried: number;
	rawJavaScriptFallbacks: number;
	artifactPathHops: number;
	mutationReplayAttempts: number;
	defaultResponseChars: number;
	defaultResponseEstimatedTokens: number;
};

export function emptyCognitiveMetrics(overrides: Partial<AgentCognitiveMetrics> = {}): AgentCognitiveMetrics {
	return {
		visibleToolCount: 3,
		publicCalls: 0,
		schemaLookups: 0,
		explicitReadinessCalls: 0,
		opaqueMechanicalIdsCarried: 1,
		rawJavaScriptFallbacks: 0,
		artifactPathHops: 0,
		mutationReplayAttempts: 0,
		defaultResponseChars: 0,
		defaultResponseEstimatedTokens: 0,
		...overrides,
	};
}
