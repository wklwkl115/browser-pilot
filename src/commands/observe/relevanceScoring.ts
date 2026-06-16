import { computeRelevanceMap } from "../../kernels/evidence/distill/relevance.js";
import type { ObserveRelevanceInput, ObserveRelevanceResult, ObserveRelevanceTerm } from "./relevanceTypes.js";

export function computeObserveRelevanceMap(inputs: ObserveRelevanceInput[], terms: ObserveRelevanceTerm[]): ObserveRelevanceResult {
	return computeRelevanceMap(inputs, terms);
}
