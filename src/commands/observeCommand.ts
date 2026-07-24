import { Type } from "typebox";
import { observeErrorResult, runScanObservation } from "./observe/scanRunner.js";
import type { ObserveToolParams } from "./observe/common.js";
import { defineBrowserCommand, resolveLocalTargetTabId, runCommandHandler, sharedTabScopedToolParams, targetTabId } from "./commandRuntime.js";
import { TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import { currentPageIdentity, pageIdentityFromUnknown } from "./observe/pageIdentity.js";
import { samePageIdentity } from "../kernels/session/pageIdentity.js";
import type { ValidationIssue } from "./commandDefinition.js";

export function validateObserveArguments(args: Record<string, unknown>): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (args.fresh === true && args.diff === true) issues.push({ code: "OBSERVE_FRESH_DIFF_CONFLICT", path: "/fresh", message: "browser_observe fresh:true cannot be combined with diff:true" });
	return issues;
}

export function selectDiffBaselineSnapshot(server: BrowserCommandRuntimePort, params: ObserveToolParams): string | undefined {
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const effectiveTabId = resolveLocalTargetTabId(server, targetTabId(params), params.browserSessionId) ?? bridge.defaultTabId;
	const browserSessionId = bridge.browserSessionId;
	const pageIdentity = currentPageIdentity(server, { browserSessionId: params.browserSessionId, tabId: effectiveTabId });
	return server.listObservationSnapshots()
		.filter((snap) => snap.browserSessionId === browserSessionId && snap.tabId === effectiveTabId && samePageIdentity(pageIdentityFromUnknown(snap), pageIdentity) && snap.sourceMode === "scan" && !snap.expired && Boolean(snap.saved?.path))
		.reduce((latest, snap) => latest === undefined || snap.capturedAt > latest.capturedAt ? snap : latest, undefined as ReturnType<BrowserCommandRuntimePort["listObservationSnapshots"]>[number] | undefined)
		?.snapshotId;
}

export function defineObserveCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_observe",
		label: "Browser Observe",
		description: "Return a decision-complete, semantically compressed ABML PageObservation for the current tab.",
		promptSnippet: "Observe the current page as a compact ABML page model with a complete captured action space, refs, context, evidence, deltas, and expandable semantic resources.",
		promptGuidelines: [
			TAB_SCOPED_TOOL_GUIDELINE,
			"Use browser_observe only for page understanding. It returns a bounded semantic projection and exposes omitted captured actions and additional page regions as MCP resources.",
		],
		parameters: strictCommandParameters({
			intent: Type.Optional(Type.String({ description: "Optional relevance hint" })),
			fresh: Type.Optional(Type.Boolean({ description: "Ignore prior observation state and return a fresh observation" })),
			diff: Type.Optional(Type.Boolean({ description: "Diff against the latest observation for this tab" })),
			visual: Type.Optional(Type.String({ enum: ["auto", "always", "never"], description: "Attach a coherent viewport screenshot automatically, always, or never." })),
			...sharedTabScopedToolParams(),
		}),
		validateArguments: validateObserveArguments,
		async execute(params, signal, ctx) {
			return await runCommandHandler(async (): Promise<import("../utils/toolResult.js").BrowserTextCommandResult> => {
				const toolCtx = ctx ?? {};
				const server = await ensureStarted();
				const observeParams = { ...params } as ObserveToolParams;
				// --diff: keep the choice (do I want a diff?) with the agent but resolve the bookkeeping
				// (which snapshotId) here — pick the most recent prior scan snapshot for this tab.
				if (observeParams.baseline === undefined && observeParams.diff === true) {
					const latestSnapshotId = selectDiffBaselineSnapshot(server, observeParams);
					if (latestSnapshotId) observeParams.baseline = latestSnapshotId;
				}
				return await runScanObservation(server, observeParams, toolCtx, signal);
			}, observeErrorResult);
		},
	});
}
