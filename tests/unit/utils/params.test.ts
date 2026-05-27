import test from "node:test";
import assert from "node:assert/strict";
import { asPositiveInt, normalizeArtifactMode, normalizeDetailLevel } from "../../../src/utils/params.ts";

test("asPositiveInt rounds positive finite values up", () => {
	assert.equal(asPositiveInt(1.2, 5), 2);
	assert.equal(asPositiveInt(3, 5), 3);
});

test("asPositiveInt falls back on invalid values", () => {
	assert.equal(asPositiveInt(undefined, 5), 5);
	assert.equal(asPositiveInt(0, 5), 5);
	assert.equal(asPositiveInt(-1, 5), 5);
});

test("normalizeDetailLevel accepts preview/full and defaults to summary", () => {
	assert.equal(normalizeDetailLevel("preview"), "preview");
	assert.equal(normalizeDetailLevel("full"), "full");
	assert.equal(normalizeDetailLevel("other"), "summary");
});

test("normalizeArtifactMode accepts json/search/sample and defaults to text", () => {
	assert.equal(normalizeArtifactMode("json"), "json");
	assert.equal(normalizeArtifactMode("search"), "search");
	assert.equal(normalizeArtifactMode("sample"), "sample");
	assert.equal(normalizeArtifactMode("other"), "text");
});
