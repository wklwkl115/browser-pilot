import test from "node:test";
import assert from "node:assert/strict";
import { distillFrameIntoProfile, emptyMemoryOriginProfile, memoryTermKey, mergeProfiles } from "../../../src/memory-core/profile.ts";
import type { PersistableMemoryTerm } from "../../../src/memory-core/types.ts";

const checkout: PersistableMemoryTerm = { term: "checkout", kind: "urlPathToken", weight: 1 };
const selector: PersistableMemoryTerm = { term: "#pay", kind: "selectorLiteral", weight: 1.2 };

test("distillFrameIntoProfile counts distinct sessions and keeps one-off terms below candidate threshold", () => {
	let profile = emptyMemoryOriginProfile("https://shop.example");
	profile = distillFrameIntoProfile(profile, { origin: profile.origin, sessionId: "s1", canonicalUrl: "https://shop.example/cart", capturedAt: 10 }, { sessionId: "s1", capturedAt: 10, terms: [checkout] });
	assert.equal(profile.termStats[memoryTermKey(checkout)].sessionCount, 1, "first-session term remains a one-off");
	profile = distillFrameIntoProfile(profile, { origin: profile.origin, sessionId: "s2", canonicalUrl: "https://shop.example/pay", capturedAt: 20 }, { sessionId: "s2", capturedAt: 20, terms: [checkout, selector] });
	assert.equal(profile.termStats[memoryTermKey(checkout)].sessionCount, 2, "recurring term crosses the future M3a candidate threshold");
	assert.equal(profile.termStats[memoryTermKey(selector)].sessionCount, 1, "new selector term remains one-off");
	assert.deepEqual(profile.urls.map((item) => item.canonicalUrl), ["https://shop.example/pay", "https://shop.example/cart"]);
});

test("mergeProfiles is commutative for disjoint deltas and max-takes counters", () => {
	const a = distillFrameIntoProfile(emptyMemoryOriginProfile("https://shop.example"), { origin: "https://shop.example", sessionId: "a", capturedAt: 10 }, { sessionId: "a", capturedAt: 10, terms: [checkout] });
	const b = distillFrameIntoProfile(emptyMemoryOriginProfile("https://shop.example"), { origin: "https://shop.example", sessionId: "b", capturedAt: 20 }, { sessionId: "b", capturedAt: 20, terms: [selector] });
	a.strikes.entry1 = 1;
	b.strikes.entry1 = 3;
	const ab = mergeProfiles(a, b)!;
	const ba = mergeProfiles(b, a)!;
	assert.deepEqual(ab.sessions, ba.sessions, "session merge must not depend on argument order");
	assert.deepEqual(ab.termStats, ba.termStats, "term stat merge must not depend on argument order");
	assert.equal(ab.strikes.entry1, 3, "overlapping strike counters use max");
});
