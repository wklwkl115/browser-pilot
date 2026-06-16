import { fitEnvelopeBudget as fitEvidenceEnvelopeBudget, fitSummaryBudget as fitEvidenceSummaryBudget, SUMMARY_MAX_CHARS } from "../kernels/evidence/distill/ladder.js";
import type { CommandBudgetedEnvelope, CommandDistilledSummary } from "./resultTypes.js";

export { SUMMARY_MAX_CHARS };

export function fitCommandSummaryBudget(summary: CommandDistilledSummary, budget: number): CommandDistilledSummary {
	return fitEvidenceSummaryBudget(summary, budget);
}

export function fitCommandEnvelopeBudget<T extends CommandBudgetedEnvelope>(envelope: T, maxChars: number): T {
	return fitEvidenceEnvelopeBudget(envelope, maxChars);
}
