import { Type } from "typebox";
import { resolveExecutionRef, type ExecutionRefTarget } from "../browser-command-runtime/executionRef.js";
import { BrowserBridgeError } from "../utils/errors.js";
import { jsonResult } from "../utils/toolResult.js";
import { withBrowserOperation } from "./browserOperation.js";
import { defineBrowserCommand, resolveRefExecutionTarget, runCommandHandler, sharedTabScopedToolParams, targetTabId } from "./commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import { validateParams } from "./validationMiddleware.js";
import { BridgeCommandSchema, type ValidatedBridgeCommand } from "../validation/schemas.js";
import { validateBridgeCommand } from "../types/nativeProtocol.js";
import { isNativeWriteCommand, isPublicNativeCommand, nativeCommandOwner, publicNativeCommandNames } from "./nativeCommandAccess.js";

const nativeCommandNames = publicNativeCommandNames();

function prepareNativeRef(command: ValidatedBridgeCommand): { command: ValidatedBridgeCommand; refs: ExecutionRefTarget[] } {
	if (command.cmd !== "input.ref") return { command, refs: [] };
	if (typeof command.ref !== "string" || !command.ref.startsWith("bp-ref://")) {
		throw new BrowserBridgeError("INVALID_REF_TARGET", "input.ref requires a bp-ref URI in ref", { ref: command.ref });
	}
	const resolved = resolveExecutionRef(command.ref);
	const { refId, kind, backendNodeId, targetId, point, locators, semantic } = resolved.target;
	const target = { refId, kind, ...(backendNodeId !== undefined ? { backendNodeId } : {}), ...(targetId ? { targetId } : {}), ...(point ? { point } : {}), locators, ...(semantic ? { semantic } : {}) };
	return { command: { ...command, target }, refs: [resolved.target] };
}

export function defineNativeCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_command",
		label: "Browser Command",
		description: "Send a validated native bridge command. Read browser-pilot://native-command/<cmd> for command-specific fields.",
		promptSnippet: "Use the native escape hatch only when a public command cannot express the operation.",
		promptGuidelines: [
			TAB_SCOPED_TOOL_GUIDELINE,
			"Use browser_command for explicit native CDP/management operations and browser_execute only for JavaScript.",
			"For a trusted physical click, use command={cmd:'input.ref',action:'click',ref:'bp-ref://...'}; Browser Pilot resolves its tab and private CDP target.",
		],
		parameters: strictCommandParameters({
			command: Type.Object({
				cmd: Type.String({ enum: nativeCommandNames, description: "Canonical native command name from browser-pilot://native-commands." }),
			}, { additionalProperties: true, description: "Validated native bridge command object." }),
			...sharedTabScopedToolParams(),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			return await runCommandHandler(async () => {
				if (!params.command || typeof params.command !== "object" || Array.isArray(params.command)) throw new BrowserBridgeError("INVALID_RULE", "browser_command requires command object", { commandName: "browser_command" });
				const validated = validateParams(BridgeCommandSchema, params.command);
				const owner = nativeCommandOwner(validated);
				if (owner) throw new BrowserBridgeError("INVALID_RULE", `${String(validated.cmd)} must be invoked through ${owner}`, { commandName: "browser_command", useTool: owner });
				if (!isPublicNativeCommand(validated)) throw new BrowserBridgeError("INVALID_RULE", `${String(validated.cmd)} is not a public native command`, { commandName: "browser_command", catalog: "browser-pilot://native-commands" });
				const protocol = validateBridgeCommand(validated, { allowMissingTabId: true });
				if (!protocol.ok) throw new BrowserBridgeError("INVALID_BROWSER_COMMAND", protocol.error, protocol.details);
				const prepared = prepareNativeRef(protocol.command as ValidatedBridgeCommand);
				const command = prepared.command;
				const server = await ensureStarted();
				const timeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
				const rawTarget = targetTabId(params, command);
				const write = isNativeWriteCommand(command);
				const target = resolveRefExecutionTarget(server, prepared.refs, { rawTarget });
				const commandName = String(command.cmd || "");
				const dispatch = ({ signal: dispatchSignal }: { signal?: AbortSignal }) => server.sendCommand(command, {
					browserSessionId: target.browserSessionId,
					tabId: target.rawTarget,
					timeoutMs,
					accessMode: write ? "write" : "read",
					signal: dispatchSignal,
				});
				const result = write
					? await withBrowserOperation({ server, browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, signal }, dispatch)
					: await dispatch({ signal });
				return jsonResult(result, { mode: "command", command: commandName });
			});
		},
	});
}
