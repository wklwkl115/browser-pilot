import { Type } from "typebox";
import { BrowserBridgeError } from "../driver/errors.js";
import { nextActionsForExecutionEffect } from "../distill-core/recovery.js";
import { rejectUnsafeExecuteCommand } from "./transferValidation.js";
import { buildExecutionJournal, compactExecutionEffect, type ExecuteEffect } from "./executionJournal.js";
import { commandCollectsExecutionEffect, withExecutionEffect } from "./executionEffect.js";
import { summarizeGenericValue } from "./summaries/index.js";
import { artifactFallbackName, defineBrowserTool, jsonToolResult, runTool, sharedTabScopedToolParams, toolMaxChars, toolTimeoutMs, withTrackedOperation } from "./toolAdapter.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictToolParameters } from "./toolShared.js";
import type { ToolRegistrarContext } from "./toolShared.js";
import { isRecord, normalizeTabId } from "../utils/params.js";
import { validateParams } from "../validation/middleware.js";
import { BridgeCommandSchema } from "../validation/schemas.js";

export function registerCommandTool({ pi, ensureStarted }: ToolRegistrarContext) {
	defineBrowserTool(pi, {
		name: "browser_command",
		label: "Browser Command",
		description: "Send a native bridge command object through the Pi browser bridge with stable validation and result envelopes.",
		promptSnippet: "Send a bridge command object through the Pi browser bridge.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_command for explicit native bridge commands such as tabs/CDP/management; use browser_execute only for JavaScript."],
		parameters: strictToolParameters({
			command: Type.Object({}, { additionalProperties: true, description: "Bridge command object, e.g. {cmd:'tabs',method:'list'} or {cmd:'cdp',...}" }),
			...sharedTabScopedToolParams(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				const server = await ensureStarted();
				const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = toolMaxChars(params, "browser_command");

				// Runtime validation: ensure command is a valid object
				if (!params.command || typeof params.command !== "object" || Array.isArray(params.command)) {
					throw new BrowserBridgeError("INVALID_RULE", "browser_command requires command object", { toolName: "browser_command" });
				}

				// Runtime validation: validate command structure with the local TypeBox schema wrapper.
				const validatedCommand = validateParams(BridgeCommandSchema, params.command);

				// Type-safe command is now guaranteed to have required fields
				rejectUnsafeExecuteCommand(validatedCommand);
				const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
				const tabId = normalizeTabId(params.tabId ?? validatedCommand.tabId);
				const shouldCollectEffect = commandCollectsExecutionEffect(validatedCommand) && tabId !== undefined;
				const { result, operation } = await withTrackedOperation(server, {
					toolName: "browser_command",
					command: String(validatedCommand.cmd || "command"),
					browserSessionId,
					tabId,
					phase: "running",
					progress: 10,
					queueDepth: server.queueDepth(browserSessionId, tabId),
					leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
				}, _onUpdate, async (handle) => {
					await handle.update({ progress: 65 });
					const result = shouldCollectEffect
						? await (async () => {
							const executed = await withExecutionEffect(server, { browserSessionId, tabId, timeoutMs }, () => server.sendCommand(validatedCommand, { browserSessionId: params.browserSessionId, tabId: params.tabId, timeoutMs }));
							return { ...executed.result, effect: executed.effect };
						})()
						: await server.sendCommand(validatedCommand, { browserSessionId: params.browserSessionId, tabId: params.tabId, timeoutMs });
					await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target } });
					return result;
				});
				const commandName = String(validatedCommand.cmd || "command");
				const dispatchKind = commandName.startsWith("input.") ? "input" : "native-command";
				const text = commandName === "input.keys" && typeof validatedCommand.text === "string" ? { redacted: true as const, charCount: validatedCommand.text.length } : undefined;
				const execution = buildExecutionJournal({
					operationId: operation.operationId,
					target: result.target,
					dispatch: { kind: dispatchKind, command: commandName, ...(text ? { text } : {}) },
					effect: (result as typeof result & { effect?: ExecuteEffect }).effect,
				});
				const resultValue = { ...result, execution };
				return await jsonToolResult(resultValue, params, ctx, {
					toolName: "browser_command",
					command: commandName,
					defaultDetailLevel: "preview",
					maxChars,
					fallbackName: artifactFallbackName("command"),
					details: { mode: "command" },
					operation,
					artifactValue: { ...resultValue, operation },
					distill: (value) => {
						const effect = isRecord(value) ? compactExecutionEffect(value.effect as ExecuteEffect | undefined) : undefined;
						const effectHints = isRecord(value) ? nextActionsForExecutionEffect(value.effect as ExecuteEffect | undefined) : undefined;
						return {
							...summarizeGenericValue(value),
							operationId: operation.operationId,
							sourceMode: operation.sourceMode,
							...(effect ? { effect } : {}),
							...(effectHints ? { nextActions: effectHints } : {}),
						};
					},
				});
			});
		},
	});
}
