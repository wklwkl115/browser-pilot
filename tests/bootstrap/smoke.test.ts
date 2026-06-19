import test from "node:test";
import assert from "node:assert/strict";

test("bootstrap test harness is available", () => {
	assert.equal(typeof process.version, "string");
});
