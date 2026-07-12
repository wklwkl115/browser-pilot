import { Type } from "typebox";
import { BrowserBridgeError } from "../utils/errors.js";
import { jsonResult } from "../utils/toolResult.js";
import { rejectUnsafeExecuteCommand } from "./transferValidation.js";
import { withBrowserOperation } from "./browserOperation.js";
import { commandMaxChars, commandTimeoutMs, defineBrowserCommand, inlineJsonCommandResult, resolveLocalTargetTabId, runCommandHandler, sharedTabScopedToolParams, targetTabId } from "./commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import { validateParams } from "./validationMiddleware.js";
import { BridgeCommandSchema } from "../validation/schemas.js";
import { hasBrowserOperationResolver, isNativeWriteCommand } from "./operationResolvers.js";

export function defineNativeCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_command",
		label: "Browser Command",
		description: "Send a validated native bridge command. Read commands return immediately; write commands return a browser-operation/v1 terminal outcome.",
		promptSnippet: "Use the native escape hatch only when a public command cannot express the operation; write calls synchronously return their operation outcome.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_command for explicit native CDP/management operations and browser_execute only for JavaScript. Internal operation and retired wait commands are not callable through this public escape hatch."],
		parameters: strictCommandParameters({
			command: Type.Object({}, { additionalProperties: true, description: "Validated native bridge command object." }),
			...sharedTabScopedToolParams(),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			return await runCommandHandler(async () => {
				if (!params.command || typeof params.command !== "object" || Array.isArray(params.command)) throw new BrowserBridgeError("INVALID_RULE", "browser_command requires command object", { commandName: "browser_command" });
				const command = validateParams(BridgeCommandSchema, params.command);
				rejectUnsafeExecuteCommand(command);
				const server = await ensureStarted();
				const timeoutMs = commandTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = commandMaxChars(params, "browser_command");
				const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
				const rawTarget = targetTabId(params, command);
				const tabId = resolveLocalTargetTabId(server, rawTarget, browserSessionId);
				const commandName = String(command.cmd || "");
				if (!isNativeWriteCommand(command)) {
					const result = await server.sendCommand(command, { browserSessionId, tabId: rawTarget as string | number | undefined, timeoutMs, accessMode: "read" });
					return jsonResult(result, { mode: "command", command: commandName }, maxChars);
				}
				if (!hasBrowserOperationResolver(command)) throw new BrowserBridgeError("INVALID_RULE", `No operation completion resolver is registered for native write command ${commandName}`, { commandName });
				const outcome = await withBrowserOperation({
					server,
					commandName: "browser_command",
					command: commandName,
					action: typeof command.method === "string" ? command.method : typeof command.action === "string" ? command.action : undefined,
					browserSessionId,
					tabId,
					targetRef: typeof rawTarget === "string" ? rawTarget : undefined,
					timeoutMs,
					ctx,
					onUpdate,
				}, () => server.sendCommand(command, { browserSessionId, tabId: rawTarget as string | number | undefined, timeoutMs, accessMode: "write" }));
				return inlineJsonCommandResult(outcome, { mode: "command", command: commandName, operationId: outcome.operationId, status: outcome.status }, { maxChars }, "browser_command");
			});
		},
	});
}
