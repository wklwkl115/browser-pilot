import { Type } from "typebox";
import { summarizeHtmlSnapshot } from "./resultMiddleware";
import { artifactFallbackName, bridgeNestedErrorResult, jsonToolResult, runTool, sharedTabScopedToolParams, targetTabId, textToolResult, toolMaxChars, toolTimeoutMs } from "./toolAdapter";
import { DEFAULT_TOOL_TIMEOUT_MS, NativeCommandParamsSchema, objectParam, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

function htmlErrorResult(error: unknown) {
	return bridgeNestedErrorResult(error, { command: "html.get", defaultMessage: "html.get failed", includeCommandInDetails: true });
}

export function registerHtmlTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_html",
		label: "Browser HTML",
		description: "Native HTML/text snapshot with optional evidence file output.",
		promptSnippet: "Capture bounded HTML or text snapshots from the target tab.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_html when a targeted HTML/text snapshot is needed instead of a full browser_scan."],
		parameters: Type.Object({
			selector: Type.Optional(Type.String({ description: "CSS selector; omitted means whole document/body" })),
			mode: Type.Optional(Type.String({ description: "fragment | raw | text | inner | outer" })),
			params: Type.Optional(NativeCommandParamsSchema),
			...sharedTabScopedToolParams(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				const server = await ensureStarted();
				const body = objectParam(params.params);
				if (params.selector !== undefined) body.selector = params.selector;
				if (params.mode !== undefined) body.mode = params.mode;
				const maxChars = toolMaxChars(params, "browser_html");
				const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const result = await server.sendCommand({ ...body, cmd: "html.get" }, { tabId: targetTabId(params, body), timeoutMs });
				const data = result.data as Record<string, unknown> | undefined;
				const html = typeof data?.html === "string" ? data.html : undefined;
				const resultMeta = data ? { ...result, data: { ...data, html: html === undefined ? undefined : `[${html.length} chars]` } } : result;
				if (html !== undefined) {
					return await textToolResult(html, params, ctx, {
						toolName: "browser_html",
						command: "html.get",
						maxChars,
						fallbackName: artifactFallbackName("snapshot"),
						summary: summarizeHtmlSnapshot(html, data),
						details: { command: "html.get", result: resultMeta },
						artifactValue: result,
					});
				}
				return await jsonToolResult(result, params, ctx, {
					toolName: "browser_html",
					command: "html.get",
					defaultDetailLevel: "preview",
					maxChars,
					fallbackName: artifactFallbackName("html-result"),
					details: { command: "html.get" },
					artifactValue: result,
				});
			}, htmlErrorResult);
		},
	});
}
