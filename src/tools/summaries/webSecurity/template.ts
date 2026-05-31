import { asArray, increment, isRecord, resultItems, summaryTable, topCounts, type Summary } from "./shared.js";

export function summarizeTemplateCheckData(value: unknown): Summary {
	const matched = isRecord(value) ? asArray(value.matched).filter(isRecord) : [];
	const results = resultItems(value);
	const failures = isRecord(value) ? asArray(value.failures).filter(isRecord) : [];
	const templateCounts: Record<string, number> = {};
	const statusCounts: Record<string, number> = {};
	for (const item of results) {
		increment(templateCounts, item.templateId ?? "unknown");
		increment(statusCounts, item.status ?? "unknown");
	}
	return {
		ok: isRecord(value) ? value.ok : undefined,
		targetCount: isRecord(value) ? value.targetCount : undefined,
		templateCount: isRecord(value) ? value.templateCount : undefined,
		requestCount: isRecord(value) ? value.requestCount : undefined,
		truncatedRequests: isRecord(value) ? value.truncatedRequests : undefined,
		matchedCount: matched.length,
		resultCount: isRecord(value) ? value.resultCount : undefined,
		rawResultCount: isRecord(value) ? value.rawResultCount : undefined,
		deduplicatedResults: isRecord(value) ? value.deduplicatedResults : undefined,
		failureCount: failures.length,
		templateCounts: topCounts(templateCounts),
		statusCounts: topCounts(statusCounts),
		matched: summaryTable(matched, [
			{ key: "template", value: (item) => item.templateId },
			{ key: "name", value: (item) => item.name },
			{ key: "url", value: (item) => item.url },
			{ key: "status", value: (item) => item.status },
			{ key: "title", value: (item) => item.title },
			{ key: "bodyBytes", value: (item) => item.bodyBytes },
			{ key: "bodySha256", value: (item) => item.bodySha256 },
			{ key: "checks", value: (item) => Array.isArray(item.checks) ? item.checks.filter((check) => isRecord(check) && check.matched === true).length : 0 },
			{ key: "extracts", value: (item) => Array.isArray(item.extracts) ? item.extracts.length : 0 },
			{ key: "extractValues", value: (item) => Array.isArray(item.extracts) ? item.extracts.map((extract) => isRecord(extract) ? extract.value : undefined).filter(Boolean).slice(0, 5) : [] },
		], 30),
		failures: summaryTable(failures, [
			{ key: "template", value: (failure) => failure.templateId },
			{ key: "url", value: (failure) => failure.url },
			{ key: "error", value: (failure) => failure.error },
		], 10),
		nextActions: [
			"use browser_http_replay to verify matched responses or extracted values with a focused baseline request",
			"use browser_template engine=nuclei with explicit template selection when built-in checks indicate deeper coverage is useful",
			"read saved artifacts or rerun with narrower target/template scope when matcher results need manual confirmation",
		],
	};
}
