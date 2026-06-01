import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAbmlError } from "../../../src/abml/errors.ts";
import { createCodedError } from "../../../src/utils/codedError.ts";

test("abml errors map etag mismatch to HANDLE_ETAG_MISMATCH", () => {
	const error = normalizeAbmlError({ code: "HANDLE_ETAG_MISMATCH", message: "etag changed", details: { etag: "v2" } });
	assert.equal(error.code, "HANDLE_ETAG_MISMATCH");
	assert.equal(error.category, "ref");
	assert.equal(error.cause?.code, "HANDLE_ETAG_MISMATCH");
});

test("abml errors map session errors to REF_SCOPE_VIOLATION", () => {
	const error = normalizeAbmlError(createCodedError({ name: "SessionError", code: "NO_SESSION", message: "missing session", details: { tabId: 5 } }));
	assert.equal(error.code, "REF_SCOPE_VIOLATION");
	assert.equal(error.category, "session");
	assert.equal(error.cause?.code, "NO_SESSION");
});

test("abml errors map selector failures and cross-origin failures", () => {
	assert.equal(normalizeAbmlError({ code: "SELECTOR_NOT_FOUND", message: "missing" }).code, "REF_STALE");
	assert.equal(normalizeAbmlError({ code: "INVALID_SELECTOR", message: "bad selector" }).code, "INVALID_INPUT");
	assert.equal(normalizeAbmlError({ code: "CROSS_ORIGIN_IFRAME", message: "blocked" }).code, "CROSS_ORIGIN_BLOCKED");
});

test("abml errors preserve actionability and verification payloads", () => {
	const error = normalizeAbmlError({ code: "SELECTOR_TIMEOUT", message: "timeout" }, {
		actionability: {
			ok: false,
			spec: { timeoutMs: 5000, pollMs: 100, stableWindowMs: 150, stableEpsilonPx: 1, required: ["visible"] },
			elapsedMs: 5000,
			attempts: 5,
			checks: { visible: false },
			blockers: [{ code: "not_visible", message: "display none" }],
		},
		verification: {
			status: "inconclusive",
			verb: "click",
			observed: { dispatched: true },
			evidence: [{ kind: "dom", summary: "input dispatched" }],
			elapsedMs: 120,
		},
	});
	assert.equal(error.code, "ACTIONABILITY_TIMEOUT");
	assert.equal(error.actionability?.blockers[0]?.code, "not_visible");
	assert.equal(error.verification?.status, "inconclusive");
});

test("abml errors fallback unknown codes to INTERNAL_ERROR", () => {
	const error = normalizeAbmlError({ code: "SOMETHING_UNKNOWN", message: "boom" });
	assert.equal(error.code, "INTERNAL_ERROR");
	assert.equal(error.category, "internal");
	assert.equal(error.cause?.code, "SOMETHING_UNKNOWN");
});

test("abml errors redact sensitive secrets in message and evidence", () => {
	const error = normalizeAbmlError(
		{ code: "INVALID_INPUT", message: "rejected token=abc123 password=hunter2" },
		{ evidence: { authorization: "Bearer xyz", note: "ok" } },
	);
	assert.doesNotMatch(error.message, /abc123|hunter2/, "secrets must not survive in message");
	assert.match(error.message, /\[redacted\]/);
	assert.equal(error.evidence?.authorization, "[redacted]");
	assert.equal(error.evidence?.note, "ok", "non-sensitive evidence fields are preserved");
});

test("abml errors derive recovery metadata from the mapped code", () => {
	const retryable = normalizeAbmlError({ code: "ACTIONABILITY_TIMEOUT", message: "slow" });
	assert.equal(retryable.category, "actionability");
	assert.equal(retryable.recovery.retryable, true);
	assert.equal(retryable.recovery.kind, "wait-and-retry");
	assert.ok(retryable.recovery.nextActions.length > 0);

	const terminal = normalizeAbmlError({ code: "TARGET_NOT_EDITABLE", message: "readonly" });
	assert.equal(terminal.category, "actionability");
	assert.equal(terminal.recovery.retryable, false);
	assert.equal(terminal.recovery.kind, "manual-review");
});
