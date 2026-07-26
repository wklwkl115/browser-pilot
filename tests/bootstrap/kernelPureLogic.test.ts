import test from "node:test";
import assert from "node:assert/strict";
import { mintRef, parseRef, isBrowserPilotRef, normalizeRef } from "../../src/kernels/refs/core.ts";
import { recoveryForNormalized } from "../../src/kernels/evidence/distill/recovery.ts";

test("refs kernel parses scoped refs and rejects malformed boundary values", () => {
	const scoped = mintRef("control", "login/button:1", { scope: "https://example.test/app path" });
	assert.equal(scoped, "bp-ref://control/https%3A%2F%2Fexample.test%2Fapp%20path/login/button:1");
	assert.deepEqual(parseRef(scoped), {
		scheme: "bp-ref",
		kind: "control",
		id: "login/button:1",
		scope: "https://example.test/app path",
	});
	assert.equal(isBrowserPilotRef(scoped), true);
	assert.equal(isBrowserPilotRef("bp-ref://control/"), false);
	assert.throws(() => parseRef("control/login"), /must start/);
	assert.throws(() => normalizeRef({ scheme: "bp-ref", kind: "control", id: "bad id" }), /Invalid Browser Pilot ref id/);
	assert.throws(() => normalizeRef({ scheme: "bp-ref", kind: "control", id: "ok", scope: "  " }), /scope cannot be empty/);
});

test("public recovery guidance keeps runtime lifecycle controls internal", () => {
	const recovery = [
		recoveryForNormalized("TIMEOUT", {}, { retryable: true }),
		recoveryForNormalized("WEBSOCKET_WAIT_TIMEOUT", {}, { retryable: true }),
	];
	assert.doesNotMatch(JSON.stringify(recovery), /timeoutMs|sessionId|tabHandle/);
});
