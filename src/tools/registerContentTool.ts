import { Type } from "typebox";
import { buildContentScript } from "../content/buildContentScript";
import { errorResult } from "../utils/toolResult";
import { assertBridgeCommandSucceeded } from "./bridgeResultValidation";
import { defaultResultBudget } from "./budgets";
import { distilledTextResult } from "./resultMiddleware";
import { summarizeContentData } from "./summaries/index";
import { asPositiveInt, DEFAULT_TOOL_TIMEOUT_MS, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

export function registerContentTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_content",
		label: "Browser Content",
		description: "Extract readable page content as Markdown from the current or navigated browser tab.",
		promptSnippet: "Extract article/main page content as Markdown with token-friendly summary and artifact output.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_content for readable article/main content before falling back to full HTML or screenshots."],
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Optional URL to navigate to before extraction" })),
			selector: Type.Optional(Type.String({ description: "Optional CSS selector to extract instead of auto-picking article/main content" })),
			includeLinks: Type.Optional(Type.Boolean({ description: "Include Markdown links; default true" })),
			tabId: optionalTargetTabId(),
			detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
			outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
			timeoutMs: Type.Optional(Type.Number({ description: "Bridge timeout in milliseconds" })),
			maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const server = await ensureStarted();
				const timeoutMs = asPositiveInt(params.timeoutMs, 35_000);
				const maxChars = asPositiveInt(params.maxChars, defaultResultBudget("browser_content"));
				if (params.url) {
					const navigation = await server.sendCommand({ cmd: "wait.navigateAndWait", url: params.url, state: "complete", timeoutMs }, { tabId: params.tabId, timeoutMs });
					assertBridgeCommandSucceeded(navigation, "wait.navigateAndWait");
				}
				const captureMaxChars = params.outputPath ? 500_000 : Math.max(maxChars, 120_000);
				const script = buildContentScript({ selector: params.selector, includeLinks: params.includeLinks, maxChars: captureMaxChars });
				const result = await server.executeJavaScript(script, { tabId: params.tabId, timeoutMs: Math.max(timeoutMs, DEFAULT_TOOL_TIMEOUT_MS) });
				const data = result.data as Record<string, unknown> | undefined;
				const markdown = typeof data?.markdown === "string" ? data.markdown : "";
				if (!markdown) throw new Error("browser_content could not extract Markdown content");
				const meta = data ? { ...data, markdown: `[${markdown.length} chars]` } : undefined;
				return await distilledTextResult(markdown, {
					toolName: "browser_content",
					command: params.url ? "navigate+content" : "content",
					detailLevel: params.detailLevel,
					maxChars,
					ctx,
					outputPath: params.outputPath,
					fallbackName: `content-${Date.now()}.md`,
					summary: summarizeContentData(data),
					details: { url: params.url, selector: params.selector, content: meta },
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}
