import { Type } from "typebox";
import { errorResult } from "../utils/toolResult";
import { defaultResultBudget } from "./budgets";
import { distilledJsonResult } from "./resultMiddleware";
import { asPositiveInt, DEFAULT_TOOL_TIMEOUT_MS, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, NativeCommandParamsSchema, NativeStringList, objectParam, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

export function registerEvidenceTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_evidence",
		label: "Browser Evidence",
		description: "Aggregate native browser evidence from hook, network recorder, and performance entries.",
		promptSnippet: "Collect native browser evidence across network/dom/console/error/storage/websocket/crypto/dom_sinks.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_evidence when a single evidence bundle is needed; write large bundles to outputPath."],
		parameters: Type.Object({
			params: Type.Optional(NativeCommandParamsSchema),
			tabId: optionalTargetTabId(),
			sessionId: Type.Optional(Type.String({ description: "Network recorder session id" })),
			eventTypes: Type.Optional(NativeStringList),
			detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
			includeHook: Type.Optional(Type.Boolean({ description: "Include page hook status/events" })),
			includeNetwork: Type.Optional(Type.Boolean({ description: "Include Network recorder status/entries" })),
			includePerformance: Type.Optional(Type.Boolean({ description: "Include performance entries" })),
			outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
			timeoutMs: Type.Optional(Type.Number({ description: "Bridge timeout in milliseconds" })),
			maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const server = await ensureStarted();
				const body = objectParam(params.params);
				if (params.sessionId && body.sessionId === undefined && body.session_id === undefined) body.sessionId = params.sessionId;
				if (params.eventTypes !== undefined) body.eventTypes = params.eventTypes;
				if (params.includeHook !== undefined) body.includeHook = params.includeHook;
				if (params.includeNetwork !== undefined) body.includeNetwork = params.includeNetwork;
				if (params.includePerformance !== undefined) body.includePerformance = params.includePerformance;
				const timeoutMs = asPositiveInt(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				if (body.timeoutMs === undefined && body.timeout_ms === undefined) body.timeoutMs = timeoutMs;
				const maxChars = asPositiveInt(params.maxChars, defaultResultBudget("browser_evidence"));
				const result = await server.sendCommand({ ...body, cmd: "evidence.collect" }, { tabId: params.tabId ?? body.tabId, timeoutMs });
				return await distilledJsonResult(result, {
					toolName: "browser_evidence",
					command: "evidence.collect",
					detailLevel: params.detailLevel,
					maxChars,
					ctx,
					outputPath: params.outputPath,
					fallbackName: `evidence-${Date.now()}.json`,
					details: { command: "evidence.collect" },
					artifactValue: result.data ?? result,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}
