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
