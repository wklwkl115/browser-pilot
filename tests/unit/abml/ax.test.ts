import test from "node:test";
import assert from "node:assert/strict";
import { buildAxEntityFromNode, buildAxLocators, boxModelToGeometry, isInterestingAxNode, mergeDomAndAxEntities } from "../../../src/abml/ax.ts";

const ctx = { observationId: "obs-1", capturedAt: 1710000000000 };

test("abml ax maps AX nodes into entities with locators and geometry", () => {
	const built = buildAxEntityFromNode({
		nodeId: "ax-1",
		backendDOMNodeId: 41,
		role: { value: "button" },
		name: { value: "Pay now" },
		properties: [{ name: "focused", value: { value: true } }],
	}, { observationId: "obs-1", browserSessionId: "session-1", tabId: 7, url: "https://example.test/checkout", capturedAt: 1710000000000 }, { box: { x: 10, y: 20, w: 30, h: 40 }, point: { x: 25, y: 40 } });
	assert.equal(built.entity.kind, "control");
	assert.equal(built.entity.role, "button");
	assert.equal(built.entity.name, "Pay now");
	assert.equal(built.entity.source, "ax");
	assert.equal(built.entity.state.focused, true);
	assert.equal(built.descriptor.owner.browserSessionId, "session-1");
	assert.equal(built.descriptor.locators.some((locator) => locator.by === "backendNodeId" && locator.value === 41), true);
	assert.equal(built.descriptor.locators.some((locator) => locator.by === "axNodeId" && locator.value === "ax-1"), true);
	assert.equal(built.descriptor.locators.some((locator) => locator.by === "textAnchor" && locator.value === "Pay now"), true);
});

test("abml ax converts CDP box model into geometry", () => {
	const geometry = boxModelToGeometry({ border: [10, 20, 50, 20, 50, 60, 10, 60] });
	assert.deepEqual(geometry, { box: { x: 10, y: 20, w: 40, h: 40 }, point: { x: 30, y: 40 } });
});

test("abml ax merges matching DOM and AX entities by role/name/geometry", () => {
	const dom = [{
		ref: "pi-ref://control/dom-1",
		kind: "control",
		role: "button",
		name: "Pay now",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		source: "dom",
		locators: [{ by: "css", value: "#pay" }],
		geometry: { point: { x: 100, y: 200 } },
		hints: { selector: "#pay" },
	}];
	const ax = [buildAxEntityFromNode({ nodeId: "ax-1", backendDOMNodeId: 81, role: { value: "button" }, name: { value: "Pay now" } }, ctx, { point: { x: 104, y: 198 } })];
	const merged = mergeDomAndAxEntities(dom as any, ax);
	assert.equal(merged.merged.length, 1);
	assert.equal(merged.unmatchedAx.length, 0);
	assert.equal(merged.merged[0]?.locators?.some((locator) => locator.by === "axNodeId"), true);
	assert.deepEqual(merged.merged[0]?.hints?.mergedSources, ["dom", "ax"]);
});

test("abml ax locator order is backendNodeId, axNodeId, textAnchor", () => {
	assert.deepEqual(buildAxLocators({
		nodeId: "ax-9",
		backendDOMNodeId: 91,
		role: { value: "tab" },
		name: { value: "Home" },
	}), [
		{ by: "backendNodeId", value: 91 },
		{ by: "axNodeId", value: "ax-9" },
		{ by: "textAnchor", value: "Home", role: "tab", exact: false },
	]);
});

test("abml ax interesting-node filter keeps controls and named generic nodes only", () => {
	assert.equal(isInterestingAxNode({ ignored: true, role: { value: "button" }, name: { value: "Pay" } }), false);
	assert.equal(isInterestingAxNode({ role: { value: "generic" } }), false);
	assert.equal(isInterestingAxNode({ role: { value: "generic" }, name: { value: "Named panel" } }), true);
	assert.equal(isInterestingAxNode({ role: { value: "button" } }), true);
});

test("abml ax handles malformed inputs defensively", () => {
	const built = buildAxEntityFromNode({}, ctx);
	assert.equal(built.entity.kind, "element");
	assert.equal(built.entity.role, "generic");
	assert.deepEqual(built.entity.locators, []);
	assert.equal(built.descriptor.createdAt, ctx.capturedAt);
	assert.equal(boxModelToGeometry({ border: [1, 2, "bad"] }), undefined);
});

test("abml ax merge dedupes repeated locators", () => {
	const dom = [{
		ref: "pi-ref://control/dom-2",
		kind: "control",
		role: "button",
		name: "Save",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		source: "dom",
		locators: [{ by: "backendNodeId", value: 100 }],
		geometry: { point: { x: 10, y: 10 } },
	}];
	const ax = [buildAxEntityFromNode({ backendDOMNodeId: 100, role: { value: "button" }, name: { value: "Save" } }, ctx, { point: { x: 10, y: 10 } })];
	const { merged } = mergeDomAndAxEntities(dom as any, ax);
	assert.equal(merged[0]?.locators?.filter((locator) => locator.by === "backendNodeId" && locator.value === 100).length, 1);
});

// Invariant: a geometry-less AX node that matches on role (and maybe name) alone must never be
// non-deterministically attributed to a same-role DOM sibling. With no geometry to disambiguate,
// the old greedy matcher glued it onto whichever candidate came first in array order and mis-
// attributed its authoritative state. These guard the absence of that mis-association — they hold
// regardless of how the merge is later re-implemented (e.g. a backendNodeId join).
const geometrylessAxButton = (nodeId: string, backendId: number, props: Array<{ name: string; value: { value: string } }> = []) =>
	buildAxEntityFromNode({ nodeId, backendDOMNodeId: backendId, role: { value: "button" }, properties: props }, ctx);
const domButton = (selector: string, name: string, point: { x: number; y: number }) => ({
	ref: `pi-ref://control${selector}`, kind: "control", role: "button", name,
	state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
	source: "dom", locators: [{ by: "css", value: selector }], geometry: { point },
});
const mergedSourcesOf = (entity: { hints?: unknown }) => (entity.hints as Record<string, unknown> | undefined)?.mergedSources as string[] | undefined;

test("abml ax merge refuses an ambiguous geometry-less role-only AX node (no order-dependent mis-glue)", () => {
	const domA = domButton("#a", "Save", { x: 10, y: 10 });
	const domB = domButton("#b", "Delete", { x: 200, y: 200 });
	// Same AX node (no name, no geometry) role-matches both DOM buttons at a flat score.
	const forward = mergeDomAndAxEntities([domA, domB] as any, [geometrylessAxButton("ax-amb", 7)]);
	const reverse = mergeDomAndAxEntities([domB, domA] as any, [geometrylessAxButton("ax-amb", 7)]);
	assert.equal(forward.unmatchedAx.length, 1, "ambiguous AX node refused (forward order)");
	assert.equal(reverse.unmatchedAx.length, 1, "ambiguous AX node refused (reverse order)");
	for (const result of [forward, reverse]) {
		for (const entity of result.merged) {
			assert.ok(!mergedSourcesOf(entity)?.includes("ax"), "no DOM sibling absorbed the ambiguous AX node");
		}
	}
});

test("abml ax merge still fuses a geometry-less role-only AX node when its same-role candidate is unique", () => {
	// The legitimate single-candidate correction — the uniqueness gate must not over-refuse it.
	const dom = domButton("#only", "Save", { x: 10, y: 10 });
	const { merged, unmatchedAx } = mergeDomAndAxEntities([dom] as any, [geometrylessAxButton("ax-only", 9)]);
	assert.equal(unmatchedAx.length, 0, "unique same-role candidate still fuses");
	assert.equal(merged.length, 1);
	assert.deepEqual(mergedSourcesOf(merged[0]!), ["dom", "ax"]);
});

test("abml ax merge does not let multiple geometry-less AX nodes pile onto one DOM entity", () => {
	const dom = domButton("#solo", "Go", { x: 10, y: 10 });
	const ax1 = geometrylessAxButton("ax-1", 201, [{ name: "pressed", value: { value: "true" } }]);
	const ax2 = geometrylessAxButton("ax-2", 202, [{ name: "expanded", value: { value: "true" } }]);
	const { merged, unmatchedAx } = mergeDomAndAxEntities([dom] as any, [ax1, ax2]);
	assert.equal(merged.length, 1);
	assert.equal(unmatchedAx.length, 1, "the second AX node does not also fuse into the same DOM entity");
	const backendLocators = (merged[0]?.locators || []).filter((locator) => locator.by === "backendNodeId");
	assert.ok(backendLocators.length <= 1, "DOM entity is not stamped with two distinct AX backend ids");
});
