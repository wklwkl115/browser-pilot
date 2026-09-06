import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pageObservationResult } from "../../src/commands/resultMiddleware.ts";
import { taskEvidenceScenario } from "../helpers/taskEvidenceScenario.ts";
import { taskEntity } from "../helpers/taskView.ts";

const { compareTaskViewCosts, withSharedExecutionTail } = await import(
	new URL("../../scripts/lib/task-view-costs.mjs", import.meta.url).href
);

for (const bounded of [false, true])
	test(`fixed strategy costs never imply equal information sufficiency (bounded=${bounded})`, async (t) => {
		const cwd = await mkdtemp(path.join(tmpdir(), "browser-task-cost-scope-"));
		t.after(() => rm(cwd, { recursive: true, force: true }));
		const f = taskEvidenceScenario();
		f.observation.snapshot.capturedAt = Date.now();
		if (bounded)
			for (let i = 0; i < 160; i++) {
				const field = taskEntity(`cost-field-${i}`, "cell", `Captured value ${i}`);
				field.hints = { contextParentRef: f.owner.ref };
				f.entities.push(field);
			}
		const result = await pageObservationResult({
			observation: f.observation,
			view: f.spec,
			ctx: { cwd },
			fallbackName: "cost.json",
		});
		const view = JSON.parse(result.content[0]!.text);
		if (bounded) assert.ok(view.task.outputScope.packetsUnavailable > 0);
		const costs = await compareTaskViewCosts(result, cwd);
		assert.equal(costs.comparisonKind, "fixed-snapshot-fixed-reading-strategy");
		assert.equal(costs.informationSufficiency, "not-evaluated");
		assert.equal(costs.equivalentTaskCostValidated, false);
		assert.match(costs.readingPolicy.page, /even if/);
		assert.match(costs.readingPolicy.wholeGroup, /bounds/);
		for (const key of ["page", "wholeGroup", "progressivePacket"])
			assert.ok(Number.isFinite(costs[key]) && costs[key] > 0);
		const withTail = withSharedExecutionTail(costs, 1234);
		assert.equal(withTail.completedTask, undefined);
		assert.equal(withTail.equivalentTaskCostValidated, false);
		assert.equal(withTail.informationSufficiency, "not-evaluated");
		for (const key of ["page", "wholeGroup", "progressivePacket"])
			assert.equal(withTail.fixedStrategyWithSharedTail[key], costs[key] + 1234);
		assert.equal(
			costs.fixedStrategyWithSharedTail,
			undefined,
			"adding a tail must not mutate the original comparison",
		);
	});
