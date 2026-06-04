import { artifactHints } from "../common.js";
import { asArray, hostOf, increment, isRecord, summaryTable, topCounts, type Summary } from "./shared.js";

export function summarizeBrowserCrawlData(value: unknown): Summary {
	const pages = isRecord(value) ? asArray(value.pages).filter(isRecord) : [];
	const endpoints = isRecord(value) ? asArray(value.endpoints).filter(isRecord) : [];
	const failures = isRecord(value) ? asArray(value.failures).filter(isRecord) : [];
	const statusCounts: Record<string, number> = {};
	const hostCounts: Record<string, number> = {};
	const serviceWorkerVersions = new Set<string>();
	let sourceArchiveCount = 0;
	const sourceMapManifests: Record<string, unknown>[] = [];
	for (const page of pages) {
		increment(statusCounts, page.status ?? "unknown");
		increment(hostCounts, hostOf(page.url));
		if (isRecord(page.sourceMapDetails)) {
			sourceArchiveCount += Number(page.sourceMapDetails.archivedSourceCount || 0);
			if (page.sourceMapDetails.manifestPath) sourceMapManifests.push({ url: page.url, manifestPath: page.sourceMapDetails.manifestPath, manifestRelativePath: page.sourceMapDetails.manifestRelativePath, archivedSourceCount: page.sourceMapDetails.archivedSourceCount });
		}
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
		activeGraphqlIntrospection: isRecord(value) ? value.activeGraphqlIntrospection : undefined,
		artifactRoot: isRecord(value) ? value.artifactRoot : undefined,
		sourceArchiveCount: isRecord(value) ? value.sourceArchiveCount : sourceArchiveCount,
		serviceWorkerCacheNames: isRecord(value) ? value.serviceWorkerCacheNames : undefined,
		serviceWorkerVersionTokens: isRecord(value) ? value.serviceWorkerVersionTokens : Array.from(serviceWorkerVersions),
		sourceMapManifestCount: sourceMapManifests.length,
		sourceMapManifests: summaryTable(sourceMapManifests, [
			{ key: "url", value: (item) => item.url },
			{ key: "manifestPath", value: (item) => item.manifestPath },
			{ key: "archivedSourceCount", value: (item) => item.archivedSourceCount },
		], 20),
		...(sourceMapManifests.length ? artifactHints([{ label: "all source map details", jsonPath: "pages", kind: "source-map-details", count: sourceMapManifests.length }]) : {}),
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
		nextActions: [
			"use browser_fuzz mode=path with discovered routes or endpoint paths for bounded path discovery",
			"use browser_template with discovered hosts, paths, or API surfaces for exposure or nuclei follow-up checks",
			"capture live request templates with browser_network or HAR before browser_http_replay, browser_fuzz mode=param, or browser_sqli",
			...(sourceMapManifests.length ? ["read sourceMapManifests[].manifestPath with browser_artifact, then search archived source-map files with bounded root/glob"] : []),
		],
	};
}
