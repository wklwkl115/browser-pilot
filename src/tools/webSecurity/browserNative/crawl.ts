import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { detectApiSpec, detectGraphqlSchema, endpointKindFor, extractAttributeUrls, extractForms, extractKnownFileUrls, extractManifestUrls, extractScriptSources, extractServiceWorkerCacheRoutes, extractServiceWorkerUrls, extractServiceWorkerVersionSummary, extractSourceMapUrls, extractStringUrls, inScope, knownFilePaths, normalizeUrlForVisit, parseSourceMapDetails, shouldProbeGraphqlIntrospection } from "./crawlExtractors";
import { compactStep, contentTypeOf, extractTitle, fetchWithRedirects, normalizeHeaders, normalizeProbeTargets, responseBodyHash, sanitizeFetchHeaders } from "../shared/http";
import { isRecord, positiveInt } from "../shared/normalize";
import type { CrawlOptions, HeaderMap, WebFetchOptions } from "../shared/types";

const GRAPHQL_INTROSPECTION_QUERY = "query PiBrowserToolsIntrospection { __schema { queryType { name } mutationType { name } subscriptionType { name } types { name fields { name args { name } } } } }";

function normalizeCrawlSeeds(options: CrawlOptions): string[] {
	const seeds = normalizeProbeTargets({ url: options.url, urls: options.urls, paths: options.paths, defaultScheme: options.defaultScheme });
	const known = knownFilePaths(options.knownFiles);
	const withKnown = [...seeds];
	for (const seed of seeds) for (const knownPath of known) withKnown.push(new URL(knownPath, seed).toString());
	return [...new Set(withKnown.map(normalizeUrlForVisit))];
}

function createCrawlArtifactRoot(): Promise<string> {
	const artifactBaseDir = path.resolve(process.cwd(), ".pi", "browser-artifacts");
	return mkdir(artifactBaseDir, { recursive: true }).then(() => mkdtemp(path.join(artifactBaseDir, "crawl-")));
}

async function probeGraphqlIntrospection(url: string, headers: HeaderMap, options: WebFetchOptions): Promise<Record<string, unknown> | undefined> {
	const requestHeaders = sanitizeFetchHeaders({ ...headers, Accept: "application/json, application/graphql-response+json", "Content-Type": "application/json" }).headers;
	try {
		const exchange = await fetchWithRedirects({ url, method: "POST", headers: requestHeaders, body: JSON.stringify({ query: GRAPHQL_INTROSPECTION_QUERY }) }, { ...options, followRedirects: true, maxRedirects: positiveInt(options.maxRedirects, 3) });
		const final = exchange.final;
		const schema = detectGraphqlSchema(final.bodyText);
		return { source: "active-probe", url: final.url, status: final.status, bodyBytes: final.bodyBytes, bodySha256: responseBodyHash(final), redirects: exchange.chain.slice(0, -1).map(compactStep), schema, error: schema ? undefined : final.status >= 400 ? `GraphQL introspection probe returned ${final.status}` : undefined };
	} catch (error) {
		return { source: "active-probe", url, error: error instanceof Error ? error.message : String(error) };
	}
}

function isHtml(headers: HeaderMap, url: string): boolean {
	const type = contentTypeOf(headers);
	return /html|xml/i.test(type) || /\.(?:html?|xml)(?:[?#]|$)/i.test(url) || (!type && !/\.[a-z0-9]{2,6}(?:[?#]|$)/i.test(url));
}

function isJavaScript(headers: HeaderMap, url: string): boolean {
	const type = contentTypeOf(headers);
	return /javascript|ecmascript/i.test(type) || /\.(?:m?js)(?:[?#]|$)/i.test(url);
}

export async function runBrowserCrawl(options: CrawlOptions) {
	const seeds = normalizeCrawlSeeds(options);
	const maxDepth = Math.min(5, positiveInt(options.maxDepth, 2));
	const maxPages = Math.min(500, positiveInt(options.maxPages, 50));
	const sameOrigin = options.sameOrigin !== false;
	const extractJs = options.extractJs !== false;
	const activeGraphqlIntrospection = options.activeGraphqlIntrospection !== false;
	const seedOrigins = new Set(seeds.map((seed) => new URL(seed).origin));
	const baseHeaders = normalizeHeaders(options.headers);
	const queue = seeds.map((url) => ({ url, depth: 0, source: "seed" }));
	const visited = new Set<string>();
	const pages: Array<Record<string, unknown>> = [];
	const endpoints = new Map<string, Record<string, unknown>>();
	const failures: Array<Record<string, unknown>> = [];
	let artifactRoot: string | undefined;
	const ensureArtifactRoot = async () => {
		if (artifactRoot) return artifactRoot;
		artifactRoot = await createCrawlArtifactRoot();
		return artifactRoot;
	};

	while (queue.length && pages.length < maxPages) {
		const next = queue.shift();
		if (!next) break;
		const url = normalizeUrlForVisit(next.url);
		if (visited.has(url) || !inScope(url, seedOrigins, sameOrigin)) continue;
		visited.add(url);
		try {
			const headers = { ...baseHeaders };
			const cookie = options.bindBrowserSession === true ? await options.cookieProvider?.(url) : undefined;
			if (cookie) headers.Cookie = cookie;
			const sanitized = sanitizeFetchHeaders(headers);
			const exchange = await fetchWithRedirects({ url, method: "GET", headers: sanitized.headers }, { ...options, followRedirects: true, maxRedirects: positiveInt(options.maxRedirects, 5) });
			const final = exchange.final;
			const type = contentTypeOf(final.headers);
			const htmlLike = isHtml(final.headers, final.url);
			const jsLike = isJavaScript(final.headers, final.url);
			const links = htmlLike ? extractAttributeUrls(final.bodyText, final.url) : [];
			const forms = htmlLike ? extractForms(final.bodyText, final.url) : [];
			const scripts = htmlLike ? extractScriptSources(final.bodyText, final.url) : [];
			const manifests = htmlLike ? extractManifestUrls(final.bodyText, final.url) : [];
			const serviceWorkers = (htmlLike || jsLike) ? extractServiceWorkerUrls(final.bodyText, final.url) : [];
			const sourceMaps = (htmlLike || jsLike) ? extractSourceMapUrls(final.bodyText, final.url) : [];
			const apiSpec = detectApiSpec(final.bodyText, final.url, type);
			let graphqlSchema = /graphql/i.test(final.url) || /__schema|__typename/i.test(final.bodyText) ? detectGraphqlSchema(final.bodyText) : undefined;
			let graphqlProbe: Record<string, unknown> | undefined;
			if (graphqlSchema) graphqlSchema = { ...graphqlSchema, source: "passive-response" };
			else if (activeGraphqlIntrospection && shouldProbeGraphqlIntrospection(final.url, type)) {
				graphqlProbe = await probeGraphqlIntrospection(final.url, headers, options);
				if (isRecord(graphqlProbe) && isRecord(graphqlProbe.schema)) graphqlSchema = { ...graphqlProbe.schema, source: "active-probe", probeStatus: graphqlProbe.status, probeUrl: graphqlProbe.url, probeBodySha256: graphqlProbe.bodySha256 };
			}
			const sourceMapDetails = await parseSourceMapDetails(final.bodyText, final.url, ensureArtifactRoot);
			const serviceWorkerCacheRoutes = jsLike && endpointKindFor(final.url, "") === "service-worker" ? extractServiceWorkerCacheRoutes(final.bodyText, final.url) : [];
			const serviceWorkerVersionSummary = jsLike && endpointKindFor(final.url, "") === "service-worker" ? extractServiceWorkerVersionSummary(final.bodyText, final.url) : undefined;
			const serviceWorkerDetails = serviceWorkerCacheRoutes.length || (isRecord(serviceWorkerVersionSummary) && ((Number(serviceWorkerVersionSummary.cacheNameCount || 0) > 0) || (Number(serviceWorkerVersionSummary.importScriptCount || 0) > 0) || (Number(serviceWorkerVersionSummary.versionTokenCount || 0) > 0)))
				? { kind: "service-worker", cacheRouteCount: serviceWorkerCacheRoutes.length, cacheRoutes: serviceWorkerCacheRoutes, versionSummary: serviceWorkerVersionSummary }
				: undefined;
			const stringEndpoints = (htmlLike || jsLike) ? extractStringUrls(final.bodyText, final.url) : [];
			const knownFileUrls = /(?:robots\.txt|sitemap\.xml)(?:[?#]|$)/i.test(final.url) ? extractKnownFileUrls(final.bodyText, final.url) : [];
			const apiEndpointHints = isRecord(apiSpec) && Array.isArray(apiSpec.endpoints) ? apiSpec.endpoints.filter(isRecord) : [];
			const sourceMapEndpointHints = isRecord(sourceMapDetails) && Array.isArray(sourceMapDetails.endpointHints) ? sourceMapDetails.endpointHints.filter(isRecord) : [];
			const discoveryHints = [
				...stringEndpoints,
				...knownFileUrls,
				...apiEndpointHints,
				...sourceMapEndpointHints,
				...serviceWorkerCacheRoutes,
				...manifests.map((manifestUrl) => ({ url: manifestUrl, kind: "manifest", source: "link" })),
				...serviceWorkers.map((serviceWorkerUrl) => ({ url: serviceWorkerUrl, kind: "service-worker", source: "serviceWorker.register" })),
				...sourceMaps.map((sourceMapUrl) => ({ url: sourceMapUrl, kind: "source-map", source: "sourceMappingURL" })),
			];
			if (apiSpec) discoveryHints.push({ url: final.url, kind: String(apiSpec.kind || "api-spec"), source: "document" });
			const scopedEndpointHints = discoveryHints.filter((endpoint) => inScope(endpoint.url, seedOrigins, sameOrigin));
			for (const endpoint of [...scopedEndpointHints, ...forms.map((form) => ({ url: form.action, kind: "form", method: form.method, inputNames: form.inputNames })).filter((form) => inScope(form.url, seedOrigins, sameOrigin))]) {
				endpoints.set(`${endpoint.kind}:${endpoint.method || ""}:${endpoint.url}`, { ...endpoint, sourceUrl: final.url });
			}
			if (next.depth < maxDepth) {
				for (const link of links) if (inScope(link.url, seedOrigins, sameOrigin)) queue.push({ url: link.url, depth: next.depth + 1, source: final.url });
				for (const endpoint of scopedEndpointHints) queue.push({ url: endpoint.url, depth: next.depth + 1, source: final.url });
			}
			if (extractJs && htmlLike) {
				for (const scriptUrl of scripts) {
					if (inScope(scriptUrl, seedOrigins, sameOrigin) && !visited.has(scriptUrl)) queue.push({ url: scriptUrl, depth: Math.min(next.depth + 1, maxDepth), source: final.url });
				}
			}
			pages.push({
				url: final.url,
				seedUrl: url,
				depth: next.depth,
				source: next.source,
				status: final.status,
				contentType: type,
				title: htmlLike ? extractTitle(final.bodyText) : undefined,
				bodyBytes: final.bodyBytes,
				bodyTruncated: final.bodyTruncated,
				redirects: exchange.chain.slice(0, -1).map(compactStep),
				links: links.map((item) => item.url).slice(0, 200),
				scripts: scripts.slice(0, 100),
				manifests: manifests.slice(0, 50),
				serviceWorkers: serviceWorkers.slice(0, 50),
				sourceMaps: sourceMaps.slice(0, 50),
				sourceMapDetails,
				apiSpec,
				graphqlSchema,
				graphqlProbe,
				serviceWorkerDetails,
				forms,
				endpoints: scopedEndpointHints.map((item) => item.url).slice(0, 100),
				endpointDetails: scopedEndpointHints.slice(0, 100),
			});
		} catch (error) {
			failures.push({ url, depth: next.depth, source: next.source, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const sourceArchiveCount = pages.reduce((sum, page) => sum + Number(isRecord(page.sourceMapDetails) ? page.sourceMapDetails.archivedSourceCount || 0 : 0), 0);
	const serviceWorkerCacheNames = Array.from(new Set(pages.flatMap((page) => isRecord(page.serviceWorkerDetails) && isRecord(page.serviceWorkerDetails.versionSummary) && Array.isArray(page.serviceWorkerDetails.versionSummary.cacheNames) ? page.serviceWorkerDetails.versionSummary.cacheNames.map(String) : []))).slice(0, 100);
	const serviceWorkerVersionTokens = Array.from(new Set(pages.flatMap((page) => isRecord(page.serviceWorkerDetails) && isRecord(page.serviceWorkerDetails.versionSummary) && Array.isArray(page.serviceWorkerDetails.versionSummary.versionTokens) ? page.serviceWorkerDetails.versionSummary.versionTokens.map(String) : []))).slice(0, 100);
	return { ok: failures.length === 0, generatedAt: new Date().toISOString(), seeds, maxDepth, maxPages, sameOrigin, extractJs, activeGraphqlIntrospection, artifactRoot, sourceArchiveCount, serviceWorkerCacheNames, serviceWorkerVersionTokens, pageCount: pages.length, endpointCount: endpoints.size, pages, endpoints: Array.from(endpoints.values()), failures };
}
