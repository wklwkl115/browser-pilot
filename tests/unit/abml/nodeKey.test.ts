import test from "node:test";
import assert from "node:assert/strict";
import { backendNodeKey, cleanTargetId, legacyBackendNodeKey } from "../../../src/abml-core/nodeKey.ts";

test("nodeKey: cleanTargetId trims non-empty target ids", () => {
	assert.equal(cleanTargetId(" child-target "), "child-target");
	assert.equal(cleanTargetId(""), undefined);
	assert.equal(cleanTargetId("   "), undefined);
	assert.equal(cleanTargetId(42), undefined);
	assert.equal(cleanTargetId(undefined), undefined);
});

test("nodeKey: backendNodeKey preserves legacy same-target ids", () => {
	assert.equal(backendNodeKey({ backendNodeId: 81 }), "b:81");
	assert.equal(legacyBackendNodeKey(81), "b:81");
});

test("nodeKey: backendNodeKey includes target scope for OOPIF ids", () => {
	assert.equal(backendNodeKey({ backendNodeId: 81, targetId: "target-child" }), "t:target-child:b:81");
});
