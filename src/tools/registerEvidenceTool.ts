import { Type } from "typebox";
import { applyDefaultTimeout, artifactFallbackName, jsonToolResult, runTool, sharedTabScopedToolParams, targetTabId, toolMaxChars, toolTimeoutMs } from "./toolAdapter";
import { DEFAULT_OBSERVATION_TIMEOUT_MS, NativeCommandParamsSchema, NativeStringList, objectParam, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
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
			...sharedTabScopedToolParams(),
			sessionId: Type.Optional(Type.String({ description: "Network recorder session id" })),
			eventTypes: Type.Optional(NativeStringList),
			includeHook: Type.Optional(Type.Boolean({ description: "Include page hook status/events" })),
			includeNetwork: Type.Optional(Type.Boolean({ description: "Include Network recorder status/entries" })),
			includePerformance: Type.Optional(Type.Boolean({ description: "Include performance entries" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				const server = await ensureStarted();
				const body = objectParam(params.params);
				if (params.sessionId && body.sessionId === undefined && body.session_id === undefined) body.sessionId = params.sessionId;
				if (params.eventTypes !== undefined) body.eventTypes = params.eventTypes;
				if (params.includeHook !== undefined) body.includeHook = params.includeHook;
				if (params.includeNetwork !== undefined) body.includeNetwork = params.includeNetwork;
				if (params.includePerformance !== undefined) body.includePerformance = params.includePerformance;
				const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_OBSERVATION_TIMEOUT_MS);
				applyDefaultTimeout(body, timeoutMs);
				const maxChars = toolMaxChars(params, "browser_evidence");
				const result = await server.sendCommand({ ...body, cmd: "evidence.collect" }, { tabId: targetTabId(params, body), timeoutMs });
				return await jsonToolResult(result, params, ctx, {
					toolName: "browser_evidence",
					command: "evidence.collect",
					maxChars,
					fallbackName: artifactFallbackName("evidence"),
					details: { command: "evidence.collect" },
					artifactValue: result,
				});
			});
		},
	});
}
