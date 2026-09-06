import assert from "node:assert/strict";
import test from "node:test";
import { attachNativeTaskRelations } from "../../src/kernels/abml/taskNativeRelations.ts";
import { projectTaskView } from "../../src/kernels/abml/taskViewSelection.ts";
import { prepareTaskView } from "../../src/commands/observe/taskViewInput.ts";
import { taskEntity, taskObservation } from "../helpers/taskView.ts";

function setup() {
	const form = taskEntity("form", "form", "Editor");
	form.hints = { selector: "#form" };
	const identity = taskEntity("id", "generic", "INV-2048");
	identity.hints = { contextParentRef: form.ref };
	const fields = taskEntity("fields", "group", "Fields");
	fields.hints = { contextParentRef: form.ref };
	const actions = taskEntity("actions", "group", "Actions");
	actions.hints = { contextParentRef: form.ref };
	const note = taskEntity("note", "textbox", "Note");
	note.hints = {
		selector: "#note",
		contextParentRef: fields.ref,
		formOwnerObserved: true,
		formOwnerSelector: "#form",
		labelledBySelectors: ["#label"],
		describedBySelectors: ["#error"],
	};
	const save = taskEntity("save", "button", "Save");
	save.hints = {
		selector: "#save",
		contextParentRef: actions.ref,
		formOwnerObserved: true,
		formOwnerSelector: "#form",
	};
	const label = taskEntity("label", "generic", "Note label");
	label.hints = { selector: "#label" };
	const error = taskEntity("error", "generic", "Note requires review");
	error.hints = { selector: "#error" };
	const entities = [form, identity, fields, actions, note, save, label, error];
	const project = () =>
		projectTaskView(
			taskObservation(attachNativeTaskRelations(entities)),
			prepareTaskView({ focus: { refs: [note.ref] }, intent: "interact", fields: ["Note"] })!,
		);
	return { form, identity, fields, actions, note, save, label, error, entities, project };
}

test("native ownership admits proven sibling and external controls with inspectable evidence", () => {
	const f = setup();
	for (const external of [false, true]) {
		if (external) {
			delete f.save.hints!.contextParentRef;
			f.entities.splice(f.entities.indexOf(f.actions), 1);
		}
		const packet = f.project().packets![0]!;
		for (const kind of ["local", "owner", "identity", "actions"] as const)
			assert.equal(
				packet.requirements[kind].evidence,
				"complete",
				`${kind} external=${external}: ${packet.gaps.join(",")}`,
			);
		assert.ok(packet.facts.some((fact) => fact.ref === f.identity.ref));
		assert.ok(packet.facts.some((fact) => fact.ref === f.save.ref));
		assert.ok(packet.facts.some((fact) => fact.ref === f.label.ref));
		assert.ok(packet.facts.some((fact) => fact.ref === f.error.ref));
		assert.ok(!packet.facts.some((fact) => fact.ref === f.actions.ref));
		const edge = packet.relationEvidence!.find(
			(edge) => edge.fromRef === f.save.ref && edge.relation === "formOwner",
		)!;
		assert.equal(edge.toRef, f.form.ref);
		assert.equal(edge.basis, "native-association");
		assert.equal(edge.snapshotId, packet.scope.snapshotId);
	}
});

test("native form ownership cannot absorb another form or a separate row under the same form", () => {
	const f = setup();
	const otherForm = taskEntity("other-form", "form", "Editor");
	otherForm.hints = { selector: "#other-form" };
	const foreign = taskEntity("foreign", "button", "Save other form");
	foreign.hints = { contextParentRef: f.actions.ref, formOwnerSelector: "#other-form", formOwnerObserved: true };
	const row = taskEntity("row", "row", "Other record");
	row.hints = { contextParentRef: f.form.ref };
	const rowSave = taskEntity("row-save", "button", "Save other row");
	rowSave.hints = { contextParentRef: row.ref, formOwnerSelector: "#form", formOwnerObserved: true };
	f.entities.push(otherForm, foreign, row, rowSave);
	const packet = f.project().packets![0]!;
	assert.ok(packet.facts.some((fact) => fact.ref === f.save.ref));
	assert.ok(!packet.facts.some((fact) => [foreign.ref, rowSave.ref, row.ref].includes(fact.ref)));
});

test("aria-controls and labels never substitute for native ownership", () => {
	const f = setup();
	delete f.save.hints!.formOwnerSelector;
	delete f.save.hints!.formOwnerObserved;
	f.save.relations = [{ type: "controls", targetRef: f.form.ref, source: "ax", confidence: "high" }];
	const packet = f.project().packets![0]!;
	assert.equal(packet.requirements.actions.evidence, "unknown");
	assert.ok(!packet.facts.some((fact) => fact.ref === f.save.ref));
});

test("ambiguous or cross-target selector endpoints remain incomplete without confidence-based guesses", () => {
	const f = setup();
	const duplicate = { ...f.form, ref: "bp-ref://region/duplicate" };
	f.entities.push(duplicate);
	let attached = attachNativeTaskRelations(f.entities);
	assert.equal(attached.find((entity) => entity.ref === f.note.ref)!.hints!.contextRelationsIncomplete, true);
	f.entities.pop();
	f.form.hints!.targetId = "foreign-frame";
	attached = attachNativeTaskRelations(f.entities);
	assert.equal(attached.find((entity) => entity.ref === f.note.ref)!.hints!.contextRelationsIncomplete, true);
	assert.ok(
		!(attached.find((entity) => entity.ref === f.note.ref)!.hints!.contextRelations as any[]).some(
			(edge) => edge.type === "formOwner",
		),
	);
});

test("captured null form ownership is not turned into proven action ownership by ancestry", () => {
	const f = setup();
	delete f.note.hints!.formOwnerSelector;
	const packet = f.project().packets![0]!;
	assert.equal(packet.requirements.actions.evidence, "unknown");
	assert.ok(packet.gaps.includes("native-form-owner-absent"));
});

test("clickable labels are dependencies of their fields, not independent owner actions", () => {
	const f = setup();
	for (let i = 0; i < 150; i++) {
		const field = taskEntity(`optional-${i}`, "textbox", `Optional ${i}`);
		field.hints = { formOwnerSelector: "#form", labelledBySelectors: [`#label-${i}`] };
		const label = taskEntity(`label-${i}`, "label", `Optional ${i}`);
		label.actionability = { actions: ["click"], confidence: "high" };
		label.hints = { selector: `#label-${i}`, contextParentRef: f.form.ref };
		f.entities.push(field, label);
	}
	const packet = f.project().packets![0]!;
	assert.ok(packet.scope.contextComplete);
	assert.ok(packet.facts.length < 10);
	assert.ok(packet.facts.every((fact) => !fact.name?.startsWith("Optional")));
});
