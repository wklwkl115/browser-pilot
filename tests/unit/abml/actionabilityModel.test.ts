import test from "node:test";
import assert from "node:assert/strict";
import {
	ACTION_POLL_MS,
	ACTION_TIMEOUT_MS,
	ACTIONABILITY_VERB_MATRIX,
	STABLE_EPSILON_PX,
	STABLE_WINDOW_MS,
	actionabilitySpecForVerb,
	isActionVerb,
} from "../../../src/abml/actionabilityModel.ts";

test("actionability model exposes reviewed default timing constants", () => {
	assert.equal(ACTION_TIMEOUT_MS, 5000);
	assert.equal(ACTION_POLL_MS, 100);
	assert.equal(STABLE_WINDOW_MS, 150);
	assert.equal(STABLE_EPSILON_PX, 1);
});

test("actionability model exposes the reviewed verb matrix", () => {
	assert.deepEqual(ACTIONABILITY_VERB_MATRIX.click, ["unique", "attached", "visible", "stable", "enabled", "inViewport", "receivesEvents", "notOccluded"]);
	assert.deepEqual(ACTIONABILITY_VERB_MATRIX.type, ["unique", "attached", "visible", "stable", "enabled", "editable", "inViewport"]);
	assert.deepEqual(ACTIONABILITY_VERB_MATRIX.select, ["unique", "attached", "visible", "stable", "enabled", "inViewport"]);
	assert.deepEqual(ACTIONABILITY_VERB_MATRIX.hover, ["unique", "attached", "visible", "stable", "inViewport", "receivesEvents"]);
	assert.deepEqual(ACTIONABILITY_VERB_MATRIX.drag, ["unique", "attached", "visible", "stable", "inViewport", "receivesEvents"]);
	assert.deepEqual(ACTIONABILITY_VERB_MATRIX.scroll, ["attached", "scrollable"]);
	assert.deepEqual(ACTIONABILITY_VERB_MATRIX.upload, ["unique", "attached", "enabled"]);
});

test("actionability model returns a cloned spec for each verb", () => {
	const clickSpec = actionabilitySpecForVerb("click");
	assert.equal(clickSpec.timeoutMs, ACTION_TIMEOUT_MS);
	assert.equal(clickSpec.pollMs, ACTION_POLL_MS);
	assert.equal(clickSpec.stableWindowMs, STABLE_WINDOW_MS);
	assert.equal(clickSpec.stableEpsilonPx, STABLE_EPSILON_PX);
	assert.deepEqual(clickSpec.required, ACTIONABILITY_VERB_MATRIX.click);
	clickSpec.required.push("editable");
	assert.deepEqual(ACTIONABILITY_VERB_MATRIX.click, ["unique", "attached", "visible", "stable", "enabled", "inViewport", "receivesEvents", "notOccluded"]);
});

test("actionability model validates supported verbs", () => {
	assert.equal(isActionVerb("click"), true);
	assert.equal(isActionVerb("upload"), true);
	assert.equal(isActionVerb("eval"), false);
});
