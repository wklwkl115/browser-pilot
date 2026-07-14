import { Type } from "typebox";
import { BrowserBridgeError } from "../utils/errors.js";
import { jsonResult } from "../utils/toolResult.js";
import { rejectUnsafeExecuteCommand } from "./transferValidation.js";
import { withBrowserOperation } from "./browserOperation.js";
import { browserOperationCommandResult } from "./browserOperationResult.js";
import { commandMaxChars, commandTimeoutMs, defineBrowserCommand, resolveLocalTargetTabId, runCommandHandler, sharedTabScopedToolParams, targetTabId } from "./commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import { validateParams } from "./validationMiddleware.js";
import { BridgeCommandSchema } from "../validation/schemas.js";
import { hasBrowserOperationResolver, isNativeWriteCommand } from "./operationResolvers.js";

function nativePageMutation(command: Record<string, unknown>): boolean {
	const commandName = String(command.cmd || "");
	return commandName === "cdp" || commandName === "persistent_cdp" || commandName.startsWith("input.") || commandName === "frame.evaluate";
}

function nestedPageMutation(value: unknown, path = "/commands"): { commandName: string; path: string } | undefined {
	if (!Array.isArray(value)) return undefined;
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const command = item as Record<string, unknown>;
		const commandName = String(command.cmd || "");
		if (nativePageMutation(command)) return { commandName, path: `${path}/${index}` };
		if (commandName === "batch") {
			const nested = nestedPageMutation(command.commands, `${path}/${index}/commands`);
			if (nested) return nested;
		}
	}
	return undefined;
}

function rejectPageMutationBatch(command: Record<string, unknown>): void {
	if (command.cmd !== "batch") return;
	const nested = nestedPageMutation(command.commands);
	if (!nested) return;
	throw new BrowserBridgeError("INVALID_RULE", "browser_command batch cannot contain page-execution writes; dispatch the page write directly so Browser Pilot can lock and settle it with ABML", {
		commandName: "batch",
		nestedCommand: nested.commandName,
		path: nested.path,
		dispatchStarted: false,
		acked: false,
	});
}

export function defineNativeCommand({ commands, ensureStarted, semanticExecution }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_command",
		label: "Browser Command",
		description: "Send a validated native bridge command. Reads return immediately; writes return browser-operation/v2, with raw CDP/input page writes settled against ABML.",
		promptSnippet: "Use the native escape hatch only when a public command cannot express the operation; classify raw CDP/input results through the returned business and semantic evidence.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_command for explicit native CDP/management operations and browser_execute only for JavaScript. Raw cdp/persistent_cdp/input page-write acknowledgements are dispatch evidence rather than business proof; read business and semantic from the same operation result. Internal operation and retired wait commands are not callable through this public escape hatch."],
		parameters: strictCommandParameters({
			command: Type.Object({}, { additionalProperties: true, description: "Validated native bridge command object." }),
			...sharedTabScopedToolParams(),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return await runCommandHandler(async () => {
				if (!params.command || typeof params.command !== "object" || Array.isArray(params.command)) throw new BrowserBridgeError("INVALID_RULE", "browser_command requires command object", { commandName: "browser_command" });
				const command = validateParams(BridgeCommandSchema, params.command);
				rejectUnsafeExecuteCommand(command);
				rejectPageMutationBatch(command);
				const server = await ensureStarted();
				const timeoutMs = commandTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = commandMaxChars(params, "browser_command");
				const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
				const rawTarget = targetTabId(params, command);
				const tabId = resolveLocalTargetTabId(server, rawTarget, browserSessionId);
				const commandName = String(command.cmd || "");
				if (!isNativeWriteCommand(command)) {
					const result = await server.sendCommand(command, { browserSessionId, tabId: rawTarget as string | number | undefined, timeoutMs, accessMode: "read", signal });
					return jsonResult(result, { mode: "command", command: commandName }, maxChars);
				}
				if (!hasBrowserOperationResolver(command)) throw new BrowserBridgeError("INVALID_RULE", `No operation completion resolver is registered for native write command ${commandName}`, { commandName });
				const semanticMutation = nativePageMutation(command);
				const outcome = await withBrowserOperation({
					server,
					commandName: "browser_command",
					command: commandName,
					action: typeof command.method === "string" ? command.method : typeof command.action === "string" ? command.action : undefined,
					browserSessionId,
					tabId,
					targetRef: typeof rawTarget === "string" ? rawTarget : undefined,
					timeoutMs,
					...(semanticMutation ? {
						semanticExecution,
						semanticAction: { verb: `native-${commandName}` },
						semanticMutation: true,
					} : {}),
					ctx,
					onUpdate,
					signal,
				}, ({ signal: operationSignal, operationId, targetGeneration }) => server.sendCommand(command, {
					browserSessionId,
					tabId: rawTarget as string | number | undefined,
					...(semanticMutation ? { operationId, operationGeneration: targetGeneration } : {}),
					timeoutMs,
					accessMode: "write",
					signal: operationSignal,
				}));
				return await browserOperationCommandResult(outcome, {
					budgetName: "browser_command",
					maxChars,
					ctx,
					details: { mode: "command", command: commandName, operationId: outcome.operationId, status: outcome.status },
				});
			});
		},
	});
}
