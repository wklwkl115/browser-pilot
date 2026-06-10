import { extractScalarTerm, extractStringLiteralTerms, extractUrlTerms, type RelevanceTapTerm } from "../distill-core/relevanceTaps.js";
import { isRecord } from "../utils/records.js";

export type ToolRelevanceTapSpec = {
	params?: Record<string, "scalar" | "url" | "jsonPath" | "query" | "ref" | "scriptLiterals">;
	nestedParams?: Record<string, "scalar" | "url" | "jsonPath" | "query" | "ref">;
};

export const TOOL_RELEVANCE_TAPS: Record<string, ToolRelevanceTapSpec> = {
	browser_execute: { params: { script: "scriptLiterals" } },
	browser_artifact: { params: { jsonPath: "jsonPath", query: "query", path: "scalar" } },
	browser_observe: { params: { url: "url", selector: "scalar", actionRef: "ref" }, nestedParams: { intent: "scalar" } },
	browser_wait: { params: { url: "url", selector: "scalar" } },
	browser_network: { params: { sessionId: "scalar" } },
	browser_hook: { params: { selector: "scalar", eventType: "scalar" } },
	browser_frame: { params: { selector: "scalar", frameId: "scalar" } },
	browser_pick: { params: { message: "scalar" } },
};

function termsForValue(value: unknown, mode: NonNullable<ToolRelevanceTapSpec["params"]>[string]): RelevanceTapTerm[] {
	if (mode === "scriptLiterals") return extractStringLiteralTerms(value);
	if (mode === "url") return extractUrlTerms(value);
	if (mode === "jsonPath") return extractScalarTerm(value, "jsonPath", 1.25);
	if (mode === "query") return extractScalarTerm(value, "query", 1.2);
	if (mode === "ref") return extractScalarTerm(value, "ref", 1.1);
	return extractScalarTerm(value, "literal", 1);
}

export function extractToolRelevanceTerms(toolName: string, params: unknown): RelevanceTapTerm[] {
	const spec = TOOL_RELEVANCE_TAPS[toolName];
	if (!spec || !isRecord(params)) return [];
	const terms: RelevanceTapTerm[] = [];
	for (const [key, mode] of Object.entries(spec.params ?? {})) terms.push(...termsForValue(params[key], mode));
	const nested = isRecord(params.params) ? params.params : undefined;
	if (nested) for (const [key, mode] of Object.entries(spec.nestedParams ?? {})) terms.push(...termsForValue(nested[key], mode));
	return terms.slice(0, 12);
}
