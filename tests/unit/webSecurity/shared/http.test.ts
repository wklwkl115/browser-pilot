import test from "node:test";
import assert from "node:assert/strict";
import { mergeCookieHeaders, parseCookieHeader, sanitizeFetchHeaders } from "../../../../src/tools/webSecurity/shared/http.ts";

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
