import assert from "node:assert/strict";
import test from "node:test";
import { buildDomEntityFromScanActionable, type Entity } from "../../src/kernels/abml/entity.ts";
import { isAbmlStateExpectation, verificationDiff, verifyAbmlState } from "../../src/kernels/abml/verification.ts";

function entity(pressed?: boolean): Entity {
	return {
		ref: "bp-ref://control/like",
		kind: "control",
		role: "button",
		name: "Like",
		state: { visible: true, occluded: false, disabled: false, focused: false, ...(pressed === undefined ? {} : { pressed }), editable: false, inViewport: true },
		source: "dom",
	};
}

test("ABML verification validates and evaluates structured state postconditions", () => {
	const expectation = { ref: "bp-ref://control/like", state: { pressed: true } } as const;
	assert.equal(isAbmlStateExpectation(expectation), true);
	assert.equal(isAbmlStateExpectation({ ref: expectation.ref, state: {} }), false);
	assert.equal(isAbmlStateExpectation({ ref: expectation.ref, state: { unknown: true } }), false);
	assert.equal(isAbmlStateExpectation({ ref: expectation.ref, value: "secret" }), false);

	assert.equal(verifyAbmlState("input.ref", expectation, { entity: entity(true), sources: ["dom", "ax"] }, 12).status, "verified");
	assert.equal(verifyAbmlState("input.ref", expectation, { entity: entity(false), sources: ["dom"] }, 12).status, "unmet");
	assert.equal(verifyAbmlState("input.ref", expectation, { entity: entity(), sources: ["dom"] }, 12).status, "inconclusive");
	assert.equal(verifyAbmlState("input.ref", { ref: expectation.ref, state: { pressed: true, checked: true } }, { entity: entity(false), sources: ["dom"] }, 12).status, "unmet");
});

test("ABML verification emits the same entity diff used by observe", () => {
	const diff = verificationDiff(entity(false), entity(true));
	assert.deepEqual(diff?.changed, [{ ref: "bp-ref://control/like", kind: "state-changed", before: { pressed: false }, after: { pressed: true } }]);
});

test("DOM actionable state retains selected and pressed for ABML settlement", () => {
	const built = buildDomEntityFromScanActionable({
		tag: "button",
		role: "button",
		pressed: true,
		selected: false,
		visible: true,
		inViewport: true,
		rect: { x: 0, y: 0, width: 10, height: 10 },
		point: { x: 5, y: 5 },
		hitOk: true,
	}, { observationId: "obs-1", capturedAt: 1 });
	assert.equal(built.entity.state.pressed, true);
	assert.equal(built.entity.state.selected, false);
});
