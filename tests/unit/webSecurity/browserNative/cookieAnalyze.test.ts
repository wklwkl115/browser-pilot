import test from "node:test";
import assert from "node:assert/strict";
import { runCookieAnalyze } from "../../../../src/tools/webSecurity/browserNative/cookieAnalyze.ts";

test("cookie_analyze auto-collects cookies from the bound browser session", async () => {
	const result = await runCookieAnalyze({
		url: "https://target.test",
		bindBrowserSession: true,
		cookieProvider: async () => "session=abc123; csrf=def456",
	});
	assert.equal(result.ok, true);
	assert.ok(result.inputCount >= 1, "collected session cookies should produce samples");
});

test("cookie_analyze implicitly binds when given a url + provider and no explicit cookies", async () => {
	let askedUrl = "";
	const result = await runCookieAnalyze({
		url: "https://target.test",
		cookieProvider: async (url: string) => { askedUrl = url; return "session=abc"; },
	});
	assert.equal(result.ok, true);
	assert.match(askedUrl, /target\.test/);
});

test("cookie_analyze gives a specific error when the bound session yields no cookies", async () => {
	await assert.rejects(
		runCookieAnalyze({ url: "https://target.test", bindBrowserSession: true, cookieProvider: async () => "" }),
		(err: unknown) => {
			assert.match(String((err as Error).message), /found no cookies/i);
			return true;
		},
	);
});

test("cookie_analyze still requires some input when nothing is provided", async () => {
	await assert.rejects(
		runCookieAnalyze({}),
		(err: unknown) => {
			assert.match(String((err as Error).message), /requires cookie/i);
			return true;
		},
	);
});

test("cookie_analyze does not auto-bind when explicit cookies are supplied", async () => {
	let providerCalled = false;
	const result = await runCookieAnalyze({
		url: "https://target.test",
		cookie: "session=explicit",
		cookieProvider: async () => { providerCalled = true; return "session=fromsession"; },
	});
	assert.equal(result.ok, true);
	assert.equal(providerCalled, false, "explicit cookies must not trigger implicit session binding");
});
