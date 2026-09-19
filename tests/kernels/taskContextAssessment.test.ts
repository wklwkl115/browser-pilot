import assert from "node:assert/strict";
import test from "node:test";
import { assessTaskContext, planOwnerContext } from "../../src/kernels/abml/taskContextCoverage.ts";
import { taskEntityIndex } from "../../src/kernels/abml/taskViewGraph.ts";
import { projectTaskView } from "../../src/kernels/abml/taskViewSelection.ts";
import type { TaskGap } from "../../src/kernels/abml/taskView.ts";
import { taskEvidenceScenario } from "../helpers/taskEvidenceScenario.ts";
import { taskEntity } from "../helpers/taskView.ts";

test("enumeration order cannot erase known capture loss with a later uninspected selection gap", () => {
	const f = taskEvidenceScenario();
	const index = taskEntityIndex(f.entities);
	const issues: Array<Omit<TaskGap, "id" | "remedyIds">> = [
		{
			code: "known-missing-text",
			requirement: "local",
			layer: "capture",
			relatedRefs: [f.note.ref],
			reason: "The required text is truncated.",
		},
		{
			code: "uninspected-index",
			requirement: "local",
			layer: "selection",
			relatedRefs: [],
			reason: "The index is bounded.",
		},
	];
	for (const ordered of [issues, [...issues].reverse()]) {
		const evidence = assessTaskContext({
			anchor: f.note,
			candidates: index.byRef,
			localRefs: new Set(index.byRef.keys()),
			ownerPlan: planOwnerContext(index, f.owner, f.note),
			intent: "interact",
			focused: true,
			issues: ordered,
		});
		for (const kind of ["local", "identity", "actions"] as const) {
			assert.equal(evidence.requirements[kind].evidence, "incomplete");
			assert.deepEqual(
				new Set(evidence.gapDetails.filter((gap) => gap.requirement === kind).map((gap) => gap.layer)),
				new Set(["capture", "selection"]),
			);
		}
	}
});

test("packet and bundle retain known local capture loss even when the global index is bounded", () => {
	const f = taskEvidenceScenario();
	f.note.hints!.contextTextIncomplete = true;
	f.entities.push(...Array.from({ length: 20_000 }, (_, i) => taskEntity(`outside-${i}`, "paragraph", "Unrelated")));
	const plan = projectTaskView(f.observation, f.spec);
	assert.equal(plan.task.observationScope.selectionComplete, false);
	for (const item of [plan.bundles[0]!, plan.packets![0]!]) {
		assert.equal(item.requirements.local.evidence, "incomplete");
		assert.deepEqual(
			new Set(item.gapDetails.filter((gap) => gap.requirement === "local").map((gap) => gap.layer)),
			new Set(["capture", "selection"]),
		);
	}
});
