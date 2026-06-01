import test from "node:test";
import assert from "node:assert/strict";
import { validateMemoryRecordPayloadShape } from "../../../src/tools/memory/evidence.ts";
import type { MemoryRecordPayload } from "../../../src/tools/memory/types.ts";

function payload(over: Partial<MemoryRecordPayload> = {}): MemoryRecordPayload {
	return { kind: "sop", url: "https://www.site.com/x", title: "t", triggers: ["t1"], body: "1. step\n", evidenceRefs: [], ...over };
}

function codeOf(fn: () => unknown): string | null {
	try { fn(); return null; } catch (err) { return (err as { code?: string })?.code ?? "THROW"; }
}

test("valid origin payload normalizes scopeKey from url", () => {
	const result = validateMemoryRecordPayloadShape(payload());
	assert.equal(result.scopeKey, "site.com");
	assert.equal(result.scopeKind, "origin");
	assert.equal(result.confidence, "verified");
});

test("scope is required for non-origin scopes without a scopeKey", () => {
	assert.equal(codeOf(() => validateMemoryRecordPayloadShape(payload({ scopeKind: "task", url: undefined }))), "MEMORY_SCOPE_REQUIRED");
});

test("title, triggers and body are required", () => {
	assert.equal(codeOf(() => validateMemoryRecordPayloadShape(payload({ title: "  " }))), "MEMORY_SCHEMA_INVALID");
	assert.equal(codeOf(() => validateMemoryRecordPayloadShape(payload({ triggers: [] }))), "MEMORY_SCHEMA_INVALID");
	assert.equal(codeOf(() => validateMemoryRecordPayloadShape(payload({ triggers: ["  "] }))), "MEMORY_SCHEMA_INVALID");
	assert.equal(codeOf(() => validateMemoryRecordPayloadShape(payload({ body: "   " }))), "MEMORY_SCHEMA_INVALID");
});

test("body size caps are enforced", () => {
	assert.equal(codeOf(() => validateMemoryRecordPayloadShape(payload({ body: "x\n".repeat(121) }))), "MEMORY_SCHEMA_INVALID");
	assert.equal(codeOf(() => validateMemoryRecordPayloadShape(payload({ body: "x".repeat(16 * 1024 + 1) }))), "MEMORY_SCHEMA_INVALID");
	// facts get a higher line cap than SOPs.
	assert.equal(codeOf(() => validateMemoryRecordPayloadShape(payload({ kind: "fact", body: "x\n".repeat(121) }))), null);
});

test("secret-like content is rejected", () => {
	assert.equal(codeOf(() => validateMemoryRecordPayloadShape(payload({ body: "1. send Authorization: Bearer abc123def456ghi\n" }))), "MEMORY_SECRET_DETECTED");
});

test("anti-bot evasion know-how is blocked", () => {
	assert.equal(codeOf(() => validateMemoryRecordPayloadShape(payload({ body: "1. bypass the captcha automatically\n" }))), "MEMORY_SECRET_DETECTED");
	assert.equal(codeOf(() => validateMemoryRecordPayloadShape(payload({ body: "1. the captcha can be solved with the 2captcha solver\n" }))), "MEMORY_SECRET_DETECTED");
	assert.equal(codeOf(() => validateMemoryRecordPayloadShape(payload({ body: "1. enable stealth mode\n" }))), "MEMORY_SECRET_DETECTED");
	// evasion intent in the title is caught too, not only the body.
	assert.equal(codeOf(() => validateMemoryRecordPayloadShape(payload({ title: "how to bypass a captcha" }))), "MEMORY_SECRET_DETECTED");
});

test("defensive captcha guidance is allowed (no evasion verb)", () => {
	// A human solving the captcha is defensive; only auto-solve/solver/bypass is blocked.
	assert.equal(codeOf(() => validateMemoryRecordPayloadShape(payload({ body: "1. if a captcha appears, stop and ask the user to solve it\n" }))), null);
});
