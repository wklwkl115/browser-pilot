import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import type { BrowserTextCommandResult } from "../../utils/toolResult.js";
import { jsonCommandResult, withTrackedOperation, type CommandOnUpdate, type CommandResultContext } from "../commandRuntime.js";
import { currentObserveSnapshotMeta, type ObserveToolParams } from "./common.js";
import { legacyProjectionDetails, legacyProjectionSummary, modeInferredDetails } from "./renderCache.js";

function summarizeTabs(value: unknown): Record<string, unknown> {
	const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const tabs = Array.isArray(record.tabs) ? record.tabs : [];
	return {
		mode: "tabs",
		sourceMode: "scan",
		tabs_count: Number(record.tabs_count || tabs.length || 0),
		active_tab: record.active_tab,
		browserSessionId: record.browserSessionId,
		selectionVersion: record.selectionVersion,
		selectionVersionAtDispatch: record.selectionVersionAtDispatch,
		selectionVersionAtResolve: record.selectionVersionAtResolve,
		tabs: tabs.slice(0, 20).map((tab) => tab && typeof tab === "object" && !Array.isArray(tab)
			? {
				tabId: (tab as Record<string, unknown>).tabId ?? (tab as Record<string, unknown>).id,
				title: (tab as Record<string, unknown>).title,
				url: (tab as Record<string, unknown>).url,
				active: (tab as Record<string, unknown>).active,
				browserId: (tab as Record<string, unknown>).browserId,
			}
			: tab),
	};
}

export async function runTabsObservation(options: {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	resultParams: ObserveToolParams;
	tabs: unknown[];
	tabId: number | undefined;
	browserSessionId: string | undefined;
	outputPath: string | undefined;
	maxChars: number;
	fallbackName: string;
	ctx: CommandResultContext;
	onUpdate?: CommandOnUpdate;
}): Promise<BrowserTextCommandResult> {
	const { server, params, resultParams, tabs, tabId, browserSessionId, outputPath, maxChars, fallbackName, ctx, onUpdate } = options;
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const data = {
		tabs_count: tabs.length,
		tabs,
		active_tab: bridge.defaultTabId,
		browserSessionId: bridge.browserSessionId,
		selectionVersion: bridge.selectionVersion,
		selectionVersionAtDispatch: bridge.selectionVersion,
		selectionVersionAtResolve: bridge.selectionVersion,
	};
	const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "scan", outputPath, undefined);
	const { result } = await withTrackedOperation(server, {
		commandName: "browser_observe",
		command: "scan.tabs",
		browserSessionId,
		tabId,
		phase: "running",
		progress: 10,
		queueDepth: server.queueDepth(browserSessionId, tabId),
		leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
		snapshotId: snapshotMeta.snapshotId,
		sourceMode: "scan",
	}, onUpdate, async (handle): Promise<BrowserTextCommandResult> => {
		await handle.update({ progress: 80, details: { tabs_count: tabs.length } });
		return await jsonCommandResult(data, resultParams, ctx, {
			commandName: "browser_observe",
			command: "scan.tabs",
			maxChars,
			fallbackName,
			details: { mode: "tabs", modeInferred: modeInferredDetails(params), ...legacyProjectionDetails(params, "tabs"), sourceMode: "scan", sourceCommand: "tabs.list" },
			operation: { ...handle.operation, snapshotId: snapshotMeta.snapshotId },
			snapshot: snapshotMeta,
			distill: (value) => ({ ...summarizeTabs(value), ...legacyProjectionSummary(params, "tabs") }),
			artifactValue: { ...data, operation: { ...handle.operation, snapshotId: snapshotMeta.snapshotId }, snapshot: snapshotMeta },
		});
	});
	return result;
}
