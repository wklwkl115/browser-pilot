export const RELEVANCE_TUNING = {
	maxTerms: 32,
	maxScore: 1000,
	directMatch: 140,
	selectorMatch: 190,
	urlMatch: 120,
	intentMatch: 180,
	memoryMatch: 70,
	maxMemoryTerms: 8,
	traceHalfLifeCalls: 6,
	containerPropagation: 0.5,
	relationPropagation: 0.25,
	fieldWeights: {
		name: 1,
		role: 0.55,
		container: 0.7,
		landmark: 0.65,
		value: 0.45,
		selector: 0.9,
		href: 0.75,
	},
} as const;

export function assertRelevanceTuningBounds(): true {
	if (RELEVANCE_TUNING.maxTerms < 1 || RELEVANCE_TUNING.maxTerms > 64) throw new Error("relevance maxTerms must stay bounded");
	if (RELEVANCE_TUNING.maxMemoryTerms < 0 || RELEVANCE_TUNING.maxMemoryTerms > 8) throw new Error("memory relevance terms must stay sub-capped");
	if (RELEVANCE_TUNING.maxScore < 100 || RELEVANCE_TUNING.maxScore > 2000) throw new Error("relevance maxScore must stay bounded");
	if (RELEVANCE_TUNING.memoryMatch > RELEVANCE_TUNING.directMatch) throw new Error("memory relevance must not outrank direct live signals");
	if (RELEVANCE_TUNING.containerPropagation <= 0 || RELEVANCE_TUNING.containerPropagation > 0.75) throw new Error("container propagation must stay conservative");
	if (RELEVANCE_TUNING.relationPropagation <= 0 || RELEVANCE_TUNING.relationPropagation > 0.5) throw new Error("relation propagation must stay conservative");
	return true;
}
