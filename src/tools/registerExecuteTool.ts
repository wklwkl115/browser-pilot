import { Type } from "typebox";
import type { BridgeCommand } from "../protocol/nativeProtocol";
import { errorResult } from "../utils/toolResult";
import { defaultResultBudget } from "./budgets";
import { distilledJsonResult } from "./resultMiddleware";
import { rejectUnsafeExecuteCommand } from "./transferValidation";
import { asPositiveInt, DEFAULT_TOOL_TIMEOUT_MS, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION, parseMaybeCommand, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

export function registerExecuteTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_execute",
		label: "Browser Execute",
		description: "Execute JavaScript or a bridge command object in a connected real browser tab.",
		promptSnippet: "Execute JS in a real browser tab or send a bridge command object.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_execute for precise browser actions; return explicit values from async JavaScript."],
		parameters: Type.Object({
			script: Type.Optional(Type.String({ description: "JavaScript source. If it is a JSON object string with cmd, it is sent as a bridge command." })),
			command: Type.Optional(Type.Any({ description: "Bridge command object, e.g. {cmd:'tabs',method:'list'} or {cmd:'cdp',...}" })),
			tabId: optionalTargetTabId(),
			timeoutMs: Type.Optional(Type.Number({ description: "Bridge timeout in milliseconds" })),
			detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
			outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
			maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const server = await ensureStarted();
				const timeoutMs = asPositiveInt(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = asPositiveInt(params.maxChars, defaultResultBudget("browser_execute"));
				if (params.command && typeof params.command === "object") {
					const command = params.command as BridgeCommand;
					rejectUnsafeExecuteCommand(command);
					return await distilledJsonResult(await server.sendCommand(command, { tabId: params.tabId, timeoutMs }), {
						toolName: "browser_execute",
						command: String(command.cmd || "command"),
						detailLevel: params.detailLevel ?? "preview",
						maxChars,
						ctx,
						outputPath: params.outputPath,
						fallbackName: `execute-${Date.now()}.json`,
						details: { mode: "command" },
					});
				}
				if (!params.script) throw new Error("browser_execute requires script or command");
				const command = parseMaybeCommand(params.script);
				if (command?.cmd) {
					rejectUnsafeExecuteCommand(command);
					return await distilledJsonResult(await server.sendCommand(command, { tabId: params.tabId, timeoutMs }), {
					toolName: "browser_execute",
					command: String(command.cmd),
					detailLevel: params.detailLevel ?? "preview",
					maxChars,
					ctx,
					outputPath: params.outputPath,
					fallbackName: `execute-${Date.now()}.json`,
					details: { mode: "command" },
				});
				}
				return await distilledJsonResult(await server.executeJavaScript(params.script, { tabId: params.tabId, timeoutMs }), {
					toolName: "browser_execute",
					command: "javascript",
					detailLevel: params.detailLevel ?? "preview",
					maxChars,
					ctx,
					outputPath: params.outputPath,
					fallbackName: `execute-${Date.now()}.json`,
					details: { mode: "javascript" },
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}
