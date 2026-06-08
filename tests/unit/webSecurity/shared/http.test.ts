import test from "node:test";
import assert from "node:assert/strict";
import { browserCookiesToProviderResult, cookieProviderResultHeader, deriveCsrfReflection, mergeCookieHeaders, parseCookieHeader, sanitizeFetchHeaders, tlsRemediation } from "../../../../src/tools/webSecurity/shared/http.ts";

test("webSecurity/shared/http parses cookie header pairs", () => {
	const cookies = parseCookieHeader("a=1; b=2; c=hello");
	assert.deepEqual(Array.from(cookies.entries()), [
		["a", "1"],
		["b", "2"],
		["c", "hello"],
	]);
});

test("webSecurity/shared/http merges cookie headers with right-hand override", () => {
	assert.equal(mergeCookieHeaders("a=1; b=2", "b=3; c=4"), "a=1; b=3; c=4");
});

test("webSecurity/shared/http omits forbidden fetch headers while preserving others", () => {
	const sanitized = sanitizeFetchHeaders({ Host: "example.test", Cookie: "a=1", "X-Test": "ok", "Content-Length": "10" });
	assert.deepEqual(sanitized.headers, { Cookie: "a=1", "X-Test": "ok" });
	assert.deepEqual(sanitized.omittedHeaderNames, ["Host", "Content-Length"]);
});

test("webSecurity/shared/http derives Angular XSRF-TOKEN reflection and percent-decodes the value", () => {
	const derived = deriveCsrfReflection("HWWAFSESTIME=1; XSRF-TOKEN=ab%2Fcd%3D%3D; sid=secret");
	assert.deepEqual(derived, { cookie: "XSRF-TOKEN", header: "X-XSRF-TOKEN", value: "ab/cd==" });
});

test("webSecurity/shared/http derives generic csrf cookie to X-CSRF-Token", () => {
	assert.deepEqual(deriveCsrfReflection("_csrf=tok123; sid=x"), { cookie: "_csrf", header: "X-CSRF-Token", value: "tok123" });
	assert.deepEqual(deriveCsrfReflection("csrftoken=dj; a=1"), { cookie: "csrftoken", header: "X-CSRF-Token", value: "dj" });
});

test("webSecurity/shared/http honors csrfCookie/csrfHeader overrides and returns undefined when absent", () => {
	assert.deepEqual(deriveCsrfReflection("token=abc; sid=x", { csrfCookie: "token", csrfHeader: "X-Token" }), { cookie: "token", header: "X-Token", value: "abc" });
	assert.equal(deriveCsrfReflection("sid=x; theme=dark"), undefined, "no csrf-looking cookie => no reflection");
	assert.equal(deriveCsrfReflection(""), undefined, "empty cookie header => no reflection");
});

test("webSecurity/shared/http default reflected header names stay within the redacted set", () => {
	// Guards token non-leak: the header carrying the token must be one redactHeaders strips.
	const redacted = new Set(["x-csrf-token", "x-xsrf-token"]);
	for (const header of ["X-XSRF-TOKEN", "X-CSRF-Token"]) assert.ok(redacted.has(header.toLowerCase()), `${header} must be redactable`);
});

test("webSecurity/shared/http preserves structured browser cookie metadata while exposing a Cookie header", () => {
	const providerResult = browserCookiesToProviderResult({ data: [
		{ name: "sid", value: "abc", domain: ".example.test", path: "/", secure: true, httpOnly: true, sameSite: "lax", session: false, expirationDate: 2000000000 },
	] }, "https://example.test/");
	assert.equal(cookieProviderResultHeader(providerResult), "sid=abc");
	assert.equal(Array.isArray(providerResult && typeof providerResult === "object" ? providerResult.cookies : undefined), true);
	assert.deepEqual(providerResult && typeof providerResult === "object" ? providerResult.cookies?.[0] : undefined, {
		name: "sid",
		value: "abc",
		domain: ".example.test",
		path: "/",
		secure: true,
		httpOnly: true,
		sameSite: "lax",
		session: false,
		expirationDate: 2000000000,
	});
});

test("webSecurity/shared/http maps untrusted-chain TLS codes to a NODE_EXTRA_CA_CERTS remediation", () => {
	for (const code of ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"]) {
		const remedy = tlsRemediation(code, undefined);
		assert.ok(remedy && /NODE_EXTRA_CA_CERTS/.test(remedy), `expected chain-trust remedy for ${code}`);
	}
	// Message-only fallback when no cause code is surfaced (undici sometimes omits it).
	assert.ok(/NODE_EXTRA_CA_CERTS/.test(tlsRemediation(undefined, "unable to verify the first certificate") || ""));
});

test("webSecurity/shared/http distinguishes expiry and hostname-mismatch TLS failures", () => {
	assert.match(tlsRemediation("CERT_HAS_EXPIRED", undefined) || "", /expired/i);
	assert.match(tlsRemediation("ERR_TLS_CERT_ALTNAME_INVALID", undefined) || "", /hostname mismatch/i);
});

test("webSecurity/shared/http returns no remediation for non-TLS fetch failures", () => {
	assert.equal(tlsRemediation("ECONNREFUSED", "connect ECONNREFUSED"), undefined);
	assert.equal(tlsRemediation("ENOTFOUND", "getaddrinfo ENOTFOUND example.test"), undefined);
	assert.equal(tlsRemediation(undefined, undefined), undefined);
});
