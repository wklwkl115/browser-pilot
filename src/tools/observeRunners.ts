import { buildContentScript } from "../content/buildContentScript.js";
import { BrowserBridgeError } from "../driver/errors.js";
import { executeBrowserWaitWithSupervisor } from "../driver/BrowserWaitSupervisor.js";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer.js";
import { nativeCommandToolMetadata } from "../protocol/nativeActionMetadata.js";
import { normalizeNativeErrorCode } from "../protocol/nativeErrorCodes.js";
import { buildScanScript } from "../scan/buildScanScript.js";
import { createCodedError } from "../utils/codedError.js";
import { isRecord, normalizeTabId } from "../utils/params.js";
import { resolveArtifactPath } from "./artifacts.js";
import { assertBridgeCommandSucceeded } from "./bridgeResultValidation.js";
import { evaluatePageScriptDirect } from "./pageScriptEvaluation.js";
import { summarizeContentData, summarizeHtmlSnapshot, summarizeScanData } from "./summaries/index.js";
import { artifactFallbackName, bridgeNestedErrorResult, jsonToolResult, targetTabId, textToolResult, toolMaxChars, toolTimeoutMs, withTrackedOperation, type ToolOnUpdate, type ToolResultContext } from "./toolAdapter.js";
import { DEFAULT_TOOL_TIMEOUT_MS, objectParam } from "./toolShared.js";

export const DEFAULT_CONTENT_TIMEOUT_MS = 35_000;
export const MIN_CONTENT_TIMEOUT_MS = 100;

export type ObserveMode = "scan" | "content" | "html" | "text" | "tabs";

export type ObserveToolParams = {
	mode?: string;
	browserSessionId?: string;
	tabId?: number | string;
	detailLevel?: string;
	outputPath?: string;
	timeoutMs?: number;
	maxChars?: number;
	selector?: string;
	url?: string;
	includeLinks?: boolean;
	maxNodes?: number;
	includeIframes?: boolean;
	htmlMode?: string;
	params?: unknown;
};

type ObserveRunnerError = Error & { code: "INVALID_TIMEOUT"; details: Record<string, unknown> };

function contentTimeoutError(message: string, value: unknown): ObserveRunnerError {
	return createCodedError({
		name: "ObserveRunnerError",
		code: "INVALID_TIMEOUT",
		message,
		details: { timeoutMs: value, minTimeoutMs: MIN_CONTENT_TIMEOUT_MS },
	}) as ObserveRunnerError;
}

export function normalizeContentTimeoutMs(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_CONTENT_TIMEOUT_MS;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) throw contentTimeoutError("browser_observe content timeoutMs must be a positive number", value);
	const timeoutMs = Math.ceil(n);
	if (timeoutMs < MIN_CONTENT_TIMEOUT_MS) throw contentTimeoutError(`browser_observe content timeoutMs must be at least ${MIN_CONTENT_TIMEOUT_MS}ms`, value);
	return timeoutMs;
}

function withObservationMeta(summary: Record<string, unknown>, mode: ObserveMode, sourceMode: "scan" | "content" | "html"): Record<string, unknown> {
	return { mode, sourceMode, ...summary };
}

function currentObserveSnapshotMeta(server: BrowserBridgeServer, params: ObserveToolParams, sourceMode: "scan" | "content" | "html", savedPath: string | undefined, url: string | undefined) {
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	return server.createObservationSnapshot({
		browserSessionId: bridge.browserSessionId,
		tabId: normalizeTabId(params.tabId) ?? bridge.defaultTabId,
		url,
		frameScope: "tab",
		selectionVersion: bridge.selectionVersion,
		sourceMode,
		capturedAt: Date.now(),
		saved: savedPath ? { path: savedPath } : undefined,
	});
}

function summarizeObserveTabsData(value: unknown): Record<string, unknown> {
	const record = isRecord(value) ? value : {};
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
		tabs: tabs.slice(0, 20).map((tab) => isRecord(tab)
			? {
				tabId: tab.tabId ?? tab.id,
				title: tab.title,
				url: tab.url,
				active: tab.active,
				browserId: tab.browserId,
			}
			: tab),
	};
}

export async function runScanObservation(server: BrowserBridgeServer, params: ObserveToolParams, ctx: ToolResultContext, mode: Extract<ObserveMode, "scan" | "text" | "tabs">, onUpdate?: ToolOnUpdate) {
	const tabs = await server.refreshTabs(5_000, { browserSessionId: params.browserSessionId }).catch(() => server.getTabs());
	const maxChars = toolMaxChars(params, "browser_observe");
	const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
	const tabId = normalizeTabId(params.tabId);
	const fallbackName = artifactFallbackName(mode === "tabs" ? "observe-tabs" : mode === "text" ? "observe-text" : "observe-scan");
	const outputPath = params.outputPath ?? resolveArtifactPath(ctx, undefined, fallbackName);
	const resultParams = { ...params, outputPath };
	if (mode === "tabs") {
		const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
		const tabsOnlyData = {
			tabs_count: tabs.length,
			tabs,
			active_tab: bridge.defaultTabId,
			browserSessionId: bridge.browserSessionId,
			selectionVersion: bridge.selectionVersion,
			selectionVersionAtDispatch: bridge.selectionVersion,
			selectionVersionAtResolve: bridge.selectionVersion,
		};
		const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "scan", outputPath, undefined);
		const trackedTabId = typeof tabId === "number" ? tabId : undefined;
		const { result: toolResult, operation } = await withTrackedOperation(server, {
			toolName: "browser_observe",
			command: "scan.tabs",
			browserSessionId,
			tabId: trackedTabId,
			phase: "running",
			progress: 10,
			queueDepth: server.queueDepth(browserSessionId, trackedTabId),
			leaseOwnerHash: server.leaseOwnerHash(browserSessionId, trackedTabId),
			snapshotId: snapshotMeta.snapshotId,
			sourceMode: "scan",
		}, onUpdate, async (handle): Promise<import("../utils/toolResult.js").PiTextToolResult> => {
			await handle.update({ progress: 80, details: { tabs_count: tabs.length } });
			return await jsonToolResult(tabsOnlyData, resultParams, ctx, {
				toolName: "browser_observe",
				command: "scan.tabs",
				maxChars,
				fallbackName,
				details: { mode: "tabs", sourceMode: "scan", sourceCommand: "tabs.list" },
				operation: { ...operation, snapshotId: snapshotMeta.snapshotId },
				snapshot: snapshotMeta,
				distill: (value) => summarizeObserveTabsData(value),
				artifactValue: { ...tabsOnlyData, operation: { ...operation, snapshotId: snapshotMeta.snapshotId }, snapshot: snapshotMeta },
			});
		});
		return toolResult;
	}
	const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
	const captureMaxChars = params.outputPath ? 500_000 : Math.max(maxChars, 100_000);
	const scanScript = buildScanScript({ textOnly: mode === "text", maxChars: captureMaxChars, maxNodes: params.maxNodes, includeIframes: params.includeIframes });
	const { result: observation, operation } = await withTrackedOperation(server, {
		toolName: "browser_observe",
		command: mode === "text" ? "scan.text" : "scan",
		browserSessionId,
		tabId,
		phase: "running",
		progress: 10,
		queueDepth: server.queueDepth(browserSessionId, tabId),
		leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
		sourceMode: "scan",
	}, onUpdate, async (handle) => {
		await handle.update({ progress: 40 });
		const result = await evaluatePageScriptDirect(server, scanScript, { browserSessionId: params.browserSessionId, tabId: params.tabId, timeoutMs, name: "scan_extract" });
		await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target } });
		return result;
	});
	const data = observation.data as Record<string, unknown> | undefined;
	const content = typeof data?.content === "string" ? data.content : JSON.stringify(data ?? observation.data, null, 2);
	const scanMeta = data ? { ...data, content: `[${content.length} chars]` } : undefined;
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "scan", outputPath, typeof data?.url === "string" ? data.url : undefined);
	const summary = {
		...withObservationMeta(summarizeScanData(data, tabs, { detailLevel: params.detailLevel, maxChars }), mode, "scan"),
		browserSessionId: bridge.browserSessionId,
		tabId,
		selectionVersion: bridge.selectionVersion,
		selectionVersionAtDispatch: bridge.selectionVersion,
		selectionVersionAtResolve: bridge.selectionVersion,
	};
	return await textToolResult(content, resultParams, ctx, {
		toolName: "browser_observe",
		command: mode === "text" ? "scan.text" : "scan",
		maxChars,
		fallbackName,
		summary,
		details: { mode, sourceMode: "scan", sourceCommand: "scan_extract", tabs_count: tabs.length, tabs, active_tab: bridge.defaultTabId, browserSessionId: bridge.browserSessionId, scan: scanMeta },
		operation,
		snapshot: snapshotMeta,
		artifactValue: { ...observation, tabs_count: tabs.length, tabs, active_tab: bridge.defaultTabId, browserSessionId: bridge.browserSessionId, operation, snapshot: snapshotMeta },
	});
}

export async function runContentObservation(server: BrowserBridgeServer, params: ObserveToolParams, ctx: ToolResultContext, onUpdate?: ToolOnUpdate) {
	const timeoutMs = normalizeContentTimeoutMs(params.timeoutMs);
	const maxChars = toolMaxChars(params, "browser_observe");
	const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
	const tabId = normalizeTabId(params.tabId);
	const fallbackName = artifactFallbackName("observe-content");
	const outputPath = params.outputPath ?? resolveArtifactPath(ctx, undefined, fallbackName);
	const resultParams = { ...params, outputPath };
	const { result, operation } = await withTrackedOperation(server, {
		toolName: "browser_observe",
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
			const navigation = await executeBrowserWaitWithSupervisor(server, { cmd: "wait.navigateAndWait", url: params.url, state: "complete", timeoutMs }, { browserSessionId: params.browserSessionId, tabId: params.tabId, timeoutMs });
			assertBridgeCommandSucceeded(navigation, "wait.navigateAndWait");
			navigationData = navigation.data;
		}
		await handle.update({ progress: 55, phase: "extracting" });
		const captureMaxChars = params.outputPath ? 500_000 : Math.max(maxChars, 120_000);
		const script = buildContentScript({ selector: params.selector, includeLinks: params.includeLinks, maxChars: captureMaxChars });
		const result = await evaluatePageScriptDirect(server, script, { browserSessionId: params.browserSessionId, tabId: params.tabId, timeoutMs, name: "content_extract" });
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
		browserSessionId: bridge.browserSessionId,
		tabId,
		selectionVersion: bridge.selectionVersion,
		selectionVersionAtDispatch: bridge.selectionVersion,
		selectionVersionAtResolve: bridge.selectionVersion,
	};
	return await textToolResult(markdown, resultParams, ctx, {
		toolName: "browser_observe",
		command: params.url ? "navigate+content" : "content",
		maxChars,
		fallbackName,
		summary,
		details: { mode: "content", sourceMode: "content", sourceCommand: "content_extract", url: params.url, selector: params.selector, navigation: result.navigationData, content: meta },
		operation,
		snapshot: snapshotMeta,
		artifactValue: { ...result.result, navigation: result.navigationData, operation, snapshot: snapshotMeta },
	});
}

export function observeErrorResult(error: unknown) {
	return bridgeNestedErrorResult(error, { command: "browser_observe", defaultMessage: "browser_observe failed", includeCommandInDetails: true });
}

export async function runHtmlObservation(server: BrowserBridgeServer, params: ObserveToolParams, ctx: ToolResultContext, onUpdate?: ToolOnUpdate) {
	const body = objectParam(params.params);
	if (params.selector !== undefined) body.selector = params.selector;
	if (params.htmlMode !== undefined) body.mode = params.htmlMode;
	const maxChars = toolMaxChars(params, "browser_observe");
	const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
	const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
	const tabId = normalizeTabId(targetTabId(params, body));
	const commandName = nativeCommandToolMetadata.browser_observe_html.command;
	const textFallbackName = artifactFallbackName(nativeCommandToolMetadata.browser_observe_html.artifactPrefix);
	const resultFallbackName = artifactFallbackName(`${nativeCommandToolMetadata.browser_observe_html.artifactPrefix}-result`);
	const outputPath = params.outputPath ?? resolveArtifactPath(ctx, undefined, textFallbackName);
	const resultParams = { ...params, outputPath };
	const { result, operation } = await withTrackedOperation(server, {
		toolName: "browser_observe",
		command: commandName,
		browserSessionId,
		tabId,
		phase: "running",
		progress: 10,
		queueDepth: server.queueDepth(browserSessionId, tabId),
		leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
		sourceMode: "html",
	}, onUpdate, async (handle) => {
		await handle.update({ progress: 45 });
		const result = await server.sendCommand({ ...body, cmd: commandName }, { browserSessionId: params.browserSessionId, tabId: targetTabId(params, body) as number | string | undefined, timeoutMs });
		await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target } });
		return result;
	});
	const data = result.data as Record<string, unknown> | undefined;
	const html = typeof data?.html === "string" ? data.html : undefined;
	const resultMeta = data ? { ...result, data: { ...data, html: html === undefined ? undefined : `[${html.length} chars]` } } : result;
	const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "html", outputPath, typeof data?.url === "string" ? data.url : undefined);
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	if (html !== undefined) {
		const summary = {
			...withObservationMeta(summarizeHtmlSnapshot(html, data), "html", "html"),
			browserSessionId: bridge.browserSessionId,
			tabId,
			selectionVersion: bridge.selectionVersion,
			selectionVersionAtDispatch: bridge.selectionVersion,
			selectionVersionAtResolve: bridge.selectionVersion,
		};
		return await textToolResult(html, resultParams, ctx, {
			toolName: "browser_observe",
			command: commandName,
			maxChars,
			fallbackName: textFallbackName,
			summary,
			details: { mode: "html", sourceMode: "html", sourceCommand: commandName, command: commandName, result: resultMeta },
			operation,
			snapshot: snapshotMeta,
			artifactValue: { ...result, operation, snapshot: snapshotMeta },
		});
	}
	return await jsonToolResult(result, resultParams, ctx, {
		toolName: "browser_observe",
		command: commandName,
		defaultDetailLevel: "preview",
		maxChars,
		fallbackName: resultFallbackName,
		details: { mode: "html", sourceMode: "html", sourceCommand: commandName, command: commandName },
		operation,
		snapshot: snapshotMeta,
		artifactValue: { ...result, operation, snapshot: snapshotMeta },
	});
}
