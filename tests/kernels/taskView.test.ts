import assert from "node:assert/strict";
import test from "node:test";
import { projectTaskView } from "../../src/kernels/abml/taskViewSelection.ts";
import { taskEntityIndex, taskObjectRoot } from "../../src/kernels/abml/taskViewGraph.ts";
import { prepareTaskView } from "../../src/commands/observe/taskViewInput.ts";
import { taskEntity, taskInvoice, taskObservation } from "../helpers/taskView.ts";

test("task query finds canonical evidence beyond generic projection limits and deduplicates record hits", () => {
	const invoice = taskInvoice();
	const observation = taskObservation([
		...Array.from({ length: 80 }, (_, i) => taskInvoice(`INV-${i}`).record),
		invoice.record,
	]);
	const original = JSON.stringify(observation);
	const plan = projectTaskView(
		observation,
		prepareTaskView({ focus: { query: "inv-2048" }, fields: ["备注"], intent: "interact" })!,
	);
	assert.equal(plan.task.status, "resolved");
	assert.equal(plan.task.matchScope.candidateCount, 1);
	assert.equal(plan.bundles.length, 1);
	assert.equal(plan.bundles[0]!.anchor.name, "INV-2048");
	assert.ok(
		plan.bundles[0]!.facts.some((fact) => fact.ref === invoice.button.ref && fact.actions?.includes("click")),
	);
	assert.ok(plan.bundles[0]!.facts.some((fact) => fact.value === "已联系客户"));
	assert.equal(JSON.stringify(observation), original);
	assert.deepEqual(
		projectTaskView(
			observation,
			prepareTaskView({ focus: { query: "inv-2048" }, fields: ["备注"], intent: "interact" })!,
		),
		plan,
	);
});

test("identical button labels never collapse distinct record identities", () => {
	const plan = projectTaskView(
		taskObservation([taskInvoice().record, taskInvoice("INV-2099").record]),
		prepareTaskView({ focus: { query: "Save" }, intent: "locate" })!,
	);
	assert.equal(plan.task.status, "ambiguous");
	assert.equal(plan.task.matchScope.candidateCount, 2);
	assert.deepEqual(
		plan.bundles.map((bundle) => bundle.anchor.name),
		["INV-2048", "INV-2099"],
	);
});

test("related portal errors and global dialogs survive a field-focused task", () => {
	const invoice = taskInvoice();
	const error = taskEntity("portal-error", "alert", "备注不可为空");
	invoice.note.relations = [{ type: "describedBy", targetRef: error.ref, source: "ax", confidence: "high" }];
	const dialog = taskEntity("login", "dialog", "登录已过期", [taskEntity("dismiss", "button", "Cancel")]);
	const plan = projectTaskView(
		taskObservation([invoice.record, error, dialog]),
		prepareTaskView({ focus: { refs: [invoice.note.ref] }, fields: ["备注"] })!,
	);
	assert.ok(plan.bundles[0]!.mandatory);
	const record = plan.bundles.find((bundle) => bundle.candidate)!;
	assert.ok(record.facts.some((fact) => fact.ref === error.ref));
	assert.ok(record.facts.some((fact) => fact.name === "INV-2048"));
	assert.ok(plan.bundles.some((bundle) => bundle.anchor.name === "登录已过期"));
});

test("missing relationships and explicit anchors are disclosed rather than replaced", () => {
	const invoice = taskInvoice();
	invoice.note.relations = [
		{ type: "describedBy", targetRef: "bp-ref://region/missing-error", source: "ax", confidence: "high" },
	];
	const observation = taskObservation([invoice.record]);
	const plan = projectTaskView(observation, prepareTaskView({ focus: { refs: [invoice.note.ref] } })!);
	assert.ok(plan.bundles[0]!.gaps.includes("related-context-unavailable"));
	assert.equal(plan.task.outputScope.contextComplete, false);
	const unresolved = projectTaskView(
		observation,
		prepareTaskView({ focus: { refs: ["bp-ref://control/old-note", invoice.button.ref] } })!,
	);
	assert.equal(unresolved.task.status, "unresolved");
	assert.deepEqual(unresolved.task.unresolvedRefs, ["bp-ref://control/old-note"]);
	assert.ok(!unresolved.bundles.some((bundle) => bundle.anchor.ref === invoice.note.ref));
});

test("zero matches in a virtualized collection do not mean global absence", () => {
	const observation = taskObservation([taskInvoice().record], {
		collections: [
			{
				ref: "bp-ref://region/table",
				kind: "table",
				observed: 25,
				total: 312,
				completeness: "virtualized",
				confidence: "high",
				itemRefs: [],
			},
		],
	});
	const plan = projectTaskView(observation, prepareTaskView({ focus: { query: "not-loaded" } })!);
	assert.equal(plan.task.status, "no-match-in-observed");
	assert.equal(plan.task.observationScope.partialCollectionCount, 1);
	assert.equal(plan.task.observationScope.collections[0]!.total, 312);
	assert.match(plan.task.limitations.join(" "), /unloaded pages were not checked/);
});

test("content-only matching produces evidence without inventing a control or object", () => {
	const plan = projectTaskView(
		taskObservation([], { content: { text: "Late section\n INV-2048 ", complete: false } }),
		prepareTaskView({ focus: { query: "inv-2048" } })!,
	);
	assert.equal(plan.task.status, "unresolved");
	assert.equal(plan.task.matchScope.candidateCount, 0);
	assert.equal(plan.task.matchScope.contentMatchCount, 1);
	assert.equal(plan.bundles[0]!.facts.length, 0);
	assert.equal(plan.task.observationScope.contentComplete, false);
});

test("field changes on an unchanged page return current self-contained evidence", () => {
	const invoice = taskInvoice();
	const observation = taskObservation([invoice.record], {
		delta: "session",
		diff: { appeared: [], disappeared: [], changed: [] },
	});
	for (const fields of [["INV-2048"], ["备注"]]) {
		const plan = projectTaskView(observation, prepareTaskView({ focus: { refs: [invoice.record.ref] }, fields })!);
		assert.ok(plan.bundles[0]!.facts.some((fact) => fact.value === "已联系客户"));
		assert.ok(plan.bundles[0]!.facts.some((fact) => fact.name === "Save"));
	}
});

test("task selection never returns password values or treats check as a business receipt", () => {
	const password = {
		...taskEntity("password", "textbox", "Password"),
		value: "secret",
		hints: { inputKind: "password" },
	};
	const observation = taskObservation([
		password,
		taskEntity("success", "status", "Saved"),
		taskEntity("failure", "alert", "Save failed"),
	]);
	assert.equal(
		projectTaskView(observation, prepareTaskView({ focus: { query: "secret" } })!).task.matchScope.candidateCount,
		0,
	);
	const plan = projectTaskView(observation, prepareTaskView({ focus: { refs: [password.ref] }, intent: "check" })!);
	assert.ok(!JSON.stringify(plan).includes("secret"));
	assert.ok(!("business" in plan.task));
	assert.ok(plan.bundles.some((bundle) => bundle.anchor.name === "Saved"));
	assert.ok(plan.bundles.some((bundle) => bundle.anchor.name === "Save failed"));
});

test("AX ancestry groups context using node identity rather than display scope names", () => {
	const owner = {
		...taskEntity("owner", "form", "Invoice"),
		locators: [{ by: "backendNodeId" as const, value: 100 }],
	};
	const child = { ...taskEntity("child", "textbox", "备注"), hints: { contextAncestorKeys: ["b:99", "b:100"] } };
	const other = {
		...taskEntity("other", "form", "Invoice"),
		locators: [{ by: "backendNodeId" as const, value: 101 }],
	};
	const index = taskEntityIndex([owner, child, other]);
	assert.equal(taskObjectRoot(index, child).ref, owner.ref);
});

test("preferred fields are selected before the internal context bound", () => {
	const children = Array.from({ length: 180 }, (_, i) => taskEntity(`field-${i}`, "textbox", `Field ${i}`));
	const form = taskEntity("large-form", "form", "Large form", children);
	const plan = projectTaskView(
		taskObservation([form]),
		prepareTaskView({ focus: { refs: [form.ref] }, fields: ["Field 179"] })!,
	);
	assert.ok(plan.bundles[0]!.facts.some((fact) => fact.ref === children[179]!.ref));
	assert.ok(plan.bundles[0]!.gaps.includes("context-selection-limit"));
	assert.equal(plan.task.outputScope.contextComplete, false);
});

test("literal hits and changed fields are kept ahead of unrelated bounded context", () => {
	const children = Array.from({ length: 180 }, (_, i) => taskEntity(`large-${i}`, "textbox", `Field ${i}`));
	const form = taskEntity("large", "form", "Record", children);
	const observation = taskObservation([form], {
		diff: {
			appeared: [],
			disappeared: [],
			changed: [{ ref: children[179]!.ref, kind: "value-changed", after: { value: "changed" } }],
		},
	});
	for (const spec of [
		{ focus: { query: "Field 179" }, intent: "locate" },
		{ focus: { refs: [form.ref] }, intent: "check" },
	]) {
		const plan = projectTaskView(observation, prepareTaskView(spec)!);
		assert.ok(plan.bundles[0]!.facts.some((fact) => fact.ref === children[179]!.ref));
	}
});

test("bounded global groups remain counted and absent capture cannot assert no match", () => {
	const alerts = Array.from({ length: 270 }, (_, i) => taskEntity(`alert-${i}`, "alert", `Alert ${i}`));
	const bounded = projectTaskView(taskObservation(alerts), prepareTaskView({ focus: { query: "missing" } })!);
	assert.equal(bounded.task.status, "unresolved");
	assert.equal(bounded.task.outputScope.mandatoryGroups, 270);
	assert.equal(bounded.task.outputScope.mandatoryGroupsFolded, 14);
	const absent = projectTaskView(
		taskObservation([], { content: undefined, actionSpace: undefined, providers: {} }),
		prepareTaskView({ focus: { query: "missing" } })!,
	);
	assert.equal(absent.task.status, "unresolved");
	assert.equal(absent.task.matchScope.complete, false);
});

test("the focused collection's loading boundary precedes unrelated collections", () => {
	const invoice = taskInvoice();
	const collections = Array.from({ length: 15 }, (_, i) => ({
		ref: `bp-ref://region/list-${i}`,
		kind: "table",
		observed: 10,
		completeness: "complete",
		confidence: "high",
		itemRefs: [] as string[],
	}));
	collections.push({
		ref: "bp-ref://region/invoices",
		kind: "table",
		observed: 25,
		completeness: "paginated",
		confidence: "high",
		itemRefs: [invoice.record.ref],
	});
	const observation = taskObservation([invoice.record], { collections });
	const plan = projectTaskView(observation, prepareTaskView({ focus: { refs: [invoice.record.ref] } })!);
	assert.equal(plan.task.observationScope.collections[0]!.ref, "bp-ref://region/invoices");
	assert.equal(plan.task.observationScope.collections[0]!.completeness, "paginated");
	observation.actionSpace!.coverage.captureComplete = false;
	assert.equal(
		projectTaskView(observation, prepareTaskView({ focus: { refs: [invoice.record.ref] } })!).task.outputScope
			.contextComplete,
		false,
	);
});
