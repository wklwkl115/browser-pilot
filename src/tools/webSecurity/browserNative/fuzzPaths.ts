import { randomUUID } from "node:crypto";
import { createCodedError } from "../../../utils/codedError";
import { baselineClusterKey, matchesStatusBodyResult, nearestBaselineByDistance, normalizeBaselineStrategy, responseChangeDelta, sameBaselineCluster } from "../shared/baseline";
import { compactStep, contentTypeOf, extractTitle, fetchWithRedirects, normalizeHeaders, normalizeProbeTargets, responseFingerprint, responsesDiffer, sanitizeFetchHeaders } from "../shared/http";
import { asString, normalizeMethod, numericList, positiveInt, readWordlist, stringList } from "../shared/normalize";
import type { CookieProvider, HeaderMap, RawFuzzPathsOptions } from "../shared/types";

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

function replaceFuzzSequential(baseUrl: string, values: string[]): string {
	let index = 0;
	return baseUrl.replace(/FUZZ/g, () => encodeURIComponent(values[Math.min(index++, values.length - 1)] || ""));
}

function buildFuzzUrls(baseUrl: string, candidate: string): string[] {
	if (baseUrl.includes("FUZZ")) {
		const count = (baseUrl.match(/FUZZ/g) || []).length;
		const tuple = candidate.split("::").map((item) => item.trim()).filter(Boolean);
		const replaced = count > 1 && tuple.length === count ? replaceFuzzSequential(baseUrl, tuple) : baseUrl.replaceAll("FUZZ", encodeURIComponent(candidate));
		return [normalizeUrlForVisit(replaced)];
	}
	return [normalizeUrlForVisit(new URL(candidate.replace(/^\/+/, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString())];
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

function recursiveBaseBudget(candidateCount: number, recursive: boolean): number {
	if (!recursive) return 1;
	return Math.max(1, Math.min(50, Math.floor(BASELINE_REQUEST_BUDGET_PER_ROOT / Math.max(1, candidateCount))));
}

function buildBaselineSamples(stem: string, extensions: string[], appendSlash: boolean): string[] {
	const cleaned = stem.replace(/^\/+/, "").replace(/\/+$/, "") || `__pi_fuzz_baseline_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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

function fuzzPathsInputError(message: string, details: Record<string, unknown> = {}): Error {
	return createCodedError({ name: "FuzzPathsInputError", code: "INVALID_RULE", message, details, suppressStack: false });
}

async function normalizeFuzzPathsOptions(options: RawFuzzPathsOptions): Promise<NormalizedFuzzPathsOptions> {
	const bases = normalizeProbeTargets({ url: options.url, urls: options.urls, defaultScheme: options.defaultScheme });
	const explicit = [...stringList(options.paths), ...stringList(options.words), ...stringList(options.wordlist), ...(await readWordlist(options.wordlistPath))];
	if (!explicit.length) throw fuzzPathsInputError("browser_fuzz_paths requires paths, words, wordlist, or wordlistPath", { field: "paths|words|wordlist|wordlistPath" });
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
	const baselinePath = asString(options.baselinePath)?.trim() || `__pi_fuzz_baseline_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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

export async function runFuzzPaths(options: RawFuzzPathsOptions) {
	const normalized = await normalizeFuzzPathsOptions(options);
	const baselines: Array<Record<string, unknown>> = [];
	const baselineFingerprints: FuzzPathFingerprint[] = [];
	const results: Array<Record<string, unknown>> = [];
	const failures: Array<Record<string, unknown>> = [];
	let sent = 0;
	let visitedBaseCount = 0;
	let discoveredDirectoryCount = 0;
	let truncatedDiscoveredDirectories = 0;
	for (const rootBase of normalized.bases) {
		const queue = [{ baseUrl: rootBase, depth: 0 }];
		const seenBases = new Set<string>([normalizeRecursiveBaseUrl(rootBase)]);
		const maxVisitedBases = recursiveBaseBudget(normalized.candidates.length, normalized.recursive);
		while (queue.length) {
			const current = queue.shift();
			if (!current) break;
			visitedBaseCount += 1;
			const currentBaselines: FuzzPathFingerprint[] = [];
			for (const sample of normalized.baselineSamples) {
				const baselineUrl = buildFuzzBaselineUrl(current.baseUrl, sample);
				try {
					const headers = { ...normalized.baseHeaders };
					const cookie = normalized.bindBrowserSession ? await normalized.cookieProvider?.(baselineUrl) : undefined;
					if (cookie) headers.Cookie = cookie;
					const sanitized = sanitizeFetchHeaders(headers);
					const baselineExchange = await fetchWithRedirects({ url: baselineUrl, method: normalized.method, headers: sanitized.headers }, normalized);
					const final = baselineExchange.final;
					const fingerprint = responseFingerprint(final);
					const item: FuzzPathFingerprint = { baseUrl: current.baseUrl, url: final.url, sample, depth: current.depth + 1, clusterKey: baselineClusterKey(fingerprint), ...fingerprint };
					currentBaselines.push(item);
					baselineFingerprints.push(item);
					baselines.push({ baseUrl: current.baseUrl, sample, depth: current.depth + 1, url: final.url, status: final.status, title: fingerprint.title, bodyBytes: final.bodyBytes, bodySha256: fingerprint.bodySha256, location: fingerprint.location, clusterKey: item.clusterKey, redirects: baselineExchange.chain.slice(0, -1).map(compactStep) });
				} catch (error) {
					baselines.push({ baseUrl: current.baseUrl, sample, depth: current.depth + 1, url: baselineUrl, error: error instanceof Error ? error.message : String(error) });
				}
			}
			for (const candidate of normalized.candidates) {
				const targets = buildFuzzUrls(current.baseUrl, candidate);
				for (const target of targets) {
					try {
						const headers = { ...normalized.baseHeaders };
						const cookie = normalized.bindBrowserSession ? await normalized.cookieProvider?.(target) : undefined;
						if (cookie) headers.Cookie = cookie;
						const sanitized = sanitizeFetchHeaders(headers);
						const exchange = await fetchWithRedirects({ url: target, method: normalized.method, headers: sanitized.headers }, normalized);
						const final = exchange.final;
						const fingerprint = responseFingerprint(final);
						const nearestBaseline = nearestBaselineByDistance(currentBaselines, fingerprint);
						const exactBaselineMatch = currentBaselines.some((baseline) => !responsesDiffer(fingerprint, baseline));
						const baselineClusterMatched = currentBaselines.some((baseline) => sameBaselineCluster(fingerprint, baseline));
						const similarToBaseline = normalized.baselineStrategy === "exact" ? exactBaselineMatch : normalized.baselineStrategy === "cluster" ? baselineClusterMatched : (exactBaselineMatch || baselineClusterMatched);
						const differentFromBaseline = currentBaselines.length ? !similarToBaseline : undefined;
						const statusBodyMatched = matchesStatusBodyResult(final.status, final.bodyBytes, normalized);
						const matched = statusBodyMatched && (!normalized.filterBaseline || differentFromBaseline !== false);
						const resultDepth = current.depth + 1;
						results.push({
							matched,
							baseUrl: current.baseUrl,
							candidate,
							depth: resultDepth,
							url: final.url,
							status: final.status,
							contentType: contentTypeOf(final.headers),
							title: extractTitle(final.bodyText),
							bodyBytes: final.bodyBytes,
							bodySha256: fingerprint.bodySha256,
							bodyTruncated: final.bodyTruncated,
							location: fingerprint.location,
							differentFromBaseline,
							baselineClusterMatched,
							exactBaselineMatch,
							nearestBaseline: nearestBaseline ? { url: nearestBaseline.baseline.url, sample: nearestBaseline.baseline.sample, distance: nearestBaseline.distance, clusterKey: nearestBaseline.baseline.clusterKey } : undefined,
							delta: nearestBaseline ? responseChangeDelta(nearestBaseline.baseline, fingerprint) : undefined,
							similarityKey: `${fingerprint.status}|${fingerprint.title || ""}|${fingerprint.bodyBytes}|${fingerprint.bodySha256}|${fingerprint.location || ""}`,
							redirects: exchange.chain.slice(0, -1).map(compactStep),
							body: { text: final.bodyText, base64: final.bodyBase64 },
						});
						if (normalized.recursive && resultDepth < normalized.maxDepth && seenBases.size < maxVisitedBases && differentFromBaseline !== false) {
							const discoveredBase = discoverDirectoryBase(current.baseUrl, target, final.url);
							if (discoveredBase) {
								if (!seenBases.has(discoveredBase)) {
									seenBases.add(discoveredBase);
									queue.push({ baseUrl: discoveredBase, depth: current.depth + 1 });
									discoveredDirectoryCount += 1;
								} else {
									truncatedDiscoveredDirectories += 1;
								}
							}
						} else if (normalized.recursive && resultDepth < normalized.maxDepth) {
							const discoveredBase = discoverDirectoryBase(current.baseUrl, target, final.url);
							if (discoveredBase && !seenBases.has(discoveredBase)) truncatedDiscoveredDirectories += 1;
						}
					} catch (error) {
						failures.push({ baseUrl: current.baseUrl, candidate, depth: current.depth + 1, url: target, error: error instanceof Error ? error.message : String(error) });
					}
					sent += 1;
					if (normalized.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, normalized.delayMs));
				}
			}
		}
	}
	const uniqueResults = dedupeFuzzPathResults(results);
	const matched = uniqueResults.filter((item) => item.matched === true);
	const clusters = clusterFuzzPathResults(results);
	const baselineClusters = clusterBaselineFingerprints(baselineFingerprints);
	return {
		ok: failures.length === 0,
		generatedAt: new Date().toISOString(),
		baseCount: normalized.bases.length,
		candidateCount: normalized.candidates.length,
		requestCount: sent,
		matchedCount: matched.length,
		resultCount: uniqueResults.length,
		rawResultCount: results.length,
		deduplicatedResults: results.length - uniqueResults.length,
		truncatedCandidates: normalized.truncatedCandidates,
		filterBaseline: normalized.filterBaseline,
		baselinePath: normalized.baselinePath,
		baselineStrategy: normalized.baselineStrategy,
		baselineSampleCount: normalized.baselineSamples.length,
		baselineClusters,
		recursive: normalized.recursive,
		maxDepth: normalized.maxDepth,
		visitedBaseCount,
		discoveredDirectoryCount,
		truncatedDiscoveredDirectories,
		matchStatus: normalized.matchStatus,
		filterStatus: normalized.filterStatus,
		filterBodyBytes: normalized.filterBodyBytes,
		baselines,
		clusters,
		results: uniqueResults,
		matched,
		failures,
	};
}
