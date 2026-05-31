import { Buffer } from "node:buffer";
import { createCodedError } from "../../../utils/codedError.js";
import { compactStep, extractTitle, normalizeHeaders, normalizeProbeTargets, responseBodyHash } from "../shared/http.js";
import { normalizeMethod, positiveInt, sleep } from "../shared/normalize.js";
import { buildReplayRequest, normalizeReplayOptions, requestContentType, sendReplayLikeRequest } from "../shared/replay.js";
import { dedupeTemplateResults, evaluateTemplateMatcher, loadTemplateDefinitions, templateTargetsForBase, type TemplateDefinition } from "../shared/template.js";
import type { ReplayRequest, TemplateCheckOptions } from "../shared/types.js";

export type NormalizedTemplateCheckOptions = ReturnType<typeof normalizeReplayOptions> & {
	rawOrCaptured: boolean;
	baseTargets: string[];
	templates: TemplateDefinition[];
	rateLimitPerSecond: number;
	delayMs: number;
	maxRequests: number;
};

function templateCheckInputError(message: string, details: Record<string, unknown> = {}): Error {
	return createCodedError({ name: "TemplateCheckInputError", code: "INVALID_RULE", message, details, suppressStack: false });
}

async function normalizeTemplateCheckOptions(options: TemplateCheckOptions): Promise<NormalizedTemplateCheckOptions> {
	const rawOrCaptured = options.rawRequest !== undefined || options.request !== undefined;
	const baseTargets = rawOrCaptured ? [buildReplayRequest(options).url] : normalizeProbeTargets({ url: options.url, urls: options.urls, paths: options.paths, defaultScheme: options.defaultScheme });
	const templates = (await loadTemplateDefinitions(options)).slice(0, Math.min(1_000, positiveInt(options.maxTemplates, 100)));
	if (!templates.length) throw templateCheckInputError("browser_template_check requires built-in templateIds, templates, or templatePath with at least one template", { field: "templateIds|templates|templatePath" });
	const rateLimitPerSecond = positiveInt(options.rateLimitPerSecond, 0);
	return {
		...normalizeReplayOptions(options),
		rawOrCaptured,
		baseTargets,
		templates,
		rateLimitPerSecond,
		delayMs: rateLimitPerSecond > 0 ? Math.ceil(1000 / rateLimitPerSecond) : 0,
		maxRequests: Math.min(10_000, positiveInt(options.maxRequests, 2_000)),
	};
}

function createTemplateRequest(options: TemplateCheckOptions, normalized: NormalizedTemplateCheckOptions, template: TemplateDefinition, target: string): ReplayRequest {
	if (normalized.rawOrCaptured) return buildReplayRequest({ ...options, url: target });
	const baseRequest: ReplayRequest = {
		url: target,
		method: normalizeMethod(template.method ?? options.method, "GET"),
		headers: { ...normalizeHeaders(options.headers), ...normalizeHeaders(template.headers) },
		body: template.bodyBase64 ? Buffer.from(template.bodyBase64, "base64") : template.body,
	};
	if (template.body !== undefined && !requestContentType(baseRequest.headers)) baseRequest.headers["Content-Type"] = "application/x-www-form-urlencoded";
	return baseRequest;
}

export async function runTemplateCheck(options: TemplateCheckOptions) {
	const normalized = await normalizeTemplateCheckOptions(options);
	const results: Array<Record<string, unknown>> = [];
	const failures: Array<Record<string, unknown>> = [];
	let requestCount = 0;
	let truncatedRequests = 0;
	for (const baseUrl of normalized.baseTargets) {
		for (const template of normalized.templates) {
			for (const target of templateTargetsForBase(baseUrl, template, options.variables)) {
				if (requestCount >= normalized.maxRequests) {
					truncatedRequests += 1;
					continue;
				}
				try {
					const baseRequest = createTemplateRequest(options, normalized, template, target);
					const replay = await sendReplayLikeRequest(baseRequest, normalized);
					const final = replay.exchange.final;
					const evaluation = evaluateTemplateMatcher(template, final);
					results.push({
						matched: evaluation.matched,
						templateId: template.id,
						name: template.name,
						tags: template.tags,
						url: final.url,
						method: baseRequest.method,
						status: final.status,
						title: extractTitle(final.bodyText),
						bodyBytes: final.bodyBytes,
						bodySha256: responseBodyHash(final),
						bodyTruncated: final.bodyTruncated,
						matcherMode: evaluation.mode,
						checks: evaluation.checks,
						extracts: evaluation.extracts,
						redirects: replay.exchange.chain.slice(0, -1).map(compactStep),
						body: { text: final.bodyText, base64: final.bodyBase64 },
					});
				} catch (error) {
					failures.push({ templateId: template.id, url: target, error: error instanceof Error ? error.message : String(error) });
				}
				requestCount += 1;
				if (normalized.delayMs > 0 && requestCount < normalized.maxRequests) await sleep(normalized.delayMs);
			}
		}
	}
	const uniqueResults = dedupeTemplateResults(results);
	const matched = uniqueResults.filter((item) => item.matched === true);
	return { ok: failures.length === 0, generatedAt: new Date().toISOString(), targetCount: normalized.baseTargets.length, templateCount: normalized.templates.length, requestCount, matchedCount: matched.length, resultCount: uniqueResults.length, rawResultCount: results.length, deduplicatedResults: results.length - uniqueResults.length, truncatedRequests, maxRequests: normalized.maxRequests, templateIds: normalized.templates.map((item) => item.id), results: uniqueResults, matched, failures };
}
