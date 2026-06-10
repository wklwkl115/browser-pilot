export type FactPlane = "entity" | "outline" | "relation" | "causal" | "diff" | "treeDiff" | "snapshot" | "identity" | "summary" | "diagnostic";

export type FactSalience = {
	actionability?: number;
	novelty?: number;
	consequence?: number;
	structure?: number;
	relevance?: number;
};

export type FactGranularity = "full" | "compact" | "line" | "ref" | "omit";

export type FactRendering = {
	value?: unknown;
	text?: string;
	cost: number;
};

export type Fact = {
	ref: string;
	plane: FactPlane;
	salience: FactSalience;
	renderings: Partial<Record<Exclude<FactGranularity, "omit">, FactRendering>>;
};

export type RenderPlan = Map<string, FactGranularity>;

export type PlaneFloor = {
	plane: FactPlane;
	minFacts?: number;
	maxFacts?: number;
	minGranularity?: Exclude<FactGranularity, "omit">;
};

export type AllocationOptions = {
	minDensity?: number;
};

export function salienceValue(salience: FactSalience): number {
	return (salience.actionability || 0) + (salience.novelty || 0) + (salience.consequence || 0) + (salience.structure || 0) + (salience.relevance || 0);
}
