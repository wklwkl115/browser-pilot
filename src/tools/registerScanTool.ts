import { Type } from "typebox";
import { buildScanScript } from "../scan/buildScanScript";
import { evaluatePageScriptDirect } from "./pageScriptEvaluation";
import { summarizeScanData } from "./resultMiddleware";
import { artifactFallbackName, jsonToolResult, runTool, sharedTabScopedToolParams, textToolResult, toolMaxChars, toolTimeoutMs } from "./toolAdapter";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
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
			...sharedTabScopedToolParams(),
			textOnly: Type.Optional(Type.Boolean({ description: "Return visible text instead of simplified DOM" })),
			maxNodes: Type.Optional(Type.Number({ description: "Maximum DOM nodes visited" })),
			includeIframes: Type.Optional(Type.Boolean({ description: "Include same-origin iframe content" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				const server = await ensureStarted();
				const tabs = await server.refreshTabs(5_000, { browserSessionId: params.browserSessionId }).catch(() => server.getTabs());
				const maxChars = toolMaxChars(params, "browser_scan");
				if (params.tabsOnly) {
					const snapshot = server.snapshot({ browserSessionId: params.browserSessionId });
					const tabsOnlyData = { tabs_count: tabs.length, tabs, active_tab: snapshot.defaultTabId, browserSessionId: snapshot.browserSessionId };
					return await jsonToolResult(tabsOnlyData, params, ctx, {
						toolName: "browser_scan",
						command: "tabsOnly",
						maxChars,
						fallbackName: artifactFallbackName("scan-tabs"),
						details: { tabsOnly: true },
						artifactValue: tabsOnlyData,
					});
				}
				const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const captureMaxChars = params.outputPath ? 500_000 : Math.max(maxChars, 100_000);
				const scanScript = buildScanScript({ textOnly: params.textOnly, maxChars: captureMaxChars, maxNodes: params.maxNodes, includeIframes: params.includeIframes });
				const result = await evaluatePageScriptDirect(server, scanScript, { browserSessionId: params.browserSessionId, tabId: params.tabId, timeoutMs, name: "scan_extract" });
				const data = result.data as Record<string, unknown> | undefined;
				const content = typeof data?.content === "string" ? data.content : JSON.stringify(data ?? result.data, null, 2);
				const scanMeta = data ? { ...data, content: `[${content.length} chars]` } : undefined;
				const snapshot = server.snapshot({ browserSessionId: params.browserSessionId });
				return await textToolResult(content, params, ctx, {
					toolName: "browser_scan",
					command: "scan",
					maxChars,
					fallbackName: artifactFallbackName("scan"),
					summary: summarizeScanData(data, tabs),
					details: { tabs_count: tabs.length, tabs, active_tab: snapshot.defaultTabId, browserSessionId: snapshot.browserSessionId, scan: scanMeta },
					artifactValue: { ...result, tabs_count: tabs.length, tabs, active_tab: snapshot.defaultTabId, browserSessionId: snapshot.browserSessionId },
				});
			});
		},
	});
}
