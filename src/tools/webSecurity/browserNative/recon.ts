import { compactStep, detectFingerprints, detectTech, detectTechHints, extractTitle, fetchFaviconHash, fetchWithRedirects, inspectTlsCertificate, normalizeHeaders, normalizeProbeTargets, redactHeaders, responseBodyHash, sanitizeFetchHeaders } from "../shared/http";
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_TIMEOUT_MS, normalizeMethod, positiveInt } from "../shared/normalize";
import type { CookieProvider, HeaderMap, ProbeOptions } from "../shared/types";

export type NormalizedProbeOptions = {
	targets: string[];
	method: string;
	headers: HeaderMap;
	followRedirects: boolean;
	maxRedirects: number;
	timeoutMs: number;
	maxBodyBytes: number;
	includeFaviconHash: boolean;
	includeTlsCertificate: boolean;
	bindBrowserSession: boolean;
	cookieProvider?: CookieProvider;
};

function normalizeProbeOptions(options: ProbeOptions): NormalizedProbeOptions {
	const followRedirects = options.followRedirects === true;
	return {
		targets: normalizeProbeTargets(options),
		method: normalizeMethod(options.method, "GET"),
		headers: normalizeHeaders(options.headers),
		followRedirects,
		maxRedirects: positiveInt(options.maxRedirects, followRedirects ? 5 : 0),
		timeoutMs: positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS),
		maxBodyBytes: positiveInt(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES),
		includeFaviconHash: options.includeFaviconHash === true,
		includeTlsCertificate: options.includeTlsCertificate === true,
		bindBrowserSession: options.bindBrowserSession === true,
		cookieProvider: options.cookieProvider,
	};
}

export async function runReconProbe(options: ProbeOptions) {
	const normalized = normalizeProbeOptions(options);
	const results = [];
	for (const target of normalized.targets) {
		try {
			const cookie = normalized.bindBrowserSession ? await normalized.cookieProvider?.(target) : undefined;
			const headers = { ...normalized.headers };
			if (cookie) headers.Cookie = cookie;
			const sanitized = sanitizeFetchHeaders(headers);
			const exchange = await fetchWithRedirects({ url: target, method: normalized.method, headers: sanitized.headers }, normalized);
			const final = exchange.final;
			const favicon = normalized.includeFaviconHash ? await fetchFaviconHash(final.url, headers, normalized) : undefined;
			const tlsCertificate = normalized.includeTlsCertificate ? await inspectTlsCertificate(final.url, normalized.timeoutMs) : undefined;
			const techHints = detectTechHints(final.headers, final.bodyText, final.setCookie);
			const fingerprints = detectFingerprints(final.headers, final.bodyText, final.setCookie);
			results.push({
				ok: true,
				inputUrl: target,
				finalUrl: final.url,
				status: final.status,
				statusText: final.statusText,
				title: extractTitle(final.bodyText),
				tech: detectTech(final.headers, final.bodyText, final.setCookie),
				techHints,
				fingerprints,
				redirects: exchange.chain.slice(0, -1).map(compactStep),
				headers: redactHeaders(final.headers),
				headerNames: Object.keys(final.headers),
				omittedRequestHeaderNames: sanitized.omittedHeaderNames,
				cookiesBound: !!cookie,
				body: {
					bytes: final.bodyBytes,
					truncated: final.bodyTruncated,
					sha256: responseBodyHash(final),
					text: final.bodyText,
					base64: final.bodyBase64,
				},
				favicon,
				tlsCertificate,
				elapsedMs: exchange.chain.reduce((sum, step) => sum + step.elapsedMs, 0),
			});
		} catch (error) {
			results.push({ ok: false, inputUrl: target, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { ok: results.every((item) => item.ok), generatedAt: new Date().toISOString(), count: results.length, results };
}
