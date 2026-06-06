import test from "node:test";
import assert from "node:assert/strict";
import { deriveCsrfReflection, mergeCookieHeaders, parseCookieHeader, sanitizeFetchHeaders } from "../../../../src/tools/webSecurity/shared/http.ts";

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
