import { Type } from "typebox";
import { BrowserBridgeError } from "../driver/errors";
import { errorResult } from "../utils/toolResult";
import { defaultResultBudget } from "./budgets";
import { distilledJsonResult, distilledTextResult, summarizeHtmlSnapshot } from "./resultMiddleware";
import { asPositiveInt, DEFAULT_TOOL_TIMEOUT_MS, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, NativeCommandParamsSchema, objectParam, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

function htmlErrorResult(error: unknown) {
	const details = error && typeof error === "object" && "details" in error ? (error as { details?: unknown }).details : undefined;
	const result = details && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>).result : undefined;
	if (result && typeof result === "object" && !Array.isArray(result)) {
		const record = result as Record<string, unknown>;
		if (typeof record.error_code === "string" && record.error_code) {
			const resultDetails = record.details && typeof record.details === "object" && !Array.isArray(record.details) ? record.details as Record<string, unknown> : {};
			return errorResult(new BrowserBridgeError(record.error_code, typeof record.error === "string" ? record.error : "html.get failed", { command: "html.get", ...resultDetails }));
		}
	}
	return errorResult(error);
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
			tabId: optionalTargetTabId(),
			detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
			outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
			timeoutMs: Type.Optional(Type.Number({ description: "Bridge timeout in milliseconds" })),
			maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const server = await ensureStarted();
				const body = objectParam(params.params);
				if (params.selector !== undefined) body.selector = params.selector;
				if (params.mode !== undefined) body.mode = params.mode;
				const maxChars = asPositiveInt(params.maxChars, defaultResultBudget("browser_html"));
				const timeoutMs = asPositiveInt(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const result = await server.sendCommand({ ...body, cmd: "html.get" }, { tabId: params.tabId ?? body.tabId, timeoutMs });
				const data = result.data as Record<string, unknown> | undefined;
				const html = typeof data?.html === "string" ? data.html : undefined;
				const resultMeta = data ? { ...result, data: { ...data, html: html === undefined ? undefined : `[${html.length} chars]` } } : result;
				if (html !== undefined) {
					return await distilledTextResult(html, {
						toolName: "browser_html",
						command: "html.get",
						detailLevel: params.detailLevel,
						maxChars,
						ctx,
						outputPath: params.outputPath,
						fallbackName: `snapshot-${Date.now()}.json`,
						summary: summarizeHtmlSnapshot(html, data),
						details: { command: "html.get", result: resultMeta },
						artifactValue: result,
					});
				}
				return await distilledJsonResult(result, {
					toolName: "browser_html",
					command: "html.get",
					detailLevel: params.detailLevel ?? "preview",
					maxChars,
					ctx,
					outputPath: params.outputPath,
					fallbackName: `html-result-${Date.now()}.json`,
					details: { command: "html.get" },
					artifactValue: result,
				});
			} catch (error) {
				return htmlErrorResult(error);
			}
		},
	});
}
