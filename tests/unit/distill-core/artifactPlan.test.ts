import test from "node:test";
import assert from "node:assert/strict";
import { artifactPlanReasons, buildSaveTextArtifactPlan } from "../../../src/distill-core/artifactPlan.ts";

test("artifactPlanReasons combines independent save reasons", () => {
	assert.deepEqual(artifactPlanReasons({
		outputPath: ".pi/browser-artifacts/out.json",
		sensitiveRaw: true,
		rawLength: 20_000,
		threshold: 10_000,
		summaryThreshold: 8_000,
		summaryLike: true,
	}), ["explicit-output", "sensitive-raw", "over-threshold", "summary-over-threshold"]);
});

test("artifactPlanReasons omits summary threshold for non-summary results", () => {
	assert.deepEqual(artifactPlanReasons({
		sensitiveRaw: false,
		rawLength: 9_000,
		threshold: 10_000,
		summaryThreshold: 8_000,
		summaryLike: false,
	}), []);
});

test("buildSaveTextArtifactPlan only emits plans with reasons", () => {
	assert.equal(buildSaveTextArtifactPlan({ text: "{}", fallbackName: "out.json", reasons: [] }), undefined);
	assert.deepEqual(buildSaveTextArtifactPlan({
		text: "{}",
		fallbackName: "out.json",
		outputPath: ".pi/browser-artifacts/out.json",
		reasons: ["explicit-output"],
	}), {
		kind: "saveText",
		text: "{}",
		fallbackName: "out.json",
		outputPath: ".pi/browser-artifacts/out.json",
		reasons: ["explicit-output"],
	});
});
