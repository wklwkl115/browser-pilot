import { extractScalarTerm, extractStringLiteralTerms, type RelevanceTapTerm } from "../kernels/evidence/distill/relevanceTaps.js";
import { isRecord } from "../utils/records.js";

export function extractToolRelevanceTerms(commandName: string, params: unknown): RelevanceTapTerm[] {
	if (!isRecord(params)) return [];
	if (commandName === "browser_execute") return extractStringLiteralTerms(params.script).slice(0, 12);
	if (commandName !== "browser_observe") return [];
	return [
		...extractScalarTerm(params.actionRef, "ref", 1.1),
		...extractScalarTerm(params.intent, "literal", 1),
	].slice(0, 12);
}
