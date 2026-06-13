/**
 * Test 4 — I4: Dirty-root cap numeric assertion
 *
 * Contract (I4 — Bounded residency): the dirty-root set is capped at 32 roots
 * (`PI_BROWSER_DIRTY_ROOT_LIMIT = 32` in bridge_src/page_scripts/content.ts:27
 * and the normalization cap in src/tools/pageSignals.ts:38).
 *
 * Design choice (Node-side normalization layer):
 *   pageSignals.ts exports `normalizePageFingerprint` which caps dirty roots at
 *   32 during normalization. This is the strongest feasible assertion because:
 *     (a) The Node-side normalization is pure (no browser deps) — directly
 *         importable and testable without mocks.
 *     (b) Capping both at the page side (content.ts) AND the normalization side
 *         (pageSignals.ts) provides defense-in-depth; our test locks the
 *         normalization side contract with an exact numeric assertion.
 *     (c) We additionally pin the page-side constant value from the built dist
 *         content script using the same text-search pattern as check-page-scripts.mjs.
 *
 * This test FAILS when:
 *   - The cap constant changes from 32 (without updating this test as a deliberate
 *     contract-change confirmation)
 *   - normalizePageFingerprint stops enforcing the cap
 *   - A fingerprint with >32 roots is normalized to >32 roots
 *   - The overflow flag is not set correctly when roots exceed the cap
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalizePageFingerprint } from "../../../src/tools/pageSignals.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// ── Pinned cap value — test fails if the cap silently changes ─────────────────

const EXPECTED_DIRTY_ROOT_LIMIT = 32;

// ── Test 1: normalizePageFingerprint caps roots at exactly 32 ─────────────────

test("I4: normalizePageFingerprint caps dirty roots at 32 (contract-pinned)", () => {
	// Build a fingerprint with >32 dirty roots
	const roots = Array.from({ length: 50 }, (_, index) => `#element-${index}`);
	const raw = {
		changeSeq: 10,
		url: "https://example.test/app",
		visibleCount: 5,
		interactiveCount: 3,
		dirty: {
			roots,
			overflow: false, // page-side may not set overflow if it caps first
			sinceSeq: 9,
		},
	};

	const normalized = normalizePageFingerprint(raw);
	assert.notEqual(normalized, undefined, "normalizePageFingerprint must return a valid fingerprint");

	const dirtyRoots = normalized!.dirty?.roots ?? [];
	assert.equal(dirtyRoots.length <= EXPECTED_DIRTY_ROOT_LIMIT, true,
		`I4: dirty roots must be capped at ${EXPECTED_DIRTY_ROOT_LIMIT}, got ${dirtyRoots.length}`);
	assert.equal(dirtyRoots.length, EXPECTED_DIRTY_ROOT_LIMIT,
		`I4: normalizePageFingerprint must accept exactly ${EXPECTED_DIRTY_ROOT_LIMIT} roots from a 50-root input`);
});

// ── Test 2: cap is exactly 32 — not 31, not 33 ────────────────────────────────

test("I4: cap is numerically exact at 32 — accepts 32, truncates at 33", () => {
	// Exactly 32 roots — all must pass through
	const roots32 = Array.from({ length: 32 }, (_, index) => `.item-${index}`);
	const fp32 = normalizePageFingerprint({ changeSeq: 1, dirty: { roots: roots32, overflow: false } });
	assert.equal(fp32?.dirty?.roots.length, 32,
		"normalizePageFingerprint must accept all 32 roots when exactly at cap");

	// 33 roots — 33rd must be truncated
	const roots33 = Array.from({ length: 33 }, (_, index) => `.item-${index}`);
	const fp33 = normalizePageFingerprint({ changeSeq: 2, dirty: { roots: roots33, overflow: false } });
	assert.equal(fp33?.dirty?.roots.length, 32,
		`I4: normalizePageFingerprint must truncate to ${EXPECTED_DIRTY_ROOT_LIMIT} roots when input has 33`);
});

// ── Test 3: overflow flag passthrough ─────────────────────────────────────────

test("I4: overflow flag is preserved through normalizePageFingerprint", () => {
	const overflowFp = normalizePageFingerprint({
		changeSeq: 5,
		dirty: { roots: ["#root-1"], overflow: true, sinceSeq: 4 },
	});
	assert.equal(overflowFp?.dirty?.overflow, true,
		"overflow:true must survive normalizePageFingerprint");
	assert.equal(overflowFp?.dirty?.sinceSeq, 4,
		"sinceSeq must survive normalizePageFingerprint");
});

test("I4: overflow:false is preserved through normalizePageFingerprint", () => {
	const noOverflowFp = normalizePageFingerprint({
		changeSeq: 3,
		dirty: { roots: ["#root-1", "#root-2"], overflow: false },
	});
	assert.equal(noOverflowFp?.dirty?.overflow, false,
		"overflow:false must survive normalizePageFingerprint");
});

// ── Test 4: empty dirty block is normalized to undefined ──────────────────────

test("I4: empty dirty block (no roots, no overflow) normalizes to undefined", () => {
	const emptyFp = normalizePageFingerprint({
		changeSeq: 7,
		dirty: { roots: [], overflow: false },
	});
	assert.equal(emptyFp?.dirty, undefined,
		"empty dirty block (no roots, no overflow) must normalize to undefined — no noise in the envelope");
});

// ── Test 5: dirty block with only sinceSeq but no roots/overflow is normalized ─

test("I4: dirty block with only sinceSeq normalizes to include sinceSeq", () => {
	const seqOnlyFp = normalizePageFingerprint({
		changeSeq: 8,
		dirty: { roots: [], overflow: false, sinceSeq: 7 },
	});
	// Per the normalization logic: if sinceSeq is finite, it's included even with no roots
	assert.equal(seqOnlyFp?.dirty?.sinceSeq, 7,
		"dirty block with only sinceSeq must include sinceSeq in normalized form");
});

// ── Test 6: page-side cap constant is pinned in source ────────────────────────

test("I4: page-side PI_BROWSER_DIRTY_ROOT_LIMIT constant is pinned at 32 in content.ts source", () => {
	// Read the authoritative page script source
	const contentSrc = readFileSync(path.join(repoRoot, "bridge_src/page_scripts/content.ts"), "utf8");
	// Assert the constant declaration with its exact value
	assert(contentSrc.includes(`PI_BROWSER_DIRTY_ROOT_LIMIT = ${EXPECTED_DIRTY_ROOT_LIMIT}`),
		`I4: PI_BROWSER_DIRTY_ROOT_LIMIT must be ${EXPECTED_DIRTY_ROOT_LIMIT} in content.ts (found different or missing value)`);
});

test("I4: page-side cap constant is pinned at 32 in the built dist content bundle", () => {
	let distSrc: string;
	try {
		distSrc = readFileSync(path.join(repoRoot, "bridge/pi_browser_bridge/dist/content.js"), "utf8");
	} catch {
		console.warn("WARN: bridge dist content.js not found — skipping bundle assertion (run npm run build:bridge)");
		return;
	}
	assert(distSrc.includes(`PI_BROWSER_DIRTY_ROOT_LIMIT = ${EXPECTED_DIRTY_ROOT_LIMIT}`) || distSrc.includes(`const PI_BROWSER_DIRTY_ROOT_LIMIT=${EXPECTED_DIRTY_ROOT_LIMIT}`) || distSrc.includes(`PI_BROWSER_DIRTY_ROOT_LIMIT=${EXPECTED_DIRTY_ROOT_LIMIT}`),
		`I4: PI_BROWSER_DIRTY_ROOT_LIMIT must be ${EXPECTED_DIRTY_ROOT_LIMIT} in the built content.js bundle`);
});

// ── Test 7: overflow contract — cap is not enforced by setting overflow ────────

test("I4: normalizePageFingerprint truncates roots via slice, not by setting overflow", () => {
	// The normalization in pageSignals.ts truncates roots via push+length-check
	// (NOT by setting overflow:true). Overflow flag is passed through AS-IS from
	// the page — it's the page's responsibility to set overflow when it exceeds
	// the cap. The normalization layer must NOT fabricate an overflow flag.
	const roots35WithoutOverflow = Array.from({ length: 35 }, (_, index) => `#item-${index}`);
	const fp = normalizePageFingerprint({
		changeSeq: 15,
		dirty: { roots: roots35WithoutOverflow, overflow: false },
	});
	// Overflow is what was sent from the page — normalization must not change it
	// (the page already set it; the normalization just caps the array length)
	assert.equal(fp?.dirty?.overflow, false,
		"I4: normalizePageFingerprint must not fabricate overflow:true when the page did not set it");
	assert.equal(fp?.dirty?.roots.length, EXPECTED_DIRTY_ROOT_LIMIT,
		"I4: roots must still be capped at 32 even when overflow:false");
});
