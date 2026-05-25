import { Buffer } from "node:buffer";
import { responseReplayDelta } from "../shared/baseline";
import { absoluteUrl, fetchWithRedirects, normalizeHeaders, parseCookieHeader, parseSetCookieLine, responseFingerprint } from "../shared/http";
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_TIMEOUT_MS, asString, isRecord, normalizeMethod, numericList, positiveInt, readWordlist, stringList } from "../shared/normalize";
import { analyzeCookieSample, tokenCountOf, tokenFormatOf, tokenMutationToken, tokenVerifiedOf } from "../shared/cookieTokens";
import type { RawCookieAnalyzeOptions } from "../shared/types";

type CookieSample = { source: string; name?: string; value: string; attributes?: Record<string, string | boolean> };

type ClaimReplayConfig = {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string | Buffer;
	followRedirects: boolean;
	maxRedirects: number;
	timeoutMs: number;
	maxBodyBytes: number;
	matchStatus: number[];
	maxCases: number;
	cookieName?: string;
	browserCookie?: string;
};

type NormalizedCookieAnalyzeOptions = {
	samples: CookieSample[];
	limitedSecrets: string[];
	truncatedSecretCandidates: boolean;
	claimMutations?: Record<string, unknown>;
	claimReplay?: ClaimReplayConfig;
};

function addCookieHeaderSamples(out: CookieSample[], raw: string, source: string) {
	const header = raw.replace(/^cookie\s*:\s*/i, "").trim();
	for (const [name, value] of parseCookieHeader(header)) out.push({ source, name, value });
}

function addCookieSamples(out: CookieSample[], value: unknown, source: string, setCookieMode = false) {
	if (Array.isArray(value)) {
		for (const item of value) addCookieSamples(out, item, source, setCookieMode);
		return;
	}
	if (isRecord(value)) {
		const name = asString(value.name)?.trim();
		const cookieValue = asString(value.value);
		if (cookieValue !== undefined) out.push({ source, name, value: cookieValue, attributes: normalizeHeaders(value.attributes) });
		return;
	}
	const text = asString(value);
	if (!text) return;
	for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
		if (setCookieMode || /^set-cookie\s*:/i.test(line) || /;\s*(path|domain|expires|max-age|httponly|secure|samesite)\b/i.test(line)) {
			const parsed = parseSetCookieLine(line, source);
			if (parsed) out.push(parsed);
		} else {
			addCookieHeaderSamples(out, line, source);
		}
	}
}

function serializeCookieMap(map: Map<string, string>): string | undefined {
	const pairs = Array.from(map.entries()).map(([name, value]) => `${name}=${value}`);
	return pairs.length ? pairs.join("; ") : undefined;
}

function normalizeClaimReplay(value: Record<string, unknown>, fallbackUrl: unknown, fallbackTimeoutMs: unknown): ClaimReplayConfig {
	const urlValue = value.url ?? fallbackUrl;
	if (!urlValue) throw new Error("browser_cookie_analyze claimReplay requires claimReplay.url or top-level url");
	const bodyBase64 = asString(value.bodyBase64);
	return {
		url: absoluteUrl(urlValue, { scheme: "https" }),
		method: normalizeMethod(value.method ?? "GET", "GET"),
		headers: normalizeHeaders(value.headers),
		body: bodyBase64 !== undefined ? Buffer.from(bodyBase64, "base64") : asString(value.body),
		followRedirects: value.followRedirects !== false,
		maxRedirects: Math.min(10, positiveInt(value.maxRedirects, 3)),
		timeoutMs: positiveInt(value.timeoutMs ?? fallbackTimeoutMs, DEFAULT_TIMEOUT_MS),
		maxBodyBytes: Math.min(DEFAULT_MAX_BODY_BYTES, positiveInt(value.maxBodyBytes, 64_000)),
		matchStatus: numericList(value.matchStatus),
		maxCases: Math.min(20, positiveInt(value.maxCases, 5)),
		cookieName: asString(value.cookieName)?.trim() || undefined,
	};
}

async function normalizeCookieAnalyzeOptions(options: RawCookieAnalyzeOptions): Promise<NormalizedCookieAnalyzeOptions> {
	const samples: CookieSample[] = [];
	addCookieSamples(samples, options.cookie, "cookie");
	addCookieSamples(samples, options.cookies, "cookies");
	addCookieSamples(samples, options.setCookie, "set-cookie", true);
	addCookieSamples(samples, options.setCookies, "set-cookies", true);
	for (const value of [...stringList(options.jwt), ...stringList(options.jwts), ...stringList(options.values)]) samples.push({ source: "value", value });
	const bindBrowserSession = options.bindBrowserSession === true;
	if (bindBrowserSession) {
		const url = absoluteUrl(options.url, { scheme: "https" });
		const browserCookie = await options.cookieProvider?.(url);
		if (browserCookie) addCookieSamples(samples, browserCookie, "browser-session");
	}
	const secrets = [...stringList(options.secretCandidates), ...stringList(options.secrets), ...stringList(options.wordlist), ...(await readWordlist(options.wordlistPath))];
	const maxSecretCandidates = Math.min(100_000, positiveInt(options.maxSecretCandidates, 10_000));
	const limitedSecrets = [...new Set(secrets)].slice(0, maxSecretCandidates);
	const claimReplay = isRecord(options.claimReplay) ? normalizeClaimReplay(options.claimReplay, options.url, options.timeoutMs) : undefined;
	if (claimReplay && bindBrowserSession) claimReplay.browserCookie = await options.cookieProvider?.(claimReplay.url);
	return {
		samples,
		limitedSecrets,
		truncatedSecretCandidates: secrets.length > limitedSecrets.length,
		claimMutations: isRecord(options.claimMutations) ? { ...options.claimMutations } : undefined,
		claimReplay,
	};
}

function claimReplayDeltaRecord(left: ReturnType<typeof responseFingerprint>, right: ReturnType<typeof responseFingerprint>) {
	return responseReplayDelta(left, right);
}

async function runClaimReplayChecks(samples: CookieSample[], results: Record<string, unknown>[], options: NormalizedCookieAnalyzeOptions) {
	const config = options.claimReplay;
	if (!config) return { claimReplays: [], claimReplayCount: 0, successfulClaimReplayCount: 0, claimReplayFailureCount: 0, claimReplayFailures: [] };
	const claimReplays: Array<Record<string, unknown>> = [];
	const claimReplayFailures: Array<Record<string, unknown>> = [];
	let attempted = 0;
	for (let index = 0; index < results.length && attempted < config.maxCases; index += 1) {
		const result = results[index];
		const sample = samples[index];
		const mutationToken = tokenMutationToken(result);
		if (!mutationToken) continue;
		const cookieName = config.cookieName || sample.name;
		if (!cookieName) {
			const failure = { index, name: sample.name, source: sample.source, format: tokenFormatOf(result), error: "claimReplay requires a cookie name; supply claimReplay.cookieName when the token did not originate from a named cookie" };
			result.claimReplay = failure;
			claimReplayFailures.push(failure);
			continue;
		}
		const baselineCookies = parseCookieHeader(config.browserCookie);
		baselineCookies.set(cookieName, sample.value);
		const mutatedCookies = new Map(baselineCookies);
		mutatedCookies.set(cookieName, mutationToken);
		const requestBase = { url: config.url, method: config.method, headers: { ...config.headers }, body: config.body };
		const baselineCookieHeader = serializeCookieMap(baselineCookies);
		const mutatedCookieHeader = serializeCookieMap(mutatedCookies);
		if (baselineCookieHeader) requestBase.headers.Cookie = baselineCookieHeader;
		attempted += 1;
		try {
			const baselineExchange = await fetchWithRedirects(requestBase, config);
			const mutatedRequest = { ...requestBase, headers: { ...requestBase.headers } };
			if (mutatedCookieHeader) mutatedRequest.headers.Cookie = mutatedCookieHeader;
			const mutatedExchange = await fetchWithRedirects(mutatedRequest, config);
			const baselineFinal = baselineExchange.final;
			const mutatedFinal = mutatedExchange.final;
			const baseline = responseFingerprint(baselineFinal);
			const mutated = responseFingerprint(mutatedFinal);
			const replay = {
				index,
				name: sample.name,
				source: sample.source,
				format: tokenFormatOf(result),
				cookieName,
				url: config.url,
				baseline: { url: baselineFinal.url, status: baseline.status, title: baseline.title, bodyBytes: baseline.bodyBytes, bodySha256: baseline.bodySha256, location: baseline.location, elapsedMs: baselineFinal.elapsedMs },
				mutated: { url: mutatedFinal.url, status: mutated.status, title: mutated.title, bodyBytes: mutated.bodyBytes, bodySha256: mutated.bodySha256, location: mutated.location, elapsedMs: mutatedFinal.elapsedMs },
				delta: claimReplayDeltaRecord(baseline, mutated),
				matchedStatus: config.matchStatus.length ? config.matchStatus.includes(mutated.status) : undefined,
			};
			result.claimReplay = replay;
			claimReplays.push(replay);
		} catch (error) {
			const failure = { index, name: sample.name, source: sample.source, format: tokenFormatOf(result), cookieName, url: config.url, error: error instanceof Error ? error.message : String(error) };
			result.claimReplay = failure;
			claimReplayFailures.push(failure);
		}
	}
	if (attempted === 0) claimReplayFailures.push({ error: "claimReplay requested but no replayable mutated cookie/session tokens were available" });
	return {
		claimReplays,
		claimReplayCount: claimReplays.length,
		successfulClaimReplayCount: claimReplays.filter((item) => isRecord(item.delta) && Array.isArray(item.delta.classifier) && item.delta.classifier.length > 0).length,
		claimReplayFailureCount: claimReplayFailures.length,
		claimReplayFailures,
	};
}

export async function runCookieAnalyze(options: RawCookieAnalyzeOptions) {
	const normalized = await normalizeCookieAnalyzeOptions(options);
	if (!normalized.samples.length) throw new Error("browser_cookie_analyze requires cookie, cookies, setCookie, setCookies, jwt, jwts, values, or bindBrowserSession with url");
	const results = await Promise.all(normalized.samples.map(async (sample, index) => ({ index, ...(await analyzeCookieSample(sample, normalized.limitedSecrets, normalized.claimMutations)) })));
	const tokenResults = results.filter((item) => tokenCountOf(item) > 0);
	const jwtResults = results.filter((item) => item.kind === "jwt");
	const jweCount = results.filter((item) => item.kind === "jwe").length;
	const pasetoCount = results.filter((item) => item.kind === "paseto").length;
	const sessionFormatCount = results.filter((item) => ["django", "flask", "rails"].includes(String(item.kind || ""))).length;
	const verifiedJwtCount = jwtResults.filter((item) => tokenVerifiedOf(item)).length;
	const verifiedTokenCount = tokenResults.filter((item) => tokenVerifiedOf(item)).length;
	const mutationCount = tokenResults.filter((item) => typeof tokenMutationToken(item) === "string").length;
	const replay = await runClaimReplayChecks(normalized.samples, results, normalized);
	return {
		ok: true,
		generatedAt: new Date().toISOString(),
		inputCount: normalized.samples.length,
		cookieCount: normalized.samples.filter((item) => item.name).length,
		tokenCount: tokenResults.length,
		jwtCount: jwtResults.length,
		jweCount,
		pasetoCount,
		sessionFormatCount,
		verifiedJwtCount,
		verifiedTokenCount,
		mutationCount,
		testedSecretCandidateCount: normalized.limitedSecrets.length,
		truncatedSecretCandidates: normalized.truncatedSecretCandidates,
		claimReplayCount: replay.claimReplayCount,
		successfulClaimReplayCount: replay.successfulClaimReplayCount,
		claimReplayFailureCount: replay.claimReplayFailureCount,
		claimReplays: replay.claimReplays,
		claimReplayFailures: replay.claimReplayFailures,
		results,
	};
}
