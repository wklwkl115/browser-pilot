import assert from "node:assert/strict";
import test from "node:test";
import { taskNeedFixture } from "../helpers/taskNeedFixture.ts";
import { taskEntity } from "../helpers/taskView.ts";

const { bindTaskNeed, assessTaskNeed } = await import(
	new URL("../../scripts/lib/task-need-oracle.mjs", import.meta.url).href
);

test("fixture oracle accepts delivered facts without trusting completeness flags", () => {
	const f = taskNeedFixture();
	const need = bindTaskNeed(f.observation, f.contract);
	assert.equal(assessTaskNeed(need, [f.delivery()]).satisfied, true);
	assert.equal(
		assessTaskNeed(need, [
			{
				scope: { contextComplete: true },
				requirements: { local: { evidence: "complete", delivery: "inline" } },
				gaps: [],
			},
		]).satisfied,
		false,
	);
	assert.equal(
		assessTaskNeed(need, [{ ...f.delivery(), scope: { contextComplete: false }, gaps: ["unknown"] }]).satisfied,
		true,
	);
});

for (const mutation of [
	"wrong-ref",
	"wrong-value",
	"missing-description",
	"controls-not-ownership",
	"missing-state",
	"wrong-snapshot",
])
	test(`independent observation need rejects ${mutation}`, () => {
		const f = taskNeedFixture();
		const need = bindTaskNeed(f.observation, f.contract);
		const value = f.delivery();
		const note = value.entities.find((item) => item.ref === f.note.ref)!;
		const save = value.entities.find((item) => item.ref === f.save.ref)!;
		if (mutation === "wrong-ref") note.ref = "bp-ref://control/a-different-record";
		if (mutation === "wrong-value") note.value = "Other record";
		if (mutation === "missing-description")
			value.entities = value.entities.filter((item) => item.ref !== f.description.ref);
		if (mutation === "controls-not-ownership")
			save.relations = [{ type: "controls", targetRef: f.owner.ref, source: "dom" }];
		if (mutation === "missing-state") save.state = {} as typeof save.state;
		if (mutation === "wrong-snapshot") value.snapshotId = "another-snapshot";
		assert.equal(assessTaskNeed(need, [{ ...value, scope: { contextComplete: true }, gaps: [] }]).satisfied, false);
	});

test("unbound capture and contradictory values cannot become sufficient by matching labels", () => {
	const f = taskNeedFixture();
	const original = f.delivery();
	f.observation.entities = f.entities.filter((item) => item.ref !== f.note.ref);
	assert.equal(assessTaskNeed(bindTaskNeed(f.observation, f.contract), [original]).satisfied, false);
	f.observation.entities = f.entities;
	const wrong = f.delivery();
	wrong.entities.find((item) => item.ref === f.note.ref)!.value = "Different";
	assert.equal(
		assessTaskNeed(bindTaskNeed(f.observation, f.contract), [original, wrong]).checks["subject-value"],
		false,
	);
});

test("candidate and blocker disclosure comes from fixture truth, not the projection's status", () => {
	const f = taskNeedFixture();
	const other = taskEntity("duplicate-candidate", "form", "INV-2048");
	other.hints = { selector: "#duplicate" };
	const blocker = taskEntity("known-blocker", "alert", "Approval required");
	blocker.hints = { selector: "#blocker" };
	f.entities.push(other, blocker);
	f.contract.candidates.push({ selector: "#duplicate", role: "form", name: "INV-2048" });
	f.contract.blockers.push({ selector: "#blocker", text: "Approval required" });
	const need = bindTaskNeed(f.observation, f.contract);
	const complete = f.delivery();
	assert.equal(assessTaskNeed(need, [complete]).satisfied, true);
	const hiddenState = f.delivery();
	hiddenState.entities.find((item) => item.ref === blocker.ref)!.state.visible = false;
	assert.equal(assessTaskNeed(need, [hiddenState]).checks["blocking-evidence"], false);
	assert.equal(
		assessTaskNeed(need, [{ ...complete, task: { status: "resolved", matchScope: { candidateCount: 1 } } }]).checks[
			"candidate-disclosure"
		],
		false,
	);
	const hidden = {
		...complete,
		entities: complete.entities.filter((item) => item.ref !== other.ref && item.ref !== blocker.ref),
		task: { status: "ambiguous" },
	};
	const verdict = assessTaskNeed(need, [hidden]);
	assert.equal(verdict.checks["candidate-disclosure"], false);
	assert.equal(verdict.checks["blocking-evidence"], false);
	assert.equal(verdict.readyToAct, undefined);
});

test("exact selector binding rejects aliases from a foreign target and ambiguous local refs", () => {
	const f = taskNeedFixture();
	const foreign = {
		...f.note,
		ref: "bp-ref://control/foreign",
		hints: { selector: "#note", targetId: "foreign-frame" },
	};
	f.entities.push(foreign);
	assert.equal(bindTaskNeed(f.observation, f.contract).subject.ref, f.note.ref);
	delete (foreign.hints as Record<string, unknown>).targetId;
	assert.equal(bindTaskNeed(f.observation, f.contract).subject.ref, undefined);
});

test("ordinary page outlines, action-space resources and relation resources can jointly satisfy the need", () => {
	const f = taskNeedFixture();
	const need = bindTaskNeed(f.observation, f.contract);
	const page = {
		outline: [
			{ container: f.owner.ref, name: f.contract.record.name },
			{ container: f.description.ref, name: f.contract.descriptions[0]!.text },
		],
	};
	const actions = {
		kind: "action-space",
		value: {
			coverage: { captured: 2, captureComplete: true },
			scopes: [],
			items: f.delivery().entities.filter((item) => item.actions?.length),
		},
	};
	const relations = {
		kind: "details",
		value: {
			summary: { formOwner: 2, describedBy: 1 },
			highlights: [
				{ type: "formOwner", sourceRef: f.note.ref, targetRef: f.owner.ref },
				{ type: "formOwner", sourceRef: f.save.ref, targetRef: f.owner.ref },
				{ type: "describedBy", sourceRef: f.note.ref, targetRef: f.description.ref },
			],
		},
	};
	assert.equal(assessTaskNeed(need, [page, actions, relations]).satisfied, true);
	assert.equal(
		assessTaskNeed(need, [page, actions, { task: { status: "resolved", matchScope: { candidateCount: 0 } } }])
			.satisfied,
		false,
	);
});
