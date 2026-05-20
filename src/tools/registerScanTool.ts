import { Type } from "typebox";
import { buildScanScript } from "../scan/buildScanScript";
import { errorResult } from "../utils/toolResult";
import { defaultResultBudget } from "./budgets";
import { evaluatePageScriptDirect } from "./pageScriptEvaluation";
import { distilledJsonResult, distilledTextResult, summarizeScanData } from "./resultMiddleware";
import { asPositiveInt, DEFAULT_TOOL_TIMEOUT_MS, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

export function registerScanTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_scan",
		label: "Browser Scan",
		description: "Return connected tabs and simplified content from the target real browser tab.",
		promptSnippet: "Inspect browser tabs and simplified DOM/text from the target real browser tab.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_scan with tabsOnly first when the target browser tab is unclear."],
		parameters: Type.Object({
			tabsOnly: Type.Optional(Type.Boolean({ description: "Only return tab list" })),
			tabId: optionalTargetTabId(),
			detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
			textOnly: Type.Optional(Type.Boolean({ description: "Return visible text instead of simplified DOM" })),
			maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
			maxNodes: Type.Optional(Type.Number({ description: "Maximum DOM nodes visited" })),
			includeIframes: Type.Optional(Type.Boolean({ description: "Include same-origin iframe content" })),
			outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
			timeoutMs: Type.Optional(Type.Number({ description: "Bridge timeout in milliseconds" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const server = await ensureStarted();
				const tabs = await server.refreshTabs(5_000).catch(() => server.getTabs());
				if (params.tabsOnly) {
					const tabsOnlyData = { tabs_count: tabs.length, tabs, active_tab: server.snapshot().defaultTabId };
					return await distilledJsonResult(tabsOnlyData, {
						toolName: "browser_scan",
						command: "tabsOnly",
						detailLevel: params.detailLevel,
						maxChars: asPositiveInt(params.maxChars, defaultResultBudget("browser_scan")),
						ctx,
						outputPath: params.outputPath,
						fallbackName: `scan-tabs-${Date.now()}.json`,
						details: { tabsOnly: true },
						artifactValue: tabsOnlyData,
					});
				}
				const maxChars = asPositiveInt(params.maxChars, defaultResultBudget("browser_scan"));
				const timeoutMs = asPositiveInt(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const captureMaxChars = params.outputPath ? 500_000 : Math.max(maxChars, 100_000);
				const scanScript = buildScanScript({ textOnly: params.textOnly, maxChars: captureMaxChars, maxNodes: params.maxNodes, includeIframes: params.includeIframes });
				const result = await evaluatePageScriptDirect(server, scanScript, { tabId: params.tabId, timeoutMs, name: "scan_extract" });
				const data = result.data as Record<string, unknown> | undefined;
				const content = typeof data?.content === "string" ? data.content : JSON.stringify(data ?? result.data, null, 2);
				const scanMeta = data ? { ...data, content: `[${content.length} chars]` } : undefined;
				return await distilledTextResult(content, {
					toolName: "browser_scan",
					command: "scan",
					detailLevel: params.detailLevel,
					maxChars,
					ctx,
					outputPath: params.outputPath,
					fallbackName: `scan-${Date.now()}.json`,
					summary: summarizeScanData(data, tabs),
					details: { tabs_count: tabs.length, tabs, active_tab: server.snapshot().defaultTabId, scan: scanMeta },
					artifactValue: { ...result, tabs_count: tabs.length, tabs, active_tab: server.snapshot().defaultTabId },
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}
