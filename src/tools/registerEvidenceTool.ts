import { Type } from "typebox";
import { nativeCommandToolMetadata } from "../protocol/nativeActionMetadata";
import { summarizeEvidenceData } from "./summaries/index";
import { applyDefaultTimeout, artifactFallbackName, defineBrowserTool, jsonToolResult, runTool, sharedTabScopedToolParams, targetTabId, toolMaxChars, toolTimeoutMs, withTrackedOperation } from "./toolAdapter";
import { DEFAULT_OBSERVATION_TIMEOUT_MS, NativeCommandParamsSchema, NativeStringList, objectParam, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";
import { isRecord } from "../utils/params";

export function registerEvidenceTool({ pi, ensureStarted }: ToolRegistrarContext) {
	defineBrowserTool(pi, {
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
				const commandName = nativeCommandToolMetadata.browser_evidence.command;
				const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
				const rawTabId = targetTabId(params, body);
				const normalizedTabId = typeof rawTabId === "string" ? Number(rawTabId) : typeof rawTabId === "number" ? rawTabId : undefined;
				const trackedTabId = typeof normalizedTabId === "number" && Number.isInteger(normalizedTabId) && normalizedTabId > 0 ? normalizedTabId : undefined;
				const command = { ...body, cmd: commandName };
				const { result, operation } = await withTrackedOperation(server, {
					toolName: "browser_evidence",
					command: commandName,
					browserSessionId,
					tabId: trackedTabId,
					phase: "running",
					progress: 10,
					queueDepth: server.queueDepth(browserSessionId, trackedTabId),
					leaseOwnerHash: server.leaseOwnerHash(browserSessionId, trackedTabId),
				}, _onUpdate, async (handle) => {
					await handle.update({ progress: 45 });
					const result = await server.sendCommand(command, { browserSessionId: params.browserSessionId, tabId: rawTabId as string | number | undefined, timeoutMs });
					await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target } });
					return result;
				});
				return await jsonToolResult(result, params, ctx, {
					toolName: "browser_evidence",
					command: commandName,
					maxChars,
					fallbackName: artifactFallbackName(nativeCommandToolMetadata.browser_evidence.artifactPrefix),
					details: { command: commandName },
					operation,
					artifactValue: { ...result, operation },
					distill: (value) => ({ ...summarizeEvidenceData(isRecord(value) && value.data !== undefined ? value.data : value), operationId: operation.operationId, sourceMode: operation.sourceMode }),
				});
			});
		},
	});
}
