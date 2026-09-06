import assert from "node:assert/strict";
import test from "node:test";
import { attachCapturedTaskContext } from "../../src/kernels/abml/taskViewCapture.ts";
import { taskEntity, taskObservation } from "../helpers/taskView.ts";
import { projectTaskView } from "../../src/kernels/abml/taskViewSelection.ts";
import { prepareTaskView } from "../../src/commands/observe/taskViewInput.ts";

function captureFixture() {
	const form = { ...taskEntity("form", "form", "INV-2048"), locators: [{ by: "backendNodeId" as const, value: 1 }] };
	const control = {
		...taskEntity("note", "textbox", "Note"),
		source: "dom" as const,
		locators: [{ by: "css" as const, value: "#note" }],
	};
	const axControl = {
		...control,
		source: "ax" as const,
		locators: [{ by: "backendNodeId" as const, value: 2 }],
		hints: { contextAncestorKeys: ["b:1"] },
	};
	const alert = {
		...taskEntity("alert", "alert", ""),
		locators: [{ by: "backendNodeId" as const, value: 3 }],
		hints: { contextText: "Note requires review" },
	};
	return { form, control, axControl, alert };
}

test("unique captured IDs associate task context without promoting backend locators or execution identity", () => {
	const f = captureFixture();
	const entities = [f.form, f.control, f.alert];
	const before = JSON.stringify(entities);
	const enriched = attachCapturedTaskContext(
		entities,
		[f.form, f.axControl, f.alert],
		[{ sourceKey: "b:2", targetKey: "b:3", type: "describedBy", source: "ax", confidence: "high" }],
		[{ id: "note", backendNodeId: 2 }],
	);
	assert.equal(JSON.stringify(entities), before);
	const control = enriched[1]!;
	assert.deepEqual(control.locators, f.control.locators);
	assert.deepEqual(control.actionability, f.control.actionability);
	assert.equal(control.hints?.backendNodeId, undefined);
	assert.equal(control.hints?.axNodeId, undefined);
	assert.equal(control.hints?.contextParentRef, f.form.ref);
	const plan = projectTaskView(taskObservation(enriched), prepareTaskView({ focus: { refs: [f.control.ref] } })!);
	assert.ok(
		plan.bundles.find((bundle) => bundle.candidate)!.facts.some((fact) => fact.text === "Note requires review"),
	);
});

test("geometry, duplicate IDs, mismatched roles and foreign targets cannot establish task ownership", () => {
	const f = captureFixture();
	for (const ids of [
		[],
		[
			{ id: "note", backendNodeId: 2 },
			{ id: "note", backendNodeId: 99 },
		],
	]) {
		const enriched = attachCapturedTaskContext([f.form, f.control], [f.form, f.axControl], [], ids);
		assert.equal(enriched[1]!.hints?.contextParentRef, undefined);
	}
	for (const control of [
		{ ...f.control, role: "button" },
		{ ...f.control, name: "Different" },
		{ ...f.control, hints: { targetId: "child-frame" } },
	]) {
		const enriched = attachCapturedTaskContext(
			[f.form, control],
			[f.form, f.axControl],
			[],
			[{ id: "note", backendNodeId: 2 }],
		);
		assert.equal(enriched[1]!.hints?.contextParentRef, undefined);
	}
});
