import { extendedEvaluationTasks } from "./browser-eval-extended-tasks.mjs";

const coreTasks = [
	{
		id: "async-form",
		kind: "workflow",
		path: "async-form",
		async run(ctx) {
			const view = await ctx.observe();
			await ctx.input(ctx.ref(view, "Request title"), "type", { text: "Evaluation request", clear: true });
			await ctx.native({ cmd: "network.start", captureBodies: true });
			let saved;
			try {
				saved = await ctx.call("browser_command", {
					command: { cmd: "input.ref", ref: ctx.ref(view, "Send request"), action: "click" },
					expect: { text: { selector: "#result", match: { equals: "CASE-001" } } },
					business: {
						success: {
							allOf: [
								{
									request: {
										url: `${ctx.fixture.url}api/cases?run=${ctx.round}`,
										method: "POST",
										status: 200,
									},
								},
								{
									request: {
										url: `${ctx.fixture.url}api/cases/CASE-001?run=${ctx.round}`,
										method: "GET",
										status: 200,
										json: [
											{ pointer: "/id", equals: "CASE-001" },
											{ pointer: "/title", equals: "Evaluation request" },
										],
									},
								},
							],
						},
					},
				});
			} finally {
				await ctx.native({ cmd: "network.stop" });
			}
			ctx.verified(saved);
			ctx.assert(
				saved.business?.status === "succeeded",
				"BUSINESS_READBACK",
				"Save response and unique-record readback did not establish success",
			);
			ctx.assert(
				JSON.stringify(ctx.fixture.submissions(ctx.round)) === '["Evaluation request"]',
				"EXACTLY_ONCE",
				"Expected exactly one persisted request with the entered title",
			);
			ctx.assert(
				(await ctx.read("document.querySelector('#result').textContent")) === "CASE-001",
				"SAVED_RECORD",
				"Saved record was not displayed",
			);
		},
	},
	{
		id: "async-invoice-lookup",
		kind: "workflow",
		path: "invoices",
		async run(ctx) {
			const view = await ctx.observe();
			await ctx.input(ctx.ref(view, "Invoice status"), "select", { label: "Overdue" });
			ctx.verified(
				await ctx.input(
					ctx.ref(view, "Load invoices"),
					"click",
					{},
					"document.querySelector('#invoice-list').dataset.ready === 'yes'",
				),
			);
			const loaded = await ctx.observe();
			ctx.assert(
				!loaded.actionSpace.items.some((item) => item.name === "Open INV-PAID"),
				"FILTER_RESULT",
				"Paid invoice remained in the overdue results",
			);
			ctx.verified(
				await ctx.input(
					ctx.ref(loaded, "Open INV-OVERDUE"),
					"click",
					{},
					"document.querySelector('#invoice-id')?.textContent === 'INV-OVERDUE'",
				),
			);
			ctx.assert(
				(await ctx.read("document.querySelector('#invoice-id')?.textContent")) === "INV-OVERDUE",
				"NAVIGATION_RESULT",
				"Wrong invoice was opened",
			);
		},
	},
	{
		id: "rerender-ref",
		kind: "workflow",
		path: "rerender",
		async run(ctx) {
			const view = await ctx.observe();
			const saveRef = ctx.ref(view, "Save draft");
			await ctx.input(ctx.ref(view, "Refresh action"), "click");
			ctx.verified(await ctx.input(saveRef, "click", {}, "window.savedCount === 1"));
			ctx.assert(
				(await ctx.read("window.savedCount")) === 1,
				"EXACTLY_ONCE",
				"Rebound control did not save exactly once",
			);
		},
	},
	{
		id: "stale-target-guard",
		kind: "safety",
		path: "guard",
		async run(ctx) {
			const view = await ctx.observe();
			const staleRef = ctx.ref(view, "Safe action");
			await ctx.input(ctx.ref(view, "Replace action"), "click");
			const rejected = await ctx.call(
				"browser_command",
				{ command: { cmd: "input.ref", action: "click", ref: staleRef } },
				["BACKEND_NODE_STALE"],
			);
			ctx.assert(
				rejected.code === "BACKEND_NODE_STALE",
				"STALE_TARGET_ACCEPTED",
				"A semantically different replacement must reject the old ref",
			);
			ctx.assert(
				(await ctx.read("window.dangerCount")) === 0,
				"UNINTENDED_ACTION",
				"The replacement control was clicked",
			);
		},
	},
];

export const evaluationTasks = [...coreTasks.map((task) => ({ ...task, suite: "core" })), ...extendedEvaluationTasks];
