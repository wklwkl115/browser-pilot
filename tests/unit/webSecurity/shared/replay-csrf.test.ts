import test from "node:test";
import assert from "node:assert/strict";
import { reflectCsrfIntoHeaders } from "../../../../src/tools/webSecurity/shared/replay.ts";

// C1: http_replay double-submit CSRF reflection wiring (default-on under
// bindBrowserSession, overridable, never overrides a caller-supplied header).

test("replay-csrf reflects XSRF-TOKEN into X-XSRF-TOKEN by default when bound", () => {
	const headers: Record<string, string> = { Cookie: "XSRF-TOKEN=ab%2Fcd; sid=secret" };
	const reflected = reflectCsrfIntoHeaders(headers, { bindBrowserSession: true, reflectCsrf: true });
	assert.deepEqual(reflected, { cookie: "XSRF-TOKEN", header: "X-XSRF-TOKEN" });
	assert.equal(headers["X-XSRF-TOKEN"], "ab/cd", "decoded token value is injected as the header value");
});

test("replay-csrf is off when the browser session is not bound", () => {
	const headers: Record<string, string> = { Cookie: "XSRF-TOKEN=tok" };
	assert.equal(reflectCsrfIntoHeaders(headers, { bindBrowserSession: false, reflectCsrf: true }), undefined);
	assert.equal(headers["X-XSRF-TOKEN"], undefined, "no header added when unbound");
});

test("replay-csrf can be disabled with reflectCsrf=false (e.g. to test CSRF protection)", () => {
	const headers: Record<string, string> = { Cookie: "XSRF-TOKEN=tok" };
	assert.equal(reflectCsrfIntoHeaders(headers, { bindBrowserSession: true, reflectCsrf: false }), undefined);
	assert.equal(headers["X-XSRF-TOKEN"], undefined, "opt-out suppresses reflection");
});

test("replay-csrf never overrides a CSRF header the caller already supplied", () => {
	const headers: Record<string, string> = { Cookie: "XSRF-TOKEN=fromcookie", "x-xsrf-token": "caller" };
	assert.equal(reflectCsrfIntoHeaders(headers, { bindBrowserSession: true }), undefined, "caller header wins");
	assert.equal(headers["x-xsrf-token"], "caller", "existing header value is preserved");
});

test("replay-csrf honors csrfCookie/csrfHeader overrides", () => {
	const headers: Record<string, string> = { Cookie: "token=abc; sid=x" };
	const reflected = reflectCsrfIntoHeaders(headers, { bindBrowserSession: true, csrfCookie: "token", csrfHeader: "X-Token" });
	assert.deepEqual(reflected, { cookie: "token", header: "X-Token" });
	assert.equal(headers["X-Token"], "abc");
});

test("replay-csrf is a no-op when no csrf-looking cookie is bound", () => {
	const headers: Record<string, string> = { Cookie: "sid=x; theme=dark" };
	assert.equal(reflectCsrfIntoHeaders(headers, { bindBrowserSession: true }), undefined);
});
