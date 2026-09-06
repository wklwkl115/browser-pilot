import { checkOwnerContextVariants, checkExactTargetDuringRouteChange } from "./browser-eval-context-checks.mjs";

function taskFact(ctx, bundle, name) {
	const facts = bundle.facts.filter((fact) => fact.name === name && fact.actions?.length);
	ctx.assert(facts.length === 1, "TASK_CONTROL_IDENTITY", `Expected one ${name} control in the selected record`);
	return facts[0].ref;
}

export const taskViewEvaluationTasks = [
	{
		id: "task-view-record",
		suite: "extended",
		kind: "workflow",
		path: "task-view",
		async run(ctx) {
			const page = await ctx.observe();
			const selected = await ctx.observe({
				view: { focus: { query: "INV-2048" }, intent: "interact", fields: ["Note"] },
			});
			ctx.assert(
				selected.task?.status === "resolved" && selected.task.matchScope.candidateCount === 1,
				"TASK_RESOLUTION",
				"Expected one captured invoice object",
			);
			const presentation = ctx.presentation();
			const textView = JSON.parse(presentation.content.find((item) => item.type === "text").text);
			ctx.assert(
				textView.task.matchScope.candidateCount === 1 && textView.bundles.length > 0,
				"TEXT_HOST_CONTEXT",
				"Text-only consumer lost task context",
			);
			const taskResource = selected.frontier.items.find((item) => item.ref === "frontier:task-view");
			const index = await ctx.readResource(taskResource.resourceUri);
			const group = index.groups.find((item) => item.candidate && item.anchor.name === "INV-2048");
			ctx.assert(!!group, "TASK_RESOURCE_INDEX", "Selected record is missing from the snapshot resource");
			const expanded = await ctx.readResource(group.resourceUri);
			ctx.assert(
				expanded.bundle.facts.some(
					(fact) => fact.name === "Note requires review" || fact.text === "Note requires review",
				),
				"PORTAL_CONTEXT",
				"Related error outside the form was omitted",
			);
			const note = taskFact(ctx, expanded.bundle, "Note");
			const save = taskFact(ctx, expanded.bundle, "Save");
			const focused = await ctx.observe({
				mode: "diff",
				view: { focus: { refs: [note] }, fields: ["Note"], intent: "read" },
			});
			ctx.assert(
				focused.bundles.some((bundle) =>
					bundle.facts.some((fact) => fact.ref === note && fact.value === "Draft"),
				),
				"TASK_SELF_CONTAINED",
				"Unchanged task diff omitted the current field",
			);
			ctx.assert(
				JSON.stringify(selected).length < JSON.stringify(page).length,
				"TASK_PROJECTION_SIZE",
				"Focused fixture view did not reduce inline output",
			);
			await ctx.input(note, "type", { text: "Reviewed invoice", clear: true });
			ctx.verified(
				await ctx.input(
					save,
					"click",
					{},
					"window.targetSaves === 1 && window.savedNote === 'Reviewed invoice'",
				),
			);
			const checked = await ctx.observe({ view: { focus: { refs: [note] }, intent: "check" } });
			ctx.assert(
				checked.business === undefined && checked.task.business === undefined,
				"NO_BUSINESS_INFERENCE",
				"Task check invented a business receipt",
			);
			ctx.assert(
				checked.bundles.some((bundle) =>
					bundle.facts.some((fact) => fact.name === "Saved locally" || fact.text === "Saved locally"),
				),
				"CHECK_FEEDBACK",
				"Check omitted visible save feedback",
			);
			ctx.assert(
				checked.bundles.some((bundle) =>
					bundle.facts.some(
						(fact) => fact.name === "Note requires review" || fact.text === "Note requires review",
					),
				),
				"CHECK_COUNTEREVIDENCE",
				"Check omitted the remaining error",
			);
			const historical = await ctx.readResource(group.resourceUri);
			ctx.assert(
				historical.bundle.facts.some((fact) => fact.ref === note && fact.value === "Draft"),
				"SNAPSHOT_RESOURCE",
				"Historical resource changed with the live page",
			);
			ctx.assert(
				await ctx.read(
					"window.targetSaves === 1 && window.otherSaves === 0 && document.querySelector('#other-note').value === 'Other record'",
				),
				"EXACT_TARGET",
				"Task view acted on the wrong record or replayed a save",
			);
			const pending = await ctx.call("browser_execute", {
				script: "return null;",
				business: { success: { text: { selector: "#save-status", match: { equals: "Unsaved" } } } },
				verificationWaitMs: 100,
			});
			ctx.assert(
				pending.business.status === "unknown",
				"BEFORE_NAVIGATION",
				"Unexpected original document evidence",
			);
			await ctx.navigate("task-view");
			const continued = await ctx.call("browser_operation", {
				operationId: pending.operationId,
				action: "wait",
				waitMs: 100,
			});
			ctx.assert(
				continued.business.status === "unknown",
				"DOCUMENT_EVIDENCE_BOUNDARY",
				"Same selector and matching text in a new document were attributed to an old operation",
			);
			await checkOwnerContextVariants(ctx);
			await checkExactTargetDuringRouteChange(ctx);
		},
	},
	{
		id: "task-view-ambiguity",
		suite: "extended",
		kind: "safety",
		path: "task-view",
		async run(ctx) {
			const view = await ctx.observe({ view: { focus: { query: "Save" }, intent: "locate" } });
			ctx.assert(
				view.task.status === "ambiguous" && view.task.matchScope.candidateCount >= 2,
				"CANDIDATE_AMBIGUITY",
				"Multiple matching controls were presented as a unique object",
			);
			const names = new Set(
				view.bundles.filter((bundle) => bundle.candidate).map((bundle) => bundle.anchor.name),
			);
			ctx.assert(
				names.has("INV-2048") && names.has("INV-2099"),
				"RECORD_IDENTITY",
				"Identical buttons lost their record identities",
			);
			const missing = await ctx.observe({ view: { focus: { query: "INV-UNLOADED-9999" } } });
			ctx.assert(
				missing.task.status === "no-match-in-observed",
				"BOUNDED_NO_MATCH",
				"Missing invoice was not scoped to captured evidence",
			);
			ctx.assert(
				await ctx.read("window.targetSaves === 0 && window.otherSaves === 0"),
				"PROJECTION_SIDE_EFFECT",
				"Observation performed a save",
			);
			const focus = view.bundles.find((bundle) => bundle.anchor.name === "INV-2048").anchor.ref;
			await ctx.navigate("task-view");
			const rejected = await ctx.call(
				"browser_observe",
				{ view: { focus: { refs: [focus] } }, visual: "never" },
				["REF_STALE", "HANDLE_NOT_FOUND"],
			);
			ctx.assert(
				["REF_STALE", "HANDLE_NOT_FOUND"].includes(rejected.code),
				"STALE_FOCUS",
				"Navigation silently rebound an explicit focus",
			);
		},
	},
];
