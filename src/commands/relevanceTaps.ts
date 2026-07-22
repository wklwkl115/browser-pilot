import { extractScalarTerm, extractStringLiteralTerms, type RelevanceTapTerm } from "../kernels/evidence/distill/relevanceTaps.js";
import { isRecord } from "../utils/records.js";

export type ToolRelevanceTapSpec = {
	params?: Record<string, "scalar" | "jsonPath" | "query" | "ref" | "scriptLiterals">;
};

export const TOOL_RELEVANCE_TAPS: Record<string, ToolRelevanceTapSpec> = {
	browser_execute: { params: { script: "scriptLiterals" } },
	browser_artifact: { params: { jsonPath: "jsonPath", query: "query", path: "scalar" } },
	browser_observe: { params: { actionRef: "ref", intent: "scalar" } },
};

function termsForValue(value: unknown, mode: NonNullable<ToolRelevanceTapSpec["params"]>[string]): RelevanceTapTerm[] {
	if (mode === "scriptLiterals") return extractStringLiteralTerms(value);
	if (mode === "jsonPath") return extractScalarTerm(value, "jsonPath", 1.25);
	if (mode === "query") return extractScalarTerm(value, "query", 1.2);
	if (mode === "ref") return extractScalarTerm(value, "ref", 1.1);
	return extractScalarTerm(value, "literal", 1);
}

export function extractToolRelevanceTerms(commandName: string, params: unknown): RelevanceTapTerm[] {
	const spec = TOOL_RELEVANCE_TAPS[commandName];
	if (!spec || !isRecord(params)) return [];
	const terms: RelevanceTapTerm[] = [];
	for (const [key, mode] of Object.entries(spec.params ?? {})) terms.push(...termsForValue(params[key], mode));
	return terms.slice(0, 12);
}
