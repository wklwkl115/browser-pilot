import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import {
	base64UrlEncode,
	parseCommandArgs,
	positiveInt,
} from "../../src/commands/webSecurity/shared/normalize.ts";
import {
	buildMultipartBodyFromParts,
	parseMultipartBody,
	setMultipartContentTypeVariant,
	summarizeMultipartParts,
	type MultipartPart,
} from "../../src/commands/webSecurity/shared/multipart.ts";
import {
	buildHarDependencyGraph,
	harEntriesFromOptions,
	harHeaderValues,
} from "../../src/commands/webSecurity/shared/har.ts";
import {
	applyReplayVariables,
	cookieHeaderFromSetCookie,
	existingParamNames,
	extractReplayVariables,
	inferFuzzParamLocations,
	mutateParamRequest,
	normalizeReplayOptions,
	reflectCsrfIntoHeaders,
	replayInputOptions,
	replaySequenceInputs,
} from "../../src/commands/webSecurity/shared/replay.ts";
import {
	buildReplayRequest,
	parseRawHttpRequest,
} from "../../src/commands/webSecurity/shared/requestTemplate.ts";
import {
	evaluateDslExtractor,
	evaluateTemplateMatcher,
	MAX_TEMPLATE_REGEX_PATTERN_CHARS,
	MAX_TEMPLATE_REGEX_TEXT_CHARS,
} from "../../src/commands/webSecurity/shared/template.ts";
import type { FetchStep } from "../../src/commands/webSecurity/shared/types.ts";
import {
	absolutizeMaybe,
	detectApiSpec,
	detectGraphqlSchema,
	endpointKindFor,
	extractAttributeUrls,
	extractForms,
	extractKnownFileUrls,
	extractManifestUrls,
	extractScriptSources,
	extractServiceWorkerCacheRoutes,
	extractServiceWorkerUrls,
	extractServiceWorkerVersionSummary,
	extractSourceMapUrls,
	extractStringUrls,
	inScope,
	knownFilePaths,
	normalizeUrlForVisit,
	parseSourceMapDetails,
	shouldProbeGraphqlIntrospection,
} from "../../src/commands/webSecurity/browserNative/crawlExtractors.ts";
import {
	absoluteUrl,
	assertAllowedTargetUrl,
	browserCookiesToProviderResult,
	compactStep,
	contentTypeOf,
	cookieProviderResultCookies,
	cookieProviderResultHeader,
	deriveCsrfReflection,
	detectFingerprints,
	detectTech,
	detectTechHints,
	extractTitle,
	headersArrayToMap,
	mergeCookieHeaders,
	normalizeHeaders,
	normalizeProbeTargets,
	parseCookieHeader,
	parseSetCookieLine,
	redactHeaders,
	redirectLocation,
	redirectMethod,
	responseBodyHash,
	responseFingerprint,
	sanitizeFetchHeaders,
	setCookieHeader,
	setHeaderCaseInsensitive,
	tlsRemediation,
} from "../../src/commands/webSecurity/shared/http.ts";
import {
	analyzeCookieSample,
	tokenFormatOf,
	tokenMutationToken,
	tokenVerifiedOf,
} from "../../src/commands/webSecurity/shared/cookieTokens.ts";
import { parseSqlmapOutput } from "../../src/commands/webSecurity/bridges/sqlmapBridge.ts";
import { runNucleiBridge } from "../../src/commands/webSecurity/bridges/nucleiBridge.ts";
import { runSqlmapBridge } from "../../src/commands/webSecurity/bridges/sqlmapBridge.ts";
import {
	assertMatureBridgeProcessResult,
	detectMatureBridgeLauncher,
	matureBridgeFailureRecord,
	matureBridgeToolError,
} from "../../src/commands/webSecurity/shared/matureBridge.ts";
import { createRailsCookieTokenFns } from "../../src/commands/webSecurity/shared/railsCookieTokens.ts";
import { summarizeBrowserCrawlData } from "../../src/commands/summaries/webSecurity/crawl.ts";
import { summarizeCookieAnalyzeData } from "../../src/commands/summaries/webSecurity/cookie.ts";
import { summarizeFuzzParamsData, summarizeFuzzPathsData, summarizeFuzzVhostsData } from "../../src/commands/summaries/webSecurity/fuzz.ts";
import { summarizeHttpReplayData } from "../../src/commands/summaries/webSecurity/replay.ts";
import { summarizeSqliProbeData } from "../../src/commands/summaries/webSecurity/sqli.ts";
import { summarizeTemplateCheckData } from "../../src/commands/summaries/webSecurity/template.ts";
import { summarizeWebReconProbeData } from "../../src/commands/summaries/webSecurity/recon.ts";
import { summarizeSqlmapBridgeData, summarizeNucleiBridgeData } from "../../src/commands/summaries/webSecurity/bridges.ts";
import { summarizeCallbackOastData } from "../../src/commands/summaries/webSecurity/oast.ts";
import { redactWebSecurityDiagnosticText, redactWebSecurityDiagnosticValue, webSecurityToolError } from "../../src/commands/webSecurity/shared/diagnostics.ts";
import { browserArtifactPrivacyMetadata } from "../../src/artifacts/artifactPrivacy.ts";

function assertSerializedOmits(value: unknown, secrets: string[]) {
	const serialized = JSON.stringify(value);
	for (const secret of secrets) assert.equal(serialized.includes(secret), false, secret);
}

function templateFetchStep(overrides: Partial<FetchStep> = {}): FetchStep {
	const bodyText = overrides.bodyText ?? "<html><title>Demo page</title><body>token=abc token=def</body></html>";
	return {
		url: "https://example.test/start",
		status: 302,
		statusText: "Found",
		ok: false,
		headers: { Location: "/next", "X-Trace": "trace-1" },
		setCookie: ["sid=abc; Path=/; HttpOnly", "theme=dark; SameSite=Lax"],
		elapsedMs: 1,
		bodyText,
		bodyBytes: Buffer.byteLength(bodyText),
		bodyTruncated: false,
		...overrides,
	};
}

function directJwe(payload: Record<string, unknown>, secret: string): string {
	const protectedHeader = base64UrlEncode(JSON.stringify({ alg: "dir", enc: "A256GCM", typ: "JWT" }));
	const iv = Buffer.alloc(12, 7);
	const cipher = createCipheriv("aes-256-gcm", Buffer.from(secret, "utf8"), iv);
	cipher.setAAD(Buffer.from(protectedHeader, "utf8"));
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
	return `${protectedHeader}..${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}.${base64UrlEncode(cipher.getAuthTag())}`;
}

function railsGcmToken(payload: Record<string, unknown>, secret: string): string {
	const iv = Buffer.alloc(12, 3);
	const cipher = createCipheriv("aes-256-gcm", Buffer.from(secret, "utf8"), iv);
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
	return `${ciphertext.toString("base64")}--${iv.toString("base64")}--${cipher.getAuthTag().toString("base64")}`;
}

function railsLegacyCbcToken(payload: Record<string, unknown>, secret: string): string {
	const iv = Buffer.alloc(16, 5);
	const cipher = createCipheriv("aes-256-cbc", Buffer.from(secret, "utf8"), iv);
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
	const payloadPart = `${ciphertext.toString("base64")}--${iv.toString("base64")}`;
	return `${payloadPart}--${createHmac("sha1", secret).update(payloadPart, "utf8").digest("hex")}`;
}

function railsTokenHelpers() {
	return createRailsCookieTokenFns({
		decodePrintableJsonValue(buffer) {
			const text = buffer.toString("utf8");
			try {
				return { text, json: JSON.parse(text) };
			} catch {
				const printable = Array.from(text).every((char) => {
					const code = char.charCodeAt(0);
					return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126);
				});
				return printable ? { text } : {};
			}
		},
		secretByteCandidates: (secret) => [{ source: "utf8", bytes: Buffer.from(secret, "utf8") }],
	});
}

function djangoToken(payload: Record<string, unknown>, secret: string): string {
	const payloadPart = base64UrlEncode(JSON.stringify(payload));
	const timestampPart = "1";
	const signedValue = `${payloadPart}:${timestampPart}`;
	const key = createHash("sha1").update(`django.core.signingsigner${secret}`, "utf8").digest();
	return `${signedValue}:${base64UrlEncode(createHmac("sha1", key).update(signedValue, "utf8").digest())}`;
}

function flaskToken(payload: Record<string, unknown>, secret: string): string {
	const payloadPart = base64UrlEncode(JSON.stringify(payload));
	const timestampPart = base64UrlEncode(Buffer.from([1]));
	const signedValue = `${payloadPart}.${timestampPart}`;
	const key = createHmac("sha1", secret).update("cookie-session", "utf8").digest();
	return `${signedValue}.${base64UrlEncode(createHmac("sha1", key).update(signedValue, "utf8").digest())}`;
}

test("web security redaction boundaries omit secrets from summaries, diagnostics, and metadata", () => {
	const pages = [{ url: "https://app.example.test/", status: 200, title: "Home", depth: 0, links: ["/a"], forms: [{}], endpoints: [{}], manifests: [], serviceWorkers: ["/sw.js"], sourceMaps: ["/app.js.map"], sourceMapDetails: { sourceCount: 2, archivedSourceCount: 1, manifestPath: "sources.json" }, apiSpec: { kind: "openapi", endpointCount: 2, parameterSummary: { totalParameters: 3, requestBodyFieldCount: 1 } }, graphqlSchema: { typeCount: 4, source: "active" }, serviceWorkerDetails: { cacheRouteCount: 2, versionSummary: { versionTokens: ["v1"] } } }];
	const endpoints = [{ url: "https://app.example.test/api", kind: "api", method: "POST", source: "fetch", parameterCount: 2, parameterSummary: { requestBodyFieldCount: 1 }, sourceUrl: "https://app.example.test/app.js" }];
	const crawl = summarizeBrowserCrawlData({ ok: true, pages, endpoints, failures: [{ url: "https://app.example.test/bad", error: "boom" }], maxDepth: 2, activeGraphqlIntrospection: true, artifactRoot: "artifacts", sourceArchiveCount: 1 });
	assert.equal(crawl.pageCount, 1);
	assert.equal(crawl.endpointCount, 1);
	assert.equal(crawl.sourceMapManifestCount, 1);
	assert.equal(Array.isArray(crawl.nextActions), true);

	const pathFuzz = summarizeFuzzPathsData({ ok: true, baseCount: 1, candidateCount: 2, requestCount: 2, matched: [{ url: "https://app.example.test/admin", depth: 1, status: 200, title: "Admin", bodyBytes: 12, bodySha256: "abc", differentFromBaseline: true, baselineClusterMatched: false, delta: { status: true }, redirects: [{}] }], results: [{ url: "https://app.example.test/admin", status: 200 }], failures: [{ url: "https://app.example.test/fail", error: "timeout" }], baselines: [{ baseUrl: "https://app.example.test/", url: "https://app.example.test/404", status: 404, bodyBytes: 9, bodySha256: "def" }], baselineClusters: [{ status: 404, title: "Missing", count: 1, bodyBytesMin: 8, bodyBytesMax: 10, samplePaths: ["/x"] }], clusters: [{ status: 200, title: "Admin", bodyBytes: 12, count: 1, matchedCount: 1, sampleUrls: ["/admin"] }] });
	assert.equal(pathFuzz.matchedCount, 1);
	assert.deepEqual(pathFuzz.statusCounts, [{ key: "200", count: 1 }]);
	const vhostFuzz = summarizeFuzzVhostsData({ matched: [{ host: "admin.example.test", status: 200, title: "Admin", tlsFingerprint256: "fp", bodySha256: "h", sniName: "admin.example.test", differentFromBaseline: true, baselineClusterMatched: false, nearestBaseline: "root", delta: {} }], results: [{ host: "admin.example.test", status: 200 }], failures: [{ host: "bad", error: "dns" }], baselines: [{ baseUrl: "https://example.test", host: "www", sniName: "www", status: 404, bodyBytes: 10, tlsFingerprint256: "fp", bodySha256: "h" }], baselineClusters: [{ status: 404, title: "Missing", tlsFingerprint256: "fp", count: 1, bodyBytesMin: 9, bodyBytesMax: 10, hosts: ["www"] }], clusters: [{ status: 200, title: "Admin", bodyBytes: 12, tlsFingerprint256: "fp2", count: 1, matchedCount: 1, hosts: ["admin"] }] });
	assert.equal(vhostFuzz.matchedCount, 1);
	const paramFuzz = summarizeFuzzParamsData({ matched: [{ location: "query", paramName: "id", operation: "set", contentTypeVariant: "json", value: "1'", status: 500, bodyBytes: 20, bodySha256: "h", responseLocation: "/err", multipart: { partCount: 1, fileCount: 0, nestedMultipartPartCount: 0 }, delta: {}, url: "https://app.example.test/?id=1" }], results: [{ status: 500, location: "query", operation: "set", contentTypeVariant: "json" }], parserClusters: [{ status: 500, title: "Error", bodyBytes: 20, count: 1, matchedCount: 1, contentTypeVariants: ["json"], params: ["id"], multipartShapes: [], repeatedNames: [], nestedMultipartPartCount: 0 }], failures: [{ location: "json", paramName: "role", operation: "append", contentTypeVariant: "bare", error: "bad" }] });
	assert.equal(paramFuzz.parserClusterCount, 1);

	assert.equal(summarizeHttpReplayData({ ok: true, request: { url: "https://app.example.test/a", method: "GET" }, response: { status: 200, body: { text: "Cookie: sid=secret" } }, steps: [{ index: 0, request: { method: "GET", url: "https://app.example.test/a" }, response: { status: 200, body: { bytes: 4 } }, capturedVariableNames: ["csrf"] }], redirects: [{}] }).stepCount, undefined);
	assert.equal(summarizeSqliProbeData({ ok: true, matched: [{ location: "query", paramName: "id", type: "error", payload: "'", response: { status: 500, bodyBytes: 20 }, sqlError: "SQL" }], results: [{ type: "error", paramName: "id" }], failures: [{ type: "time", paramName: "id", error: "fail" }] }).matchedCount, 1);
	assert.equal(summarizeTemplateCheckData({ ok: true, matched: [{ templateId: "exposure", name: "Env", url: "https://app.example.test/.env", status: 200, checks: [{ matched: true }], extracts: [{ value: "APP_KEY" }] }], results: [{ templateId: "exposure", status: 200 }], failures: [{ templateId: "bad", url: "x", error: "fail" }] }).matchedCount, 1);
	assert.equal(summarizeWebReconProbeData({ ok: true, results: [{ inputUrl: "https://app.example.test/", finalUrl: "https://app.example.test/", status: 200, tech: ["Next.js"], fingerprints: [{ label: "nginx" }] }, { inputUrl: "https://bad.test/", ok: false, error: "fail" }] }).count, 2);
	assert.equal(summarizeCookieAnalyzeData({ ok: true, cookieCount: 1, results: [{ source: "cookie", name: "sid", kind: "jwt", token: { format: "jwt", payload: { sub: "alice" }, signature: { verified: true }, mutation: { token: "mut" } } }], claimReplays: [{ name: "admin", format: "jwt", cookieName: "sid", mutated: { status: 200 }, baseline: { status: 403 }, delta: {} }] }).cookieCount, 1);
	assert.equal(summarizeCallbackOastData({ ok: true, sessions: [{ sessionId: "s1", eventCount: 2 }], events: [{ sessionId: "s1", type: "http", url: "https://oast.test/cb" }] }).eventCount, 1);
	assert.equal(summarizeSqlmapBridgeData({ ok: true, runs: [{ index: 0, source: "raw", targetUrl: "https://app.example.test", vulnerable: true, findingCount: 1, dbmsFingerprints: ["PostgreSQL"], stdoutArtifact: { path: "out.txt" } }], findings: [{ runIndex: 0, targetUrl: "https://app.example.test", parameter: "id", place: "GET", type: "boolean", title: "blind", payload: "id=1" }], artifacts: [{ kind: "stdout", label: "out", path: "out.txt", bytes: 10 }] }).findingCount, 1);
	assert.equal(summarizeNucleiBridgeData({ ok: true, runs: [{ index: 0, source: "url", targetUrl: "https://app.example.test", matched: true, matchCount: 1, matchSeverities: ["high"], matchTemplateIds: ["exposure/test"] }], matches: [{ runIndex: 0, targetUrl: "https://app.example.test", templateId: "exposure/test", templateName: "Exposure", severity: "high", matchedAt: "https://app.example.test/.env", extractedResults: ["APP_KEY"] }] }).matchCount, 1);
	const secrets = ["Bearer raw-auth-secret", "sid=raw-cookie-secret", "set-cookie-secret", "raw-api-key", "raw-query-token", "raw-body-token", "scanner-secret"];
	const replaySecretSummary = summarizeHttpReplayData({
		ok: false,
		request: { url: "https://app.example.test/api?token=raw-query-token", method: "POST", headerNames: ["Authorization", "Cookie", "X-Api-Key"], bodyBytes: 33 },
		response: { status: 500, url: "https://app.example.test/api?token=raw-query-token", headerNames: ["Set-Cookie"], body: { text: "Authorization: Bearer raw-auth-secret\nCookie: sid=raw-cookie-secret\nSet-Cookie: sid=set-cookie-secret\nX-Api-Key: raw-api-key\n{\"token\":\"raw-body-token\"}" } },
		steps: [{ index: 0, request: { method: "POST", url: "https://app.example.test/api?token=raw-query-token" }, response: { status: 500, body: { bytes: 33 } }, error: "Authorization: Bearer raw-auth-secret Cookie: sid=raw-cookie-secret" }],
	});
	assertSerializedOmits(replaySecretSummary, secrets);
	const sqlmapSecretSummary = summarizeSqlmapBridgeData({
		ok: false,
		runs: [{ index: 0, source: "raw", targetUrl: "https://app.example.test/search?token=raw-query-token", vulnerable: true, findingCount: 1, args: ["-r", "request.txt", "--headers", "Authorization: Bearer raw-auth-secret"], requestArtifact: { kind: "request", label: "raw", path: "request.txt", metadata: { Authorization: "Bearer raw-auth-secret", Cookie: "sid=raw-cookie-secret", "X-Api-Key": "raw-api-key" } }, stdoutArtifact: { kind: "stdout", label: "out", path: "stdout.txt", token: "scanner-secret" } }],
		findings: [{ runIndex: 0, targetUrl: "https://app.example.test/search?token=raw-query-token", parameter: "token", place: "GET", type: "boolean", title: "blind", payload: "token=raw-query-token&api_key=raw-api-key" }],
		failures: [{ index: 0, source: "raw", error: "Cookie: sid=raw-cookie-secret", details: { Authorization: "Bearer raw-auth-secret" } }],
		artifacts: [{ kind: "diagnostic", label: "diag", path: "diag.json", headers: { Authorization: "Bearer raw-auth-secret", Cookie: "sid=raw-cookie-secret" }, url: "https://app.example.test/?token=raw-query-token" }],
	});
	assertSerializedOmits(sqlmapSecretSummary, secrets);
	const nucleiSecretSummary = summarizeNucleiBridgeData({
		ok: true,
		runs: [{ index: 0, source: "url", targetUrl: "https://app.example.test/debug?token=raw-query-token", matched: true, matchCount: 1, stdoutArtifact: { path: "out.txt", headers: { "Set-Cookie": "sid=set-cookie-secret" } } }],
		matches: [{ runIndex: 0, targetUrl: "https://app.example.test/debug?token=raw-query-token", templateId: "exposure/test", templateName: "Exposure", severity: "high", matchedAt: "https://app.example.test/.env?api_key=raw-api-key", extractedResults: ["token=raw-body-token", "Authorization: Bearer raw-auth-secret"], requestPreview: "Cookie: sid=raw-cookie-secret\nX-Api-Key: raw-api-key" }],
		artifacts: [{ kind: "jsonl", label: "nuclei", path: "nuclei.jsonl", request: { headers: { Cookie: "sid=raw-cookie-secret" } } }],
	});
	assertSerializedOmits(nucleiSecretSummary, secrets);
	assertSerializedOmits(redactWebSecurityDiagnosticText("Authorization: Bearer raw-auth-secret\nCookie: sid=raw-cookie-secret\nX-Api-Key: raw-api-key\nurl=https://app.example.test/?token=raw-query-token"), secrets);
	assertSerializedOmits(redactWebSecurityDiagnosticValue({ headers: { Authorization: "Bearer raw-auth-secret", Cookie: "sid=raw-cookie-secret", "Set-Cookie": "sid=set-cookie-secret", "X-Api-Key": "raw-api-key" }, body: { token: "raw-body-token" }, url: "https://app.example.test/?token=raw-query-token" }), secrets);
	assertSerializedOmits(webSecurityToolError(new Error("Cookie: sid=raw-cookie-secret Authorization: Bearer raw-auth-secret"), { commandName: "browser_http_replay", command: "browser_http_replay" }), secrets);
	assertSerializedOmits(browserArtifactPrivacyMetadata(), secrets);
});

test("HTTP shared helpers normalize targets, cookies, redirects, tech hints, and safe headers", async () => {
	assert.equal(tlsRemediation("CERT_HAS_EXPIRED", undefined)?.includes("expired"), true);
	assert.equal(tlsRemediation(undefined, "self-signed certificate")?.includes("TLS chain"), true);
	assert.equal(absoluteUrl("example.test/path", { scheme: "http" }), "http://example.test/path");
	assert.equal(absoluteUrl("/next", { baseUrl: "https://example.test/root/" }), "https://example.test/next");
	assert.throws(() => absoluteUrl(""), /URL is required/);
	assert.deepEqual(normalizeProbeTargets({ url: "example.test", paths: ["/a", "b"], ports: [80, "443"], schemes: ["http", "https"] }), [
		"http://example.test/a",
		"http://example.test/b",
		"http://example.test:443/a",
		"http://example.test:443/b",
		"https://example.test:80/a",
		"https://example.test:80/b",
		"https://example.test/a",
		"https://example.test/b",
	]);
	await assert.rejects(() => assertAllowedTargetUrl("http://169.254.169.254/latest"), /Private or metadata target/);
	await assertAllowedTargetUrl("http://localhost:3000", { allowLoopback: true });
	assert.deepEqual(normalizeHeaders({ " Content-Type ": "text/html", ":method": "GET", empty: undefined, multi: ["a", 2] }), { "Content-Type": "text/html", multi: "a, 2" });
	assert.deepEqual(headersArrayToMap([{ name: "A", value: 1 }, { key: "B", val: "two" }]), { A: "1", B: "two" });
	assert.deepEqual(redactHeaders({ Authorization: "Bearer secret", Cookie: "sid=1", Accept: "text/html" }), { Authorization: "[redacted]", Cookie: "[redacted]", Accept: "text/html" });
	assert.deepEqual([...parseCookieHeader("a=1; bad; b=two").entries()], [["a", "1"], ["b", "two"]]);
	assert.equal(mergeCookieHeaders("a=1; b=old", "b=new; c=3"), "a=1; b=new; c=3");
	const cookieHeaders = { Cookie: "sid=1", other: "x" };
	setCookieHeader(cookieHeaders, undefined);
	assert.deepEqual(cookieHeaders, { other: "x" });
	setCookieHeader(cookieHeaders, "sid=2");
	assert.equal(cookieHeaders.Cookie, "sid=2");
	assert.deepEqual(deriveCsrfReflection("XSRF-TOKEN=a%20b; sid=1"), { cookie: "XSRF-TOKEN", header: "X-XSRF-TOKEN", value: "a b" });
	const browserCookies = [{ name: "sid", value: "1", domain: "example.test" }, { name: "theme", value: "dark" }];
	const provider = browserCookiesToProviderResult({ data: browserCookies }, "https://example.test/");
	assert.equal(cookieProviderResultHeader(provider), "sid=1; theme=dark");
	assert.equal(cookieProviderResultCookies(provider).length, 2);
	assert.equal(parseSetCookieLine("Set-Cookie: sid=1; HttpOnly; SameSite=Lax", "header")?.attributes?.httponly, true);
	assert.deepEqual(sanitizeFetchHeaders({ Host: "example.test", "X-Test": "1", ":authority": "x" }), { headers: { "X-Test": "1" }, omittedHeaderNames: ["Host", ":authority"] });
	assert.equal(extractTitle("<html><title> Demo <b>Site</b> </title></html>"), "Demo Site");
	const body = "<meta name='generator' content='WordPress 6'><script src='/_next/app.js'></script><div data-reactroot>jquery</div>";
	const hints = detectTechHints({ Server: "nginx/1.25", "X-Powered-By": "Express" }, body, ["PHPSESSID=1", "csrftoken=abc"]);
	assert.equal(hints.some((hint) => hint.label === "Next.js"), true);
	assert.equal(detectTech({ Server: "nginx/1.25" }, body, []).includes("server:nginx"), true);
	assert.equal(detectFingerprints({ Server: "nginx/1.25" }, body, ["connect.sid=s"]).some((item) => item.label === "Express session"), true);
	assert.equal(redirectLocation(302, { Location: "/login" }, "https://example.test/admin"), "https://example.test/login");
	assert.equal(redirectLocation(200, { Location: "/login" }, "https://example.test/admin"), undefined);
	assert.equal(redirectMethod("POST", 302), "GET");
	assert.equal(redirectMethod("POST", 307), "POST");
	const step = { url: "https://example.test/old", status: 301, statusText: "Moved", ok: false, headers: { location: "/new", Cookie: "sid=1", "content-type": "text/html" }, setCookie: [], bodyText: "<title>Old</title>", bodyBytes: 18, bodyTruncated: false, elapsedMs: 5 };
	assert.equal(contentTypeOf(step.headers), "text/html");
	assert.equal(responseBodyHash(step).length, 64);
	assert.deepEqual(responseFingerprint(step), { status: 301, title: "Old", bodyBytes: 18, bodySha256: responseBodyHash(step), location: "https://example.test/new" });
	assert.deepEqual(compactStep(step), { url: "https://example.test/old", status: 301, statusText: "Moved", location: "https://example.test/new", elapsedMs: 5, headers: { location: "/new", Cookie: "[redacted]", "content-type": "text/html" }, headerNames: ["location", "Cookie", "content-type"], bodyBytes: 18, bodyTruncated: false });
	const caseHeaders = { "X-Test": "old", Other: "v" };
	setHeaderCaseInsensitive(caseHeaders, "x-test", "new");
	assert.deepEqual(caseHeaders, { Other: "v", "x-test": "new" });
});

test("normalize helpers bound integers and parse shell-style args without execution", () => {
	assert.equal(positiveInt("12.9", 5), 12);
	assert.equal(positiveInt("0", 5), 5);
	assert.deepEqual(parseCommandArgs("--flag 'two words' \"three four\" escaped\\ value"), ["--flag", "two words", "three four", "escaped value"]);
	assert.throws(() => parseCommandArgs("--unterminated 'quote"), /unclosed/);
});

test("multipart helpers round-trip fields, files, quoted boundaries, and malformed content types", () => {
	const parts: MultipartPart[] = [
		{ name: "field", body: Buffer.from("value") },
		{ name: "upload", filename: "a\"b.txt", contentType: "text/plain", body: Buffer.from("file-body") },
	];
	const built = buildMultipartBodyFromParts(parts, "bp-boundary");
	const headers: Record<string, string> = {};
	setMultipartContentTypeVariant(headers, "bp-boundary", "quoted");
	const parsed = parseMultipartBody(built.body, headers["Content-Type"] ?? "");
	assert.equal(parsed.boundary, "bp-boundary");
	assert.equal(parsed.parts.length, 2);
	assert.equal(parsed.parts[0]?.name, "field");
	assert.equal(parsed.parts[0]?.body.toString(), "value");
	assert.equal(parsed.parts[1]?.filename, "a%22b.txt");
	assert.equal(parsed.parts[1]?.contentType, "text/plain");
	assert.equal(parsed.parts[1]?.body.toString(), "file-body");
	assert.throws(() => parseMultipartBody(built.body, "multipart/form-data"), /missing boundary/);
	assert.deepEqual(summarizeMultipartParts(parsed.parts, parsed.boundary, "quoted"), {
		boundary: "bp-boundary",
		contentTypeVariant: "quoted",
		partCount: 2,
		fieldCount: 1,
		fileCount: 1,
		nestedMultipartPartCount: 0,
		repeatedNameCounts: [],
		filenames: ["a%22b.txt"],
		contentTypes: ["text/plain"],
	});
});

test("HAR helpers select entries and infer redirect, referer, and cookie dependencies", async () => {
	const har = {
		log: {
			entries: [
				{
					request: { method: "GET", url: "https://example.test/login", headers: [] },
					response: { status: 302, redirectURL: "/dashboard", headers: [{ name: "Set-Cookie", value: "sid=abc; Path=/" }] },
				},
				{
					request: { method: "GET", url: "https://example.test/dashboard", headers: [{ name: "Referer", value: "https://example.test/login" }, { name: "Cookie", value: "sid=abc" }] },
					response: { status: 200, headers: [] },
				},
			],
		},
	};
	const selected = await harEntriesFromOptions({ har, harUrlPattern: "dashboard", harMaxEntries: 5 });
	assert.equal(selected.length, 1);
	assert.equal(harHeaderValues([{ name: "set-cookie", value: "sid=abc" }], "Set-Cookie")[0], "sid=abc");
	const graph = buildHarDependencyGraph(har.log.entries.map((input) => ({ input, source: "har" })));
	assert.equal(graph?.nodeCount, 2);
	assert.equal(graph?.edgeCount, 3);
	assert.deepEqual(graph?.edgeTypes.map((item) => item.key).sort(), ["cookie", "redirect", "referer"]);
});

test("cookie token helpers decode, verify, and mutate JWT samples offline", async () => {
	const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = base64UrlEncode(JSON.stringify({ sub: "alice", admin: false }));
	const signature = base64UrlEncode(createHmac("sha256", "secret").update(`${header}.${payload}`).digest());
	const jwt = `${header}.${payload}.${signature}`;
	const result = await analyzeCookieSample({ source: "cookie", name: "session", value: jwt }, ["secret"], { admin: true });
	assert.equal(tokenFormatOf(result), "jwt");
	assert.equal(tokenVerifiedOf(result), true);
	assert.equal((result.token as { payload?: Record<string, unknown> } | undefined)?.payload?.sub, "alice");
	assert.match(tokenMutationToken(result) ?? "", /^[^.]+\.[^.]+\.[^.]+$/);
});

test("cookie token analysis distinguishes unsigned and unverified JWT mutation", async () => {
	const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = base64UrlEncode(JSON.stringify({ sub: "alice" }));
	const signature = base64UrlEncode(createHmac("sha256", "secret").update(`${header}.${payload}`).digest());
	const unverified = await analyzeCookieSample({ source: "header", value: `${header}.${payload}.${signature}` }, ["wrong"], { admin: true });
	assert.equal(tokenVerifiedOf(unverified), false);
	assert.equal(tokenMutationToken(unverified), undefined);
	assert.match(String(((unverified.token as Record<string, unknown>).mutation as Record<string, unknown>).error), /no matching secret/);

	const noneHeader = base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
	const unsigned = await analyzeCookieSample({ source: "header", value: `${noneHeader}.${payload}.` }, [], { admin: true });
	assert.equal(tokenVerifiedOf(unsigned), true);
	assert.match(tokenMutationToken(unsigned) ?? "", /\.$/);
});

test("cookie token analysis decrypts direct JWE and recognizes PASETO offline", async () => {
	const secret = "0123456789abcdef0123456789abcdef";
	const jwe = await analyzeCookieSample({ source: "cookie", name: "secure", value: directJwe({ sub: "alice", admin: false }, secret) }, [secret], { admin: true });
	assert.equal(tokenFormatOf(jwe), "jwe");
	assert.equal(tokenVerifiedOf(jwe), true);
	assert.equal(((jwe.token as Record<string, unknown>).payload as Record<string, unknown>).sub, "alice");
	assert.equal((tokenMutationToken(jwe) ?? "").split(".").length, 5);

	const pasetoValue = `v4.local.${base64UrlEncode(JSON.stringify({ sub: "bob" }))}.${base64UrlEncode(JSON.stringify({ kid: "one" }))}`;
	const paseto = await analyzeCookieSample({ source: "cookie", value: pasetoValue }, [], { admin: true });
	assert.equal(tokenFormatOf(paseto), "paseto");
	assert.deepEqual((paseto.token as Record<string, unknown>).payload, { sub: "bob" });
	assert.match(String(((paseto.token as Record<string, unknown>).mutation as Record<string, unknown>).error), /not supported/);
});

test("cookie token analysis verifies Django and Flask sessions without empty-secret mutation fallback", async () => {
	for (const [format, value] of [["django", djangoToken({ user_id: 7 }, "secret")], ["flask", flaskToken({ user_id: 8 }, "secret")]] as const) {
		const verified = await analyzeCookieSample({ source: "cookie", name: "session", value }, ["secret"], { admin: true });
		assert.equal(tokenFormatOf(verified), format);
		assert.equal(tokenVerifiedOf(verified), true);
		assert.ok(tokenMutationToken(verified));

		const unverified = await analyzeCookieSample({ source: "cookie", name: "session", value }, ["wrong"], { admin: true });
		assert.equal(tokenVerifiedOf(unverified), false);
		assert.equal(tokenMutationToken(unverified), undefined);
		assert.match(String(((unverified.token as Record<string, unknown>).mutation as Record<string, unknown>).error), /no matching secret/);
	}
});

test("cookie token analysis keeps generic decoding bounded and classifies opaque values", async () => {
	const encoded = await analyzeCookieSample({ source: "header", value: encodeURIComponent(JSON.stringify({ role: "admin" })) }, [], undefined);
	assert.equal(encoded.kind, "encoded-json");
	assert.deepEqual((encoded.decodings as Array<Record<string, unknown>>)[0]?.json, { role: "admin" });

	const opaque = await analyzeCookieSample({ source: "header", value: "%not-a-valid-cookie%" }, [], undefined);
	assert.equal(opaque.kind, "opaque");
	assert.deepEqual(opaque.decodings, []);
});

test("sqlmap bridge parser extracts findings and redacts no external scanner execution", () => {
	const parsed = parseSqlmapOutput(`
web server operating system: Linux Ubuntu
web application technology: nginx, PHP
back-end DBMS: PostgreSQL
Parameter: id (GET)
    Type: boolean-based blind
    Title: PostgreSQL AND boolean-based blind
    Payload: id=1 AND 1=1

current user: 'app'
current database: 'prod'
current user is DBA: false
banner: PostgreSQL 15
`);
	assert.equal(parsed.vulnerable, true);
	assert.deepEqual(parsed.dbmsFingerprints, ["PostgreSQL"]);
	assert.equal(parsed.webServerOs, "Linux Ubuntu");
	assert.equal(parsed.webTechnology, "nginx, PHP");
	assert.equal(parsed.currentUser, "app");
	assert.equal(parsed.currentDatabase, "prod");
	assert.equal(parsed.isDba, false);
	assert.equal(parsed.banner, "PostgreSQL 15");
	assert.deepEqual(parsed.findings, [{ parameter: "id", place: "GET", type: "boolean-based blind", title: "PostgreSQL AND boolean-based blind", payload: "id=1 AND 1=1" }]);
});

test("crawl extractors enumerate browser-native discovery surfaces offline", async () => {
	const baseUrl = "https://app.example.test/root/page.html#frag";
	const html = `
		<html><head>
			<title>Portal</title>
			<link rel="manifest" href="/manifest.json">
			<script src="/static/app.mjs?v=1"></script>
		</head><body>
			<a href="/admin?x=1#drop">admin</a>
			<img src="data:image/png;base64,deadbeef">
			<form method="post" action="/login"><input name="user"><input name='csrf'></form>
			<script>navigator.serviceWorker.register('/sw.js'); fetch('/api/users',{method:'POST'}); axios.get('/debug.json'); xhr.open('PUT','/v1/items')</script>
		</body></html>`;
	assert.equal(normalizeUrlForVisit(baseUrl), "https://app.example.test/root/page.html");
	assert.deepEqual(knownFilePaths("api"), ["/openapi.json", "/swagger.json", "/v3/api-docs", "/api-docs"]);
	assert.equal(inScope("https://app.example.test/a", new Set(["https://app.example.test"]), true), true);
	assert.equal(inScope("https://cdn.example.test/a", new Set(["https://app.example.test"]), true), false);
	assert.equal(absolutizeMaybe("/admin?x=1&amp;y=2#drop", baseUrl), "https://app.example.test/admin?x=1&y=2");
	assert.equal(absolutizeMaybe("javascript:alert(1)", baseUrl), undefined);
	assert.deepEqual(extractAttributeUrls(html, baseUrl).filter((item) => item.kind !== "resource"), [
		{ url: "https://app.example.test/manifest.json", kind: "link" },
		{ url: "https://app.example.test/admin?x=1", kind: "link" },
		{ url: "https://app.example.test/login", kind: "form" },
	]);
	assert.deepEqual(extractScriptSources(html, baseUrl), ["https://app.example.test/static/app.mjs?v=1"]);
	assert.deepEqual(extractManifestUrls(html, baseUrl), ["https://app.example.test/manifest.json"]);
	assert.deepEqual(extractServiceWorkerUrls(html, baseUrl), ["https://app.example.test/sw.js"]);
	assert.deepEqual(extractForms(html, baseUrl), [{ method: "POST", action: "https://app.example.test/login", inputNames: ["user", "csrf"] }]);
	assert.equal(endpointKindFor("https://app.example.test/graphql", "fetch"), "graphql");
	assert.deepEqual(extractStringUrls(html, baseUrl).filter((item) => item.source !== "literal").map((item) => `${item.source}:${item.method ?? ""}:${item.url}`).sort(), [
		"axios:GET:https://app.example.test/debug.json",
		"fetch:POST:https://app.example.test/api/users",
		"xhr:PUT:https://app.example.test/v1/items",
	]);
	assert.deepEqual(extractKnownFileUrls("Sitemap: /sitemap.xml\n<loc>/docs/openapi.json</loc>", baseUrl).map((item) => item.url), ["https://app.example.test/sitemap.xml", "https://app.example.test/docs/openapi.json"]);
	assert.deepEqual(extractSourceMapUrls("//# sourceMappingURL=app.js.map", baseUrl), ["https://app.example.test/root/app.js.map"]);
	const graphql = detectGraphqlSchema(JSON.stringify({
		data: {
			__schema: {
				queryType: { name: "Query" },
				mutationType: { name: "Mutation" },
				types: [
					{ name: "Query", fields: [{ name: "viewer", args: [{ name: "id" }] }] },
					{ name: "Mutation", fields: [{ name: "save", args: [] }] },
				],
			},
		},
	}));
	assert.equal(graphql?.kind, "graphql-introspection");
	assert.deepEqual(graphql?.queryFields, [{ name: "viewer", args: ["id"] }]);
	assert.equal(shouldProbeGraphqlIntrospection("https://app.example.test/graphql", "text/html"), true);
	const openapi = detectApiSpec(JSON.stringify({ openapi: "3.1.0", info: { title: "Demo" }, servers: [{ url: "/api" }], paths: { "/users/{id}": { get: { operationId: "getUser", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { role: { enum: ["admin", "user"] } } } } } } } } } }), "https://app.example.test/openapi.json", "application/json");
	assert.equal(openapi?.kind, "openapi");
	assert.equal(openapi?.endpointCount, 1);
	assert.equal((openapi?.parameterSummary as Record<string, unknown>).pathCount, 1);
	const sourceMapRoot = await mkdtemp(path.join(os.tmpdir(), "bp-source-map-"));
	const sourceMap = await parseSourceMapDetails(JSON.stringify({ version: 3, file: "app.js", sourceRoot: "/src", sources: ["api/client.ts"], sourcesContent: ["fetch('/api/private')"], names: ["fetch"] }), "https://app.example.test/static/app.js.map", async () => sourceMapRoot);
	assert.equal(sourceMap?.kind, "source-map");
	assert.equal(sourceMap?.archivedSourceCount, 1);
	assert.equal((sourceMap?.endpointHints as Array<Record<string, unknown>>)[0]?.url, "https://app.example.test/api/private");
	const swText = "const CACHE='app-v1.2.3'; caches.open(CACHE); cache.addAll(['/offline.html','/api/cache']); new Request('/graphql'); importScripts('/sw-lib.9f1e2d3.js')";
	assert.deepEqual(extractServiceWorkerCacheRoutes(swText, baseUrl).map((item) => item.url), ["https://app.example.test/offline.html", "https://app.example.test/api/cache", "https://app.example.test/graphql"]);
	const swVersion = extractServiceWorkerVersionSummary(swText, baseUrl);
	assert.equal(swVersion.cacheNameCount, 0);
	assert.deepEqual(swVersion.importScripts, ["https://app.example.test/sw-lib.9f1e2d3.js"]);
});

test("template DSL extractors preserve scalar, cookie, and JSON projections", () => {
	const final = templateFetchStep();
	const headersLower = { location: "/next", "x-trace": "trace-1" };
	assert.deepEqual(evaluateDslExtractor({ type: "header", name: "trace", header: "X-Trace" }, final, headersLower), [{ name: "trace", type: "header", part: "header", value: "trace-1", values: ["trace-1"] }]);
	assert.deepEqual(evaluateDslExtractor({ type: "header", header: "missing" }, final, headersLower), []);
	assert.deepEqual(evaluateDslExtractor({ type: "status" }, final, headersLower), [{ name: "status", type: "status", part: "status", value: 302, values: [302] }]);
	assert.equal(evaluateDslExtractor({ type: "title" }, final, headersLower)[0]?.value, "Demo page");
	assert.equal(evaluateDslExtractor({ type: "location" }, final, headersLower)[0]?.value, "https://example.test/next");
	assert.equal(evaluateDslExtractor({ type: "sha256" }, final, headersLower)[0]?.value, responseBodyHash(final));
	const cookies = evaluateDslExtractor({ type: "cookie", name: "session", cookie: "sid" }, final, headersLower);
	assert.deepEqual(cookies.map(({ name, cookie, value }) => ({ name, cookie, value })), [{ name: "session", cookie: "sid", value: "abc" }]);
	assert.deepEqual(evaluateDslExtractor({ type: "cookie", cookie: "missing" }, final, headersLower), []);

	const jsonFinal = templateFetchStep({ status: 200, bodyText: JSON.stringify({ csrf: "tok", roles: ["admin", "user"] }) });
	assert.deepEqual(evaluateDslExtractor({ type: "json", name: "roles", jsonPath: "$.roles" }, jsonFinal, {}), [{ name: "roles", type: "json", part: "body", jsonPath: "$.roles", value: ["admin", "user"], values: ["admin", "user"] }]);
	assert.deepEqual(evaluateDslExtractor({ type: "json", jsonPath: "$.missing" }, jsonFinal, {}), []);
	assert.deepEqual(evaluateDslExtractor({ type: "json", jsonPath: "$.csrf" }, templateFetchStep({ bodyText: "not-json" }), {}), []);
});

test("template DSL regex extraction stays bounded and reports unsafe or truncated inputs", () => {
	const final = templateFetchStep({ status: 200, bodyText: "token=abc token=def" });
	const extracted = evaluateDslExtractor({ type: "regex", name: "token", regex: ["token=(\\w+)"], group: 1 }, final, {});
	assert.deepEqual(extracted.map(({ value, group }) => ({ value, group })), [{ value: "abc", group: 1 }, { value: "def", group: 1 }]);
	const evaluation = evaluateTemplateMatcher({ id: "tokens", extractRegex: ["token=(\\w+)"], extractors: [{ type: "regex", name: "selected", regex: ["token=(\\w+)"], group: 1 }] }, final);
	assert.deepEqual(evaluation.extracts.map((item) => item.value), ["token=abc", "token=def", "abc", "def"]);

	const unsafe = evaluateDslExtractor({ type: "regex", regex: ["a".repeat(MAX_TEMPLATE_REGEX_PATTERN_CHARS + 1)] }, final, {});
	assert.equal(unsafe[0]?.skipped, true);
	assert.equal(unsafe[0]?.error_code, "TEMPLATE_REGEX_UNSAFE");
	const truncated = evaluateDslExtractor({ type: "regex", regex: ["never-matches"] }, templateFetchStep({ status: 200, bodyText: "x".repeat(MAX_TEMPLATE_REGEX_TEXT_CHARS + 1) }), {});
	assert.equal(truncated[0]?.regexInputTruncated, true);
	assert.equal(truncated[0]?.skipped, true);
	const many = evaluateDslExtractor({ type: "regex", regex: ["v\\d+"] }, templateFetchStep({ status: 200, bodyText: Array.from({ length: 25 }, (_, index) => `v${index}`).join(" ") }), {});
	assert.equal(many.length, 20);
});

test("template DSL matchers preserve modes, negation, and regex diagnostics", () => {
	const final = templateFetchStep({ status: 200, statusText: "OK", ok: true, bodyText: "hello admin" });
	const all = evaluateTemplateMatcher({
		id: "all-matchers",
		matchers: [
			{ type: "status", status: [200] },
			{ type: "word", words: ["hello", "admin"] },
			{ type: "contains", value: "hello" },
			{ type: "equals", part: "header", name: "X-Trace", value: "trace-1" },
			{ type: "regex", regex: ["adm.n"] },
			{ type: "word", value: "missing", negative: true },
		],
	}, final);
	assert.equal(all.matched, true);
	assert.equal(all.mode, "all");
	assert.deepEqual(all.checks.map((check) => check.matched), [true, true, true, true, true, true]);

	const any = evaluateTemplateMatcher({ id: "any-matchers", matcherMode: "any", matchers: [{ type: "equals", value: "missing" }, { type: "regex", regex: ["admin"] }] }, final);
	assert.equal(any.matched, true);
	const unsafe = evaluateTemplateMatcher({ id: "unsafe-matcher", matchers: [{ type: "regex", regex: ["a".repeat(MAX_TEMPLATE_REGEX_PATTERN_CHARS + 1)] }] }, final);
	assert.equal(unsafe.matched, false);
	assert.equal((((unsafe.checks[0]?.regexDiagnostics as Array<Record<string, unknown>>)?.[0]?.regexIssue as Record<string, unknown>)?.error_code), "TEMPLATE_REGEX_UNSAFE");
	assert.equal(evaluateTemplateMatcher({ id: "default-success" }, final).matched, true);
	assert.equal(evaluateTemplateMatcher({ id: "default-failure" }, templateFetchStep({ status: 500 })).matched, false);
});

test("replay and request-template helpers mutate requests without network I/O", async () => {
	const raw = "POST /submit?x=1 HTTP/1.1\r\nHost: example.test\r\nCookie: a=1\r\n b=2\r\nContent-Type: application/json\r\n\r\n{\"user\":{\"name\":\"alice\"},\"roles\":[\"user\"]}";
	const parsedRaw = parseRawHttpRequest(raw, { defaultScheme: "https" });
	assert.equal(parsedRaw.url, "https://example.test/submit?x=1");
	assert.equal(parsedRaw.headers.Cookie, "a=1 b=2");
	const request = buildReplayRequest({ rawRequest: raw, headers: { "X-Trace": "one" } });
	assert.equal(request.method, "POST");
	assert.equal(request.headers["X-Trace"], "one");
	assert.deepEqual(inferFuzzParamLocations(request, undefined).sort(), ["json", "query"]);
	assert.deepEqual(existingParamNames(request, ["query", "json", "header"]).sort(), ["Content-Type", "Cookie", "X-Trace", "roles", "user", "user.name", "x"].sort());
	assert.equal(mutateParamRequest(request, "query", "x", "2").url, "https://example.test/submit?x=2");
	assert.equal(mutateParamRequest({ ...request, body: "" }, "form", "token", "abc").body, "token=abc");
	assert.equal(JSON.parse(String(mutateParamRequest(request, "json", "user.admin", true).body)).user.admin, true);
	assert.equal(JSON.parse(String(mutateParamRequest(request, "json", "roles[0]", "admin").body)).roles[0], "admin");
	assert.equal(mutateParamRequest(request, "header", "Cookie", "sid=2", "set").headers.cookie, "sid=2");
	assert.throws(() => mutateParamRequest({ ...request, body: "not-json" }, "json", "x", 1), /Invalid JSON request body/);
	const multipartRequest = buildReplayRequest({ url: "https://example.test/upload", multipart: { fields: { name: "a" }, files: [{ name: "file", filename: "a.txt", content: "one", contentType: "text/plain" }] } });
	const changedMultipart = mutateParamRequest(multipartRequest, "multipart", "file", { filename: "b.txt", content: "two", contentType: "text/plain" }, "set", "bare");
	assert.equal(changedMultipart.multipart?.fileCount, 1);
	assert.match(String(changedMultipart.headers["Content-Type"]), /^multipart\/form-data; boundary=/);
	const normalized = normalizeReplayOptions({ followRedirects: true, cookieMode: "replace", timeoutMs: "20" as unknown as number, variables: { token: 123 }, variableScope: "local" });
	assert.equal(normalized.maxRedirects, 5);
	assert.equal(normalized.cookieMode, "replace");
	assert.deepEqual(normalized.variables, { token: "123" });
	assert.equal(normalized.variableScope, "step");
	assert.deepEqual(applyReplayVariables({ url: "https://{{host}}/a", nested: ["{{id}}"] }, { host: "example.test", id: "42" }), { url: "https://example.test/a", nested: ["42"] });
	const headers: Record<string, string> = { Cookie: "XSRF-TOKEN=abc; sid=1" };
	assert.deepEqual(reflectCsrfIntoHeaders(headers, { bindBrowserSession: true }), { cookie: "XSRF-TOKEN", header: "X-XSRF-TOKEN" });
	assert.equal(headers["X-XSRF-TOKEN"], "abc");
	assert.equal(cookieHeaderFromSetCookie(["sid=2; Path=/", "bad", "theme=dark; HttpOnly"]), "sid=2; theme=dark");
	const final = { headers: { "x-next": "abc", "set-cookie": "sid=3" }, bodyText: JSON.stringify({ csrf: "tok" }), setCookie: ["sid=3; Path=/"], url: "https://example.test", status: 200, statusText: "OK", ok: true, bodyBytes: 14, bodyTruncated: false, elapsedMs: 1 };
	assert.deepEqual(extractReplayVariables([{ name: "next", type: "header", header: "x-next" }, { name: "csrf", type: "json", jsonPath: "$.csrf" }], final), { next: "abc", csrf: "tok" });
	const cookieProvider = async () => undefined;
	const inputOptions = replayInputOptions({ url: "https://step.test", timeoutMs: 30 }, { timeoutMs: 10, maxBodyBytes: 20, cookieProvider });
	assert.equal(inputOptions.cookieProvider, cookieProvider);
	assert.deepEqual({ ...inputOptions, cookieProvider: undefined }, { url: "https://step.test", timeoutMs: 30, maxBodyBytes: 20, cookieProvider: undefined, rawRequest: undefined, request: undefined, body: undefined, bodyBase64: undefined, multipart: undefined, requests: undefined, sequence: undefined, har: undefined, harPath: undefined, defaultScheme: undefined, baseUrl: undefined });
	assert.deepEqual(await replaySequenceInputs({ requests: ["GET / HTTP/1.1\nHost: example.test"] }), [{ input: "GET / HTTP/1.1\nHost: example.test", source: "sequence", label: "step-1" }]);
});

test("rails cookie token helpers verify signed tokens and expose binary/encrypted fallback metadata", async () => {
	const helpers = railsTokenHelpers();
	const payloadPart = Buffer.from(JSON.stringify({ user_id: 7 }), "utf8").toString("base64");
	const signature = createHmac("sha1", "secret").update(payloadPart, "utf8").digest("hex");
	const signed = await helpers.verifyRailsSignedToken(`${payloadPart}--${signature}`, ["wrong", "secret"]);
	assert.equal(signed?.matches.length, 1);
	assert.deepEqual(signed?.decoded.json, { user_id: 7 });
	const mutated = await helpers.signRailsSignedToken({ user_id: 8 }, "secret", signed?.matches[0] ?? {}, "base64", false);
	assert.match(mutated ?? "", /--[a-f0-9]+$/);
	assert.equal((await helpers.verifyRailsSignedToken(mutated ?? "", ["secret"]))?.matches.length, 1);
	const analyzed = await analyzeCookieSample({ source: "cookie", name: "session", value: `${payloadPart}--${signature}` }, ["secret"], { user_id: 9 });
	assert.equal(analyzed.kind, "rails");
	assert.equal(tokenFormatOf(analyzed), "rails");
	assert.equal(tokenVerifiedOf(analyzed), true);
	assert.ok(tokenMutationToken(analyzed));
	const unverified = await analyzeCookieSample({ source: "cookie", name: "session", value: `${payloadPart}--${signature}` }, ["wrong"], { user_id: 9 });
	assert.equal(tokenVerifiedOf(unverified), false);
	assert.equal(tokenMutationToken(unverified), undefined);
	assert.match(String(((unverified.token as Record<string, unknown>).mutation as Record<string, unknown>).error), /no matching secret/);
	assert.equal(await helpers.verifyRailsEncryptedToken("not--a--token", ["secret"]), undefined);
	assert.equal(await helpers.verifyRailsLegacyCbcPayload("not--a", signed?.matches ?? [], 1), undefined);
});

test("rails cookie token helpers preserve GCM and legacy CBC round trips", async () => {
	const helpers = railsTokenHelpers();
	const secret = "r".repeat(32);
	assert.equal(Buffer.byteLength(secret), 32);

	const encrypted = await helpers.verifyRailsEncryptedToken(railsGcmToken({ user_id: 7 }, secret), ["wrong", secret]);
	assert.deepEqual(encrypted?.decrypted?.payload, { user_id: 7 });
	assert.equal(encrypted?.matches.length, 1);
	const mutatedGcm = await helpers.encryptRailsToken({ user_id: 8 }, secret, encrypted?.matches[0] ?? {}, encrypted!);
	assert.deepEqual((await helpers.verifyRailsEncryptedToken(mutatedGcm ?? "", [secret]))?.decrypted?.payload, { user_id: 8 });

	const signed = await helpers.verifyRailsSignedToken(railsLegacyCbcToken({ user_id: 9 }, secret), [secret]);
	const legacy = await helpers.verifyRailsLegacyCbcPayload(signed?.payloadPart ?? "", signed?.matches ?? [], signed?.testedSecretCandidateCount ?? 0);
	assert.deepEqual(legacy?.decrypted?.payload, { user_id: 9 });
	const mutatedCbc = await helpers.encryptRailsLegacyCbcToken({ user_id: 10 }, secret, legacy?.matches[0] ?? {}, legacy!);
	const mutatedSigned = await helpers.verifyRailsSignedToken(mutatedCbc ?? "", [secret]);
	const mutatedLegacy = await helpers.verifyRailsLegacyCbcPayload(mutatedSigned?.payloadPart ?? "", mutatedSigned?.matches ?? [], mutatedSigned?.testedSecretCandidateCount ?? 0);
	assert.deepEqual(mutatedLegacy?.decrypted?.payload, { user_id: 10 });
});

test("mature bridge and scanner bridges use local stub launchers only", async () => {
	const stub = path.join(process.cwd(), "tests", "web-security", "scannerStub.cjs");
	const originalSqlmap = process.env.BROWSER_PILOT_SQLMAP_PATH;
	const originalSqlmapArgs = process.env.BROWSER_PILOT_SQLMAP_ARGS;
	const originalNuclei = process.env.BROWSER_PILOT_NUCLEI_PATH;
	const originalNucleiArgs = process.env.BROWSER_PILOT_NUCLEI_ARGS;
	const originalScanner = process.env.BP_STUB_SCANNER;
	const originalVersion = process.env.BP_STUB_VERSION;
	const originalMode = process.env.BP_STUB_MODE;
	try {
		process.env.BP_STUB_VERSION = "sqlmap stub";
		const sqlmapLauncher = detectMatureBridgeLauncher({ bridgeName: "sqlmap", explicitPath: process.execPath, explicitArgs: [stub], envPathVar: "BP_UNUSED_SQLMAP", envArgsVar: "BP_UNUSED_SQLMAP_ARGS", autoCandidates: [], versionArgs: ["--version"], successPattern: /sqlmap/, allowLauncherOverride: true });
		assert.deepEqual(sqlmapLauncher, { command: process.execPath, preArgs: [stub], source: "param" });
		assert.throws(() => detectMatureBridgeLauncher({ bridgeName: "sqlmap", explicitPath: process.execPath, explicitArgs: [stub], envPathVar: "BP_UNUSED_SQLMAP", envArgsVar: "BP_UNUSED_SQLMAP_ARGS", autoCandidates: [], versionArgs: ["--version"], successPattern: /sqlmap/ }), /explicit launcher overrides require/);
		assert.throws(() => detectMatureBridgeLauncher({ bridgeName: "sqlmap", explicitPath: path.join(os.tmpdir(), "missing-sqlmap-binary"), envPathVar: "BP_UNUSED_SQLMAP", envArgsVar: "BP_UNUSED_SQLMAP_ARGS", autoCandidates: [], versionArgs: ["--version"], successPattern: /sqlmap/, allowLauncherOverride: true }), /launcher was not found/);
		assert.throws(() => assertMatureBridgeProcessResult("sqlmap", sqlmapLauncher, [], { pid: 1, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: null, signal: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) }, 10), /not found/);
		const failure = matureBridgeFailureRecord(matureBridgeToolError("MATURE_BRIDGE_LAUNCH_FAILED", "failed", { Authorization: "Bearer secret", nested: { cookie: "sid=1" } }));
		assert.equal(failure.code, "MATURE_BRIDGE_LAUNCH_FAILED");
		assert.equal(((failure.details as Record<string, unknown>).nested as Record<string, unknown>).cookie, "[redacted]");
		process.env.BROWSER_PILOT_SQLMAP_PATH = process.execPath;
		process.env.BROWSER_PILOT_SQLMAP_ARGS = "tests/web-security/scannerStub.cjs";
		process.env.BP_STUB_SCANNER = "sqlmap";
		process.env.BP_STUB_VERSION = "sqlmap stub";
		const cwd = await mkdtemp(path.join(os.tmpdir(), "bp-sqlmap-"));
		const sqlmap = await runSqlmapBridge({ rawRequest: "GET /search?q=1 HTTP/1.1\nHost: example.test\nCookie: sid=secret\n\n", allowLauncherOverride: true, cwd, paramNames: "q", currentUser: true });
		assert.deepEqual(sqlmap.failures, []);
		assert.equal(sqlmap.ok, true);
		assert.equal(sqlmap.findingCount, 1);
		assert.equal(sqlmap.currentUsers[0], "stub");
		const requestFile = ((sqlmap.runs[0] as Record<string, unknown>).requestFile as string);
		assert.match(await readFile(requestFile, "utf8"), /Cookie: sid=secret/);
		process.env.BROWSER_PILOT_NUCLEI_PATH = process.execPath;
		process.env.BROWSER_PILOT_NUCLEI_ARGS = "tests/web-security/scannerStub.cjs";
		process.env.BP_STUB_SCANNER = "nuclei";
		process.env.BP_STUB_VERSION = "nuclei stub";
		const nucleiCwd = await mkdtemp(path.join(os.tmpdir(), "bp-nuclei-"));
		const nuclei = await runNucleiBridge({ url: "https://example.test/debug", templateIds: "exposure/test", allowLauncherOverride: true, cwd: nucleiCwd, concurrency: 2, bulkSize: 1, retries: 0, rateLimitPerSecond: 0 });
		assert.equal(nuclei.ok, true);
		assert.equal(nuclei.matchCount, 1);
		assert.equal(nuclei.parseErrorCount, 1);
		assert.equal(nuclei.matchedSeverities[0], "high");
		assert.match(String((nuclei.matches[0] as Record<string, unknown>).curlPreview), /\[redacted\]/);
	} finally {
		if (originalSqlmap === undefined) delete process.env.BROWSER_PILOT_SQLMAP_PATH;
		else process.env.BROWSER_PILOT_SQLMAP_PATH = originalSqlmap;
		if (originalSqlmapArgs === undefined) delete process.env.BROWSER_PILOT_SQLMAP_ARGS;
		else process.env.BROWSER_PILOT_SQLMAP_ARGS = originalSqlmapArgs;
		if (originalNuclei === undefined) delete process.env.BROWSER_PILOT_NUCLEI_PATH;
		else process.env.BROWSER_PILOT_NUCLEI_PATH = originalNuclei;
		if (originalNucleiArgs === undefined) delete process.env.BROWSER_PILOT_NUCLEI_ARGS;
		else process.env.BROWSER_PILOT_NUCLEI_ARGS = originalNucleiArgs;
		if (originalScanner === undefined) delete process.env.BP_STUB_SCANNER;
		else process.env.BP_STUB_SCANNER = originalScanner;
		if (originalVersion === undefined) delete process.env.BP_STUB_VERSION;
		else process.env.BP_STUB_VERSION = originalVersion;
		if (originalMode === undefined) delete process.env.BP_STUB_MODE;
		else process.env.BP_STUB_MODE = originalMode;
	}
});

test("scanner bridge command contract preserves argv boundaries for injection-like input", async () => {
	const originalSqlmap = process.env.BROWSER_PILOT_SQLMAP_PATH;
	const originalSqlmapArgs = process.env.BROWSER_PILOT_SQLMAP_ARGS;
	const originalNuclei = process.env.BROWSER_PILOT_NUCLEI_PATH;
	const originalNucleiArgs = process.env.BROWSER_PILOT_NUCLEI_ARGS;
	const originalVersion = process.env.BP_STUB_VERSION;
	const originalMode = process.env.BP_STUB_MODE;
	try {
		process.env.BROWSER_PILOT_SQLMAP_PATH = process.execPath;
		process.env.BROWSER_PILOT_SQLMAP_ARGS = "tests/web-security/scannerStub.cjs";
		process.env.BROWSER_PILOT_NUCLEI_PATH = process.execPath;
		process.env.BROWSER_PILOT_NUCLEI_ARGS = "tests/web-security/scannerStub.cjs";
		process.env.BP_STUB_VERSION = "sqlmap stub nuclei stub";
		process.env.BP_STUB_MODE = "echo-argv";
		const cwd = await mkdtemp(path.join(os.tmpdir(), "bp-scanner-argv-"));
		const sqlmap = await runSqlmapBridge({ url: "https://example.test/search?q=1;echo pwned&token=raw-query-token", headers: { Authorization: "Bearer raw-auth-secret", Cookie: "sid=raw-cookie-secret" }, paramNames: "q\n--os-shell,'quoted;value'", tamper: "space2comment,between\nrandomcase", extraArgs: ["--safe-url=https://example.test/a;b", "--eval=print('x;y')"], allowLauncherOverride: true, cwd, retries: 0, timeoutSeconds: 1 });
		assert.equal(sqlmap.ok, true);
		const sqlmapArgv = JSON.parse(String((sqlmap.runs[0] as Record<string, unknown>).stdoutPreview)) as { argv: string[] };
		assert.equal(sqlmapArgv.argv.includes("pwned"), false);
		assert.equal(sqlmapArgv.argv.includes("--os-shell"), false);
		assert.equal(sqlmapArgv.argv[sqlmapArgv.argv.indexOf("-p") + 1], "q,--os-shell,'quoted;value'");
		assert.equal(sqlmapArgv.argv[sqlmapArgv.argv.indexOf("--tamper") + 1], "space2comment,between,randomcase");
		assert.equal(sqlmapArgv.argv.includes("--safe-url=https://example.test/a;b"), true);
		assert.equal(sqlmapArgv.argv.includes("--eval=print('x;y')"), true);
		const nuclei = await runNucleiBridge({ url: "https://example.test/debug?token=raw-query-token;echo pwned", headers: { "X-Api-Key": "raw-api-key", Cookie: "sid=raw-cookie-secret" }, templateIds: "exposure/test,--danger\n'quoted;id'", tags: "debug\n--system", extraArgs: ["-H", "Authorization: Bearer raw-auth-secret"], allowLauncherOverride: true, cwd, retries: 0, rateLimitPerSecond: 0 });
		assert.equal(nuclei.ok, true);
		const nucleiArgv = JSON.parse(String((nuclei.runs[0] as Record<string, unknown>).stdoutPreview)) as { argv: string[] };
		assert.equal(nucleiArgv.argv.includes("pwned"), false);
		assert.equal(nucleiArgv.argv[nucleiArgv.argv.indexOf("-id") + 1], "exposure/test,--danger,'quoted;id'");
		assert.equal(nucleiArgv.argv[nucleiArgv.argv.indexOf("-tags") + 1], "debug,--system");
		assert.equal(nucleiArgv.argv[nucleiArgv.argv.indexOf("-H") + 1], "Authorization: [redacted]");
	} finally {
		if (originalSqlmap === undefined) delete process.env.BROWSER_PILOT_SQLMAP_PATH;
		else process.env.BROWSER_PILOT_SQLMAP_PATH = originalSqlmap;
		if (originalSqlmapArgs === undefined) delete process.env.BROWSER_PILOT_SQLMAP_ARGS;
		else process.env.BROWSER_PILOT_SQLMAP_ARGS = originalSqlmapArgs;
		if (originalNuclei === undefined) delete process.env.BROWSER_PILOT_NUCLEI_PATH;
		else process.env.BROWSER_PILOT_NUCLEI_PATH = originalNuclei;
		if (originalNucleiArgs === undefined) delete process.env.BROWSER_PILOT_NUCLEI_ARGS;
		else process.env.BROWSER_PILOT_NUCLEI_ARGS = originalNucleiArgs;
		if (originalVersion === undefined) delete process.env.BP_STUB_VERSION;
		else process.env.BP_STUB_VERSION = originalVersion;
		if (originalMode === undefined) delete process.env.BP_STUB_MODE;
		else process.env.BP_STUB_MODE = originalMode;
	}
});

test("scanner bridge failure and malformed output contract redacts diagnostics", async () => {
	const originalSqlmap = process.env.BROWSER_PILOT_SQLMAP_PATH;
	const originalSqlmapArgs = process.env.BROWSER_PILOT_SQLMAP_ARGS;
	const originalNuclei = process.env.BROWSER_PILOT_NUCLEI_PATH;
	const originalNucleiArgs = process.env.BROWSER_PILOT_NUCLEI_ARGS;
	const originalVersion = process.env.BP_STUB_VERSION;
	const originalMode = process.env.BP_STUB_MODE;
	const secrets = ["stdout-secret-token", "stderr-secret-token", "malformed-secret-token", "raw-query-token", "raw-auth-secret", "raw-cookie-secret"];
	try {
		process.env.BROWSER_PILOT_SQLMAP_PATH = process.execPath;
		process.env.BROWSER_PILOT_SQLMAP_ARGS = "tests/web-security/scannerStub.cjs";
		process.env.BROWSER_PILOT_NUCLEI_PATH = process.execPath;
		process.env.BROWSER_PILOT_NUCLEI_ARGS = "tests/web-security/scannerStub.cjs";
		process.env.BP_STUB_VERSION = "sqlmap stub nuclei stub";
		process.env.BP_STUB_MODE = "fail-secret";
		const cwd = await mkdtemp(path.join(os.tmpdir(), "bp-scanner-failure-"));
		const sqlmap = await runSqlmapBridge({ url: "https://example.test/search?token=raw-query-token", headers: { Authorization: "Bearer raw-auth-secret", Cookie: "sid=raw-cookie-secret" }, paramNames: "token", allowLauncherOverride: true, cwd, retries: 0, timeoutSeconds: 1 });
		assert.equal(sqlmap.ok, false);
		assert.deepEqual(sqlmap.failures, []);
		const sqlmapRun = sqlmap.runs[0] as Record<string, unknown>;
		assert.equal(sqlmapRun.exitCode, 2);
		assert.match(String(sqlmapRun.stdoutPreview), /Authorization: \[redacted\]/);
		assert.match(String(sqlmapRun.stderrPreview), /Cookie: \[redacted\]/);
		assert.equal(String(sqlmapRun.stdoutPreview).length <= 1001, true);
		assertSerializedOmits(summarizeSqlmapBridgeData(sqlmap), secrets);
		process.env.BP_STUB_MODE = "nuclei-malformed";
		const nuclei = await runNucleiBridge({ url: "https://example.test/debug?token=raw-query-token", headers: { Authorization: "Bearer raw-auth-secret", Cookie: "sid=raw-cookie-secret" }, templateIds: "exposure/test", allowLauncherOverride: true, cwd, retries: 0, rateLimitPerSecond: 0 });
		assert.equal(nuclei.ok, true);
		assert.equal(nuclei.matchCount, 0);
		assert.equal(nuclei.parseErrorCount, 1);
		const nucleiRun = nuclei.runs[0] as Record<string, unknown>;
		assert.match(String(nucleiRun.stderrPreview), /Set-Cookie: \[redacted\]/);
		assertSerializedOmits(summarizeNucleiBridgeData(nuclei), secrets);
	} finally {
		if (originalSqlmap === undefined) delete process.env.BROWSER_PILOT_SQLMAP_PATH;
		else process.env.BROWSER_PILOT_SQLMAP_PATH = originalSqlmap;
		if (originalSqlmapArgs === undefined) delete process.env.BROWSER_PILOT_SQLMAP_ARGS;
		else process.env.BROWSER_PILOT_SQLMAP_ARGS = originalSqlmapArgs;
		if (originalNuclei === undefined) delete process.env.BROWSER_PILOT_NUCLEI_PATH;
		else process.env.BROWSER_PILOT_NUCLEI_PATH = originalNuclei;
		if (originalNucleiArgs === undefined) delete process.env.BROWSER_PILOT_NUCLEI_ARGS;
		else process.env.BROWSER_PILOT_NUCLEI_ARGS = originalNucleiArgs;
		if (originalVersion === undefined) delete process.env.BP_STUB_VERSION;
		else process.env.BP_STUB_VERSION = originalVersion;
		if (originalMode === undefined) delete process.env.BP_STUB_MODE;
		else process.env.BP_STUB_MODE = originalMode;
	}
});
