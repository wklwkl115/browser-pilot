function frameTask(mode) {
	return {
		id: `frame-${mode}`,
		suite: "extended",
		kind: "workflow",
		path: `frames/${mode}`,
		async run(ctx) {
			const listed = await ctx.native({ cmd: "frame.list" });
			const frames = listed.result?.frames ?? [];
			const children = frames.filter((frame) => new URL(frame.url).pathname === "/frame-child");
			ctx.assert(children.length === 1, "FRAME_DISCOVERY", "Expected one child form frame");
			const frameId = children[0].frameId;
			ctx.assert(typeof frameId === "string", "FRAME_ID", "Discovered child has no frame ID");
			const childOrigin = new URL(children[0].url).origin;
			ctx.assert(
				childOrigin === (mode === "same" ? new URL(ctx.fixture.url).origin : ctx.fixture.crossOrigin),
				"FRAME_ORIGIN",
				"The child did not load from the intended origin",
			);
			if (mode === "nested") {
				const middle = frames.find((frame) => new URL(frame.url).pathname === "/frame-middle");
				const parent = frames.find((frame) => new URL(frame.url).pathname === "/frames/nested");
				ctx.assert(
					middle && parent && children[0].parentId === middle.frameId && middle.parentId === parent.frameId,
					"FRAME_HIERARCHY",
					"Nested parent/child relationships were not preserved",
				);
			}
			const evaluate = async (expression) => {
				const reply = await ctx.native({
					cmd: "frame.evaluate",
					frameId,
					expression,
					returnByValue: true,
					grantUniversalAccess: false,
					worldName: "browser_pilot_evaluation",
				});
				return reply.result?.result?.result?.value;
			};
			ctx.assert(
				(await evaluate("document.querySelector('#frame-value').value")) === "child",
				"FRAME_READ",
				"Frame read did not select the child document",
			);
			ctx.assert(
				(await evaluate("document.querySelector('#frame-value').value = 'scoped write'")) === "scoped write",
				"FRAME_WRITE",
				"Frame write was not applied",
			);
			ctx.assert(
				(await evaluate("document.querySelector('#frame-value').value")) === "scoped write",
				"FRAME_PERSISTENCE",
				"Child value did not persist",
			);
			ctx.assert(
				(await ctx.read("document.querySelector('#frame-value').value")) === "parent",
				"FRAME_SCOPE",
				"Frame operation modified the parent input",
			);
			if (mode !== "same") {
				const expression =
					mode === "cross"
						? "document.querySelector('#child-frame').contentDocument === null"
						: "document.querySelector('#child-frame').contentDocument.querySelector('iframe').contentDocument === null";
				ctx.assert(
					(await ctx.read(expression)) === true,
					"FRAME_ORIGIN_BOUNDARY",
					"Cross-origin access boundary was weakened",
				);
			}
		},
	};
}

export const extendedEvaluationTasks = [
	{
		id: "failed-submit-no-replay",
		suite: "extended",
		kind: "safety",
		path: "failed-submit",
		async run(ctx) {
			const view = await ctx.observe();
			ctx.verified(
				await ctx.input(
					ctx.ref(view, "Send failing request"),
					"click",
					{},
					"document.querySelector('#status').dataset.failed === 'yes'",
				),
			);
			ctx.assert(
				ctx.fixture.failedRequests(ctx.round) === 1,
				"DUPLICATE_REQUEST",
				"Failed submission was sent more than once",
			);
			ctx.assert(
				await ctx
					.read("({status:document.querySelector('#status').dataset.httpStatus,saved:window.savedCount})")
					.then((value) => value.status === "503" && value.saved === 0),
				"FALSE_SUCCESS",
				"Server rejection was reported as a successful save",
			);
		},
	},
	{
		id: "spa-ref-continuity",
		suite: "extended",
		kind: "workflow",
		path: "spa",
		async run(ctx) {
			const view = await ctx.observe();
			const name = ctx.ref(view, "Workspace name");
			const boot = await ctx.read("window.documentBoot");
			ctx.verified(
				await ctx.input(ctx.ref(view, "Open settings"), "click", {}, "location.pathname === '/spa/settings'"),
			);
			ctx.verified(
				await ctx.input(
					name,
					"type",
					{ text: "Updated workspace", clear: true },
					"document.querySelector('#workspace-name').value === 'Updated workspace'",
				),
			);
			ctx.assert(
				(await ctx.read("window.documentBoot")) === boot,
				"SPA_DOCUMENT_REPLACED",
				"SPA task unexpectedly reloaded the document",
			);
		},
	},
	{
		id: "multitab-ref-ownership",
		suite: "extended",
		kind: "safety",
		path: "tab-owner",
		async run(ctx) {
			const view = await ctx.observe();
			const save = ctx.ref(view, "Save draft");
			const other = await ctx.call("browser_tabs", {
				action: "create",
				url: `${ctx.fixture.url}tab-owner?other=1`,
				active: true,
			});
			const targetRef = other.tabs?.[0]?.targetRef;
			ctx.assert(Boolean(targetRef), "TAB_CREATION", "Second tab has no stable target");
			try {
				await ctx.call("browser_command", { targetRef, command: { cmd: "wait.loadState", state: "complete" } });
				ctx.verified(await ctx.input(save, "click", {}, "window.savedCount === 1"));
				ctx.assert(
					(await ctx.read("window.savedCount")) === 1,
					"OWNER_NOT_UPDATED",
					"Owning tab was not updated",
				);
				const untouched = await ctx.call("browser_execute", {
					targetRef,
					readOnly: true,
					script: "window.savedCount",
				});
				ctx.assert(untouched.result === 0, "WRONG_TAB_WRITE", "The active non-owning tab was modified");
			} finally {
				await ctx.call("browser_tabs", { action: "close", targetRef });
			}
		},
	},
	frameTask("same"),
	frameTask("cross"),
	frameTask("nested"),
	{
		id: "occluded-control-guard",
		suite: "extended",
		kind: "safety",
		path: "occlusion",
		async run(ctx) {
			const view = await ctx.observe();
			const protectedRef = ctx.ref(view, "Protected action");
			await ctx.input(ctx.ref(view, "Cover action"), "click");
			const rejected = await ctx.call(
				"browser_command",
				{ command: { cmd: "input.ref", ref: protectedRef, action: "click" } },
				["TARGET_OCCLUDED"],
			);
			ctx.assert(rejected.code === "TARGET_OCCLUDED", "OCCLUSION_ACCEPTED", "Covered target did not fail closed");
			ctx.assert(
				(await ctx.read("window.protectedCount")) === 0,
				"OCCLUDED_WRITE",
				"Covered control was activated",
			);
		},
	},
	{
		id: "browser-reconnect",
		suite: "extended",
		kind: "recovery",
		path: "rerender",
		async run(ctx) {
			const old = ctx.ref(await ctx.observe(), "Save draft");
			await ctx.restart();
			await ctx.navigate("rerender");
			const rejected = await ctx.call(
				"browser_command",
				{ command: { cmd: "input.ref", ref: old, action: "click" } },
				["SESSION_NOT_FOUND", "TAB_NOT_FOUND", "REF_STALE", "REF_NOT_FOUND", "BACKEND_NODE_STALE"],
			);
			ctx.assert(Boolean(rejected.code), "OLD_SESSION_REF_ACCEPTED", "Previous browser session ref was accepted");
			ctx.assert(
				(await ctx.read("window.savedCount")) === 0,
				"RECONNECT_WRONG_WRITE",
				"Stale session ref changed the new browser",
			);
			const fresh = ctx.ref(await ctx.observe(), "Save draft");
			ctx.verified(await ctx.input(fresh, "click", {}, "window.savedCount === 1"));
		},
	},
];
