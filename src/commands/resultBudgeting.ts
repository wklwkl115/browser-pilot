import { fitEnvelopeBudget as fitEvidenceEnvelopeBudget, fitSummaryBudget as fitEvidenceSummaryBudget, SUMMARY_MAX_CHARS } from "../kernels/evidence/distill/ladder.js";
import type { DistilledEnvelope, DistilledSummary } from "./resultTypes.js";

export { SUMMARY_MAX_CHARS };

export function fitCommandSummaryBudget(summary: DistilledSummary, budget: number): DistilledSummary {
	return fitEvidenceSummaryBudget(summary, budget);
}

export function fitCommandEnvelopeBudget<T extends DistilledEnvelope>(envelope: T, maxChars: number): T {
	return fitEvidenceEnvelopeBudget(envelope, maxChars);
}
