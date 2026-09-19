import assert from "node:assert/strict";
import test from "node:test";
import { prepareTaskView } from "../../src/commands/observe/taskViewInput.ts";
import { projectTaskView } from "../../src/kernels/abml/taskViewSelection.ts";
import { taskEntity, taskObservation } from "../helpers/taskView.ts";

test("missing relations outside selected facts remain capture gaps, independently of field ranking", () => {
	const fields = Array.from({ length: 150 }, (_, i) => taskEntity(`field-${i}`, "textbox", `Field ${i}`));
	const missing = "bp-ref://region/missing-error";
	fields[149]!.relations = [{ type: "describedBy", targetRef: missing, source: "ax", confidence: "high" }];
	const form = taskEntity("form", "form", "INV-2048", fields);
	for (const preferred of ["Field 0", "Field 149"]) {
		const bundle = projectTaskView(
			taskObservation([form]),
			prepareTaskView({
				focus: { refs: [form.ref] },
				intent: "interact",
				fields: [preferred],
			})!,
		).bundles[0]!;
		assert.equal(bundle.requirements.local.evidence, "incomplete");
		assert.equal(bundle.requirements.actions.evidence, "incomplete");
		const gap = bundle.gapDetails.find((item) => item.code === "related-context-unavailable")!;
		assert.equal(gap.layer, "capture");
		assert.ok(gap.relatedRefs.includes(missing));
		assert.ok(
			bundle.remedies.some((remedy) => gap.remedyIds.includes(remedy.id) && remedy.kind === "observe-again"),
		);
	}
});

test("an oversized related error changes delivery, not evidence or the error's necessity", () => {
	const note = taskEntity("note", "textbox", "Note");
	const error = taskEntity("error", "paragraph", "Required explanation ".repeat(900));
	note.relations = [{ type: "describedBy", targetRef: error.ref, source: "ax", confidence: "high" }];
	const owner = taskEntity("owner", "form", "INV-2048", [note, taskEntity("save", "button", "Save")]);
	const bundle = projectTaskView(
		taskObservation([owner, error]),
		prepareTaskView({
			focus: { refs: [note.ref] },
			intent: "interact",
			fields: ["Note"],
		})!,
	).bundles[0]!;
	assert.equal(bundle.requirements.actions.evidence, "complete");
	assert.equal(bundle.requirements.actions.delivery, "partial");
	assert.ok(bundle.requirements.actions.evidenceRefs.includes(error.ref));
	assert.ok(bundle.gapDetails.some((gap) => gap.requirement === "actions" && gap.layer === "selection"));
});

test("captured preferred fields omitted by the context bound are selection gaps, not missing capture", () => {
	const fields = Array.from({ length: 150 }, (_, i) => taskEntity(`field-${i}`, "cell", "Note"));
	const owner = taskEntity("owner", "form", "INV-2048", fields);
	const bundle = projectTaskView(
		taskObservation([owner]),
		prepareTaskView({
			focus: { refs: [owner.ref] },
			fields: ["Note"],
		})!,
	).bundles[0]!;
	assert.equal(bundle.requirements.local.evidence, "complete");
	assert.equal(bundle.requirements.local.delivery, "partial");
	assert.ok(bundle.gapDetails.every((gap) => gap.layer === "selection"));
	assert.ok(bundle.requirements.local.evidenceRefs.length <= 128);
	assert.deepEqual(bundle.gaps, [...new Set(bundle.gapDetails.map((gap) => gap.code))]);
});

test("read-only text needs local evidence without inventing owner or action requirements", () => {
	const paragraph = taskEntity("paragraph", "paragraph", "Captured body");
	const bundle = projectTaskView(
		taskObservation([paragraph]),
		prepareTaskView({
			focus: { refs: [paragraph.ref] },
			intent: "read",
		})!,
	).bundles[0]!;
	assert.equal(bundle.requirements.local.evidence, "complete");
	assert.equal(bundle.requirements.local.delivery, "inline");
	for (const kind of ["owner", "identity", "actions"] as const) {
		assert.equal(bundle.requirements[kind].evidence, "not-applicable");
		assert.equal(bundle.requirements[kind].delivery, "not-applicable");
	}
	assert.deepEqual(bundle.gaps, []);
});

test("a relation outside the bounded index is uninspected selection, not absent capture", () => {
	const note = taskEntity("note", "textbox", "Note");
	const error = taskEntity("last-error", "paragraph", "Captured outside the index");
	note.relations = [{ type: "describedBy", targetRef: error.ref, source: "ax", confidence: "high" }];
	const form = taskEntity("form", "form", "INV-2048", [note]);
	const unrelated = Array.from({ length: 20_000 }, (_, i) => taskEntity(`outside-${i}`, "paragraph", "Unrelated"));
	const bundle = projectTaskView(
		taskObservation([form, ...unrelated, error]),
		prepareTaskView({
			focus: { refs: [note.ref] },
			intent: "interact",
		})!,
	).bundles[0]!;
	assert.equal(bundle.requirements.local.evidence, "unknown");
	const gap = bundle.gapDetails.find((item) => item.code === "related-context-unavailable")!;
	assert.equal(gap.layer, "selection");
	assert.ok(!bundle.remedies.some((remedy) => remedy.kind === "observe-again"));
});
