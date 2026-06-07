import { isRecord } from "../utils/records.js";

export const DEPRECATED_AGENT_PARAM_KEYS = [
	"browserSessionId",
	"detailLevel",
	"maxChars",
	"timeoutMs",
	"outputPath",
	"maxBodyBytes",
	"maxDepth",
	"maxPages",
	"maxCases",
	"maxCandidates",
	"maxTemplates",
	"rateLimitPerSecond",
	"timeoutSeconds",
	"harMaxEntries",
	"followRedirects",
	"maxRedirects",
	"defaultScheme",
	"cookieMode",
	"redact",
] as const;

export function stripDeprecatedAgentParams(args: unknown, keys: readonly string[] = DEPRECATED_AGENT_PARAM_KEYS): unknown {
	if (!isRecord(args)) return args;
	const strip = new Set(keys);
	let changed = false;
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (strip.has(key)) {
			changed = true;
			continue;
		}
		next[key] = value;
	}
	return changed ? next : args;
}

export function strippedDeprecatedParamKeys(args: unknown, prepared: unknown, keys: readonly string[] = DEPRECATED_AGENT_PARAM_KEYS): string[] {
	if (!isRecord(args)) return [];
	const preparedKeys = isRecord(prepared) ? new Set(Object.keys(prepared)) : new Set<string>();
	return keys.filter((key) => Object.prototype.hasOwnProperty.call(args, key) && !preparedKeys.has(key));
}

export function withDeprecatedParamStrip<T extends { prepareArguments?: (args: any) => any }>(definition: T, keys: readonly string[] = DEPRECATED_AGENT_PARAM_KEYS): T {
	const originalPrepare = definition.prepareArguments;
	return {
		...definition,
		prepareArguments(args: any) {
			const prepared = originalPrepare ? originalPrepare(args) : args;
			return stripDeprecatedAgentParams(prepared, keys);
		},
	};
}
