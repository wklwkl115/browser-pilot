import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { taskNeedFixture } from "../helpers/taskNeedFixture.ts";
import { taskEntity } from "../helpers/taskView.ts";
import { pageObservationResult } from "../../src/commands/resultMiddleware.ts";
import {
	OBSERVATION_RESOURCES_DETAIL_KEY,
	type ObservationResourceDescriptor,
} from "../../src/commands/observe/observationResources.ts";

const { compareEquivalentNeedCosts } = await import(
	new URL("../../scripts/lib/equivalent-need-costs.mjs", import.meta.url).href
);

async function setup(t: any, large = false, missing = false) {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-equivalent-need-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const f = taskNeedFixture();
	if (large)
		for (let i = 0; i < 180; i++) {
			const other = taskEntity(`optional-${i}`, "textbox", `Optional ${i}`);
			other.hints = { contextParentRef: f.owner.ref };
			f.entities.push(other);
		}
	if (missing) f.observation.entities = f.entities.filter((entity) => entity.ref !== f.description.ref);
	const result = await pageObservationResult({
		observation: f.observation,
		view: f.spec,
		ctx: { cwd },
		fallbackName: "equivalent.json",
	});
	const descriptors = result.details![OBSERVATION_RESOURCES_DETAIL_KEY] as ObservationResourceDescriptor[];
	return { cwd, f, result, descriptors };
}

test("three configurations reach the same independent need and leave original artifacts unchanged", async (t) => {
	const { cwd, f, result, descriptors } = await setup(t, true);
	const original = await Promise.all(descriptors.map((item) => readFile(item.path, "utf8")));
	const comparison = await compareEquivalentNeedCosts(result, cwd, f.contract);
	assert.equal(comparison.allPathsSatisfied, true);
	assert.equal(comparison.comparisonKind, "equivalent-observation-need");
	for (const [profile, entry] of Object.entries(comparison.paths) as [string, any][]) {
		assert.equal(entry.status, "satisfied");
		assert.deepEqual(entry.missing, []);
		assert.equal(
			entry.contextJsonBytes,
			entry.trace.reduce((sum: number, step: any) => sum + (step.admitted ? step.responseJsonBytes : 0), 0),
		);
		assert.equal(comparison.costsAtEqualSufficiency[profile], entry.contextJsonBytes);
	}
	assert.ok(comparison.paths.page.resourceReads > 0);
	assert.equal(comparison.paths.progressivePacket.resourceReads, 0);
	assert.deepEqual(await Promise.all(descriptors.map((item) => readFile(item.path, "utf8"))), original);
	assert.ok(!JSON.stringify(comparison).includes(cwd));
});

test("insufficient capture is not assigned a successful comparable cost", async (t) => {
	const { cwd, f, result } = await setup(t, false, true);
	const comparison = await compareEquivalentNeedCosts(result, cwd, f.contract);
	assert.equal(comparison.allPathsSatisfied, false);
	assert.equal(comparison.costsAtEqualSufficiency, null);
	for (const entry of Object.values(comparison.paths) as any[]) {
		assert.equal(entry.status, "unsatisfied");
		assert.ok(entry.missing.includes("related-descriptions"));
	}
});

test("a satisfied packet cannot turn other budget-exhausted paths into a valid cost ranking", async (t) => {
	const { cwd, f, result } = await setup(t, true);
	const comparison = await compareEquivalentNeedCosts(result, cwd, f.contract, {
		maxResourceReads: 0,
		maxContextJsonBytes: 512 * 1024,
	});
	assert.equal(comparison.paths.progressivePacket.status, "satisfied");
	assert.equal(comparison.paths.page.status, "budget-exhausted");
	assert.equal(comparison.paths.wholeGroup.status, "budget-exhausted");
	assert.equal(comparison.costsAtEqualSufficiency, null);
});

test("comparison validates the saved canonical digest instead of substituting current data", async (t) => {
	const { cwd, f, result, descriptors } = await setup(t);
	const canonical = descriptors.find((item) => item.jsonPath === "$")!;
	const changed = JSON.parse(await readFile(canonical.path, "utf8"));
	changed.content.text = "Changed capture";
	await writeFile(canonical.path, JSON.stringify(changed));
	await assert.rejects(compareEquivalentNeedCosts(result, cwd, f.contract), /digest/);
});

test("the production page configuration does not force a full read when its inline page meets the need", async (t) => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-inline-need-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const f = taskNeedFixture();
	f.observation.outline = [
		{ container: f.owner.ref, name: "INV-2048", memberCount: 2, memberRefs: [f.note.ref, f.save.ref] },
		{ container: f.description.ref, name: "Review this invoice before saving.", memberCount: 0, memberRefs: [] },
	];
	f.observation.actionSpace = {
		coverage: { captured: 2, captureComplete: true },
		scopes: [],
		items: [f.note, f.save].map((entity) => ({
			ref: entity.ref,
			kind: "control",
			role: entity.role,
			name: entity.name,
			value: entity.value,
			actions: entity.actionability!.actions,
			confidence: "high",
			state: entity.state,
		})),
	};
	f.observation.relations = {
		summary: { formOwner: 2, describedBy: 1 },
		highlights: [
			{ type: "formOwner", sourceRef: f.note.ref, targetRef: f.owner.ref, source: "dom" },
			{ type: "formOwner", sourceRef: f.save.ref, targetRef: f.owner.ref, source: "dom" },
			{ type: "describedBy", sourceRef: f.note.ref, targetRef: f.description.ref, source: "dom" },
		],
	};
	const result = await pageObservationResult({
		observation: f.observation,
		view: f.spec,
		ctx: { cwd },
		fallbackName: "inline.json",
	});
	const comparison = await compareEquivalentNeedCosts(result, cwd, f.contract, {
		maxResourceReads: 0,
		maxContextJsonBytes: 512 * 1024,
	});
	assert.equal(comparison.paths.page.status, "satisfied");
	assert.equal(comparison.paths.page.resourceReads, 0);
	assert.equal(comparison.allPathsSatisfied, true);
});
