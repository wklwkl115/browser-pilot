import { buildContentScript } from "../../content/buildContentScript.js";
import { BrowserBridgeError } from "../../bridge/protocol/errors.js";
import { executeBrowserWaitWithSupervisor } from "../../browser-command-runtime/waitSupervisor.js";
import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { normalizeNativeErrorCode } from "../../bridge/protocol/nativeErrorCodes.js";
import { isRecord } from "../../utils/params.js";
import { resolveArtifactPath } from "../../artifacts/artifactFiles.js";
import { assertBridgeCommandSucceeded } from "../../bridge/protocol/bridgeResultValidation.js";
import { evaluatePageScriptDirect } from "../../browser-command-runtime/pageScriptEvaluation.js";
import { summarizeContentData } from "../summaries/index.js";
import { artifactFallbackName, resolveLocalTargetTabId, targetTabId, textCommandResult, commandMaxChars, withTrackedOperation, type CommandOnUpdate, type CommandResultContext } from "../commandRuntime.js";
import { modeInferredDetails, modeInferredSummary } from "./renderCache.js";
import { currentObserveSnapshotMeta, normalizeContentTimeoutMs, withObservationMeta, type ObserveToolParams } from "./common.js";

export async function runContentObservation(server: BrowserCommandRuntimePort, params: ObserveToolParams, ctx: CommandResultContext, onUpdate?: CommandOnUpdate) {
	const timeoutMs = normalizeContentTimeoutMs(params.timeoutMs);
	const maxChars = commandMaxChars(params, "browser_observe");
	const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
	const rawTargetRef = targetTabId(params);
	const tabId = resolveLocalTargetTabId(server, rawTargetRef, browserSessionId);
	const fallbackName = artifactFallbackName("observe-content");
	const outputPath = params.outputPath ?? resolveArtifactPath(ctx, undefined, fallbackName);
	const resultParams = { ...params, outputPath };
	const { result, operation } = await withTrackedOperation(server, {
		commandName: "browser_observe",
		command: params.url ? "navigate+content" : "content",
		browserSessionId,
		tabId,
		phase: "running",
		progress: 10,
		queueDepth: server.queueDepth(browserSessionId, tabId),
		leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
		sourceMode: "content",
	}, onUpdate, async (handle) => {
		let navigationData: unknown;
		if (params.url) {
			await handle.update({ progress: 20, phase: "navigating" });
			const navigation = await executeBrowserWaitWithSupervisor(server, { cmd: "wait.navigateAndWait", url: params.url, state: "complete", timeoutMs }, { browserSessionId: params.browserSessionId, tabId: rawTargetRef as number | string | undefined, timeoutMs });
			assertBridgeCommandSucceeded(navigation, "wait.navigateAndWait");
			navigationData = navigation.data;
		}
		await handle.update({ progress: 55, phase: "extracting" });
		const captureMaxChars = params.outputPath ? 500_000 : Math.max(maxChars, 120_000);
		const script = buildContentScript({ selector: params.selector, includeLinks: params.includeLinks, maxChars: captureMaxChars });
		const result = await evaluatePageScriptDirect(server, script, { browserSessionId: params.browserSessionId, tabId: rawTargetRef, timeoutMs, name: "content_extract" });
		return { result, navigationData };
	});
	const data = result.result.data as Record<string, unknown> | undefined;
	if (data?.ok === false) {
		const code = normalizeNativeErrorCode(data.error_code, "CONTENT_EXTRACTION_FAILED");
		const message = typeof data.error === "string" ? data.error : "content extraction failed";
		const details = isRecord(data.details) ? data.details : {};
		throw new BrowserBridgeError(code, message, { command: "browser_observe", mode: "content", ...details });
	}
	const markdown = typeof data?.markdown === "string" ? data.markdown : "";
	const meta = data ? { ...data, markdown: `[${markdown.length} chars]` } : undefined;
	const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "content", outputPath, typeof data?.url === "string" ? data.url : params.url);
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const summary = {
		...withObservationMeta(summarizeContentData(data), "content", "content"),
		...modeInferredSummary(params),
		browserSessionId: bridge.browserSessionId,
		tabId,
		selectionVersion: bridge.selectionVersion,
		selectionVersionAtDispatch: bridge.selectionVersion,
		selectionVersionAtResolve: bridge.selectionVersion,
	};
	return await textCommandResult(markdown, resultParams, ctx, {
		commandName: "browser_observe",
		command: params.url ? "navigate+content" : "content",
		maxChars,
		fallbackName,
		summary,
		details: { mode: "content", modeInferred: modeInferredDetails(params), sourceMode: "content", sourceCommand: "content_extract", url: params.url, selector: params.selector, navigation: result.navigationData, content: meta },
		operation,
		snapshot: snapshotMeta,
		artifactValue: { ...result.result, navigation: result.navigationData, operation, snapshot: snapshotMeta },
	});
}
