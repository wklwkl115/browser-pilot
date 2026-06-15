export const COMPACTION_TUNING = {
	jsonProjectionDefaultBudget: 8_000,
	jsonProjectionTemplateBudgetRatio: 0.65,
	jsonProjectionRenderBudgetRatio: 0.75,
} as const;

export function assertCompactionTuningBounds(): true {
	if (COMPACTION_TUNING.jsonProjectionDefaultBudget < 1_000 || COMPACTION_TUNING.jsonProjectionDefaultBudget > 32_000) throw new Error("json projection default budget must stay bounded");
	if (COMPACTION_TUNING.jsonProjectionTemplateBudgetRatio <= 0 || COMPACTION_TUNING.jsonProjectionTemplateBudgetRatio > 0.9) throw new Error("json projection template budget ratio must stay below the root budget");
	if (COMPACTION_TUNING.jsonProjectionRenderBudgetRatio <= COMPACTION_TUNING.jsonProjectionTemplateBudgetRatio || COMPACTION_TUNING.jsonProjectionRenderBudgetRatio > 0.95) throw new Error("json projection render budget ratio must leave frontier/metadata headroom");
	return true;
}
