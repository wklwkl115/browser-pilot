import { Buffer } from "node:buffer";
import { createCodedError } from "../../../utils/codedError.js";
import { responseReplayDelta } from "../shared/baseline.js";
import { absoluteUrl, cookieProviderResultCookies, cookieProviderResultHeader, fetchWithRedirects, normalizeHeaders, parseCookieHeader, parseSetCookieLine, responseFingerprint } from "../shared/http.js";
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_TIMEOUT_MS, asString, isRecord, normalizeMethod, numericList, positiveInt, readWordlist, stringList } from "../shared/normalize.js";
import { analyzeCookieSample, tokenCountOf, tokenFormatOf, tokenMutationToken, tokenVerifiedOf } from "../shared/cookieTokens.js";
import type { RawCookieAnalyzeOptions } from "../shared/types.js";

type CookieSample = { source: string; name?: string; value: string; attributes?: Record<string, unknown> };

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
	allowPrivateTargets: boolean;
	cookieName?: string;
	browserCookie?: string;
};

type NormalizedCookieAnalyzeOptions = {
	samples: CookieSample[];
	limitedSecrets: string[];
	truncatedSecretCandidates: boolean;
	claimMutations?: Record<string, unknown>;
	claimReplay?: ClaimReplayConfig;
	browserSessionAttempted?: boolean;
	bindUrl?: string;
};

function normalizeBrowserCookieAttributes(value: Record<string, unknown>): Record<string, unknown> | undefined {
	const attributes: Record<string, unknown> = {};
	const copyString = (key: string) => {
		const raw = asString(value[key])?.trim();
		if (raw) attributes[key] = raw;
	};
	const copyBoolean = (key: string) => {
		if (typeof value[key] === "boolean") attributes[key] = value[key];
	};
	const copyNumber = (key: string) => {
		if (typeof value[key] === "number" && Number.isFinite(value[key])) attributes[key] = value[key];
	};
	copyString("domain");
	copyString("path");
	copyString("sameSite");
	copyString("storeId");
	copyBoolean("secure");
	copyBoolean("httpOnly");
	copyBoolean("session");
	copyNumber("expirationDate");
	copyNumber("expires");
	if (isRecord(value.partitionKey)) attributes.partitionKey = { ...value.partitionKey };
	return Object.keys(attributes).length ? attributes : undefined;
}

function addCookieHeaderSamples(out: CookieSample[], raw: string, source: string, metadata: Map<string, Record<string, unknown>> = new Map()) {
	const header = raw.replace(/^cookie\s*:\s*/i, "").trim();
	for (const [name, value] of parseCookieHeader(header)) out.push({ source, name, value, attributes: metadata.get(name) });
}

function addCookieSamples(out: CookieSample[], value: unknown, source: string, setCookieMode = false) {
	if (Array.isArray(value)) {
		for (const item of value) addCookieSamples(out, item, source, setCookieMode);
		return;
	}
	if (isRecord(value)) {
		const name = asString(value.name)?.trim();
		const cookieValue = asString(value.value);
		const attributes = isRecord(value.attributes) ? { ...value.attributes } : normalizeBrowserCookieAttributes(value);
		if (cookieValue !== undefined) out.push({ source, name, value: cookieValue, attributes });
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

function cookieAnalyzeInputError(message: string, details: Record<string, unknown> = {}): Error {
	return createCodedError({ name: "CookieAnalyzeInputError", code: "INVALID_RULE", message, details, suppressStack: false });
}

function serializeCookieMap(map: Map<string, string>): string | undefined {
	const pairs = Array.from(map.entries()).map(([name, value]) => `${name}=${value}`);
	return pairs.length ? pairs.join("; ") : undefined;
}

function normalizeClaimReplay(value: Record<string, unknown>, fallbackUrl: unknown, fallbackTimeoutMs: unknown, fallbackAllowPrivateTargets: unknown): ClaimReplayConfig {
	const urlValue = value.url ?? fallbackUrl;
	if (!urlValue) throw cookieAnalyzeInputError("browser_cookie_analyze claimReplay requires claimReplay.url or top-level url", { field: "claimReplay.url|url" });
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
		allowPrivateTargets: value.allowPrivateTargets === true || fallbackAllowPrivateTargets === true,
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
	const hadExplicitSamples = samples.length > 0;
	// Honor an explicit bindBrowserSession, but also treat a bare {url + tab/session}
	// with no explicit cookie input as an implicit request to read the bound
	// session's cookies — that is the obvious intent and avoids a confusing
	// "requires cookie..." rejection when the agent already pointed us at a tab.
	const wantsBrowserSession = options.bindBrowserSession === true
		|| (options.bindBrowserSession !== false && !hadExplicitSamples && !!options.cookieProvider && options.url != null && String(options.url).trim() !== "");
	let browserSessionAttempted = false;
	let bindUrl: string | undefined;
	if (wantsBrowserSession) {
		bindUrl = absoluteUrl(options.url, { scheme: "https" });
		browserSessionAttempted = true;
		const browserCookie = await options.cookieProvider?.(bindUrl);
		const browserCookieHeader = cookieProviderResultHeader(browserCookie);
		const browserCookies = cookieProviderResultCookies(browserCookie);
		const browserCookieMetadata = new Map<string, Record<string, unknown>>();
		for (const cookie of browserCookies) {
			const name = asString(cookie.name)?.trim();
			const attributes = normalizeBrowserCookieAttributes(cookie);
			if (name && attributes) browserCookieMetadata.set(name, attributes);
		}
		if (browserCookieHeader) addCookieHeaderSamples(samples, browserCookieHeader, "browser-session", browserCookieMetadata);
		else for (const cookie of browserCookies) addCookieSamples(samples, cookie, "browser-session");
	}
	const secrets = [...stringList(options.secretCandidates), ...stringList(options.secrets), ...stringList(options.wordlist), ...(await readWordlist(options.wordlistPath))];
	const maxSecretCandidates = Math.min(100_000, positiveInt(options.maxSecretCandidates, 10_000));
	const limitedSecrets = [...new Set(secrets)].slice(0, maxSecretCandidates);
	const claimReplay = isRecord(options.claimReplay) ? normalizeClaimReplay(options.claimReplay, options.url, undefined, options.allowPrivateTargets) : undefined;
	if (claimReplay && wantsBrowserSession) claimReplay.browserCookie = cookieProviderResultHeader(await options.cookieProvider?.(claimReplay.url));
	return {
		samples,
		limitedSecrets,
		truncatedSecretCandidates: secrets.length > limitedSecrets.length,
		claimMutations: isRecord(options.claimMutations) ? { ...options.claimMutations } : undefined,
		claimReplay,
		browserSessionAttempted,
		bindUrl,
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
	if (!normalized.samples.length) {
		if (normalized.browserSessionAttempted) {
			throw cookieAnalyzeInputError(`browser_cookie_analyze found no cookies for ${normalized.bindUrl || options.url} in the bound browser session. The page may not be authenticated, the cookies may belong to a different origin, or the tab/session binding may be stale — navigate the bound tab to the target origin first, or pass an explicit cookie/cookies/setCookie value.`, { bindUrl: normalized.bindUrl, browserSessionAttempted: true, recovery: { retryable: true } });
		}
		throw cookieAnalyzeInputError("browser_cookie_analyze requires cookie, cookies, setCookie, setCookies, jwt, jwts, values, or bindBrowserSession with url", { fields: ["cookie", "cookies", "setCookie", "setCookies", "jwt", "jwts", "values", "bindBrowserSession+url"] });
	}
	const results: Record<string, unknown>[] = await Promise.all(normalized.samples.map(async (sample, index) => ({ index, source: sample.source, name: sample.name, attributes: sample.attributes, ...(await analyzeCookieSample(sample, normalized.limitedSecrets, normalized.claimMutations)) })));
	const tokenResults = results.filter((item) => tokenCountOf(item) > 0);
	const jwtResults = results.filter((item) => String(item.kind || "") === "jwt");
	const jweCount = results.filter((item) => String(item.kind || "") === "jwe").length;
	const pasetoCount = results.filter((item) => String(item.kind || "") === "paseto").length;
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
