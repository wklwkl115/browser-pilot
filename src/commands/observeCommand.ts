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

function provided(args: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(args, key) && args[key] !== undefined;
}

export function validateObserveArguments(args: Record<string, unknown>): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const baselineKeys = ["baseline", "baselineSnapshotId", "baselinePath"].filter((key) => provided(args, key));
	if (baselineKeys.length > 1) issues.push({ code: "OBSERVE_BASELINE_CONFLICT", path: "/", message: `browser_observe accepts only one baseline source, got ${baselineKeys.join(", ")}` });
	if (args.diff === true && baselineKeys.length) issues.push({ code: "OBSERVE_DIFF_BASELINE_CONFLICT", path: "/diff", message: "browser_observe diff:true cannot be combined with an explicit baseline source" });
	if (args.fresh === true && baselineKeys.length) issues.push({ code: "OBSERVE_FRESH_BASELINE_CONFLICT", path: "/fresh", message: "browser_observe fresh:true cannot be combined with a baseline" });
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
			description: "Return the canonical ABML PageObservation for the current tab.",
		promptSnippet: "Observe the current page as the canonical ABML page model with structure, actionables, refs, context, evidence, deltas, and diagnostics.",
		promptGuidelines: [
			TAB_SCOPED_TOOL_GUIDELINE,
				"Use browser_observe only for page understanding. Navigate or issue native commands with browser_command. timeoutMs is a hard deadline, maxChars is the inline ceiling, and outputPath controls the saved artifact.",
		],
		parameters: strictCommandParameters({
			browserSessionId: Type.Optional(Type.String({ description: "Browser automation session id" })),
			timeoutMs: Type.Optional(Type.Number({ description: "Hard observe deadline in milliseconds; render/persist reserve is protected before optional providers run." })),
			maxChars: Type.Optional(Type.Number({ description: "Hard upper bound for the rendered inline PageObservation v3 JSON." })),
			outputPath: Type.Optional(Type.String({ description: "Optional path for the saved PageObservation v3 artifact." })),
				maxNodes: Type.Optional(Type.Number({ description: "Maximum DOM nodes visited" })),
				includeIframes: Type.Optional(Type.Boolean({ description: "Include same-origin iframe content" })),
				baseline: Type.Optional(Type.Union([Type.Array(Type.Object({}, { additionalProperties: true })), Type.Object({}, { additionalProperties: true })], { description: "Prior PageObservation or entity list used for diffing" })),
				baselineSnapshotId: Type.Optional(Type.String({ description: "Snapshot id of a prior PageObservation" })),
				baselinePath: Type.Optional(Type.String({ description: "Path to a prior PageObservation artifact" })),
				actionRef: Type.Optional(Type.String({ description: "Ref of the action that caused the observed delta" })),
				intent: Type.Optional(Type.String({ description: "Optional relevance hint" })),
				fresh: Type.Optional(Type.Boolean({ description: "Ignore the session baseline and force a fresh observation" })),
				diff: Type.Optional(Type.Boolean({ description: "Diff against the latest observation for this tab" })),
			...sharedTabScopedToolParams(),
		}),
		validateArguments: validateObserveArguments,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runCommandHandler(async (): Promise<import("../utils/toolResult.js").BrowserTextCommandResult> => {
				const toolCtx = ctx ?? {};
				const server = await ensureStarted();
				const observeParams = params as ObserveToolParams;
					if (observeParams.baseline === undefined) {
					const raw = params as Record<string, unknown>;
					const baselinePath = typeof raw.baselinePath === "string" ? raw.baselinePath.trim() : "";
					const baselineSnapshotId = typeof raw.baselineSnapshotId === "string" ? raw.baselineSnapshotId.trim() : "";
					if (baselinePath) observeParams.baseline = { saved: { path: baselinePath } };
					else if (baselineSnapshotId) observeParams.baseline = { snapshotId: baselineSnapshotId };
				}
				// --diff: keep the choice (do I want a diff?) with the agent but resolve the bookkeeping
				// (which snapshotId) here — pick the most recent prior scan snapshot for this tab. Explicit
				// baseline still wins; if no prior scan exists, leave baseline unset (full scan, no error).
					if (observeParams.baseline === undefined && observeParams.diff === true) {
					const latestSnapshotId = selectDiffBaselineSnapshot(server, observeParams);
					if (latestSnapshotId) observeParams.baseline = { snapshotId: latestSnapshotId };
				}
					return await runScanObservation(server, observeParams, toolCtx, _onUpdate);
			}, observeErrorResult);
		},
	});
}
