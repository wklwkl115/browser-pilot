import test from "node:test";
import assert from "node:assert/strict";
import { toolMaxChars, toolPositiveInt, toolTimeoutMs } from "../../../src/tools/toolAdapter.ts";

test("toolAdapter uses tool budget as default max chars", () => {
	assert.equal(toolMaxChars({}, "browser_artifact"), 8000);
});

test("toolAdapter normalizes positive integers with fallback", () => {
	assert.equal(toolPositiveInt(123, 10), 123);
	assert.equal(toolPositiveInt(undefined, 10), 10);
	assert.equal(toolPositiveInt(-1, 10), 10);
});

test("toolAdapter supports allowZero timeout probes", () => {
	assert.equal(toolTimeoutMs(0, 15000, { allowZero: true }), 0);
	assert.equal(toolTimeoutMs(undefined, 15000), 15000);
});
