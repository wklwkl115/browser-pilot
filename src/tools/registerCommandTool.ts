import { Type } from "typebox";
import type { BridgeCommand } from "../protocol/nativeProtocol";
import { rejectUnsafeExecuteCommand } from "./transferValidation";
import { summarizeGenericValue } from "./summaries/index";
import { artifactFallbackName, jsonToolResult, runTool, sharedTabScopedToolParams, toolMaxChars, toolTimeoutMs, withTrackedOperation } from "./toolAdapter";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

function normalizeTabId(value: unknown): number | undefined {
	const tabId = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isInteger(tabId) && tabId > 0 ? tabId : undefined;
}

export function registerCommandTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_command",
		label: "Browser Command",
		description: "Send a native bridge command object through the Pi browser bridge with stable validation and result envelopes.",
		promptSnippet: "Send a bridge command object through the Pi browser bridge.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_command for explicit native bridge commands such as tabs/CDP/management; use browser_execute only for JavaScript."],
		parameters: Type.Object({
			command: Type.Any({ description: "Bridge command object, e.g. {cmd:'tabs',method:'list'} or {cmd:'cdp',...}" }),
			...sharedTabScopedToolParams(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				const server = await ensureStarted();
				const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = toolMaxChars(params, "browser_command");
				if (!params.command || typeof params.command !== "object" || Array.isArray(params.command)) throw new Error("browser_command requires command object");
				const command = params.command as BridgeCommand;
				rejectUnsafeExecuteCommand(command);
				const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
				const tabId = normalizeTabId(params.tabId ?? command.tabId);
				const { result, operation } = await withTrackedOperation(server, {
					toolName: "browser_command",
					command: String(command.cmd || "command"),
					browserSessionId,
					tabId,
					phase: "running",
					progress: 10,
					queueDepth: server.queueDepth(browserSessionId, tabId),
					leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
				}, _onUpdate, async (handle) => {
					await handle.update({ progress: 65 });
					const result = await server.sendCommand(command, { browserSessionId: params.browserSessionId, tabId: params.tabId, timeoutMs });
					await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target } });
					return result;
				});
				return await jsonToolResult(result, params, ctx, {
					toolName: "browser_command",
					command: String(command.cmd || "command"),
					defaultDetailLevel: "preview",
					maxChars,
					fallbackName: artifactFallbackName("command"),
					details: { mode: "command" },
					operation,
					artifactValue: { ...result, operation },
					distill: (value) => ({ ...summarizeGenericValue(value), operationId: operation.operationId, sourceMode: operation.sourceMode }),
				});
			});
		},
	});
}
