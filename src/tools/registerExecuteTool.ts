import { Type } from "typebox";
import type { BrowserBridgeExecutionResult } from "../driver/types.js";
import { BrowserBridgeError } from "../driver/errors.js";
import { buildScanScript } from "../scan/buildScanScript.js";
import { createBrowserAbmlIntegration } from "../abml/verbs/integration.js";
import { compactError } from "../utils/errors.js";
import { tryJson } from "../utils/json.js";
import { normalizeTabId } from "../utils/params.js";
import { isRecord } from "../utils/records.js";
import { summarizeGenericValue } from "./summaries/index.js";
import { artifactFallbackName, defineBrowserTool, jsonToolResult, runTool, sharedTabScopedToolParams, toolMaxChars, toolTimeoutMs, withTrackedOperation } from "./toolAdapter.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictToolParameters } from "./toolShared.js";
import type { ToolRegistrarContext } from "./toolShared.js";

type MonitorScanResult = {
	ok: boolean;
	content?: string;
	url?: string;
	error?: Record<string, unknown>;
	source?: "abml-read" | "legacy-scan";
};

type MonitorMetadata = {
	beforeOk: boolean;
	afterOk: boolean;
	beforeChars: number;
	afterChars: number;
	changed: number;
	top_change?: string;
	navigated?: boolean;
	afterUnreliable?: boolean;
	urlBefore?: string;
	urlAfter?: string;
	beforeError?: Record<string, unknown>;
	afterError?: Record<string, unknown>;
	beforeSource?: "abml-read" | "legacy-scan";
	afterSource?: "abml-read" | "legacy-scan";
};

function textLines(value: unknown): string[] {
	return String(value || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function diffScanContent(before: unknown, after: unknown): { changed: number; top_change?: string } {
	const beforeSet = new Set(textLines(before));
	const added = textLines(after).filter((line) => !beforeSet.has(line));
	return { changed: added.length, top_change: added[0]?.slice(0, 2_000) };
}

function detectCommandLikeScript(script: string): boolean {
	const trimmed = script.trim();
	if (!trimmed.startsWith("{")) return false;
	const parsed = tryJson(trimmed);
	return isRecord(parsed) && typeof parsed.cmd === "string";
}

async function monitorScan(server: Awaited<ReturnType<ToolRegistrarContext["ensureStarted"]>>, scanScript: string, options: { browserSessionId?: string; tabId?: unknown; timeoutMs: number }): Promise<MonitorScanResult> {
	try {
		const runtime = createBrowserAbmlIntegration(server, { browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs, maxChars: 50_000 });
		const abml = await runtime.readStructure({ browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs, maxChars: 50_000 });
		if (abml?.ok && abml.data && typeof abml.data === "object") {
			const summary = (abml.data as Record<string, unknown>).summary as Record<string, unknown> | undefined;
			const content = typeof summary?.textPreview === "string" ? summary.textPreview : JSON.stringify(abml.entities ?? [], null, 2);
			const url = typeof summary?.url === "string" ? summary.url : undefined;
			return { ok: true, content, url, source: "abml-read" };
		}
		const result = await server.executeJavaScript(scanScript, { browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs });
		const content = (result.data as Record<string, unknown> | undefined)?.content;
		return { ok: true, content: typeof content === "string" ? content : undefined, source: "legacy-scan" };
	} catch (error) {
		return { ok: false, error: compactError(error, "MONITOR_SCAN_FAILED") };
	}
}

async function executeJavaScriptWithMonitor(server: Awaited<ReturnType<ToolRegistrarContext["ensureStarted"]>>, script: string, options: { browserSessionId?: string; tabId?: unknown; timeoutMs: number }): Promise<BrowserBridgeExecutionResult & { monitor: MonitorMetadata }> {
	const monitorTimeoutMs = Math.min(Math.max(500, options.timeoutMs), 5_000);
	const scanScript = buildScanScript({ textOnly: false, maxChars: 50_000, maxNodes: 3_000 });
	const before = await monitorScan(server, scanScript, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: monitorTimeoutMs });
	const executed = await server.executeJavaScript(script, { browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs });
	const after = await monitorScan(server, scanScript, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: monitorTimeoutMs });
	const diff = before.ok && after.ok ? diffScanContent(before.content, after.content) : { changed: 0, top_change: undefined };
	// A script that navigates/reloads makes the same-document line diff meaningless: the after-read
	// races the navigation and often sees no NEW lines → a misleading `changed: 0`. `summary.url` comes
	// from the page's location.href (updated synchronously on assignment), so a url change is the reliable
	// signal. Flag it so `changed: 0` is never read as "nothing happened" (observed in a real agent
	// session: a click that navigated to the next chapter reported changed:0). For navigation-level change
	// detection use browser_wait + a baseline observe (treeDiff), not monitor.
	const navigated = !!(before.url && after.url && before.url !== after.url);
	const afterUnreliable = before.ok && !after.ok;
	return {
		...executed,
		monitor: {
			beforeOk: before.ok,
			afterOk: after.ok,
			beforeChars: typeof before.content === "string" ? before.content.length : 0,
			afterChars: typeof after.content === "string" ? after.content.length : 0,
			...diff,
			...(navigated ? { navigated: true, urlBefore: before.url, urlAfter: after.url } : {}),
			...(afterUnreliable ? { afterUnreliable: true } : {}),
			beforeError: before.error,
			afterError: after.error,
			beforeSource: before.source,
			afterSource: after.source,
		},
	};
}

export function registerExecuteTool({ pi, ensureStarted }: ToolRegistrarContext) {
	defineBrowserTool(pi, {
		name: "browser_execute",
		label: "Browser Execute",
		description: "Execute JavaScript in a connected real browser tab.",
		promptSnippet: "Execute JavaScript in a real browser tab.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_execute for precise browser actions; return explicit values from async JavaScript."],
		parameters: strictToolParameters({
			script: Type.String({ description: "JavaScript source." }),
			...sharedTabScopedToolParams(),
			monitor: Type.Optional(Type.Boolean({ description: "Capture compact before/after scan diff for JavaScript mode. Default false to avoid token and latency overhead." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				if (!params.script) throw new BrowserBridgeError("INVALID_RULE", "browser_execute requires script", { toolName: "browser_execute" });
				if (detectCommandLikeScript(params.script)) {
					throw new BrowserBridgeError("INVALID_RULE", "browser_execute only accepts JavaScript; use browser_command for bridge commands", { toolName: "browser_execute", recovery: { useTool: "browser_command" } });
				}
				const server = await ensureStarted();
				const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = toolMaxChars(params, "browser_execute");
				const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
				const tabId = normalizeTabId(params.tabId);
				const { result: jsResult, operation } = await withTrackedOperation(server, {
					toolName: "browser_execute",
					command: "javascript",
					browserSessionId,
					tabId,
					phase: "running",
					progress: 5,
					queueDepth: server.queueDepth(browserSessionId, tabId),
					leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
				}, _onUpdate, async (handle) => {
					await handle.update({ progress: params.monitor === true ? 15 : 35 });
					const result = params.monitor === true
						? await executeJavaScriptWithMonitor(server, params.script, { browserSessionId, tabId: params.tabId, timeoutMs })
						: await server.executeJavaScript(params.script, { browserSessionId, tabId: params.tabId, timeoutMs });
					await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target } });
					return result;
				});
				return await jsonToolResult(jsResult, params, ctx, {
					toolName: "browser_execute",
					command: "javascript",
					defaultDetailLevel: "preview",
					maxChars,
					fallbackName: artifactFallbackName("execute"),
					details: { mode: "javascript", monitor: params.monitor === true },
					operation,
					artifactValue: { ...jsResult, operation },
					distill: (value) => {
						const generic = summarizeGenericValue(value);
						// H1: mark when the script's return value is already fully inline in summary.data so
						// artifactReadActions can suppress the misleading correlation-ID nextActions hints
						// (blind-eval H1, n=2). The generic summarizer inlines small values; large ones
						// collapse to shape placeholders — detect inline by checking data is not a shape.
						const data = generic.data;
						const dataInline = data !== undefined && data !== null &&
							!(isRecord(data) && (data.type === "array" || data.type === "object" || data.type === "string"));
						const base = { ...generic, operationId: operation.operationId, sourceMode: operation.sourceMode, ...(dataInline ? { dataInline: true } : {}) } as Record<string, unknown>;
						const monitor = isRecord(value) && isRecord(value.monitor) ? value.monitor : undefined;
						if (monitor) {
							base.monitorSource = {
								before: monitor.beforeSource,
								after: monitor.afterSource,
								changed: monitor.changed,
								top_change: monitor.top_change,
								...(monitor.navigated === true ? { navigated: true, urlBefore: monitor.urlBefore, urlAfter: monitor.urlAfter, note: "page navigated — the before/after DOM diff does not span navigation; use browser_wait + a baseline observe (treeDiff) for post-navigation change" } : {}),
								...(monitor.afterUnreliable === true ? { afterUnreliable: true } : {}),
								abmlIntegrated: monitor.beforeSource === "abml-read" || monitor.afterSource === "abml-read",
							};
						}
						return base;
					},
				});
			});
		},
	});
}
