import { taskContext, taskEntityIndex } from "../../src/kernels/abml/taskViewGraph.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { taskEntity, taskObservation } from "../helpers/taskView.ts";
import { prepareTaskView } from "../../src/commands/observe/taskViewInput.ts";
import { projectTaskView } from "../../src/kernels/abml/taskViewSelection.ts";

for (const ownerRole of ["form", "row"]) {
	for (const actionWrapper of ["generic", "group"]) {
		for (const fieldWrapper of ["group", "region"]) {
			test(`${ownerRole} context with ${fieldWrapper} field and ${actionWrapper} actions keeps facts or discloses uncertainty`, () => {
				const identity = taskEntity("identity", ownerRole === "row" ? "cell" : "heading", "INV-2048");
				const note = taskEntity("note", "textbox", "Note");
				const field = taskEntity("field", fieldWrapper, "Notes", [note]);
				const save = taskEntity("save", "button", "Save");
				const other = taskEntity("other", "row", "Other record", [taskEntity("other-save", "button", "Save")]);
				const owner = taskEntity("owner", ownerRole, "Editor", [
					identity,
					taskEntity("field-cell", "generic", "", [field]),
					taskEntity("actions", actionWrapper, "Actions", [save]),
					other,
				]);
				const plan = projectTaskView(
					taskObservation([owner]),
					prepareTaskView({ focus: { refs: [note.ref] }, intent: "interact" })!,
				);
				const bundle = plan.bundles[0]!;
				const refs = new Set(bundle.facts.map((fact) => fact.ref));
				assert.ok(refs.has(identity.ref), "captured same-owner fields must include the record text");
				assert.ok(!refs.has(other.ref));
				assert.ok(!refs.has("bp-ref://control/other-save"));
				if (actionWrapper === "generic") assert.ok(refs.has(save.ref));
				else {
					assert.ok(!refs.has(save.ref), "a name does not prove this group belongs to the same record");
					assert.ok(bundle.gaps.length > 0);
					assert.equal(plan.task.outputScope.contextComplete, false);
				}
			});
		}
	}
}

test("coverage requirements distinguish retained fields, uncertain ownership and bounded selection", () => {
	const note = taskEntity("note", "textbox", "Note");
	const owner = taskEntity("owner", "row", "Record", [
		taskEntity("identity", "cell", "INV-2048"),
		taskEntity("local", "group", "Notes", [note]),
		taskEntity("save", "button", "Save"),
	]);
	const preferences = {
		spec: prepareTaskView({ focus: { refs: [note.ref] }, intent: "interact" })!,
		matchedRefs: new Set<string>(),
		changedRefs: new Set<string>(),
	};
	const complete = taskContext(taskEntityIndex([owner]), note, preferences);
	assert.deepEqual(complete.requirements, {
		local: "complete",
		owner: "complete",
		identity: "complete",
		actions: "complete",
	});
	assert.deepEqual(complete.gaps, []);
	const unknown = taskEntity("unclassified", "group", "Anything", [taskEntity("hidden-action", "button", "Submit")]);
	(owner.children as (typeof note)[]).push(unknown);
	const uncertain = taskContext(taskEntityIndex([owner]), note, preferences);
	assert.equal(uncertain.requirements.owner, "complete");
	assert.equal(uncertain.requirements.identity, "unknown");
	assert.equal(uncertain.requirements.actions, "unknown");
	(owner.children as (typeof note)[]).pop();
	(owner.children as (typeof note)[]).push(
		...Array.from({ length: 140 }, (_, i) => taskEntity(`cell-${i}`, "cell", `Field ${i}`)),
	);
	const bounded = taskContext(taskEntityIndex([owner]), note, preferences);
	assert.equal(bounded.requirements.identity, "incomplete");
	assert.ok(bounded.gaps.includes("context-identity-incomplete"));
	const signal = taskEntity("status", "status", "Saved");
	const global = taskContext(taskEntityIndex([signal]), signal, preferences);
	assert.equal(global.requirements.owner, "not-applicable");
	assert.equal(global.requirements.actions, "not-applicable");
	const cell = taskEntity("unowned-cell", "cell", "INV-unknown");
	const unresolved = taskContext(taskEntityIndex([cell]), cell, {
		...preferences,
		spec: prepareTaskView({ focus: { refs: [cell.ref] }, intent: "interact" })!,
	});
	assert.equal(unresolved.requirements.owner, "unknown");
	assert.equal(unresolved.requirements.actions, "unknown");
});
