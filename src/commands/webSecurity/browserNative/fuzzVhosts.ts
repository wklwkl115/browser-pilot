import http from "node:http";
import https from "node:https";
import { Buffer } from "node:buffer";
import { createCodedError } from "../../../utils/codedError.js";
import { baselineClusterKey, matchesStatusBodyResult, nearestBaselineByDistance, normalizeBaselineStrategy, responseChangeDelta, responseDistance, responsesDiffer, sameBaselineCluster as sameHttpBaselineCluster } from "../shared/baseline.js";
import { TEXTUAL_CONTENT_TYPE, assertAllowedTargetUrl, compactStep, cookieProviderResultHeader, normalizeHeaders, normalizeProbeTargets, redirectLocation, redirectMethod, responseFingerprint, sanitizeFetchHeaders } from "../shared/http.js";
import { asString, normalizeMethod, numericList, positiveInt, readWordlist, stringList } from "../shared/normalize.js";
import type { CookieProvider, FetchStep, HeaderMap, RawFuzzVhostsOptions, WebFetchOptions } from "../shared/types.js";

type TlsCertificateSummary = Record<string, unknown>;
type VhostFetchStep = FetchStep & { tlsCertificate?: TlsCertificateSummary };
type VhostResponseFingerprint = ReturnType<typeof responseFingerprint> & {
	certificateKey: string;
	tlsFingerprint256?: string;
	tlsSubject?: string;
	tlsSubjectAltName?: string;
	tlsSerialNumber?: string;
};
type VhostBaselineFingerprint = VhostResponseFingerprint & { host: string; sniName?: string; clusterKey: string };

function isIpLikeHost(hostname: string): boolean {
	return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname === "localhost" || hostname.includes(":");
}

function buildVhostCandidates(baseUrl: string, options: NormalizedFuzzVhostsOptions): string[] {
	const parsed = new URL(baseUrl);
	const baseDomain = options.baseDomain || (isIpLikeHost(parsed.hostname) ? "" : parsed.hostname);
	const generated = options.words.map((word) => {
		if (options.template?.includes("FUZZ")) return options.template.replaceAll("FUZZ", word);
		if (word.includes(".")) return word;
		return baseDomain ? `${word}.${baseDomain}` : word;
	});
	return [...new Set([...options.explicitHosts, ...generated].map((item) => item.trim()).filter(Boolean))];
}

function hostHeaderName(hostHeader: string): string {
	return hostHeader.replace(/:\d+$/, "");
}

function vhostSniName(baseUrl: string, hostHeader: string, options: NormalizedFuzzVhostsOptions): string | undefined {
	if (options.sniMode === "none") return undefined;
	if (options.sniMode === "host") return hostHeaderName(hostHeader);
	if (options.sniMode === "custom") return options.sniName;
	return new URL(baseUrl).hostname;
}

function summarizeTlsCertificate(socket: { getPeerCertificate?: (detailed?: boolean) => Record<string, unknown> } | undefined | null): TlsCertificateSummary | undefined {
	const raw = socket && typeof socket.getPeerCertificate === "function" ? socket.getPeerCertificate(true) : undefined;
	if (!raw || !Object.keys(raw).length) return undefined;
	return {
		subject: raw.subject,
		issuer: raw.issuer,
		subjectaltname: raw.subjectaltname,
		validFrom: raw.valid_from,
		validTo: raw.valid_to,
		fingerprint256: raw.fingerprint256,
		serialNumber: raw.serialNumber,
	};
}

async function fetchSingleWithHost(request: { url: string; method: string; headers: HeaderMap; body?: string | Buffer }, hostHeader: string, options: Required<Pick<WebFetchOptions, "timeoutMs" | "maxBodyBytes">> & Pick<WebFetchOptions, "allowPrivateTargets">, sniName?: string): Promise<VhostFetchStep> {
	await assertAllowedTargetUrl(request.url, { allowPrivateTargets: options.allowPrivateTargets, allowLoopback: true });
	const url = new URL(request.url);
	const client = url.protocol === "https:" ? https : http;
	const headers = { ...request.headers, Host: hostHeader };
	const startedAt = Date.now();
	return await new Promise<VhostFetchStep>((resolve, reject) => {
		const requestOptions: https.RequestOptions = {
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port || undefined,
			path: `${url.pathname}${url.search}`,
			method: request.method,
			headers,
			timeout: options.timeoutMs,
		};
		if (url.protocol === "https:") {
			requestOptions.rejectUnauthorized = false;
			if (sniName) requestOptions.servername = sniName;
		}
		const req = client.request(requestOptions, (res) => {
			const tlsCertificate = url.protocol === "https:" ? summarizeTlsCertificate(res.socket as unknown as { getPeerCertificate?: (detailed?: boolean) => Record<string, unknown> }) : undefined;
			const chunks: Buffer[] = [];
			let total = 0;
			let truncated = false;
			res.on("data", (chunk: Buffer) => {
				const remaining = options.maxBodyBytes - total;
				if (remaining > 0) {
					const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
					chunks.push(slice);
					total += slice.byteLength;
				}
				if (chunk.byteLength > remaining) truncated = true;
			});
			res.on("end", () => {
				const buffer = Buffer.concat(chunks);
				const responseHeaders: HeaderMap = {};
				for (const [name, value] of Object.entries(res.headers)) responseHeaders[name] = Array.isArray(value) ? value.join(", ") : value === undefined ? "" : String(value);
				const contentType = responseHeaders["content-type"] || "";
				const textual = TEXTUAL_CONTENT_TYPE.test(contentType) || !contentType;
				resolve({
					url: request.url,
					status: res.statusCode || 0,
					statusText: res.statusMessage || "",
					ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
					headers: responseHeaders,
					setCookie: Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"] : res.headers["set-cookie"] ? [String(res.headers["set-cookie"])] : [],
					elapsedMs: Date.now() - startedAt,
					bodyText: textual ? buffer.toString("utf8") : "",
					bodyBytes: buffer.length,
					bodyTruncated: truncated,
					bodyBase64: textual ? undefined : buffer.toString("base64"),
					tlsCertificate,
				});
			});
		});
		req.on("timeout", () => req.destroy(new Error(`vhost request timed out after ${options.timeoutMs}ms`)));
		req.on("error", reject);
		if (request.body !== undefined && request.method !== "GET" && request.method !== "HEAD") req.write(request.body);
		req.end();
	});
}

async function fetchWithHostRedirects(request: { url: string; method: string; headers: HeaderMap; body?: string | Buffer }, hostHeader: string, options: WebFetchOptions, sniName?: string) {
	const followRedirects = options.followRedirects === true;
	const maxRedirects = positiveInt(options.maxRedirects, followRedirects ? 3 : 0);
	const timeoutMs = positiveInt(options.timeoutMs, 15_000);
	const maxBodyBytes = positiveInt(options.maxBodyBytes, 256_000);
	const chain: VhostFetchStep[] = [];
	let current = { ...request };
	for (let i = 0; i <= maxRedirects; i += 1) {
		const step = await fetchSingleWithHost(current, hostHeader, { timeoutMs, maxBodyBytes, allowPrivateTargets: options.allowPrivateTargets === true }, sniName);
		chain.push(step);
		const nextUrl = followRedirects ? redirectLocation(step.status, step.headers, current.url) : undefined;
		if (!nextUrl) break;
		const nextMethod = redirectMethod(current.method, step.status);
		current = { url: nextUrl, method: nextMethod, headers: { ...current.headers }, body: nextMethod === current.method ? current.body : undefined };
	}
	return { chain, final: chain[chain.length - 1] };
}

function certificateKey(cert: TlsCertificateSummary | undefined): string {
	const fingerprint = asString(cert?.fingerprint256)?.trim();
	if (fingerprint) return fingerprint;
	const serial = asString(cert?.serialNumber)?.trim();
	const subject = cert?.subject && typeof cert.subject === "object" ? JSON.stringify(cert.subject) : asString(cert?.subject);
	const altName = asString(cert?.subjectaltname)?.trim();
	return [serial, subject, altName].filter(Boolean).join("|") || "no-cert";
}

function vhostResponse(step: VhostFetchStep): VhostResponseFingerprint {
	const fingerprint = responseFingerprint(step);
	const tlsFingerprint256 = asString(step.tlsCertificate?.fingerprint256)?.trim();
	const tlsSubjectAltName = asString(step.tlsCertificate?.subjectaltname)?.trim();
	const tlsSerialNumber = asString(step.tlsCertificate?.serialNumber)?.trim();
	const subject = step.tlsCertificate?.subject && typeof step.tlsCertificate.subject === "object" ? JSON.stringify(step.tlsCertificate.subject) : asString(step.tlsCertificate?.subject);
	return { ...fingerprint, certificateKey: certificateKey(step.tlsCertificate), tlsFingerprint256, tlsSubject: subject, tlsSubjectAltName, tlsSerialNumber };
}

function vhostDistance(left: VhostBaselineFingerprint, right: VhostResponseFingerprint): number {
	let score = responseDistance(left, right);
	if (left.certificateKey !== right.certificateKey) score += 4_000;
	return score;
}

function sameBaselineCluster(left: VhostResponseFingerprint, right: VhostBaselineFingerprint): boolean {
	return left.certificateKey === right.certificateKey && sameHttpBaselineCluster(left, right);
}

function exactBaselineMatch(left: VhostResponseFingerprint, right: VhostBaselineFingerprint): boolean {
	return !responsesDiffer(left, right) && left.certificateKey === right.certificateKey;
}

function clusterKeyForBaseline(fingerprint: VhostResponseFingerprint): string {
	return `${baselineClusterKey(fingerprint)}|${fingerprint.certificateKey}`;
}

function clusterBaselineFingerprints(baselines: VhostBaselineFingerprint[]): Array<Record<string, unknown>> {
	const clusters = new Map<string, { key: string; status: number; title?: string; location?: string; tlsFingerprint256?: string; count: number; bodyBytesMin: number; bodyBytesMax: number; hosts: string[]; sampleUrls: string[] }>();
	for (const baseline of baselines) {
		let cluster = clusters.get(baseline.clusterKey);
		if (!cluster) {
			cluster = {
				key: baseline.clusterKey,
				status: baseline.status,
				title: baseline.title,
				location: baseline.location,
				tlsFingerprint256: baseline.tlsFingerprint256,
				count: 0,
				bodyBytesMin: baseline.bodyBytes,
				bodyBytesMax: baseline.bodyBytes,
				hosts: [],
				sampleUrls: [],
			};
			clusters.set(baseline.clusterKey, cluster);
		}
		cluster.count += 1;
		cluster.bodyBytesMin = Math.min(cluster.bodyBytesMin, baseline.bodyBytes);
		cluster.bodyBytesMax = Math.max(cluster.bodyBytesMax, baseline.bodyBytes);
		if (!cluster.hosts.includes(baseline.host) && cluster.hosts.length < 20) cluster.hosts.push(baseline.host);
		if (!cluster.sampleUrls.includes(baseline.location || baseline.host) && cluster.sampleUrls.length < 5) cluster.sampleUrls.push(baseline.location || baseline.host);
	}
	return Array.from(clusters.values()).sort((a, b) => b.count - a.count).slice(0, 20);
}

function clusterVhostResponses(results: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	const clusters = new Map<string, { key: string; status?: unknown; title?: unknown; bodyBytes?: unknown; bodySha256?: unknown; tlsFingerprint256?: unknown; count: number; matchedCount: number; hosts: string[]; sampleUrls: string[] }>();
	for (const item of results) {
		const key = `${item.status}|${item.title || ""}|${item.bodyBytes || 0}|${item.bodySha256 || ""}|${item.location || ""}|${item.tlsFingerprint256 || item.certificateKey || ""}`;
		let cluster = clusters.get(key);
		if (!cluster) {
			cluster = { key, status: item.status, title: item.title, bodyBytes: item.bodyBytes, bodySha256: item.bodySha256, tlsFingerprint256: item.tlsFingerprint256, count: 0, matchedCount: 0, hosts: [], sampleUrls: [] };
			clusters.set(key, cluster);
		}
		cluster.count += 1;
		if (item.matched === true) cluster.matchedCount += 1;
		if (typeof item.host === "string" && cluster.hosts.length < 20 && !cluster.hosts.includes(item.host)) cluster.hosts.push(item.host);
		if (typeof item.url === "string" && cluster.sampleUrls.length < 5 && !cluster.sampleUrls.includes(item.url)) cluster.sampleUrls.push(item.url);
	}
	return Array.from(clusters.values()).sort((a, b) => b.count - a.count).slice(0, 50);
}

type NormalizedFuzzVhostsOptions = {
	bases: string[];
	explicitHosts: string[];
	words: string[];
	baseDomain?: string;
	template?: string;
	baselineHost?: string;
	baselineHosts: string[];
	sniMode: "target" | "host" | "custom" | "none";
	sniName?: string;
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
	baselineStrategy: "exact" | "cluster" | "auto";
	maxCandidates: number;
	delayMs: number;
};

async function normalizeFuzzVhostsOptions(options: RawFuzzVhostsOptions): Promise<NormalizedFuzzVhostsOptions> {
	const words = [...stringList(options.words), ...stringList(options.wordlist), ...(await readWordlist(options.wordlistPath))];
	const followRedirects = options.followRedirects === true;
	const rateLimitPerSecond = positiveInt(options.rateLimitPerSecond, 0);
	const rawSniMode = String(options.sniMode || "target").trim().toLowerCase();
	const sniMode = rawSniMode === "none" || rawSniMode === "host" || rawSniMode === "custom" ? rawSniMode : "target";
	return {
		bases: normalizeProbeTargets({ url: options.url, urls: options.urls, defaultScheme: options.defaultScheme }),
		explicitHosts: stringList(options.hosts),
		words,
		baseDomain: asString(options.baseDomain)?.trim() || undefined,
		template: asString(options.template)?.trim() || undefined,
		baselineHost: asString(options.baselineHost)?.trim() || undefined,
		baselineHosts: stringList(options.baselineHosts),
		sniMode,
		sniName: asString(options.sniName)?.trim() || undefined,
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
		filterBaseline: options.filterBaseline !== false,
		baselineStrategy: normalizeBaselineStrategy(options.baselineStrategy),
		maxCandidates: Math.min(5_000, positiveInt(options.maxCandidates, 500)),
		delayMs: rateLimitPerSecond > 0 ? Math.ceil(1000 / rateLimitPerSecond) : 0,
	};
}

type FuzzVhostRoot = { baseUrl: string; candidates: string[]; baselineHosts: string[] };
type FuzzVhostRunState = { baselines: Array<Record<string, unknown>>; baselineFingerprints: VhostBaselineFingerprint[]; results: Array<Record<string, unknown>>; failures: Array<Record<string, unknown>>; sent: number };

function fuzzVhostHardCapWarnings(options: RawFuzzVhostsOptions): string[] {
	const requestedMaxCandidates = positiveInt(options.maxCandidates, 500);
	return requestedMaxCandidates > 5_000 ? [`maxCandidates capped from ${requestedMaxCandidates} to 5000 (hard limit)`] : [];
}

function prepareFuzzVhostRoots(options: NormalizedFuzzVhostsOptions): { roots: FuzzVhostRoot[]; truncatedCandidates: number } {
	const roots: FuzzVhostRoot[] = [];
	let truncatedCandidates = 0;
	for (const baseUrl of options.bases) {
		const allCandidates = buildVhostCandidates(baseUrl, options);
		if (!allCandidates.length) throw createCodedError({ name: "FuzzVhostsInputError", code: "INVALID_RULE", message: "browser_fuzz_vhosts requires hosts, words, wordlist, or wordlistPath", details: { field: "hosts|words|wordlist|wordlistPath" }, suppressStack: false });
		const candidates = allCandidates.slice(0, options.maxCandidates);
		truncatedCandidates += allCandidates.length - candidates.length;
		const defaultBaselineHost = `__browser_pilot_vhost_baseline__.${new URL(baseUrl).hostname}`;
		roots.push({ baseUrl, candidates, baselineHosts: [...new Set([...options.baselineHosts, options.baselineHost || defaultBaselineHost].filter(Boolean))] });
	}
	return { roots, truncatedCandidates };
}

async function fetchFuzzVhost(baseUrl: string, host: string, options: NormalizedFuzzVhostsOptions) {
	const headers = { ...options.baseHeaders };
	const cookie = cookieProviderResultHeader(options.bindBrowserSession ? await options.cookieProvider?.(baseUrl) : undefined);
	if (cookie) headers.Cookie = cookie;
	const sniName = vhostSniName(baseUrl, host, options);
	const exchange = await fetchWithHostRedirects({ url: baseUrl, method: options.method, headers: sanitizeFetchHeaders(headers).headers }, host, options, sniName);
	return { exchange, sniName };
}

async function collectVhostBaselines(root: FuzzVhostRoot, options: NormalizedFuzzVhostsOptions, state: FuzzVhostRunState): Promise<VhostBaselineFingerprint[]> {
	const currentBaselines: VhostBaselineFingerprint[] = [];
	for (const host of root.baselineHosts) {
		try {
			const { exchange, sniName } = await fetchFuzzVhost(root.baseUrl, host, options);
			const final = exchange.final;
			const fingerprint = vhostResponse(final);
			const record: VhostBaselineFingerprint = { host, sniName, clusterKey: clusterKeyForBaseline(fingerprint), ...fingerprint };
			currentBaselines.push(record);
			state.baselineFingerprints.push(record);
			state.baselines.push({ baseUrl: root.baseUrl, host, sniName, status: final.status, title: fingerprint.title, bodyBytes: final.bodyBytes, bodySha256: fingerprint.bodySha256, location: fingerprint.location, tlsFingerprint256: fingerprint.tlsFingerprint256, tlsSubjectAltName: fingerprint.tlsSubjectAltName, certificateKey: fingerprint.certificateKey, tlsCertificate: final.tlsCertificate, redirects: exchange.chain.slice(0, -1).map(compactStep) });
		} catch (error) {
			state.baselines.push({ baseUrl: root.baseUrl, host, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return currentBaselines;
}

function projectVhostResult(baseUrl: string, host: string, sniName: string | undefined, exchange: Awaited<ReturnType<typeof fetchWithHostRedirects>>, currentBaselines: VhostBaselineFingerprint[], options: NormalizedFuzzVhostsOptions): Record<string, unknown> {
	const final = exchange.final;
	const fingerprint = vhostResponse(final);
	const nearestBaseline = nearestBaselineByDistance(currentBaselines, fingerprint, vhostDistance);
	const isExactBaseline = currentBaselines.some((baseline) => exactBaselineMatch(fingerprint, baseline));
	const baselineClusterMatched = currentBaselines.some((baseline) => sameBaselineCluster(fingerprint, baseline));
	const similarToBaseline = options.baselineStrategy === "exact" ? isExactBaseline : options.baselineStrategy === "cluster" ? baselineClusterMatched : isExactBaseline || baselineClusterMatched;
	const differentFromBaseline = currentBaselines.length ? !similarToBaseline : true;
	return {
		matched: matchesStatusBodyResult(final.status, final.bodyBytes, options) && (!options.filterBaseline || differentFromBaseline),
		baseUrl, host, sniName, url: final.url, status: final.status, title: fingerprint.title, bodyBytes: final.bodyBytes, bodySha256: fingerprint.bodySha256, bodyTruncated: final.bodyTruncated, location: fingerprint.location,
		tlsFingerprint256: fingerprint.tlsFingerprint256, certificateKey: fingerprint.certificateKey, tlsCertificate: final.tlsCertificate,
		differentFromBaseline, baselineClusterMatched, exactBaselineMatch: isExactBaseline,
		nearestBaseline: nearestBaseline ? { host: nearestBaseline.baseline.host, sniName: nearestBaseline.baseline.sniName, distance: nearestBaseline.distance, tlsFingerprint256: nearestBaseline.baseline.tlsFingerprint256, certificateKey: nearestBaseline.baseline.certificateKey } : undefined,
		certificateDelta: nearestBaseline ? { fingerprintChanged: fingerprint.certificateKey !== nearestBaseline.baseline.certificateKey, subjectChanged: fingerprint.tlsSubject !== nearestBaseline.baseline.tlsSubject, subjectAltNameChanged: fingerprint.tlsSubjectAltName !== nearestBaseline.baseline.tlsSubjectAltName, serialNumberChanged: fingerprint.tlsSerialNumber !== nearestBaseline.baseline.tlsSerialNumber } : undefined,
		delta: nearestBaseline ? { ...responseChangeDelta(nearestBaseline.baseline, fingerprint), certificateChanged: fingerprint.certificateKey !== nearestBaseline.baseline.certificateKey } : undefined,
		redirects: exchange.chain.slice(0, -1).map(compactStep), body: { text: final.bodyText, base64: final.bodyBase64 },
	};
}

async function probeFuzzVhost(root: FuzzVhostRoot, host: string, currentBaselines: VhostBaselineFingerprint[], options: NormalizedFuzzVhostsOptions, state: FuzzVhostRunState, totalCandidates: number): Promise<void> {
	try {
		const { exchange, sniName } = await fetchFuzzVhost(root.baseUrl, host, options);
		state.results.push(projectVhostResult(root.baseUrl, host, sniName, exchange, currentBaselines, options));
	} catch (error) {
		state.failures.push({ baseUrl: root.baseUrl, host, error: error instanceof Error ? error.message : String(error) });
	}
	state.sent += 1;
	if (options.delayMs > 0 && state.sent < totalCandidates) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
}

async function runFuzzVhostRoot(root: FuzzVhostRoot, options: NormalizedFuzzVhostsOptions, state: FuzzVhostRunState, totalCandidates: number): Promise<void> {
	const currentBaselines = await collectVhostBaselines(root, options, state);
	for (const host of root.candidates) await probeFuzzVhost(root, host, currentBaselines, options, state, totalCandidates);
}

function fuzzVhostsResult(options: NormalizedFuzzVhostsOptions, state: FuzzVhostRunState, truncatedCandidates: number, warnings: string[]) {
	const matched = state.results.filter((item) => item.matched === true);
	return {
		ok: state.failures.length === 0, generatedAt: new Date().toISOString(), baseCount: options.bases.length, requestCount: state.sent, matchedCount: matched.length, truncatedCandidates,
		filterBaseline: options.filterBaseline, baselineStrategy: options.baselineStrategy, sniMode: options.sniMode, matchStatus: options.matchStatus, filterStatus: options.filterStatus, filterBodyBytes: options.filterBodyBytes,
		baselines: state.baselines, baselineClusters: clusterBaselineFingerprints(state.baselineFingerprints), clusters: clusterVhostResponses(state.results), results: state.results, matched, failures: state.failures,
		...(warnings.length ? { warnings } : {}),
	};
}

export async function runFuzzVhosts(options: RawFuzzVhostsOptions) {
	const warnings = fuzzVhostHardCapWarnings(options);
	const normalized = await normalizeFuzzVhostsOptions(options);
	const { roots, truncatedCandidates } = prepareFuzzVhostRoots(normalized);
	const state: FuzzVhostRunState = { baselines: [], baselineFingerprints: [], results: [], failures: [], sent: 0 };
	const totalCandidates = roots.reduce((sum, root) => sum + root.candidates.length, 0);
	for (const root of roots) await runFuzzVhostRoot(root, normalized, state, totalCandidates);
	return fuzzVhostsResult(normalized, state, truncatedCandidates, warnings);
}
