import { asArray, increment, isRecord, summaryTable, textPreview, topCounts, type Summary } from "./common";

function resultItems(value: unknown): Record<string, unknown>[] {
	if (!isRecord(value)) return [];
	return asArray(value.results).filter(isRecord);
}

function hostOf(value: unknown): string {
	try { return new URL(String(value || "")).host || "unknown"; } catch { return "unknown"; }
}

function techPreview(value: unknown): string {
	return Array.isArray(value) ? value.slice(0, 4).join(", ") : "";
}

function fingerprintPreview(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value.slice(0, 4).map((item) => isRecord(item) ? item.label : item).filter(Boolean).join(", ");
}

function redactSensitiveText(text: string): string {
	return text
		.replace(/((?:^|[\r\n])\s*(?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)\s*:\s*)[^\r\n]*/gi, "$1[redacted]")
		.replace(/("(?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)"\s*:\s*)"[^"]*"/gi, "$1\"[redacted]\"")
		.replace(/((?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)\s*=\s*)[^;\s,"'}]+/gi, "$1[redacted]");
}

function bodyPreview(body: unknown): string {
	return isRecord(body) && typeof body.text === "string" ? textPreview(redactSensitiveText(body.text), 220) : "";
}

export function summarizeWebReconProbeData(value: unknown): Summary {
	const items = resultItems(value);
	const statusCounts: Record<string, number> = {};
	const hostCounts: Record<string, number> = {};
	let failed = 0;
	for (const item of items) {
		if (item.ok === false) failed += 1;
		increment(statusCounts, item.status ?? (item.ok === false ? "error" : "unknown"));
		increment(hostCounts, hostOf(item.finalUrl ?? item.inputUrl));
	}
	return {
		ok: isRecord(value) ? value.ok : undefined,
		count: items.length,
		failed,
		statusCounts: topCounts(statusCounts),
		hostCounts: topCounts(hostCounts),
		results: summaryTable(items, [
			{ key: "url", value: (item) => item.finalUrl ?? item.inputUrl },
			{ key: "status", value: (item) => item.status ?? (item.ok === false ? "error" : undefined) },
			{ key: "title", value: (item) => item.title },
			{ key: "tech", value: (item) => techPreview(item.tech) },
			{ key: "fingerprints", value: (item) => fingerprintPreview(item.fingerprints) },
			{ key: "redirects", value: (item) => Array.isArray(item.redirects) ? item.redirects.length : 0 },
			{ key: "bodyBytes", value: (item) => isRecord(item.body) ? item.body.bytes : undefined },
			{ key: "bodySha256", value: (item) => isRecord(item.body) ? item.body.sha256 : undefined },
			{ key: "favicon", value: (item) => isRecord(item.favicon) ? item.favicon.mmh3 ?? item.favicon.sha256 ?? item.favicon.error : undefined },
			{ key: "faviconSimHash", value: (item) => isRecord(item.favicon) ? item.favicon.simHash64 : undefined },
			{ key: "tls", value: (item) => isRecord(item.tlsCertificate) ? item.tlsCertificate.fingerprint256 || item.tlsCertificate.error : undefined },
			{ key: "preview", value: (item) => bodyPreview(item.body) || item.error },
		], 20),
	};
}

export function summarizeBrowserCrawlData(value: unknown): Summary {
	const pages = isRecord(value) ? asArray(value.pages).filter(isRecord) : [];
	const endpoints = isRecord(value) ? asArray(value.endpoints).filter(isRecord) : [];
	const failures = isRecord(value) ? asArray(value.failures).filter(isRecord) : [];
	const statusCounts: Record<string, number> = {};
	const hostCounts: Record<string, number> = {};
	const serviceWorkerVersions = new Set<string>();
	let sourceArchiveCount = 0;
	for (const page of pages) {
		increment(statusCounts, page.status ?? "unknown");
		increment(hostCounts, hostOf(page.url));
		sourceArchiveCount += Number(isRecord(page.sourceMapDetails) ? page.sourceMapDetails.archivedSourceCount || 0 : 0);
		if (isRecord(page.serviceWorkerDetails) && isRecord(page.serviceWorkerDetails.versionSummary) && Array.isArray(page.serviceWorkerDetails.versionSummary.versionTokens)) {
			for (const token of page.serviceWorkerDetails.versionSummary.versionTokens) serviceWorkerVersions.add(String(token));
		}
	}
	return {
		ok: isRecord(value) ? value.ok : undefined,
		pageCount: pages.length,
		endpointCount: endpoints.length,
		failureCount: failures.length,
		maxDepth: isRecord(value) ? value.maxDepth : undefined,
		artifactRoot: isRecord(value) ? value.artifactRoot : undefined,
		sourceArchiveCount: isRecord(value) ? value.sourceArchiveCount : sourceArchiveCount,
		serviceWorkerCacheNames: isRecord(value) ? value.serviceWorkerCacheNames : undefined,
		serviceWorkerVersionTokens: isRecord(value) ? value.serviceWorkerVersionTokens : Array.from(serviceWorkerVersions),
		statusCounts: topCounts(statusCounts),
		hostCounts: topCounts(hostCounts),
		pages: summaryTable(pages, [
			{ key: "url", value: (page) => page.url },
			{ key: "status", value: (page) => page.status },
			{ key: "title", value: (page) => page.title },
			{ key: "depth", value: (page) => page.depth },
			{ key: "links", value: (page) => Array.isArray(page.links) ? page.links.length : 0 },
			{ key: "forms", value: (page) => Array.isArray(page.forms) ? page.forms.length : 0 },
			{ key: "endpoints", value: (page) => Array.isArray(page.endpoints) ? page.endpoints.length : 0 },
			{ key: "manifests", value: (page) => Array.isArray(page.manifests) ? page.manifests.length : 0 },
			{ key: "serviceWorkers", value: (page) => Array.isArray(page.serviceWorkers) ? page.serviceWorkers.length : 0 },
			{ key: "sourceMaps", value: (page) => Array.isArray(page.sourceMaps) ? page.sourceMaps.length : 0 },
			{ key: "sourceMapSources", value: (page) => isRecord(page.sourceMapDetails) ? page.sourceMapDetails.sourceCount : undefined },
			{ key: "sourceMapArchived", value: (page) => isRecord(page.sourceMapDetails) ? page.sourceMapDetails.archivedSourceCount : undefined },
			{ key: "apiSpec", value: (page) => isRecord(page.apiSpec) ? `${page.apiSpec.kind}${page.apiSpec.endpointCount !== undefined ? `:${page.apiSpec.endpointCount}` : ""}` : undefined },
			{ key: "apiParams", value: (page) => isRecord(page.apiSpec) && isRecord(page.apiSpec.parameterSummary) ? page.apiSpec.parameterSummary.totalParameters : undefined },
			{ key: "apiBodyFields", value: (page) => isRecord(page.apiSpec) && isRecord(page.apiSpec.parameterSummary) ? page.apiSpec.parameterSummary.requestBodyFieldCount : undefined },
			{ key: "graphqlTypes", value: (page) => isRecord(page.graphqlSchema) ? page.graphqlSchema.typeCount : undefined },
			{ key: "graphqlSource", value: (page) => isRecord(page.graphqlSchema) ? page.graphqlSchema.source : undefined },
			{ key: "swCacheRoutes", value: (page) => isRecord(page.serviceWorkerDetails) ? page.serviceWorkerDetails.cacheRouteCount : undefined },
			{ key: "swVersions", value: (page) => isRecord(page.serviceWorkerDetails) && isRecord(page.serviceWorkerDetails.versionSummary) ? page.serviceWorkerDetails.versionSummary.versionTokens : undefined },
		], 20),
		endpoints: summaryTable(endpoints, [
			{ key: "url", value: (endpoint) => endpoint.url },
			{ key: "kind", value: (endpoint) => endpoint.kind },
			{ key: "method", value: (endpoint) => endpoint.method },
			{ key: "source", value: (endpoint) => endpoint.source },
			{ key: "parameterCount", value: (endpoint) => endpoint.parameterCount },
			{ key: "requestBodyFields", value: (endpoint) => isRecord(endpoint.parameterSummary) ? endpoint.parameterSummary.requestBodyFieldCount : undefined },
			{ key: "sourceUrl", value: (endpoint) => endpoint.sourceUrl },
		], 30),
		failures: summaryTable(failures, [
			{ key: "url", value: (failure) => failure.url },
			{ key: "error", value: (failure) => failure.error },
		], 10),
	};
}

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
	};
}

export function summarizeCookieAnalyzeData(value: unknown): Summary {
	const results = resultItems(value);
	const kindCounts: Record<string, number> = {};
	const sourceCounts: Record<string, number> = {};
	for (const item of results) {
		increment(kindCounts, item.kind ?? "unknown");
		increment(sourceCounts, item.source ?? "unknown");
	}
	const tokenInfo = (item: Record<string, unknown>) => isRecord(item.token) ? item.token : isRecord(item.jwt) ? item.jwt : undefined;
	const tokenVerified = (item: Record<string, unknown>) => {
		const token = tokenInfo(item);
		return isRecord(token) ? (isRecord(token.signature) ? token.signature.verified : isRecord(token.decryption) ? token.decryption.verified : undefined) : undefined;
	};
	const tokenPayload = (item: Record<string, unknown>) => {
		const token = tokenInfo(item);
		return isRecord(token) && isRecord(token.payload) ? token.payload : undefined;
	};
	const tokenMutation = (item: Record<string, unknown>) => {
		const token = tokenInfo(item);
		return isRecord(token) && isRecord(token.mutation) ? (typeof token.mutation.token === "string" ? "token" : token.mutation.error) : undefined;
	};
	const tokenFormat = (item: Record<string, unknown>) => {
		const token = tokenInfo(item);
		return isRecord(token) ? token.format : undefined;
	};
	return {
		ok: isRecord(value) ? value.ok : undefined,
		inputCount: isRecord(value) ? value.inputCount : undefined,
		cookieCount: isRecord(value) ? value.cookieCount : undefined,
		tokenCount: isRecord(value) ? value.tokenCount : undefined,
		jwtCount: isRecord(value) ? value.jwtCount : undefined,
		jweCount: isRecord(value) ? value.jweCount : undefined,
		pasetoCount: isRecord(value) ? value.pasetoCount : undefined,
		sessionFormatCount: isRecord(value) ? value.sessionFormatCount : undefined,
		verifiedJwtCount: isRecord(value) ? value.verifiedJwtCount : undefined,
		verifiedTokenCount: isRecord(value) ? value.verifiedTokenCount : undefined,
		mutationCount: isRecord(value) ? value.mutationCount : undefined,
		testedSecretCandidateCount: isRecord(value) ? value.testedSecretCandidateCount : undefined,
		truncatedSecretCandidates: isRecord(value) ? value.truncatedSecretCandidates : undefined,
		claimReplayCount: isRecord(value) ? value.claimReplayCount : undefined,
		successfulClaimReplayCount: isRecord(value) ? value.successfulClaimReplayCount : undefined,
		claimReplayFailureCount: isRecord(value) ? value.claimReplayFailureCount : undefined,
		kindCounts: topCounts(kindCounts),
		sourceCounts: topCounts(sourceCounts),
		claimReplays: summaryTable(isRecord(value) ? asArray(value.claimReplays).filter(isRecord) : [], [
			{ key: "name", value: (item) => item.name },
			{ key: "format", value: (item) => item.format },
			{ key: "cookie", value: (item) => item.cookieName },
			{ key: "status", value: (item) => isRecord(item.mutated) ? item.mutated.status : undefined },
			{ key: "baseline", value: (item) => isRecord(item.baseline) ? item.baseline.status : undefined },
			{ key: "delta", value: (item) => item.delta },
		], 20),
		results: summaryTable(results, [
			{ key: "source", value: (item) => item.source },
			{ key: "name", value: (item) => item.name },
			{ key: "kind", value: (item) => item.kind },
			{ key: "format", value: (item) => tokenFormat(item) },
			{ key: "length", value: (item) => item.valueLength },
			{ key: "alg", value: (item) => { const token = tokenInfo(item); return isRecord(token) ? token.alg ?? token.enc ?? token.purpose : undefined; } },
			{ key: "kid", value: (item) => { const token = tokenInfo(item); return isRecord(token) ? token.kid : undefined; } },
			{ key: "verified", value: (item) => tokenVerified(item) },
			{ key: "claimKeys", value: (item) => tokenPayload(item) ? Object.keys(tokenPayload(item) || {}).slice(0, 20) : undefined },
			{ key: "decodings", value: (item) => Array.isArray(item.decodings) ? item.decodings.length : 0 },
			{ key: "mutation", value: (item) => tokenMutation(item) },
			{ key: "replay", value: (item) => isRecord(item.claimReplay) && isRecord(item.claimReplay.mutated) ? item.claimReplay.mutated.status : isRecord(item.claimReplay) ? item.claimReplay.error : undefined },
		], 30),
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
	};
}

export function summarizeSqliProbeData(value: unknown): Summary {
	const matched = isRecord(value) ? asArray(value.matched).filter(isRecord) : [];
	const results = resultItems(value);
	const failures = isRecord(value) ? asArray(value.failures).filter(isRecord) : [];
	const typeCounts: Record<string, number> = {};
	const paramCounts: Record<string, number> = {};
	for (const item of results) {
		increment(typeCounts, item.type ?? "unknown");
		increment(paramCounts, item.paramName ?? "unknown");
	}
	return {
		ok: isRecord(value) ? value.ok : undefined,
		caseCount: isRecord(value) ? value.caseCount : undefined,
		requestCount: isRecord(value) ? value.requestCount : undefined,
		matchedCount: matched.length,
		failureCount: failures.length,
		oracleTypes: isRecord(value) ? value.oracleTypes : undefined,
		dbmsPayloadPack: isRecord(value) ? value.dbmsPayloadPack : undefined,
		dbmsFingerprints: isRecord(value) ? value.dbmsFingerprints : undefined,
		columnHints: summaryTable(isRecord(value) ? asArray(value.columnHints).filter(isRecord) : [], [
			{ key: "location", value: (item) => item.location },
			{ key: "param", value: (item) => item.paramName },
			{ key: "orderByMaxValid", value: (item) => item.orderByMaxValid },
			{ key: "unionSelectColumns", value: (item) => item.unionSelectColumns },
			{ key: "confidence", value: (item) => item.confidence },
		], 10),
		echoPositions: summaryTable(isRecord(value) ? asArray(value.echoPositions).filter(isRecord) : [], [
			{ key: "location", value: (item) => item.location },
			{ key: "param", value: (item) => item.paramName },
			{ key: "columns", value: (item) => item.columnCount },
			{ key: "position", value: (item) => item.position },
		], 20),
		extractions: summaryTable(isRecord(value) ? asArray(value.extractions).filter(isRecord) : [], [
			{ key: "location", value: (item) => item.location },
			{ key: "param", value: (item) => item.paramName },
			{ key: "expression", value: (item) => item.expression },
			{ key: "value", value: (item) => item.value },
			{ key: "length", value: (item) => item.length },
			{ key: "attempts", value: (item) => item.attempts },
			{ key: "complete", value: (item) => item.complete },
		], 10),
		truncatedCases: isRecord(value) ? value.truncatedCases : undefined,
		timeThresholdMs: isRecord(value) ? value.timeThresholdMs : undefined,
		typeCounts: topCounts(typeCounts),
		paramCounts: topCounts(paramCounts),
		matched: summaryTable(matched, [
			{ key: "type", value: (item) => item.type },
			{ key: "location", value: (item) => item.location },
			{ key: "param", value: (item) => item.paramName },
			{ key: "payload", value: (item) => item.payload ?? (isRecord(item.payloads) ? item.payloads.truePayload : undefined) },
			{ key: "status", value: (item) => isRecord(item.response) ? item.response.status : isRecord(item.trueResponse) ? item.trueResponse.status : undefined },
			{ key: "bodyBytes", value: (item) => isRecord(item.response) ? item.response.bodyBytes : isRecord(item.trueResponse) ? item.trueResponse.bodyBytes : undefined },
			{ key: "elapsedDeltaMs", value: (item) => item.elapsedDeltaMs },
			{ key: "sqlError", value: (item) => item.sqlError },
			{ key: "dbms", value: (item) => item.dbms },
			{ key: "columns", value: (item) => item.columnCount },
			{ key: "echoPosition", value: (item) => item.echoPosition },
			{ key: "baselineDistance", value: (item) => item.baselineDistance },
		], 30),
		failures: summaryTable(failures, [
			{ key: "type", value: (failure) => failure.type },
			{ key: "param", value: (failure) => failure.paramName },
			{ key: "error", value: (failure) => failure.error },
		], 10),
	};
}

export function summarizeSqlmapBridgeData(value: unknown): Summary {
	const runs = isRecord(value) ? asArray(value.runs).filter(isRecord) : [];
	const findings = isRecord(value) ? asArray(value.findings).filter(isRecord) : [];
	const failures = isRecord(value) ? asArray(value.failures).filter(isRecord) : [];
	const dbmsCounts: Record<string, number> = {};
	const parameterCounts: Record<string, number> = {};
	for (const item of findings) {
		if (Array.isArray(item.dbmsFingerprints)) for (const dbms of item.dbmsFingerprints) increment(dbmsCounts, dbms);
		increment(parameterCounts, item.parameter ?? "unknown");
	}
	for (const run of runs) {
		if (Array.isArray(run.dbmsFingerprints)) for (const dbms of run.dbmsFingerprints) increment(dbmsCounts, dbms);
	}
	return {
		ok: isRecord(value) ? value.ok : undefined,
		runCount: runs.length,
		targetCount: isRecord(value) ? value.targetCount : undefined,
		vulnerableRunCount: isRecord(value) ? value.vulnerableRunCount : undefined,
		findingCount: findings.length,
		failureCount: failures.length,
		launcher: isRecord(value) ? value.launcher : undefined,
		artifactRoot: isRecord(value) ? value.artifactRoot : undefined,
		dbmsFingerprints: isRecord(value) ? value.dbmsFingerprints : undefined,
		currentUsers: isRecord(value) ? value.currentUsers : undefined,
		currentDatabases: isRecord(value) ? value.currentDatabases : undefined,
		dbmsCounts: topCounts(dbmsCounts),
		parameterCounts: topCounts(parameterCounts),
		runs: summaryTable(runs, [
			{ key: "index", value: (item) => item.index },
			{ key: "source", value: (item) => item.source },
			{ key: "url", value: (item) => item.targetUrl },
			{ key: "exitCode", value: (item) => item.exitCode },
			{ key: "durationMs", value: (item) => item.durationMs },
			{ key: "vulnerable", value: (item) => item.vulnerable },
			{ key: "findings", value: (item) => item.findingCount },
			{ key: "dbms", value: (item) => item.dbmsFingerprints },
			{ key: "currentDb", value: (item) => item.currentDatabase },
			{ key: "currentUser", value: (item) => item.currentUser },
			{ key: "isDba", value: (item) => item.isDba },
			{ key: "stdoutPreview", value: (item) => item.stdoutPreview },
			{ key: "outputDir", value: (item) => item.outputDir },
		], 20),
		findings: summaryTable(findings, [
			{ key: "run", value: (item) => item.runIndex },
			{ key: "url", value: (item) => item.targetUrl },
			{ key: "param", value: (item) => item.parameter },
			{ key: "place", value: (item) => item.place },
			{ key: "type", value: (item) => item.type },
			{ key: "title", value: (item) => item.title },
			{ key: "payload", value: (item) => item.payload },
		], 30),
		failures: summaryTable(failures, [
			{ key: "index", value: (item) => item.index },
			{ key: "source", value: (item) => item.source },
			{ key: "error", value: (item) => item.error },
		], 10),
	};
}

export function summarizeNucleiBridgeData(value: unknown): Summary {
	const runs = isRecord(value) ? asArray(value.runs).filter(isRecord) : [];
	const matches = isRecord(value) ? asArray(value.matches).filter(isRecord) : [];
	const failures = isRecord(value) ? asArray(value.failures).filter(isRecord) : [];
	const severityCounts: Record<string, number> = {};
	const templateCounts: Record<string, number> = {};
	const hostCounts: Record<string, number> = {};
	for (const item of matches) {
		increment(severityCounts, item.severity ?? "unknown");
		increment(templateCounts, item.templateId ?? "unknown");
		increment(hostCounts, hostOf(item.matchedAt ?? item.host ?? item.targetUrl));
	}
	return {
		ok: isRecord(value) ? value.ok : undefined,
		runCount: runs.length,
		targetCount: isRecord(value) ? value.targetCount : undefined,
		matchedRunCount: isRecord(value) ? value.matchedRunCount : undefined,
		matchCount: matches.length,
		failureCount: failures.length,
		parseErrorCount: isRecord(value) ? value.parseErrorCount : undefined,
		launcher: isRecord(value) ? value.launcher : undefined,
		artifactRoot: isRecord(value) ? value.artifactRoot : undefined,
		matchedTemplateIds: isRecord(value) ? value.matchedTemplateIds : undefined,
		matchedSeverities: isRecord(value) ? value.matchedSeverities : undefined,
		selectedTemplatePaths: isRecord(value) ? value.selectedTemplatePaths : undefined,
		selectedWorkflowPaths: isRecord(value) ? value.selectedWorkflowPaths : undefined,
		selectedTemplateIds: isRecord(value) ? value.selectedTemplateIds : undefined,
		selectedTags: isRecord(value) ? value.selectedTags : undefined,
		selectedExcludeTags: isRecord(value) ? value.selectedExcludeTags : undefined,
		selectedSeverities: isRecord(value) ? value.selectedSeverities : undefined,
		selectedAuthors: isRecord(value) ? value.selectedAuthors : undefined,
		severityCounts: topCounts(severityCounts),
		templateCounts: topCounts(templateCounts),
		hostCounts: topCounts(hostCounts),
		runs: summaryTable(runs, [
			{ key: "index", value: (item) => item.index },
			{ key: "source", value: (item) => item.source },
			{ key: "url", value: (item) => item.targetUrl },
			{ key: "exitCode", value: (item) => item.exitCode },
			{ key: "durationMs", value: (item) => item.durationMs },
			{ key: "matched", value: (item) => item.matched },
			{ key: "matches", value: (item) => item.matchCount },
			{ key: "severities", value: (item) => item.matchSeverities },
			{ key: "templateIds", value: (item) => item.matchTemplateIds },
			{ key: "stdoutPreview", value: (item) => item.stdoutPreview },
			{ key: "outputDir", value: (item) => item.outputDir },
		], 20),
		matches: summaryTable(matches, [
			{ key: "run", value: (item) => item.runIndex },
			{ key: "url", value: (item) => item.targetUrl },
			{ key: "templateId", value: (item) => item.templateId },
			{ key: "name", value: (item) => item.templateName },
			{ key: "severity", value: (item) => item.severity },
			{ key: "matchedAt", value: (item) => item.matchedAt },
			{ key: "matcher", value: (item) => item.matcherName },
			{ key: "extractor", value: (item) => item.extractorName },
			{ key: "extracts", value: (item) => Array.isArray(item.extractedResults) ? item.extractedResults.slice(0, 4) : undefined },
			{ key: "requestPreview", value: (item) => item.requestPreview },
		], 30),
		failures: summaryTable(failures, [
			{ key: "index", value: (item) => item.index },
			{ key: "source", value: (item) => item.source },
			{ key: "error", value: (item) => item.error },
		], 10),
	};
}

export function summarizeCallbackOastData(value: unknown): Summary {
	const events = isRecord(value) ? asArray(value.events).filter(isRecord) : [];
	const sessions = isRecord(value) ? asArray(value.sessions).filter(isRecord) : [];
	const methodCounts: Record<string, number> = {};
	const pathCounts: Record<string, number> = {};
	const protocolCounts: Record<string, number> = {};
	for (const event of events) {
		increment(methodCounts, event.method ?? event.protocol ?? "unknown");
		increment(pathCounts, event.path ?? event.queryName ?? event.url ?? "unknown");
		increment(protocolCounts, event.protocol ?? "http");
	}
	return {
		ok: isRecord(value) ? value.ok : undefined,
		action: isRecord(value) ? value.action : undefined,
		sessionId: isRecord(value) ? value.sessionId : undefined,
		listenHost: isRecord(value) ? value.listenHost : undefined,
		port: isRecord(value) ? value.port : undefined,
		httpsPort: isRecord(value) ? value.httpsPort : undefined,
		dnsPort: isRecord(value) ? value.dnsPort : undefined,
		correlationId: isRecord(value) ? value.correlationId : undefined,
		callbackUrl: isRecord(value) ? value.callbackUrl : undefined,
		httpsCallbackUrl: isRecord(value) ? value.httpsCallbackUrl : undefined,
		dnsCallbackHost: isRecord(value) ? value.dnsCallbackHost : undefined,
		publicCallbackUrl: isRecord(value) ? value.publicCallbackUrl : undefined,
		publicHttpsCallbackUrl: isRecord(value) ? value.publicHttpsCallbackUrl : undefined,
		publicDnsCallbackHost: isRecord(value) ? value.publicDnsCallbackHost : undefined,
		listenerActive: isRecord(value) ? value.listenerActive : undefined,
		recovered: isRecord(value) ? value.recovered : undefined,
		enabledProtocols: isRecord(value) ? value.enabledProtocols : undefined,
		eventCount: events.length || (isRecord(value) ? value.eventCount : undefined),
		nextSeq: isRecord(value) ? value.nextSeq : undefined,
		sessions: summaryTable(sessions, [
			{ key: "sessionId", value: (item) => item.sessionId },
			{ key: "callbackUrl", value: (item) => item.callbackUrl },
			{ key: "https", value: (item) => item.httpsCallbackUrl ? 1 : 0 },
			{ key: "dns", value: (item) => item.dnsCallbackHost },
			{ key: "active", value: (item) => item.listenerActive },
			{ key: "events", value: (item) => item.eventCount },
			{ key: "startedAt", value: (item) => item.startedAt },
		], 20),
		protocolCounts: topCounts(protocolCounts),
		methodCounts: topCounts(methodCounts),
		pathCounts: topCounts(pathCounts),
		events: summaryTable(events, [
			{ key: "seq", value: (event) => event.seq },
			{ key: "protocol", value: (event) => event.protocol },
			{ key: "method", value: (event) => event.method },
			{ key: "url", value: (event) => event.url ?? event.queryName },
			{ key: "matched", value: (event) => event.matchedCorrelation },
			{ key: "bodyBytes", value: (event) => isRecord(event.body) ? event.body.bytes : event.queryBytes },
			{ key: "remote", value: (event) => event.remoteAddress },
		], 30),
	};
}

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
	};
}

export function summarizeHttpReplayData(value: unknown): Summary {
	const request = isRecord(value) && isRecord(value.request) ? value.request : {};
	const response = isRecord(value) && isRecord(value.response) ? value.response : {};
	const steps = isRecord(value) ? asArray(value.steps).filter(isRecord) : [];
	const dependencyGraph = isRecord(value) && isRecord(value.dependencyGraph) ? value.dependencyGraph : undefined;
	const multipartMatrix = isRecord(value) && isRecord(value.multipartMatrix) ? value.multipartMatrix : undefined;
	return {
		ok: isRecord(value) ? value.ok : undefined,
		mode: isRecord(value) ? value.mode : undefined,
		stepCount: isRecord(value) ? value.stepCount : undefined,
		failureCount: isRecord(value) ? value.failureCount : undefined,
		variableScope: isRecord(value) ? value.variableScope : undefined,
		variableNames: isRecord(value) ? value.variableNames : undefined,
		multipartMatrix: multipartMatrix ? {
			caseCount: multipartMatrix.caseCount,
			truncatedCases: multipartMatrix.truncatedCases,
			fieldNames: multipartMatrix.fieldNames,
			fileValueCount: multipartMatrix.fileValueCount,
		} : undefined,
		request: {
			method: request.method,
			url: request.url,
			headerCount: Array.isArray(request.headerNames) ? request.headerNames.length : undefined,
			omittedHeaderNames: request.omittedHeaderNames,
			bodyBytes: request.bodyBytes,
			cookiesBound: request.cookiesBound,
			multipart: isRecord(request.multipart) ? { partCount: request.multipart.partCount, fileCount: request.multipart.fileCount, fieldCount: request.multipart.fieldCount, nestedMultipartPartCount: request.multipart.nestedMultipartPartCount } : undefined,
		},
		response: {
			status: response.status,
			statusText: response.statusText,
			url: response.url,
			headerCount: Array.isArray(response.headerNames) ? response.headerNames.length : undefined,
			bodyBytes: isRecord(response.body) ? response.body.bytes : undefined,
			bodySha256: isRecord(response.body) ? response.body.sha256 : undefined,
			bodyTruncated: isRecord(response.body) ? response.body.truncated : undefined,
			preview: bodyPreview(response.body),
			elapsedMs: response.elapsedMs,
		},
		delta: isRecord(value) ? value.delta : undefined,
		dependencyGraph: dependencyGraph ? {
			nodeCount: dependencyGraph.nodeCount,
			edgeCount: dependencyGraph.edgeCount,
			edgeTypes: dependencyGraph.edgeTypes,
		} : undefined,
		clusters: summaryTable(isRecord(value) ? asArray(value.clusters).filter(isRecord) : [], [
			{ key: "status", value: (item) => item.status },
			{ key: "title", value: (item) => item.title },
			{ key: "bodyBytes", value: (item) => item.bodyBytes },
			{ key: "count", value: (item) => item.count },
			{ key: "ok", value: (item) => item.okCount },
			{ key: "samples", value: (item) => item.sampleSteps },
		], 20),
		steps: summaryTable(steps, [
			{ key: "index", value: (step) => step.index },
			{ key: "source", value: (step) => step.source },
			{ key: "method", value: (step) => isRecord(step.request) ? step.request.method : undefined },
			{ key: "url", value: (step) => isRecord(step.request) ? step.request.url : undefined },
			{ key: "status", value: (step) => isRecord(step.response) ? step.response.status : undefined },
			{ key: "bodyBytes", value: (step) => isRecord(step.response) && isRecord(step.response.body) ? step.response.body.bytes : undefined },
			{ key: "multipartCase", value: (step) => isRecord(step.multipartMatrixCase) ? `${step.multipartMatrixCase.fieldName}:${step.multipartMatrixCase.kind}:${step.multipartMatrixCase.fileCount}` : undefined },
			{ key: "multipartFiles", value: (step) => isRecord(step.request) && isRecord(step.request.multipart) ? step.request.multipart.fileCount : undefined },
			{ key: "variableScope", value: (step) => step.variableScope },
			{ key: "capturedVariables", value: (step) => step.capturedVariableNames },
			{ key: "persistedVariables", value: (step) => step.persistedVariableNames },
			{ key: "delta", value: (step) => step.delta },
			{ key: "error", value: (step) => step.error },
		], 20),
		redirects: isRecord(value) && Array.isArray(value.redirects) ? value.redirects.length : 0,
	};
}
