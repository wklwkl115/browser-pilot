import { executeBrowserWaitWithSupervisor } from "../../driver/BrowserWaitSupervisor.js";
import type { BrowserBridgeServer } from "../../driver/BrowserBridgeServer.js";
import { nativeCommandToolMetadata } from "../../protocol/nativeActionMetadata.js";
import { resolveArtifactPath } from "../artifacts.js";
import { assertBridgeCommandSucceeded } from "../bridgeResultValidation.js";
import { summarizeHtmlSnapshot } from "../summaries/index.js";
import { artifactFallbackName, jsonToolResult, resolveLocalTargetTabId, targetTabId, textToolResult, toolMaxChars, toolTimeoutMs, withTrackedOperation, type ToolOnUpdate, type ToolResultContext } from "../toolAdapter.js";
import { DEFAULT_TOOL_TIMEOUT_MS, objectParam } from "../toolShared.js";
import { modeInferredDetails, modeInferredSummary } from "./renderCache.js";
import { currentObserveSnapshotMeta, withObservationMeta, type ObserveToolParams } from "./common.js";

export async function runHtmlObservation(server: BrowserBridgeServer, params: ObserveToolParams, ctx: ToolResultContext, onUpdate?: ToolOnUpdate) {
	const body = objectParam(params.params);
	if (params.selector !== undefined) body.selector = params.selector;
	if (params.htmlMode !== undefined) body.mode = params.htmlMode;
	const maxChars = toolMaxChars(params, "browser_observe");
	const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
	const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
	const rawTargetRef = targetTabId(params, body);
	const tabId = resolveLocalTargetTabId(server, rawTargetRef, browserSessionId);
	const commandName = nativeCommandToolMetadata.browser_observe_html.command;
	const hasNavigation = typeof params.url === "string" && params.url.trim().length > 0;
	const observeCommandName = hasNavigation ? "navigate+html" : commandName;
	const textFallbackName = artifactFallbackName(nativeCommandToolMetadata.browser_observe_html.artifactPrefix);
	const resultFallbackName = artifactFallbackName(`${nativeCommandToolMetadata.browser_observe_html.artifactPrefix}-result`);
	const outputPath = params.outputPath ?? resolveArtifactPath(ctx, undefined, textFallbackName);
	const resultParams = { ...params, outputPath };
	const { result, operation } = await withTrackedOperation(server, {
		toolName: "browser_observe",
		command: observeCommandName,
		browserSessionId,
		tabId,
		phase: "running",
		progress: 10,
		queueDepth: server.queueDepth(browserSessionId, tabId),
		leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
		sourceMode: "html",
	}, onUpdate, async (handle) => {
		let navigationData: unknown;
		if (hasNavigation) {
			await handle.update({ progress: 20, phase: "navigating" });
			const navigation = await executeBrowserWaitWithSupervisor(server, { cmd: "wait.navigateAndWait", url: params.url!, state: "complete", timeoutMs }, { browserSessionId: params.browserSessionId, tabId: rawTargetRef as number | string | undefined, timeoutMs });
			assertBridgeCommandSucceeded(navigation, "wait.navigateAndWait");
			navigationData = navigation.data;
		}
		await handle.update({ progress: 45 });
		const result = await server.sendCommand({ ...body, cmd: commandName }, { browserSessionId: params.browserSessionId, tabId: rawTargetRef as number | string | undefined, timeoutMs });
		await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target } });
		return { result, navigationData };
	});
	const data = result.result.data as Record<string, unknown> | undefined;
	const html = typeof data?.html === "string" ? data.html : undefined;
	const resultMeta = data ? { ...result.result, data: { ...data, html: html === undefined ? undefined : `[${html.length} chars]` } } : result.result;
	const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "html", outputPath, typeof data?.url === "string" ? data.url : params.url);
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	if (html !== undefined) {
		const summary = {
			...withObservationMeta(summarizeHtmlSnapshot(html, data), "html", "html"),
			...modeInferredSummary(params),
			browserSessionId: bridge.browserSessionId,
			tabId,
			selectionVersion: bridge.selectionVersion,
			selectionVersionAtDispatch: bridge.selectionVersion,
			selectionVersionAtResolve: bridge.selectionVersion,
		};
		return await textToolResult(html, resultParams, ctx, {
			toolName: "browser_observe",
			command: observeCommandName,
			maxChars,
			fallbackName: textFallbackName,
			summary,
			details: { mode: "html", modeInferred: modeInferredDetails(params), sourceMode: "html", sourceCommand: commandName, command: commandName, navigation: result.navigationData, result: resultMeta },
			operation,
			snapshot: snapshotMeta,
			artifactValue: { ...result.result, navigation: result.navigationData, operation, snapshot: snapshotMeta },
		});
	}
	return await jsonToolResult(result.result, resultParams, ctx, {
		toolName: "browser_observe",
		command: observeCommandName,
		defaultDetailLevel: "preview",
		maxChars,
		fallbackName: resultFallbackName,
		details: { mode: "html", modeInferred: modeInferredDetails(params), sourceMode: "html", sourceCommand: commandName, command: commandName, navigation: result.navigationData },
		operation,
		snapshot: snapshotMeta,
		artifactValue: { ...result.result, navigation: result.navigationData, operation, snapshot: snapshotMeta },
	});
}
