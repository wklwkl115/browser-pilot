import test from "node:test";
import assert from "node:assert/strict";
import { classifyResolveResult, RESOLVE_MIN_SCORE, RESOLVE_UNIQUE_GAP, scoreCandidate } from "../../../src/abml/resolveModel.ts";
import { defaultRefPolicyForKind } from "../../../src/abml/refPolicy.ts";
import type { CandidateSummary, RefDescriptor } from "../../../src/abml/types.ts";

function makeRef(overrides: Partial<RefDescriptor> = {}): RefDescriptor {
	return {
		refId: "pi-ref://fixture",
		kind: "control",
		locators: [{ by: "backendNodeId", value: 101 }, { by: "attrSignature", value: { "data-testid": "add-to-cart" } }],
		owner: { browserSessionId: "session-a", tabId: 1, topLevelOrigin: "https://shop.test" },
		policy: defaultRefPolicyForKind("control"),
		semantic: { role: "button", name: "Add to cart" },
		observationId: "obs-1",
		createdAt: 0,
		ttlMs: 60_000,
		...overrides,
	};
}

function makeCandidate(overrides: Partial<CandidateSummary> = {}): CandidateSummary {
	return {
		candidateId: "candidate-1",
		locatorHits: [{ by: "attrSignature", weight: 90 }],
		score: 90,
		role: "button",
		name: "Add to cart",
		source: "dom",
		documentOrder: 1,
		...overrides,
	};
}

test("resolveModel scoreCandidate applies locator and bonus rules once per unique locator", () => {
	const score = scoreCandidate({
		locatorHits: [
			{ by: "backendNodeId" },
			{ by: "backendNodeId" },
			{ by: "textAnchor" },
		],
		semantic: { roleMatches: true, nameMatches: true, textAnchorFuzzyMatches: true },
		geometry: { pointDistancePx: 3, boxIou: 0.9 },
		owner: { frameMatches: true },
	});
	assert.equal(score, 100 + 60 + 10 + 10 + 4 + 8 + 8 + 15);
});

test("resolveModel classifies rerendered backendNodeId loss with stable data-testid as unique", () => {
	const ref = makeRef();
	const candidate = makeCandidate({
		candidateId: "rerendered",
		locatorHits: [{ by: "attrSignature", weight: 90 }],
		score: scoreCandidate({ locatorHits: [{ by: "attrSignature" }], semantic: { roleMatches: true, nameMatches: true } }),
	});
	const result = classifyResolveResult(ref, [candidate]);
	assert.equal(result.status, "unique");
	assert.equal(result.candidate.candidateId, "rerendered");
});

test("resolveModel classifies random class but stable role/text as unique via text anchor", () => {
	const ref = makeRef({ locators: [{ by: "textAnchor", value: "Checkout", role: "button", exact: false }], semantic: { role: "button", name: "Checkout" } });
	const candidate = makeCandidate({
		candidateId: "text-role-match",
		locatorHits: [{ by: "textAnchor", weight: 60 }],
		name: "Checkout",
		score: scoreCandidate({ locatorHits: [{ by: "textAnchor" }], semantic: { roleMatches: true, nameMatches: true, textAnchorFuzzyMatches: true } }),
	});
	const result = classifyResolveResult(ref, [candidate]);
	assert.equal(result.status, "unique");
	assert.equal(result.candidate.candidateId, "text-role-match");
});

test("resolveModel classifies many same-name candidates without extra locators as ambiguous", () => {
	const ref = makeRef({ locators: [{ by: "textAnchor", value: "Add to cart", role: "button", exact: true }], semantic: { role: "button", name: "Add to cart" } });
	const score = scoreCandidate({ locatorHits: [{ by: "textAnchor" }], semantic: { roleMatches: true, nameMatches: true } });
	const candidates = Array.from({ length: 10 }, (_, index) => makeCandidate({ candidateId: `candidate-${index + 1}`, locatorHits: [{ by: "textAnchor", weight: 60 }], score, documentOrder: index + 1 }));
	const result = classifyResolveResult(ref, candidates);
	assert.equal(result.status, "ambiguous");
	assert.equal(result.candidates.length, 10);
	assert.match(result.reason, /unique gap/i);
	assert.equal(score, RESOLVE_MIN_SCORE - 0 + 20);
});

test("resolveModel returns stale when navigation epoch changed and only backendNodeId remained", () => {
	const ref = makeRef({ locators: [{ by: "backendNodeId", value: 404 }], semantic: undefined });
	const candidate = makeCandidate({ locatorHits: [{ by: "point", weight: 40 }], score: 40, name: undefined, role: undefined });
	const result = classifyResolveResult(ref, [candidate]);
	assert.equal(result.status, "stale");
	assert.match(result.reason, new RegExp(String(RESOLVE_MIN_SCORE)));
});

test("resolveModel detects semantic conflict as ambiguous", () => {
	const ref = makeRef({ semantic: { role: "button", name: "Pay now" } });
	const candidate = makeCandidate({ score: 100, role: "link", name: "Pay now" });
	const result = classifyResolveResult(ref, [candidate]);
	assert.equal(result.status, "ambiguous");
	assert.match(result.reason, /semantic/i);
});

test("resolveModel keeps eval-returned selector or point as non-actionable stale candidates below min score", () => {
	const selectorRef = makeRef({ locators: [{ by: "css", value: ".temp-generated" }], semantic: undefined });
	const selectorCandidate = makeCandidate({ locatorHits: [{ by: "css", weight: 80 }], score: 20 });
	const selectorResult = classifyResolveResult(selectorRef, [selectorCandidate]);
	assert.equal(selectorResult.status, "stale");
	const pointRef = makeRef({ kind: "element", locators: [{ by: "point", x: 15, y: 25 }], semantic: undefined });
	const pointCandidate = makeCandidate({ locatorHits: [{ by: "point", weight: 40 }], score: 40, source: "dom" });
	const pointResult = classifyResolveResult(pointRef, [pointCandidate]);
	assert.equal(pointResult.status, "stale");
});

test("resolveModel allows region refs with only point locator to resolve uniquely", () => {
	const ref = makeRef({ kind: "region", locators: [{ by: "point", x: 30, y: 40 }], semantic: undefined });
	const candidate = makeCandidate({ locatorHits: [{ by: "point", weight: 40 }], score: 40, source: "vision" });
	const result = classifyResolveResult(ref, [candidate]);
	assert.equal(result.status, "unique");
	assert.equal(result.candidate.source, "vision");
});

test("resolveModel supports explicit backend unavailable classification", () => {
	const result = classifyResolveResult(makeRef(), [], { backendUnavailable: true, backend: "cdp" });
	assert.equal(result.status, "backendUnavailable");
	assert.equal(result.backend, "cdp");
});

test("resolveModel returns ambiguous when top gap is below threshold", () => {
	const top = makeCandidate({ candidateId: "top", score: 100, documentOrder: 1 });
	const second = makeCandidate({ candidateId: "second", score: 100 - RESOLVE_UNIQUE_GAP + 1, documentOrder: 2 });
	const result = classifyResolveResult(makeRef(), [top, second]);
	assert.equal(result.status, "ambiguous");
	assert.equal(result.candidates[0].candidateId, "top");
});
