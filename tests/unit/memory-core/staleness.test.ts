import test from "node:test";
import assert from "node:assert/strict";
import { applyVerificationStrike, transitionStrikeCount, verifyMemoryAnchors } from "../../../src/memory-core/staleness.ts";
import { emptyMemoryOriginProfile } from "../../../src/memory-core/profile.ts";

test("verifyMemoryAnchors reports fresh, stale, and unverified tiers", () => {
	assert.deepEqual(verifyMemoryAnchors(undefined, { canonicalUrl: "https://example.test/a" }), { status: "unverified", reasons: ["no-anchors"] });
	assert.deepEqual(verifyMemoryAnchors({ canonicalUrl: "https://example.test/a", stampSetId: "s1" }, { canonicalUrl: "https://example.test/a", stampSetId: "s1" }), { status: "fresh", reasons: ["anchors-match"] });
	assert.deepEqual(verifyMemoryAnchors({ canonicalUrl: "https://example.test/a", stampSetId: "s1" }, { canonicalUrl: "https://example.test/b", stampSetId: "s2" }), { status: "stale", reasons: ["canonicalUrl", "stampSetId"] });
	assert.deepEqual(
		verifyMemoryAnchors({ canonicalUrl: "https://example.test/a", stampSetId: "s1", fingerprintSummary: { changeSeq: 1 } }, {}),
		{ status: "stale", reasons: ["canonicalUrl", "stampSetId", "fingerprintSummary"] },
	);
});

test("verification strike transitions increment stale and reset on fresh", () => {
	assert.equal(transitionStrikeCount(undefined, "unverified"), undefined);
	assert.equal(transitionStrikeCount(undefined, "stale"), 1);
	assert.equal(transitionStrikeCount(2, "stale"), 3);
	assert.equal(transitionStrikeCount(3, "fresh"), undefined);

	let profile = emptyMemoryOriginProfile("https://example.test");
	profile = applyVerificationStrike(profile, "entry", "stale");
	profile = applyVerificationStrike(profile, "entry", "stale");
	assert.equal(profile.strikes.entry, 2);
	profile = applyVerificationStrike(profile, "entry", "fresh");
	assert.equal(profile.strikes.entry, undefined);
});
