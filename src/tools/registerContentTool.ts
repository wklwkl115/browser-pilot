import { Type } from "typebox";
import { buildContentScript } from "../content/buildContentScript";
import { BrowserBridgeError } from "../driver/errors";
import { executeBrowserWaitWithSupervisor } from "../driver/BrowserWaitSupervisor";
import { assertBridgeCommandSucceeded } from "./bridgeResultValidation";
import { evaluatePageScriptDirect } from "./pageScriptEvaluation";
import { summarizeContentData } from "./summaries/index";
import { artifactFallbackName, runTool, sharedTabScopedToolParams, textToolResult, toolMaxChars } from "./toolAdapter";
import { TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

const DEFAULT_CONTENT_TIMEOUT_MS = 35_000;
const MIN_CONTENT_TIMEOUT_MS = 100;

function contentTimeoutError(message: string, value: unknown): Error {
	const error = new Error(message) as Error & { code?: string; details?: Record<string, unknown> };
	error.code = "INVALID_TIMEOUT";
	error.details = { timeoutMs: value, minTimeoutMs: MIN_CONTENT_TIMEOUT_MS };
	return error;
}

function normalizeContentTimeoutMs(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_CONTENT_TIMEOUT_MS;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) throw contentTimeoutError("browser_content timeoutMs must be a positive number", value);
	const timeoutMs = Math.ceil(n);
	if (timeoutMs < MIN_CONTENT_TIMEOUT_MS) throw contentTimeoutError(`browser_content timeoutMs must be at least ${MIN_CONTENT_TIMEOUT_MS}ms`, value);
	return timeoutMs;
}

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
			...sharedTabScopedToolParams(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				const server = await ensureStarted();
				const timeoutMs = normalizeContentTimeoutMs(params.timeoutMs);
				const maxChars = toolMaxChars(params, "browser_content");
				let navigationData: unknown;
				if (params.url) {
					const navigation = await executeBrowserWaitWithSupervisor(server, { cmd: "wait.navigateAndWait", url: params.url, state: "complete", timeoutMs }, { tabId: params.tabId, timeoutMs });
					assertBridgeCommandSucceeded(navigation, "wait.navigateAndWait");
					navigationData = navigation.data;
				}
				const captureMaxChars = params.outputPath ? 500_000 : Math.max(maxChars, 120_000);
				const script = buildContentScript({ selector: params.selector, includeLinks: params.includeLinks, maxChars: captureMaxChars });
				const result = await evaluatePageScriptDirect(server, script, { tabId: params.tabId, timeoutMs, name: "content_extract" });
				const data = result.data as Record<string, unknown> | undefined;
				if (data?.ok === false) {
					const code = typeof data.error_code === "string" ? data.error_code : "CONTENT_EXTRACTION_FAILED";
					const message = typeof data.error === "string" ? data.error : "browser_content extraction failed";
					const details = data.details && typeof data.details === "object" && !Array.isArray(data.details) ? data.details as Record<string, unknown> : {};
					throw new BrowserBridgeError(code, message, { command: "browser_content", ...details });
				}
				const markdown = typeof data?.markdown === "string" ? data.markdown : "";
				const meta = data ? { ...data, markdown: `[${markdown.length} chars]` } : undefined;
				return await textToolResult(markdown, params, ctx, {
					toolName: "browser_content",
					command: params.url ? "navigate+content" : "content",
					maxChars,
					fallbackName: artifactFallbackName("content"),
					summary: summarizeContentData(data),
					details: { url: params.url, selector: params.selector, navigation: navigationData, content: meta },
					artifactValue: { ...result, navigation: navigationData },
				});
			});
		},
	});
}
