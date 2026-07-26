import { Type } from "typebox";
import { observeErrorResult, runScanObservation } from "./observe/scanRunner.js";
import type { ObserveToolParams } from "./observe/common.js";
import { defineBrowserCommand, resolveLocalTargetTabId, runCommandHandler, sharedTabScopedToolParams, targetTabId } from "./commandRuntime.js";
import { strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import { currentPageIdentity, pageIdentityFromUnknown } from "./observe/pageIdentity.js";
import { samePageIdentity } from "../kernels/session/pageIdentity.js";

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
		description: "Return compact page content, actions, changes, and expandable semantic resources for the current tab.",
		promptGuidelines: [
			"Use browser_observe only for page understanding. It returns a deterministic whole-page semantic map and exposes only irreducible overflow as MCP resources.",
		],
		parameters: strictCommandParameters({
			mode: Type.Optional(Type.String({ enum: ["auto", "full", "diff"], description: "Return an automatic session view, full view, or diff against the latest observation." })),
			visual: Type.Optional(Type.String({ enum: ["auto", "always", "never"], description: "Attach a coherent viewport screenshot automatically, always, or never." })),
			...sharedTabScopedToolParams(),
		}),
		async execute(params, signal, ctx) {
			return await runCommandHandler(async (): Promise<import("../utils/toolResult.js").BrowserTextCommandResult> => {
				const toolCtx = ctx ?? {};
				const server = await ensureStarted();
				const { mode, ...rest } = params as Record<string, unknown>;
				const observeParams = { ...rest, ...(mode === "full" ? { fresh: true } : {}), ...(mode === "diff" ? { diff: true } : {}) } as ObserveToolParams;
				// diff mode keeps the semantic choice with the agent while resolving the bookkeeping
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
