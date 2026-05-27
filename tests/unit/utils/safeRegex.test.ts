import test from "node:test";
import assert from "node:assert/strict";
import { isSafeRegexPattern, unsafeRegexReason } from "../../../src/utils/safeRegex.ts";

test("safeRegex accepts simple bounded patterns", () => {
	assert.equal(isSafeRegexPattern("h[12]\\.test"), true);
	assert.equal(unsafeRegexReason("h[12]\\.test"), undefined);
});

test("safeRegex rejects empty patterns", () => {
	assert.equal(unsafeRegexReason(""), "empty_pattern");
});

test("safeRegex rejects nested quantifiers and backreferences", () => {
	assert.equal(unsafeRegexReason("(a+)+$"), "nested_quantifier");
	assert.equal(unsafeRegexReason("(a)\\1"), "backreference");
});

test("safeRegex rejects lookarounds and overlong patterns", () => {
	assert.equal(unsafeRegexReason("(?=a)b"), "lookaround_or_special_group");
	assert.equal(unsafeRegexReason("a".repeat(600), 512), "pattern_too_long");
});
