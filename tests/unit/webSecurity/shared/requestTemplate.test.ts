import test from "node:test";
import assert from "node:assert/strict";
import { parseRawHttpRequest } from "../../../../src/tools/webSecurity/shared/requestTemplate.ts";

test("webSecurity/shared/requestTemplate merges repeated cookie headers instead of overwriting", () => {
	const parsed = parseRawHttpRequest(
		"GET /test HTTP/1.1\r\nHost: example.test\r\nCookie: a=1\r\nCookie: b=2\r\n\r\n",
		{ defaultScheme: "https" },
	);
	assert.equal(parsed.url, "https://example.test/test");
	assert.equal(parsed.headers.Cookie, "a=1; b=2");
});

test("webSecurity/shared/requestTemplate keeps folded header continuations", () => {
	const parsed = parseRawHttpRequest(
		"POST /submit HTTP/1.1\r\nHost: example.test\r\nX-Test: alpha\r\n beta\r\n\r\nbody",
		{ defaultScheme: "https" },
	);
	assert.equal(parsed.headers["X-Test"], "alpha beta");
	assert.equal(parsed.body, "body");
});
