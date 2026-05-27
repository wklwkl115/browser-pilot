import test from "node:test";
import assert from "node:assert/strict";
import { isSafeArtifactSearchRegexPattern } from "../../../src/tools/artifactReader.ts";

test("artifactReader regex safety helper accepts simple patterns", () => {
	assert.equal(isSafeArtifactSearchRegexPattern("h[12]\\.test"), true);
});

test("artifactReader regex safety helper rejects unsafe nested quantifiers", () => {
	assert.equal(isSafeArtifactSearchRegexPattern("(a+)+$"), false);
});
