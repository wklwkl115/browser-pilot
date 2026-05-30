import { asArray, hostOf, increment, isRecord, resultItems, summaryTable, topCounts, type Summary } from "./shared";

export function summarizeFuzzPathsData(value: unknown): Summary {
	const matched = isRecord(value) ? asArray(value.matched).filter(isRecord) : [];
	const results = resultItems(value);
	const failures = isRecord(value) ? asArray(value.failures).filter(isRecord) : [];
	const statusCounts: Record<string, number> = {};
	const hostCounts: Record<string, number> = {};
	for (const item of results) {
		increment(statusCounts, item.status ?? "unknown");
		increment(hostCounts, hostOf(item.url));
	}
	return {
		ok: isRecord(value) ? value.ok : undefined,
		baseCount: isRecord(value) ? value.baseCount : undefined,
		candidateCount: isRecord(value) ? value.candidateCount : undefined,
		requestCount: isRecord(value) ? value.requestCount : undefined,
		matchedCount: matched.length,
		failureCount: failures.length,
		resultCount: isRecord(value) ? value.resultCount : undefined,
		rawResultCount: isRecord(value) ? value.rawResultCount : undefined,
		deduplicatedResults: isRecord(value) ? value.deduplicatedResults : undefined,
		filterBaseline: isRecord(value) ? value.filterBaseline : undefined,
		baselineStrategy: isRecord(value) ? value.baselineStrategy : undefined,
		recursive: isRecord(value) ? value.recursive : undefined,
		maxDepth: isRecord(value) ? value.maxDepth : undefined,
		visitedBaseCount: isRecord(value) ? value.visitedBaseCount : undefined,
		discoveredDirectoryCount: isRecord(value) ? value.discoveredDirectoryCount : undefined,
		truncatedDiscoveredDirectories: isRecord(value) ? value.truncatedDiscoveredDirectories : undefined,
		truncatedCandidates: isRecord(value) ? value.truncatedCandidates : undefined,
		baselines: summaryTable(isRecord(value) ? asArray(value.baselines).filter(isRecord) : [], [
			{ key: "baseUrl", value: (item) => item.baseUrl },
			{ key: "url", value: (item) => item.url },
			{ key: "status", value: (item) => item.status },
			{ key: "bodyBytes", value: (item) => item.bodyBytes },
			{ key: "bodySha256", value: (item) => item.bodySha256 },
		], 10),
		baselineClusters: summaryTable(isRecord(value) ? asArray(value.baselineClusters).filter(isRecord) : [], [
			{ key: "status", value: (item) => item.status },
			{ key: "title", value: (item) => item.title },
			{ key: "count", value: (item) => item.count },
			{ key: "bodyBytes", value: (item) => `${item.bodyBytesMin ?? item.bodyBytesMax}-${item.bodyBytesMax ?? item.bodyBytesMin}` },
			{ key: "samplePaths", value: (item) => item.samplePaths },
		], 10),
		clusters: summaryTable(isRecord(value) ? asArray(value.clusters).filter(isRecord) : [], [
			{ key: "status", value: (item) => item.status },
			{ key: "title", value: (item) => item.title },
			{ key: "bodyBytes", value: (item) => item.bodyBytes },
			{ key: "count", value: (item) => item.count },
			{ key: "matched", value: (item) => item.matchedCount },
			{ key: "sampleUrls", value: (item) => item.sampleUrls },
		], 10),
		statusCounts: topCounts(statusCounts),
		hostCounts: topCounts(hostCounts),
		matched: summaryTable(matched, [
			{ key: "url", value: (item) => item.url },
			{ key: "depth", value: (item) => item.depth },
			{ key: "status", value: (item) => item.status },
			{ key: "title", value: (item) => item.title },
			{ key: "bodyBytes", value: (item) => item.bodyBytes },
			{ key: "bodySha256", value: (item) => item.bodySha256 },
			{ key: "different", value: (item) => item.differentFromBaseline },
			{ key: "baselineCluster", value: (item) => item.baselineClusterMatched },
			{ key: "delta", value: (item) => item.delta },
			{ key: "redirects", value: (item) => Array.isArray(item.redirects) ? item.redirects.length : 0 },
		], 30),
		failures: summaryTable(failures, [
			{ key: "url", value: (failure) => failure.url },
			{ key: "error", value: (failure) => failure.error },
		], 10),
		nextActions: [
			"use browser_http_replay with matched URLs to verify path findings with focused baseline comparison or header/body mutations",
			"use browser_template with matched paths or hosts for built-in exposure checks or nuclei follow-up",
			"use browser_fuzz mode=path with recursive:true and bounded maxDepth when matched directories suggest deeper route structure",
		],
	};
}
export function summarizeFuzzVhostsData(value: unknown): Summary {
	const matched = isRecord(value) ? asArray(value.matched).filter(isRecord) : [];
	const results = resultItems(value);
	const failures = isRecord(value) ? asArray(value.failures).filter(isRecord) : [];
	const statusCounts: Record<string, number> = {};
	const hostCounts: Record<string, number> = {};
	for (const item of results) {
		increment(statusCounts, item.status ?? "unknown");
		increment(hostCounts, item.host ?? "unknown");
	}
	return {
		ok: isRecord(value) ? value.ok : undefined,
		baseCount: isRecord(value) ? value.baseCount : undefined,
		requestCount: isRecord(value) ? value.requestCount : undefined,
		matchedCount: matched.length,
		failureCount: failures.length,
		filterBaseline: isRecord(value) ? value.filterBaseline : undefined,
		baselineStrategy: isRecord(value) ? value.baselineStrategy : undefined,
		baselines: summaryTable(isRecord(value) ? asArray(value.baselines).filter(isRecord) : [], [
			{ key: "baseUrl", value: (item) => item.baseUrl },
			{ key: "host", value: (item) => item.host },
			{ key: "sni", value: (item) => item.sniName },
			{ key: "status", value: (item) => item.status },
			{ key: "bodyBytes", value: (item) => item.bodyBytes },
			{ key: "tls", value: (item) => item.tlsFingerprint256 },
			{ key: "bodySha256", value: (item) => item.bodySha256 },
		], 10),
		baselineClusters: summaryTable(isRecord(value) ? asArray(value.baselineClusters).filter(isRecord) : [], [
			{ key: "status", value: (item) => item.status },
			{ key: "title", value: (item) => item.title },
			{ key: "tls", value: (item) => item.tlsFingerprint256 },
			{ key: "count", value: (item) => item.count },
			{ key: "bodyBytes", value: (item) => `${item.bodyBytesMin ?? item.bodyBytesMax}-${item.bodyBytesMax ?? item.bodyBytesMin}` },
			{ key: "hosts", value: (item) => item.hosts },
		], 10),
		clusters: summaryTable(isRecord(value) ? asArray(value.clusters).filter(isRecord) : [], [
			{ key: "status", value: (item) => item.status },
			{ key: "title", value: (item) => item.title },
			{ key: "bodyBytes", value: (item) => item.bodyBytes },
			{ key: "tls", value: (item) => item.tlsFingerprint256 },
			{ key: "count", value: (item) => item.count },
			{ key: "matched", value: (item) => item.matchedCount },
			{ key: "hosts", value: (item) => item.hosts },
		], 10),
		statusCounts: topCounts(statusCounts),
		hostCounts: topCounts(hostCounts),
		matched: summaryTable(matched, [
			{ key: "host", value: (item) => item.host },
			{ key: "status", value: (item) => item.status },
			{ key: "title", value: (item) => item.title },
			{ key: "bodyBytes", value: (item) => item.bodyBytes },
			{ key: "tls", value: (item) => item.tlsFingerprint256 },
			{ key: "bodySha256", value: (item) => item.bodySha256 },
			{ key: "sni", value: (item) => item.sniName },
			{ key: "different", value: (item) => item.differentFromBaseline },
			{ key: "baselineCluster", value: (item) => item.baselineClusterMatched },
			{ key: "nearestBaseline", value: (item) => item.nearestBaseline },
			{ key: "delta", value: (item) => item.delta },
		], 30),
		failures: summaryTable(failures, [
			{ key: "host", value: (failure) => failure.host },
			{ key: "error", value: (failure) => failure.error },
		], 10),
		nextActions: [
			"use browser_http_replay with the matched Host header to verify vhost-specific behavior or baseline deltas",
			"use browser_crawl action=fingerprint against matched hosts to inspect redirects, TLS, and tech hints per virtual host",
			"use browser_template with matched hosts for bounded exposure or nuclei follow-up checks",
		],
	};
}
export function summarizeFuzzParamsData(value: unknown): Summary {
	const matched = isRecord(value) ? asArray(value.matched).filter(isRecord) : [];
	const results = resultItems(value);
	const failures = isRecord(value) ? asArray(value.failures).filter(isRecord) : [];
	const parserClusters = isRecord(value) ? asArray(value.parserClusters).filter(isRecord) : [];
	const statusCounts: Record<string, number> = {};
	const locationCounts: Record<string, number> = {};
	const operationCounts: Record<string, number> = {};
	const contentTypeVariantCounts: Record<string, number> = {};
	for (const item of results) {
		increment(statusCounts, item.status ?? "unknown");
		increment(locationCounts, item.location ?? "unknown");
		increment(operationCounts, item.operation ?? "set");
		if (item.contentTypeVariant) increment(contentTypeVariantCounts, item.contentTypeVariant);
	}
	return {
		ok: isRecord(value) ? value.ok : undefined,
		caseCount: isRecord(value) ? value.caseCount : undefined,
		requestCount: isRecord(value) ? value.requestCount : undefined,
		matchedCount: matched.length,
		failureCount: failures.length,
		truncatedCases: isRecord(value) ? value.truncatedCases : undefined,
		baseline: isRecord(value) ? value.baseline : undefined,
		operations: isRecord(value) ? value.operations : undefined,
		contentTypeVariants: isRecord(value) ? value.contentTypeVariants : undefined,
		parserClusterCount: parserClusters.length,
		statusCounts: topCounts(statusCounts),
		locationCounts: topCounts(locationCounts),
		operationCounts: topCounts(operationCounts),
		contentTypeVariantCounts: topCounts(contentTypeVariantCounts),
		parserClusters: summaryTable(parserClusters, [
			{ key: "status", value: (item) => item.status },
			{ key: "title", value: (item) => item.title },
			{ key: "bodyBytes", value: (item) => item.bodyBytes },
			{ key: "count", value: (item) => item.count },
			{ key: "matched", value: (item) => item.matchedCount },
			{ key: "variants", value: (item) => item.contentTypeVariants },
			{ key: "params", value: (item) => item.params },
			{ key: "shapes", value: (item) => item.multipartShapes },
			{ key: "repeated", value: (item) => item.repeatedNames },
			{ key: "nested", value: (item) => item.nestedMultipartPartCount },
		], 20),
		matched: summaryTable(matched, [
			{ key: "location", value: (item) => item.location },
			{ key: "param", value: (item) => item.paramName },
			{ key: "operation", value: (item) => item.operation },
			{ key: "contentTypeVariant", value: (item) => item.contentTypeVariant },
			{ key: "value", value: (item) => item.value },
			{ key: "status", value: (item) => item.status },
			{ key: "bodyBytes", value: (item) => item.bodyBytes },
			{ key: "bodySha256", value: (item) => item.bodySha256 },
			{ key: "responseLocation", value: (item) => item.responseLocation },
			{ key: "multipart", value: (item) => isRecord(item.multipart) ? `${item.multipart.partCount || 0}/${item.multipart.fileCount || 0}/${item.multipart.nestedMultipartPartCount || 0}` : undefined },
			{ key: "delta", value: (item) => item.delta },
			{ key: "url", value: (item) => item.url },
		], 30),
		failures: summaryTable(failures, [
			{ key: "location", value: (failure) => failure.location },
			{ key: "param", value: (failure) => failure.paramName },
			{ key: "operation", value: (failure) => failure.operation },
			{ key: "contentTypeVariant", value: (failure) => failure.contentTypeVariant },
			{ key: "error", value: (failure) => failure.error },
		], 10),
		nextActions: [
			"pass the original request template to browser_sqli for bounded SQLi probing on interesting parameters or locations",
			"use browser_http_replay with narrow parameter mutations to verify parser, validation, or authorization deltas",
			"use browser_template with the same request scope when parameter behavior suggests exposure or framework-specific checks",
		],
	};
}
