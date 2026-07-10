import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { detectApiSpec, detectGraphqlSchema, endpointKindFor, extractAttributeUrls, extractForms, extractKnownFileUrls, extractManifestUrls, extractScriptSources, extractServiceWorkerCacheRoutes, extractServiceWorkerUrls, extractServiceWorkerVersionSummary, extractSourceMapUrls, extractStringUrls, inScope, knownFilePaths, normalizeUrlForVisit, parseSourceMapDetails, shouldProbeGraphqlIntrospection } from "./crawlExtractors.js";
import { compactStep, contentTypeOf, cookieProviderResultHeader, extractTitle, fetchWithRedirects, normalizeHeaders, normalizeProbeTargets, responseBodyHash, sanitizeFetchHeaders } from "../shared/http.js";
import { isRecord, positiveInt, requestCwd } from "../shared/normalize.js";
import type { CrawlOptions, HeaderMap, WebFetchOptions } from "../shared/types.js";

const GRAPHQL_INTROSPECTION_QUERY = "query BrowserPilotToolsIntrospection { __schema { queryType { name } mutationType { name } subscriptionType { name } types { name fields { name args { name } } } } }";

type CrawlQueueItem = { url: string; depth: number; source: string };

function normalizeCrawlSeeds(options: CrawlOptions): string[] {
	const seeds = normalizeProbeTargets({ url: options.url, urls: options.urls, paths: options.paths, defaultScheme: options.defaultScheme });
	const withKnown = seeds.flatMap((seed) => [seed, ...knownFilePaths(options.knownFiles).map((knownPath) => new URL(knownPath, seed).toString())]);
	return [...new Set(withKnown.map(normalizeUrlForVisit))];
}

function createCrawlArtifactRoot(cwd: string): Promise<string> {
	const artifactBaseDir = path.resolve(cwd, ".browser-pilot", "artifacts");
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

function createCrawlState(options: CrawlOptions) {
	const seeds = normalizeCrawlSeeds(options);
	const requestedMaxDepth = positiveInt(options.maxDepth, 2);
	const requestedMaxPages = positiveInt(options.maxPages, 50);
	const hardCapWarnings: string[] = [];
	if (requestedMaxDepth > 5) hardCapWarnings.push(`maxDepth capped from ${requestedMaxDepth} to 5 (hard limit)`);
	if (requestedMaxPages > 500) hardCapWarnings.push(`maxPages capped from ${requestedMaxPages} to 500 (hard limit)`);
	return {
		options,
		seeds,
		maxDepth: Math.min(5, requestedMaxDepth),
		maxPages: Math.min(500, requestedMaxPages),
		sameOrigin: options.sameOrigin !== false,
		extractJs: options.extractJs !== false,
		activeGraphqlIntrospection: options.activeGraphqlIntrospection !== false,
		seedOrigins: new Set(seeds.map((seed) => new URL(seed).origin)),
		baseHeaders: normalizeHeaders(options.headers),
		queue: seeds.map((url) => ({ url, depth: 0, source: "seed" })) as CrawlQueueItem[],
		visited: new Set<string>(),
		pages: [] as Array<Record<string, unknown>>,
		endpoints: new Map<string, Record<string, unknown>>(),
		failures: [] as Array<Record<string, unknown>>,
		hardCapWarnings,
		artifactRoot: undefined as string | undefined,
	};
}

type CrawlState = ReturnType<typeof createCrawlState>;

async function ensureCrawlArtifactRoot(state: CrawlState): Promise<string> {
	state.artifactRoot ??= await createCrawlArtifactRoot(requestCwd(state.options));
	return state.artifactRoot;
}

async function crawlGraphqlDiscovery(state: CrawlState, url: string, type: string, bodyText: string, headers: HeaderMap) {
	let schema = /graphql/i.test(url) || /__schema|__typename/i.test(bodyText) ? detectGraphqlSchema(bodyText) : undefined;
	let probe: Record<string, unknown> | undefined;
	if (schema) schema = { ...schema, source: "passive-response" };
	else if (state.activeGraphqlIntrospection && shouldProbeGraphqlIntrospection(url, type)) {
		probe = await probeGraphqlIntrospection(url, headers, state.options);
		if (isRecord(probe?.schema)) schema = { ...probe.schema, source: "active-probe", probeStatus: probe.status, probeUrl: probe.url, probeBodySha256: probe.bodySha256 };
	}
	return { graphqlSchema: schema, graphqlProbe: probe };
}

function crawlServiceWorkerDetails(bodyText: string, url: string, jsLike: boolean) {
	if (!jsLike || endpointKindFor(url, "") !== "service-worker") return { serviceWorkerCacheRoutes: [], serviceWorkerDetails: undefined };
	const serviceWorkerCacheRoutes = extractServiceWorkerCacheRoutes(bodyText, url);
	const versionSummary = extractServiceWorkerVersionSummary(bodyText, url);
	const hasVersionDetails = versionSummary !== undefined && [versionSummary.cacheNameCount, versionSummary.importScriptCount, versionSummary.versionTokenCount].some((count) => count > 0);
	const serviceWorkerDetails = serviceWorkerCacheRoutes.length || hasVersionDetails
		? { kind: "service-worker", cacheRouteCount: serviceWorkerCacheRoutes.length, cacheRoutes: serviceWorkerCacheRoutes, versionSummary }
		: undefined;
	return { serviceWorkerCacheRoutes, serviceWorkerDetails };
}

async function discoverCrawlPage(state: CrawlState, url: string) {
	const headers = { ...state.baseHeaders };
	const cookieResult = state.options.bindBrowserSession === true ? await state.options.cookieProvider?.(url) : undefined;
	const cookie = cookieProviderResultHeader(cookieResult);
	if (cookie) headers.Cookie = cookie;
	const exchange = await fetchWithRedirects({ url, method: "GET", headers: sanitizeFetchHeaders(headers).headers }, { ...state.options, followRedirects: true, maxRedirects: positiveInt(state.options.maxRedirects, 5) });
	const final = exchange.final;
	const type = contentTypeOf(final.headers);
	const htmlLike = isHtml(final.headers, final.url);
	const jsLike = isJavaScript(final.headers, final.url);
	const links = htmlLike ? extractAttributeUrls(final.bodyText, final.url) : [];
	const forms = htmlLike ? extractForms(final.bodyText, final.url) : [];
	const scripts = htmlLike ? extractScriptSources(final.bodyText, final.url) : [];
	const manifests = htmlLike ? extractManifestUrls(final.bodyText, final.url) : [];
	const serviceWorkers = htmlLike || jsLike ? extractServiceWorkerUrls(final.bodyText, final.url) : [];
	const sourceMaps = htmlLike || jsLike ? extractSourceMapUrls(final.bodyText, final.url) : [];
	const apiSpec = detectApiSpec(final.bodyText, final.url, type);
	const graphql = await crawlGraphqlDiscovery(state, final.url, type, final.bodyText, headers);
	const sourceMapDetails = await parseSourceMapDetails(final.bodyText, final.url, () => ensureCrawlArtifactRoot(state));
	const serviceWorker = crawlServiceWorkerDetails(final.bodyText, final.url, jsLike);
	return { exchange, final, type, htmlLike, jsLike, links, forms, scripts, manifests, serviceWorkers, sourceMaps, apiSpec, sourceMapDetails, ...graphql, ...serviceWorker };
}

type CrawlPageDiscovery = Awaited<ReturnType<typeof discoverCrawlPage>>;

function scopedCrawlHints(state: CrawlState, discovery: CrawlPageDiscovery): Array<Record<string, unknown> & { url: string }> {
	const { final, htmlLike, jsLike, apiSpec, sourceMapDetails, serviceWorkerCacheRoutes, manifests, serviceWorkers, sourceMaps } = discovery;
	const hints: Array<Record<string, unknown>> = [
		...(htmlLike || jsLike ? extractStringUrls(final.bodyText, final.url) : []),
		...(/(?:robots\.txt|sitemap\.xml)(?:[?#]|$)/i.test(final.url) ? extractKnownFileUrls(final.bodyText, final.url) : []),
		...(isRecord(apiSpec) && Array.isArray(apiSpec.endpoints) ? apiSpec.endpoints.filter(isRecord) : []),
		...(isRecord(sourceMapDetails) && Array.isArray(sourceMapDetails.endpointHints) ? sourceMapDetails.endpointHints.filter(isRecord) : []),
		...serviceWorkerCacheRoutes,
		...manifests.map((url) => ({ url, kind: "manifest", source: "link" })),
		...serviceWorkers.map((url) => ({ url, kind: "service-worker", source: "serviceWorker.register" })),
		...sourceMaps.map((url) => ({ url, kind: "source-map", source: "sourceMappingURL" })),
	];
	if (apiSpec) hints.push({ url: final.url, kind: String(apiSpec.kind || "api-spec"), source: "document" });
	return hints.filter((hint): hint is Record<string, unknown> & { url: string } => isRecord(hint) && typeof hint.url === "string" && inScope(hint.url, state.seedOrigins, state.sameOrigin));
}

function recordCrawlEndpoints(state: CrawlState, discovery: CrawlPageDiscovery, scopedHints: Array<Record<string, unknown> & { url: string }>): void {
	const formHints = discovery.forms
		.map((form) => ({ url: form.action, kind: "form", method: form.method, inputNames: form.inputNames }))
		.filter((form) => inScope(form.url, state.seedOrigins, state.sameOrigin));
	for (const endpoint of [...scopedHints, ...formHints]) {
		const key = `${String(endpoint.kind || "endpoint")}:${typeof endpoint.method === "string" ? endpoint.method : ""}:${endpoint.url}`;
		state.endpoints.set(key, { ...endpoint, sourceUrl: discovery.final.url });
	}
}

function enqueueCrawlUrl(state: CrawlState, url: string, depth: number, source: string): void {
	if (inScope(url, state.seedOrigins, state.sameOrigin) && !state.visited.has(url)) state.queue.push({ url, depth, source });
}

function enqueueCrawlDiscoveries(state: CrawlState, next: CrawlQueueItem, discovery: CrawlPageDiscovery, scopedHints: Array<Record<string, unknown> & { url: string }>): void {
	if (next.depth < state.maxDepth) {
		for (const link of discovery.links) enqueueCrawlUrl(state, link.url, next.depth + 1, discovery.final.url);
		for (const hint of scopedHints) enqueueCrawlUrl(state, hint.url, next.depth + 1, discovery.final.url);
	}
	if (state.extractJs && discovery.htmlLike) {
		for (const scriptUrl of discovery.scripts) enqueueCrawlUrl(state, scriptUrl, Math.min(next.depth + 1, state.maxDepth), discovery.final.url);
	}
}

function crawlPageRecord(next: CrawlQueueItem, seedUrl: string, discovery: CrawlPageDiscovery, scopedHints: Array<Record<string, unknown> & { url: string }>): Record<string, unknown> {
	const { exchange, final, type, htmlLike, links, forms, scripts, manifests, serviceWorkers, sourceMaps, sourceMapDetails, apiSpec, graphqlSchema, graphqlProbe, serviceWorkerDetails } = discovery;
	return {
		url: final.url,
		seedUrl,
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
		endpoints: scopedHints.map((item) => item.url).slice(0, 100),
		endpointDetails: scopedHints.slice(0, 100),
	};
}

function crawlVersionValues(pages: Array<Record<string, unknown>>, key: "cacheNames" | "versionTokens"): string[] {
	const values = pages.flatMap((page) => {
		const details = isRecord(page.serviceWorkerDetails) ? page.serviceWorkerDetails : undefined;
		const summary = isRecord(details?.versionSummary) ? details.versionSummary : undefined;
		return Array.isArray(summary?.[key]) ? summary[key].map(String) : [];
	});
	return Array.from(new Set(values)).slice(0, 100);
}

export async function runBrowserCrawl(options: CrawlOptions) {
	const state = createCrawlState(options);
	while (state.queue.length && state.pages.length < state.maxPages) {
		const next = state.queue.shift();
		if (!next) break;
		const url = normalizeUrlForVisit(next.url);
		if (state.visited.has(url) || !inScope(url, state.seedOrigins, state.sameOrigin)) continue;
		state.visited.add(url);
		try {
			const discovery = await discoverCrawlPage(state, url);
			const scopedHints = scopedCrawlHints(state, discovery);
			recordCrawlEndpoints(state, discovery, scopedHints);
			enqueueCrawlDiscoveries(state, next, discovery, scopedHints);
			state.pages.push(crawlPageRecord(next, url, discovery, scopedHints));
		} catch (error) {
			state.failures.push({ url, depth: next.depth, source: next.source, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const sourceArchiveCount = state.pages.reduce((sum, page) => sum + Number(isRecord(page.sourceMapDetails) ? page.sourceMapDetails.archivedSourceCount || 0 : 0), 0);
	return {
		ok: state.failures.length === 0,
		generatedAt: new Date().toISOString(),
		seeds: state.seeds,
		maxDepth: state.maxDepth,
		maxPages: state.maxPages,
		sameOrigin: state.sameOrigin,
		extractJs: state.extractJs,
		activeGraphqlIntrospection: state.activeGraphqlIntrospection,
		artifactRoot: state.artifactRoot,
		sourceArchiveCount,
		serviceWorkerCacheNames: crawlVersionValues(state.pages, "cacheNames"),
		serviceWorkerVersionTokens: crawlVersionValues(state.pages, "versionTokens"),
		pageCount: state.pages.length,
		endpointCount: state.endpoints.size,
		pages: state.pages,
		endpoints: Array.from(state.endpoints.values()),
		failures: state.failures,
		...(state.hardCapWarnings.length ? { warnings: state.hardCapWarnings } : {}),
	};
}
