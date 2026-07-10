import { randomUUID } from "node:crypto";
import { createCodedError } from "../../../utils/codedError.js";
import { baselineClusterKey, matchesStatusBodyResult, nearestBaselineByDistance, normalizeBaselineStrategy, responseChangeDelta, responsesDiffer, sameBaselineCluster } from "../shared/baseline.js";
import { compactStep, contentTypeOf, cookieProviderResultHeader, fetchWithRedirects, normalizeHeaders, normalizeProbeTargets, responseFingerprint, sanitizeFetchHeaders } from "../shared/http.js";
import { asString, normalizeMethod, numericList, positiveInt, readWordlist, stringList } from "../shared/normalize.js";
import type { CookieProvider, HeaderMap, RawFuzzPathsOptions } from "../shared/types.js";

const MAX_FUZZ_DEPTH = 5;
const BASELINE_REQUEST_BUDGET_PER_ROOT = 1_000;

type FuzzPathFingerprint = ReturnType<typeof responseFingerprint> & {
	baseUrl: string;
	url: string;
	sample: string;
	depth: number;
	clusterKey: string;
};

function candidateVariants(raw: string, extensions: string[], appendSlash: boolean): string[] {
	const cleaned = raw.trim().replace(/^\/+/, "");
	if (!cleaned) return [];
	const variants = new Set<string>([cleaned]);
	if (appendSlash && !cleaned.endsWith("/")) variants.add(`${cleaned}/`);
	if (!/\.[A-Za-z0-9]{1,8}(?:[/?#]|$)/.test(cleaned)) {
		for (const ext of extensions) {
			const normalized = ext.startsWith(".") ? ext : `.${ext}`;
			variants.add(`${cleaned}${normalized}`);
		}
	}
	return Array.from(variants);
}

function normalizeUrlForVisit(url: string): string {
	const parsed = new URL(url);
	parsed.hash = "";
	return parsed.toString();
}

function normalizeRecursiveBaseUrl(url: string): string {
	const parsed = new URL(normalizeUrlForVisit(url));
	parsed.search = "";
	if (!parsed.pathname.endsWith("/")) parsed.pathname = `${parsed.pathname}/`;
	return parsed.toString();
}

function buildFuzzUrl(baseUrl: string, candidate: string): string {
	if (baseUrl.includes("FUZZ")) {
		const count = (baseUrl.match(/FUZZ/g) || []).length;
		const tuple = candidate.split("::").map((item) => item.trim()).filter(Boolean);
		let tupleIndex = 0;
		const replaced = count > 1 && tuple.length === count ? baseUrl.replace(/FUZZ/g, () => encodeURIComponent(tuple[Math.min(tupleIndex++, tuple.length - 1)] || "")) : baseUrl.replaceAll("FUZZ", encodeURIComponent(candidate));
		return normalizeUrlForVisit(replaced);
	}
	return normalizeUrlForVisit(new URL(candidate.replace(/^\/+/, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString());
}

function buildFuzzBaselineUrl(baseUrl: string, baselinePath: string): string {
	if (baseUrl.includes("FUZZ")) return normalizeUrlForVisit(baseUrl.replaceAll("FUZZ", encodeURIComponent(baselinePath.replace(/^\/+/, ""))));
	return normalizeUrlForVisit(new URL(baselinePath.replace(/^\/+/, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString());
}

function dedupeFuzzPathResults(results: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	const seen = new Set<string>();
	const out: Array<Record<string, unknown>> = [];
	for (const item of results) {
		const key = `${item.url}|${item.status}|${item.bodySha256 || ""}|${item.location || ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}

function clusterFuzzPathResults(results: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	const clusters = new Map<string, { key: string; status?: unknown; title?: unknown; bodyBytes?: unknown; bodySha256?: unknown; count: number; matchedCount: number; sampleUrls: string[]; sampleCandidates: string[] }>();
	for (const item of results) {
		const key = String(item.similarityKey || `${item.status}|${item.title || ""}|${item.bodyBytes || 0}|${item.bodySha256 || ""}`);
		let cluster = clusters.get(key);
		if (!cluster) {
			cluster = { key, status: item.status, title: item.title, bodyBytes: item.bodyBytes, bodySha256: item.bodySha256, count: 0, matchedCount: 0, sampleUrls: [], sampleCandidates: [] };
			clusters.set(key, cluster);
		}
		cluster.count += 1;
		if (item.matched === true) cluster.matchedCount += 1;
		if (typeof item.url === "string" && cluster.sampleUrls.length < 5 && !cluster.sampleUrls.includes(item.url)) cluster.sampleUrls.push(item.url);
		if (typeof item.candidate === "string" && cluster.sampleCandidates.length < 10 && !cluster.sampleCandidates.includes(item.candidate)) cluster.sampleCandidates.push(item.candidate);
	}
	return Array.from(clusters.values()).sort((a, b) => b.count - a.count).slice(0, 50);
}

function clusterBaselineFingerprints(baselines: FuzzPathFingerprint[]): Array<Record<string, unknown>> {
	const clusters = new Map<string, { key: string; status: number; title?: string; location?: string; count: number; bodyBytesMin: number; bodyBytesMax: number; sampleUrls: string[]; samplePaths: string[] }>();
	for (const baseline of baselines) {
		let cluster = clusters.get(baseline.clusterKey);
		if (!cluster) {
			cluster = {
				key: baseline.clusterKey,
				status: baseline.status,
				title: baseline.title,
				location: baseline.location,
				count: 0,
				bodyBytesMin: baseline.bodyBytes,
				bodyBytesMax: baseline.bodyBytes,
				sampleUrls: [],
				samplePaths: [],
			};
			clusters.set(baseline.clusterKey, cluster);
		}
		cluster.count += 1;
		cluster.bodyBytesMin = Math.min(cluster.bodyBytesMin, baseline.bodyBytes);
		cluster.bodyBytesMax = Math.max(cluster.bodyBytesMax, baseline.bodyBytes);
		if (cluster.sampleUrls.length < 5 && !cluster.sampleUrls.includes(baseline.url)) cluster.sampleUrls.push(baseline.url);
		if (cluster.samplePaths.length < 10 && !cluster.samplePaths.includes(baseline.sample)) cluster.samplePaths.push(baseline.sample);
	}
	return Array.from(clusters.values()).sort((a, b) => b.count - a.count).slice(0, 20);
}

function buildBaselineSamples(stem: string, extensions: string[], appendSlash: boolean): string[] {
	const cleaned = stem.replace(/^\/+/, "").replace(/\/+$/, "") || `__browser_pilot_fuzz_baseline_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const ext = extensions[0] || "txt";
	const samples = [cleaned, `${cleaned}-alt`, `${cleaned}.${ext}`];
	if (appendSlash || !cleaned.endsWith("/")) samples.push(`${cleaned}/`);
	return [...new Set(samples)].slice(0, 4);
}

function discoverDirectoryBase(baseUrl: string, targetUrl: string, finalUrl: string): string | undefined {
	if (baseUrl.includes("FUZZ")) return undefined;
	const base = new URL(normalizeRecursiveBaseUrl(baseUrl));
	const target = new URL(targetUrl);
	const final = new URL(finalUrl);
	if (base.origin !== target.origin || base.origin !== final.origin) return undefined;
	const pathname = final.pathname.endsWith("/") ? final.pathname : target.pathname.endsWith("/") ? target.pathname : undefined;
	if (!pathname) return undefined;
	if (!pathname.startsWith(base.pathname)) return undefined;
	const discovered = normalizeRecursiveBaseUrl(new URL(pathname, final.origin).toString());
	return discovered === normalizeRecursiveBaseUrl(baseUrl) ? undefined : discovered;
}

type NormalizedFuzzPathsOptions = {
	bases: string[];
	candidates: string[];
	truncatedCandidates: number;
	method: string;
	baseHeaders: HeaderMap;
	followRedirects: boolean;
	maxRedirects: number;
	timeoutMs: number;
	maxBodyBytes: number;
	allowPrivateTargets: boolean;
	bindBrowserSession: boolean;
	cookieProvider?: CookieProvider;
	matchStatus: number[];
	filterStatus: number[];
	filterBodyBytes: number[];
	filterBaseline: boolean;
	baselinePath: string;
	baselineStrategy: "exact" | "cluster" | "auto";
	baselineSamples: string[];
	recursive: boolean;
	maxDepth: number;
	rateLimitPerSecond: number;
	delayMs: number;
};

async function normalizeFuzzPathsOptions(options: RawFuzzPathsOptions): Promise<NormalizedFuzzPathsOptions> {
	const bases = normalizeProbeTargets({ url: options.url, urls: options.urls, defaultScheme: options.defaultScheme });
	const explicit = [...stringList(options.paths), ...stringList(options.words), ...stringList(options.wordlist), ...(await readWordlist(options.wordlistPath))];
	if (!explicit.length) throw createCodedError({ name: "FuzzPathsInputError", code: "INVALID_RULE", message: "browser_fuzz_paths requires paths, words, wordlist, or wordlistPath", details: { field: "paths|words|wordlist|wordlistPath" }, suppressStack: false });
	const extensions = stringList(options.extensions).map((item) => item.replace(/^\./, "")).filter(Boolean);
	const appendSlash = options.appendSlash === true;
	const maxCandidates = Math.min(5_000, positiveInt(options.maxCandidates, 500));
	const seenCandidates = new Set<string>();
	const limitedCandidates: string[] = [];
	let totalCandidates = 0;
	for (const item of explicit) {
		for (const candidate of candidateVariants(item, extensions, appendSlash)) {
			if (seenCandidates.has(candidate)) continue;
			seenCandidates.add(candidate);
			totalCandidates += 1;
			if (limitedCandidates.length < maxCandidates) limitedCandidates.push(candidate);
		}
	}
	const recursive = options.recursive === true;
	const rateLimitPerSecond = positiveInt(options.rateLimitPerSecond, 0);
	const followRedirects = options.followRedirects === true;
	const baselinePath = asString(options.baselinePath)?.trim() || `__browser_pilot_fuzz_baseline_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	return {
		bases,
		candidates: limitedCandidates,
		truncatedCandidates: Math.max(0, totalCandidates - limitedCandidates.length),
		method: normalizeMethod(options.method, "GET"),
		baseHeaders: normalizeHeaders(options.headers),
		followRedirects,
		maxRedirects: positiveInt(options.maxRedirects, followRedirects ? 3 : 0),
		timeoutMs: positiveInt(options.timeoutMs, 15_000),
		maxBodyBytes: positiveInt(options.maxBodyBytes, 256_000),
		allowPrivateTargets: options.allowPrivateTargets === true,
		bindBrowserSession: options.bindBrowserSession === true,
		cookieProvider: options.cookieProvider,
		matchStatus: numericList(options.matchStatus),
		filterStatus: numericList(options.filterStatus),
		filterBodyBytes: numericList(options.filterBodyBytes),
		filterBaseline: options.filterBaseline === true,
		baselinePath,
		baselineStrategy: normalizeBaselineStrategy(options.baselineStrategy),
		baselineSamples: buildBaselineSamples(baselinePath, extensions, appendSlash),
		recursive,
		maxDepth: Math.min(MAX_FUZZ_DEPTH, Math.max(1, positiveInt(options.maxDepth, recursive ? 2 : 1))),
		rateLimitPerSecond,
		delayMs: rateLimitPerSecond > 0 ? Math.ceil(1000 / rateLimitPerSecond) : 0,
	};
}

type FuzzPathBase = { baseUrl: string; depth: number };
type FuzzPathRunState = { baselines: Array<Record<string, unknown>>; results: Array<Record<string, unknown>>; failures: Array<Record<string, unknown>>; sent: number; visitedBaseCount: number; discoveredDirectoryCount: number; truncatedDiscoveredDirectories: number };

function fuzzPathsHardCapWarnings(options: RawFuzzPathsOptions): string[] {
	const warnings: string[] = [];
	const requestedMaxCandidates = positiveInt(options.maxCandidates, 500);
	if (requestedMaxCandidates > 5_000) warnings.push(`maxCandidates capped from ${requestedMaxCandidates} to 5000 (hard limit)`);
	const requestedMaxDepth = positiveInt(options.maxDepth, options.recursive === true ? 2 : 1);
	if (requestedMaxDepth > MAX_FUZZ_DEPTH) warnings.push(`maxDepth capped from ${requestedMaxDepth} to ${MAX_FUZZ_DEPTH} (hard limit)`);
	return warnings;
}

async function fetchFuzzPath(url: string, options: NormalizedFuzzPathsOptions) {
	const headers = { ...options.baseHeaders };
	const cookie = cookieProviderResultHeader(options.bindBrowserSession ? await options.cookieProvider?.(url) : undefined);
	if (cookie) headers.Cookie = cookie;
	return fetchWithRedirects({ url, method: options.method, headers: sanitizeFetchHeaders(headers).headers }, options);
}

async function collectFuzzPathBaselines(current: FuzzPathBase, options: NormalizedFuzzPathsOptions, state: FuzzPathRunState): Promise<FuzzPathFingerprint[]> {
	const currentBaselines: FuzzPathFingerprint[] = [];
	for (const sample of options.baselineSamples) {
		const baselineUrl = buildFuzzBaselineUrl(current.baseUrl, sample);
		try {
			const exchange = await fetchFuzzPath(baselineUrl, options);
			const final = exchange.final;
			const fingerprint = responseFingerprint(final);
			const item: FuzzPathFingerprint = { baseUrl: current.baseUrl, url: final.url, sample, depth: current.depth + 1, clusterKey: baselineClusterKey(fingerprint), ...fingerprint };
			currentBaselines.push(item);
			state.baselines.push({ ...item, redirects: exchange.chain.slice(0, -1).map(compactStep) });
		} catch (error) {
			state.baselines.push({ baseUrl: current.baseUrl, sample, depth: current.depth + 1, url: baselineUrl, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return currentBaselines;
}

function projectFuzzPathResult(current: FuzzPathBase, candidate: string, exchange: Awaited<ReturnType<typeof fetchWithRedirects>>, currentBaselines: FuzzPathFingerprint[], options: NormalizedFuzzPathsOptions) {
	const final = exchange.final;
	const fingerprint = responseFingerprint(final);
	const nearestBaseline = nearestBaselineByDistance(currentBaselines, fingerprint);
	const exactBaselineMatch = currentBaselines.some((baseline) => !responsesDiffer(fingerprint, baseline));
	const baselineClusterMatched = currentBaselines.some((baseline) => sameBaselineCluster(fingerprint, baseline));
	const similarToBaseline = options.baselineStrategy === "exact" ? exactBaselineMatch : options.baselineStrategy === "cluster" ? baselineClusterMatched : exactBaselineMatch || baselineClusterMatched;
	const differentFromBaseline = currentBaselines.length ? !similarToBaseline : undefined;
	const matched = matchesStatusBodyResult(final.status, final.bodyBytes, options) && (!options.filterBaseline || differentFromBaseline !== false);
	const resultDepth = current.depth + 1;
	return {
		matched,
		baseUrl: current.baseUrl,
		candidate,
		depth: resultDepth,
		url: final.url,
		contentType: contentTypeOf(final.headers),
		...fingerprint,
		bodyTruncated: final.bodyTruncated,
		differentFromBaseline,
		baselineClusterMatched,
		exactBaselineMatch,
		nearestBaseline: nearestBaseline ? { url: nearestBaseline.baseline.url, sample: nearestBaseline.baseline.sample, distance: nearestBaseline.distance, clusterKey: nearestBaseline.baseline.clusterKey } : undefined,
		delta: nearestBaseline ? responseChangeDelta(nearestBaseline.baseline, fingerprint) : undefined,
		similarityKey: `${fingerprint.status}|${fingerprint.title || ""}|${fingerprint.bodyBytes}|${fingerprint.bodySha256}|${fingerprint.location || ""}`,
		redirects: exchange.chain.slice(0, -1).map(compactStep),
		body: { text: final.bodyText, base64: final.bodyBase64 },
	};
}

function queueDiscoveredFuzzBase(current: FuzzPathBase, target: string, probe: ReturnType<typeof projectFuzzPathResult>, queue: FuzzPathBase[], seenBases: Set<string>, maxVisitedBases: number, options: NormalizedFuzzPathsOptions, state: FuzzPathRunState): void {
	if (!options.recursive || probe.depth >= options.maxDepth) return;
	const discoveredBase = discoverDirectoryBase(current.baseUrl, target, probe.url);
	if (!discoveredBase) return;
	const canQueue = seenBases.size < maxVisitedBases && probe.differentFromBaseline !== false;
	const seen = seenBases.has(discoveredBase);
	if (!seen && canQueue) {
		seenBases.add(discoveredBase);
		queue.push({ baseUrl: discoveredBase, depth: current.depth + 1 });
		state.discoveredDirectoryCount += 1;
		return;
	}
	if (!seen || canQueue) state.truncatedDiscoveredDirectories += 1;
}

async function probeFuzzPathCandidate(current: FuzzPathBase, candidate: string, currentBaselines: FuzzPathFingerprint[], queue: FuzzPathBase[], seenBases: Set<string>, maxVisitedBases: number, options: NormalizedFuzzPathsOptions, state: FuzzPathRunState): Promise<void> {
	const target = buildFuzzUrl(current.baseUrl, candidate);
	try {
		const exchange = await fetchFuzzPath(target, options);
		const probe = projectFuzzPathResult(current, candidate, exchange, currentBaselines, options);
		state.results.push(probe);
		queueDiscoveredFuzzBase(current, target, probe, queue, seenBases, maxVisitedBases, options, state);
	} catch (error) {
		state.failures.push({ baseUrl: current.baseUrl, candidate, depth: current.depth + 1, url: target, error: error instanceof Error ? error.message : String(error) });
	}
	state.sent += 1;
	if (options.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
}

async function runFuzzPathRoot(rootBase: string, options: NormalizedFuzzPathsOptions, state: FuzzPathRunState): Promise<void> {
	const queue: FuzzPathBase[] = [{ baseUrl: rootBase, depth: 0 }];
	const seenBases = new Set<string>([normalizeRecursiveBaseUrl(rootBase)]);
	const maxVisitedBases = options.recursive ? Math.max(1, Math.min(50, Math.floor(BASELINE_REQUEST_BUDGET_PER_ROOT / Math.max(1, options.candidates.length)))) : 1;
	while (queue.length) {
		const current = queue.shift()!;
		state.visitedBaseCount += 1;
		const currentBaselines = await collectFuzzPathBaselines(current, options, state);
		for (const candidate of options.candidates) await probeFuzzPathCandidate(current, candidate, currentBaselines, queue, seenBases, maxVisitedBases, options, state);
	}
}

function fuzzPathsResult(options: NormalizedFuzzPathsOptions, state: FuzzPathRunState, warnings: string[]) {
	const uniqueResults = dedupeFuzzPathResults(state.results);
	const matched = uniqueResults.filter((item) => item.matched === true);
	return {
		ok: state.failures.length === 0,
		generatedAt: new Date().toISOString(),
		baseCount: options.bases.length,
		candidateCount: options.candidates.length,
		requestCount: state.sent,
		matchedCount: matched.length,
		resultCount: uniqueResults.length,
		rawResultCount: state.results.length,
		deduplicatedResults: state.results.length - uniqueResults.length,
		truncatedCandidates: options.truncatedCandidates,
		filterBaseline: options.filterBaseline,
		baselinePath: options.baselinePath,
		baselineStrategy: options.baselineStrategy,
		baselineSampleCount: options.baselineSamples.length,
		baselineClusters: clusterBaselineFingerprints(state.baselines.filter((item) => typeof item.status === "number") as FuzzPathFingerprint[]),
		recursive: options.recursive,
		maxDepth: options.maxDepth,
		visitedBaseCount: state.visitedBaseCount,
		discoveredDirectoryCount: state.discoveredDirectoryCount,
		truncatedDiscoveredDirectories: state.truncatedDiscoveredDirectories,
		matchStatus: options.matchStatus,
		filterStatus: options.filterStatus,
		filterBodyBytes: options.filterBodyBytes,
		baselines: state.baselines,
		clusters: clusterFuzzPathResults(state.results),
		results: uniqueResults,
		matched,
		failures: state.failures,
		...(warnings.length ? { warnings } : {}),
	};
}

export async function runFuzzPaths(options: RawFuzzPathsOptions) {
	const warnings = fuzzPathsHardCapWarnings(options);
	const normalized = await normalizeFuzzPathsOptions(options);
	const state: FuzzPathRunState = { baselines: [], results: [], failures: [], sent: 0, visitedBaseCount: 0, discoveredDirectoryCount: 0, truncatedDiscoveredDirectories: 0 };
	for (const rootBase of normalized.bases) await runFuzzPathRoot(rootBase, normalized, state);
	return fuzzPathsResult(normalized, state, warnings);
}
