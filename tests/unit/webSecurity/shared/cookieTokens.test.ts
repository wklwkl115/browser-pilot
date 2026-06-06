import test from "node:test";
import assert from "node:assert/strict";
import {
	analyzeCookieSample,
	tokenCountOf,
	tokenVerifiedOf,
	tokenMutationToken,
	tokenPayloadOf,
	tokenFormatOf,
} from "../../../../src/tools/webSecurity/shared/cookieTokens.ts";

// ── JWT analysis ──────────────────────────────────────────────────────────────

// HS256 JWT signed with secret "test-secret"
// header: {"alg":"HS256","typ":"JWT"}
// payload: {"sub":"1234567890","name":"Test User","iat":1516239022}
const HS256_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlRlc3QgVXNlciIsImlhdCI6MTUxNjIzOTAyMn0.d7wvJgt3ToQbZth4JlHZFnPex-NFlO9HrtpL3gG7MYU";
const JWT_SECRET = "test-secret";

test("analyzeCookieSample identifies JWT format", async () => {
	const result = await analyzeCookieSample({ source: "cookie", name: "token", value: HS256_JWT }, [], null);
	assert.equal(result.kind, "jwt");
	assert.ok(result.jwt !== undefined);
});

test("analyzeCookieSample verifies HS256 JWT with correct secret", async () => {
	const result = await analyzeCookieSample({ source: "cookie", name: "token", value: HS256_JWT }, [JWT_SECRET], null);
	assert.equal(result.kind, "jwt");
	const token = result.token as Record<string, unknown>;
	const signature = token.signature as Record<string, unknown>;
	assert.equal(signature.verified, true);
});

test("analyzeCookieSample does not verify HS256 JWT with wrong secret", async () => {
	const result = await analyzeCookieSample({ source: "cookie", name: "token", value: HS256_JWT }, ["wrong-secret"], null);
	const token = result.token as Record<string, unknown>;
	const signature = token.signature as Record<string, unknown>;
	assert.equal(signature.verified, false);
});

test("analyzeCookieSample extracts JWT payload claims", async () => {
	const result = await analyzeCookieSample({ source: "cookie", name: "auth", value: HS256_JWT }, [], null);
	const payload = tokenPayloadOf(result as Record<string, unknown>);
	assert.ok(payload !== undefined);
	assert.equal(payload!.sub, "1234567890");
	assert.equal(payload!.name, "Test User");
});

test("analyzeCookieSample produces mutation token for JWT with verified secret", async () => {
	const result = await analyzeCookieSample({ source: "cookie", name: "token", value: HS256_JWT }, [JWT_SECRET], { name: "Admin" });
	const mutation = tokenMutationToken(result as Record<string, unknown>);
	assert.ok(mutation !== undefined && typeof mutation === "string", "expected mutation token");
	assert.ok(mutation !== HS256_JWT, "mutated token should differ from original");
});

// ── none-alg JWT (unsigned) ───────────────────────────────────────────────────

// JWT with alg:"none" (no signature)
const NONE_JWT = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ0ZXN0In0.";

test("analyzeCookieSample identifies alg:none JWT as verified (no signature)", async () => {
	const result = await analyzeCookieSample({ source: "cookie", value: NONE_JWT }, [], null);
	assert.equal(result.kind, "jwt");
	const token = result.token as Record<string, unknown>;
	const signature = token.signature as Record<string, unknown>;
	assert.equal(signature.verified, true);
});

// ── opaque cookie (not a recognized token) ────────────────────────────────────

test("analyzeCookieSample marks unrecognized cookie as opaque", async () => {
	const result = await analyzeCookieSample({ source: "cookie", name: "session", value: "random-opaque-session-123" }, [], null);
	assert.ok(result.kind === "opaque" || result.kind === "encoded-json", `got kind: ${result.kind}`);
});

// ── utility functions ─────────────────────────────────────────────────────────

test("tokenCountOf returns 1 when result has a token", async () => {
	const result = await analyzeCookieSample({ source: "cookie", value: HS256_JWT }, [], null);
	assert.equal(tokenCountOf(result as Record<string, unknown>), 1);
});

test("tokenCountOf returns 0 when no token in result", () => {
	assert.equal(tokenCountOf({ kind: "opaque", decodings: [] }), 0);
});

test("tokenVerifiedOf returns true for verified JWT", async () => {
	const result = await analyzeCookieSample({ source: "cookie", value: HS256_JWT }, [JWT_SECRET], null);
	assert.equal(tokenVerifiedOf(result as Record<string, unknown>), true);
});

test("tokenVerifiedOf returns false for unverified JWT", async () => {
	const result = await analyzeCookieSample({ source: "cookie", value: HS256_JWT }, [], null);
	assert.equal(tokenVerifiedOf(result as Record<string, unknown>), false);
});

test("tokenFormatOf returns jwt for JWT cookies", async () => {
	const result = await analyzeCookieSample({ source: "cookie", value: HS256_JWT }, [], null);
	assert.equal(tokenFormatOf(result as Record<string, unknown>), "jwt");
});

test("tokenFormatOf returns undefined for opaque cookies", () => {
	const result = { kind: "opaque", decodings: [] };
	assert.equal(tokenFormatOf(result), undefined);
});

// ── result metadata ───────────────────────────────────────────────────────────

test("analyzeCookieSample includes source, name, valueSha256 in result", async () => {
	const result = await analyzeCookieSample({ source: "header", name: "Authorization", value: HS256_JWT }, [], null);
	assert.equal(result.source, "header");
	assert.equal(result.name, "Authorization");
	assert.ok(typeof result.valueSha256 === "string" && result.valueSha256.length === 64);
});
