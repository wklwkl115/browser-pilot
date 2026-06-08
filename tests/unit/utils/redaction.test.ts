import test from "node:test";
import assert from "node:assert/strict";
import { redactSensitiveText, redactSensitiveValue, redactSensitiveValueWithPointers, containsSensitiveEvidence } from "../../../src/utils/redaction.ts";

// ── redactSensitiveText ──────────────────────────────────────────────────────

test("redactSensitiveText redacts Bearer token", () => {
	const result = redactSensitiveText("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig");
	assert.ok(result.includes("[redacted]"), `expected redaction, got: ${result}`);
	assert.ok(!result.includes("eyJhbGci"), `token value should be gone, got: ${result}`);
});

test("redactSensitiveText redacts Basic auth", () => {
	const result = redactSensitiveText("Authorization: Basic dXNlcjpwYXNz");
	assert.ok(result.includes("[redacted]"));
	assert.ok(!result.includes("dXNlcjpwYXNz"));
});

test("redactSensitiveText redacts cookie header", () => {
	const result = redactSensitiveText("cookie: session=abc123; token=xyz");
	assert.ok(result.includes("[redacted]"));
});

test("redactSensitiveText redacts sensitive header fragments on mixed lines", () => {
	const result = redactSensitiveText("Cookie: sid=abc Authorization: Bearer secret");
	assert.equal(result.includes("sid=abc"), false);
	assert.equal(result.includes("Bearer secret"), false);
	assert.ok(result.includes("Cookie: [redacted]"));
});

test("redactSensitiveText redacts PEM private key block", () => {
	const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";
	const result = redactSensitiveText(pem);
	assert.ok(result.includes("[redacted private key]"));
});

test("redactSensitiveText leaves safe text unchanged", () => {
	const safe = "GET /api/v1/users HTTP/1.1\nContent-Type: application/json";
	assert.equal(redactSensitiveText(safe), safe);
});

test("redactSensitiveText redacts email in query param", () => {
	const result = redactSensitiveText("https://example.com/search?q=user@example.com");
	assert.ok(result.includes("[redacted]"));
	assert.ok(!result.includes("user@example.com"));
});

test("redactSensitiveText does not redact multi-word free-text query", () => {
	const input = "https://example.com/search?q=hello+world";
	const result = redactSensitiveText(input);
	assert.ok(result.includes("[redacted]"), `free-text multi-word should be redacted: ${result}`);
});

// ── redactSensitiveValue ─────────────────────────────────────────────────────

test("redactSensitiveValue redacts object with password field", () => {
	const result = redactSensitiveValue({ password: "secret123", username: "alice" }) as Record<string, unknown>;
	assert.equal(result.password, "[redacted]");
	assert.equal(result.username, "alice");
});

test("redactSensitiveValue redacts authorization field", () => {
	const result = redactSensitiveValue({ authorization: "Bearer tok", other: "ok" }) as Record<string, unknown>;
	assert.equal(result.authorization, "[redacted]");
	assert.equal(result.other, "ok");
});

test("redactSensitiveValue redacts cookie field", () => {
	const result = redactSensitiveValue({ cookie: "session=abc", x: 1 }) as Record<string, unknown>;
	assert.equal(result.cookie, "[redacted]");
});

test("redactSensitiveValue handles arrays", () => {
	const result = redactSensitiveValue([{ password: "s" }, { name: "ok" }]) as unknown[];
	assert.equal((result[0] as Record<string, unknown>).password, "[redacted]");
	assert.equal((result[1] as Record<string, unknown>).name, "ok");
});

test("redactSensitiveValue handles circular references", () => {
	const obj: Record<string, unknown> = { safe: "ok" };
	obj.self = obj;
	const result = redactSensitiveValue(obj) as Record<string, unknown>;
	assert.equal(result.self, "[Circular]");
});

test("redactSensitiveValue passes primitives through", () => {
	assert.equal(redactSensitiveValue(42), 42);
	assert.equal(redactSensitiveValue(null), null);
	assert.equal(redactSensitiveValue(undefined), undefined);
	assert.equal(redactSensitiveValue(true), true);
});

test("redactSensitiveValue redacts body field as [redacted body]", () => {
	const result = redactSensitiveValue({ body: "some body text" }) as Record<string, unknown>;
	assert.equal(result.body, "[redacted body]");
});

test("redactSensitiveValue redacts postData field as [redacted postData]", () => {
	const result = redactSensitiveValue({ postData: "a=1&b=2" }) as Record<string, unknown>;
	assert.equal(result.postData, "[redacted postData]");
});

test("redactSensitiveValueWithPointers emits readable bracket jsonPath for complex keys", () => {
	const artifactValue = { response: { headers: { "Set-Cookie": "sid=secret", "x.api.key": "secret-key" } } };
	const result = redactSensitiveValueWithPointers(artifactValue, { rawArtifactPath: "/tmp/raw.json", artifactValue }) as {
		response: { headers: Record<string, { redacted: true; raw: string; jsonPath: string }> };
	};
	assert.equal(result.response.headers["Set-Cookie"].jsonPath, "response.headers['Set-Cookie']");
	assert.equal(result.response.headers["x.api.key"].jsonPath, "response.headers['x.api.key']");
	assert.equal(result.response.headers["Set-Cookie"].raw, "/tmp/raw.json");
});

// ── containsSensitiveEvidence ────────────────────────────────────────────────

test("containsSensitiveEvidence returns true for object with password", () => {
	assert.equal(containsSensitiveEvidence({ password: "secret" }), true);
});

test("containsSensitiveEvidence returns false for safe object", () => {
	assert.equal(containsSensitiveEvidence({ url: "https://example.com", status: 200 }), false);
});

test("containsSensitiveEvidence returns true for string with Bearer token", () => {
	assert.equal(containsSensitiveEvidence("Authorization: Bearer abc.def.ghi"), true);
});

test("containsSensitiveEvidence returns false for plain text", () => {
	assert.equal(containsSensitiveEvidence("hello world"), false);
});
