import test from "node:test";
import assert from "node:assert/strict";
import { redactWebSecurityDiagnosticText, webSecurityToolError } from "../../../../src/tools/webSecurity/shared/diagnostics.ts";

test("redactWebSecurityDiagnosticText strips cookie and authorization values", () => {
	const text = redactWebSecurityDiagnosticText("Authorization: Bearer secret\nCookie: sid=abc\nX-Test: ok");
	assert.equal(text.includes("secret"), false);
	assert.equal(text.includes("sid=abc"), false);
	assert.equal(text.includes("X-Test: ok"), true);
});

test("webSecurityToolError wraps and redacts nested diagnostics", () => {
	const cause = new Error("Cookie: sid=abc Authorization: Bearer secret") as Error & { code?: string; details?: Record<string, unknown> };
	cause.code = "MATURE_BRIDGE_LAUNCH_FAILED";
	cause.details = {
		cookie: "sid=abc",
		nested: { authorization: "Bearer secret", safe: "ok" },
		recovery: { nextActions: ["retry with Authorization: Bearer secret", "retry token=web-token"] },
		stack: "should-be-removed",
	};
	const wrapped = webSecurityToolError(cause, { toolName: "browser_sqlmap_bridge", command: "web.sqlmap_bridge" }) as Error & { code?: string; details?: Record<string, unknown> };
	assert.equal(wrapped.code, "MATURE_BRIDGE_LAUNCH_FAILED");
	assert.equal(wrapped.message.includes("sid=abc"), false);
	assert.equal(JSON.stringify(wrapped.details).includes("sid=abc"), false);
	assert.equal(JSON.stringify(wrapped.details).includes("Bearer secret"), false);
	assert.equal(JSON.stringify(wrapped.details).includes("web-token"), false);
	assert.equal(JSON.stringify(wrapped.details).includes("token=[redacted]"), true);
	assert.equal(JSON.stringify(wrapped.details).includes("should-be-removed"), false);
	assert.equal(wrapped.details?.domain, "webSecurity");
	assert.equal(wrapped.details?.toolName, "browser_sqlmap_bridge");
	assert.equal(Object.hasOwn(wrapped, "stack"), false);
});
