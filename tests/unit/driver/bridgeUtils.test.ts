import test from "node:test";
import assert from "node:assert/strict";
import { bridgeResultFailure, isAllowedBridgeOrigin, normalizeErrorMessage, normalizePort, recordValue, toTabId } from "../../../src/driver/bridgeUtils.ts";

test("bridgeUtils validates ports, tab ids, and extension origins", () => {
	assert.equal(normalizePort("18888"), 18888);
	assert.equal(normalizePort("0", 18765), 18765);
	assert.equal(toTabId("42"), 42);
	assert.equal(toTabId(-1), undefined);
	assert.equal(isAllowedBridgeOrigin(undefined), true);
	assert.equal(isAllowedBridgeOrigin("null"), true);
	assert.equal(isAllowedBridgeOrigin("chrome-extension://abc"), true);
	assert.equal(isAllowedBridgeOrigin("https://example.test"), false);
});

test("bridgeUtils extracts structured failures and compact messages", () => {
	assert.deepEqual(bridgeResultFailure({ ok: false, error: "failed", details: { selector: "#go" } }), { message: "failed", details: { selector: "#go" } });
	assert.equal(bridgeResultFailure({ ok: true }), undefined);
	assert.equal(normalizeErrorMessage({ error: "nested" }), "nested");
	assert.deepEqual(recordValue({ a: 1 }), { a: 1 });
	assert.equal(recordValue(["nope"]), undefined);
});
