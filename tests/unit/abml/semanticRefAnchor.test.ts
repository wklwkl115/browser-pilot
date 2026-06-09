import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deriveSemanticRefAnchors, semanticRefAnchorHashInput, type SemanticRefAnchorHashInput } from "../../../src/abml-core/semanticRefAnchor.ts";
import type { Entity, EntityState } from "../../../src/abml-core/entity.ts";
import type { RefDescriptor } from "../../../src/abml-core/types.ts";

const state = (overrides: Partial<EntityState> = {}): EntityState => ({
	visible: true,
	occluded: false,
	disabled: false,
	focused: false,
	editable: false,
	inViewport: true,
	...overrides,
});

function item(ref: string, name: string | undefined, index: number, overrides: Partial<Entity> = {}): Entity {
	return {
		ref,
		kind: "control",
		role: "link",
		...(name !== undefined ? { name } : {}),
		state: state(overrides.state),
		source: "ax",
		structure: { posInSet: index, setSize: 8, ...(overrides.structure || {}) },
		hints: { containerRole: "list", containerName: "Products", ...(overrides.hints || {}) },
		...overrides,
	};
}

function list(names: Array<string | undefined>, prefix: string): Entity[] {
	return names.map((name, index) => item(`pi-ref://control/${prefix}${index}`, name, index + 1));
}

const descriptor = (kind: RefDescriptor["kind"] = "control"): Pick<RefDescriptor, "kind" | "owner" | "documentEpoch"> => ({
	kind,
	owner: { tabId: 7, topLevelOrigin: "https://example.test" },
	documentEpoch: { url: "https://example.test/catalog", capturedAt: 1000 },
});

function stableShadowId(input: SemanticRefAnchorHashInput): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24);
}

test("semanticRefAnchor: unique names in a template group become high-confidence minting candidates", () => {
	const summary = deriveSemanticRefAnchors(list(["Alpha", "Bravo", "Charlie", "Delta"], "a"));
	assert.equal(summary.highConfidenceCount, 4);
	assert.equal(summary.lowConfidenceCount, 0);
	assert.equal(summary.mintingEligibleCount, 4);
	const bravo = summary.anchors.find((candidate) => candidate.anchor.name === "Bravo");
	assert.ok(bravo);
	assert.equal(bravo.anchor.confidence, "high");
	assert.equal(bravo.anchor.reason, "unique-name");
	assert.equal(bravo.anchor.mintingEligible, true);
	assert.equal(bravo.anchor.containerRole, "list");
	assert.equal(bravo.anchor.containerName, "Products");
});

test("semanticRefAnchor: duplicate names stay low-confidence and are not minting eligible", () => {
	const summary = deriveSemanticRefAnchors(list(["Item", "Item", "Item", "Item"], "a"));
	assert.equal(summary.highConfidenceCount, 0);
	assert.equal(summary.lowConfidenceCount, 4);
	assert.equal(summary.mintingEligibleCount, 0);
	assert.equal(summary.anchors[0].anchor.reason, "duplicate-name");
	assert.equal(summary.anchors[0].anchor.mintingEligible, false);
});

test("semanticRefAnchor: unnamed positional instances stay low-confidence/diff-only", () => {
	const summary = deriveSemanticRefAnchors(list([undefined, undefined, undefined, undefined], "a"));
	assert.equal(summary.highConfidenceCount, 0);
	assert.equal(summary.lowConfidenceCount, 4);
	assert.equal(summary.mintingEligibleCount, 0);
	assert.equal(summary.anchors[0].anchor.reason, "missing-name");
	assert.equal(summary.anchors[0].anchor.posInSet, 1);
	assert.equal(semanticRefAnchorHashInput(descriptor(), summary.anchors[0].anchor), undefined);
});

test("semanticRefAnchor: non-template entities get no anchor", () => {
	const summary = deriveSemanticRefAnchors(list(["Alpha", "Bravo", "Charlie"], "a"));
	assert.equal(summary.anchors.length, 0);
});

// ── I1: anchor gate relaxation — unnamed containers ─────────────────────────

function unnamedContainerItem(ref: string, name: string | undefined, index: number): Entity {
	return item(ref, name, index, { hints: { containerRole: "list" } });
}

function unnamedContainerList(names: Array<string | undefined>, prefix: string): Entity[] {
	return names.map((name, index) => unnamedContainerItem(`pi-ref://control/${prefix}${index}`, name, index + 1));
}

test("I1: unique names in unnamed container (containerRole only, no containerName) are minting eligible", () => {
	const summary = deriveSemanticRefAnchors(unnamedContainerList(["Alpha", "Bravo", "Charlie", "Delta"], "u"));
	assert.equal(summary.highConfidenceCount, 4);
	assert.equal(summary.mintingEligibleCount, 4, "containerRole alone now sufficient for minting");
	const alpha = summary.anchors.find((c) => c.anchor.name === "Alpha");
	assert.ok(alpha);
	assert.equal(alpha.anchor.mintingEligible, true);
	assert.equal(alpha.anchor.containerRole, "list");
	assert.equal(alpha.anchor.containerName, undefined, "no containerName present");
});

test("I1: semanticRefAnchorHashInput works with unnamed container (containerName normalized to empty string)", () => {
	const summary = deriveSemanticRefAnchors(unnamedContainerList(["Alpha", "Bravo", "Charlie", "Delta"], "u"));
	const alpha = summary.anchors.find((c) => c.anchor.name === "Alpha");
	assert.ok(alpha);
	const input = semanticRefAnchorHashInput(descriptor(), alpha.anchor);
	assert.ok(input, "hash input produced for unnamed container");
	assert.equal(input.anchor.containerName, "", "containerName normalized to empty string for hash stability");
	assert.equal(input.anchor.containerRole, "list");
	assert.equal(input.anchor.normalizedName, "alpha");
});

test("I1: ref hash is stable across selector change when entity has unnamed-container anchor", () => {
	const first = deriveSemanticRefAnchors(unnamedContainerList(["Alpha", "Bravo", "Charlie", "Delta"], "v1-"));
	const second = deriveSemanticRefAnchors(unnamedContainerList(["Alpha", "Bravo", "Charlie", "Delta"], "v2-"));
	const firstAlpha = first.anchors.find((c) => c.anchor.name === "Alpha");
	const secondAlpha = second.anchors.find((c) => c.anchor.name === "Alpha");
	assert.ok(firstAlpha && secondAlpha);
	const firstInput = semanticRefAnchorHashInput(descriptor(), firstAlpha.anchor);
	const secondInput = semanticRefAnchorHashInput(descriptor(), secondAlpha.anchor);
	assert.deepEqual(firstInput, secondInput, "same anchor input despite different refs (different selector)");
});

test("I1: duplicate names in unnamed container still ineligible (namedUniquely preserved)", () => {
	const summary = deriveSemanticRefAnchors(unnamedContainerList(["Same", "Same", "Same", "Same"], "d"));
	assert.equal(summary.mintingEligibleCount, 0, "duplicate names → ineligible regardless of container naming");
});

test("semanticRefAnchor: shadow hash input is stable across reorder and insertion, without changing live refs", () => {
	const before = deriveSemanticRefAnchors(list(["Alpha", "Bravo", "Charlie", "Delta"], "b"));
	const after = deriveSemanticRefAnchors(list(["Charlie", "Alpha", "Bravo", "Delta", "Echo"], "a"));
	const beforeBravo = before.anchors.find((candidate) => candidate.anchor.name === "Bravo")?.anchor;
	const afterBravo = after.anchors.find((candidate) => candidate.anchor.name === "Bravo")?.anchor;
	assert.ok(beforeBravo);
	assert.ok(afterBravo);
	const beforeInput = semanticRefAnchorHashInput(descriptor(), beforeBravo);
	const afterInput = semanticRefAnchorHashInput(descriptor(), afterBravo);
	assert.deepEqual(beforeInput, afterInput);
	assert.equal(stableShadowId(beforeInput), stableShadowId(afterInput));
});
