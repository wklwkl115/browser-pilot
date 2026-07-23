import { Type } from "typebox";
import { resolveExecutionRef, type ExecutionRefTarget } from "../browser-command-runtime/executionRef.js";
import { BrowserBridgeError } from "../utils/errors.js";
import { jsonResult } from "../utils/toolResult.js";
import { withBrowserOperation } from "./browserOperation.js";
import { withCommandEffect } from "./commandEffect.js";
import { defineBrowserCommand, pinTabExecutionTarget, resolveRefExecutionTarget, runCommandHandler, sharedTabScopedToolParams, targetTabId } from "./commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import { validateBridgeCommand, type BridgeCommand } from "../types/nativeProtocol.js";
import { isNativeTabScopedCommand, isNativeWriteCommand, isPublicNativeCommand, nativeCommandOwner, publicNativeCommandNames } from "./nativeCommandAccess.js";

const nativeCommandNames = publicNativeCommandNames();

function prepareNativeRef(command: BridgeCommand): { command: BridgeCommand; refs: ExecutionRefTarget[] } {
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
		description: "Send one validated native browser command through the selected or explicit target. Runtime routing, serialization, cancellation, and page-effect feedback require no extra control fields.",
		promptSnippet: "Use one native command for browser/CDP capabilities outside page JavaScript; read its resource only when command-specific fields are needed.",
		promptGuidelines: [
			TAB_SCOPED_TOOL_GUIDELINE,
			"Use browser_command for explicit native CDP/management operations and browser_execute only for JavaScript.",
			"For raw CDP, pass command={cmd:'cdp',method:'Domain.method',params:{...}}; Browser Pilot owns attach, reuse, recovery, and cleanup.",
			"For a trusted physical click, use command={cmd:'input.ref',action:'click',ref:'bp-ref://...'}; Browser Pilot resolves its tab and private CDP target.",
			"For tab-scoped writes, expect may declare a JavaScript truth expression; Browser Pilot owns waiting and reports effect.verification as verified, failed, or inconclusive.",
		],
		parameters: strictCommandParameters({
			command: Type.Object({
				cmd: Type.String({ enum: nativeCommandNames, description: "Canonical native command name from browser-pilot://native-commands." }),
			}, { additionalProperties: true, description: "Validated native bridge command object." }),
			expect: Type.Optional(Type.String({ minLength: 1, description: "Write postcondition as a JavaScript expression returning truthy when the intended state is reached." })),
			...sharedTabScopedToolParams(),
		}),
		async execute(params, signal) {
			return await runCommandHandler(async () => {
				if (!params.command || typeof params.command !== "object" || Array.isArray(params.command)) throw new BrowserBridgeError("INVALID_RULE", "browser_command requires command object", { commandName: "browser_command" });
				const protocol = validateBridgeCommand(params.command, { allowMissingTabId: true, publicCall: true });
				if (!protocol.ok) throw new BrowserBridgeError("INVALID_BROWSER_COMMAND", protocol.error, protocol.details);
				const owner = nativeCommandOwner(protocol.command);
				if (owner) throw new BrowserBridgeError("INVALID_RULE", `${String(protocol.command.cmd)} must be invoked through ${owner}`, { commandName: "browser_command", useTool: owner });
				if (!isPublicNativeCommand(protocol.command)) throw new BrowserBridgeError("INVALID_RULE", `${String(protocol.command.cmd)} is not a public native command`, { commandName: "browser_command", catalog: "browser-pilot://native-commands" });
				const prepared = prepareNativeRef(protocol.command);
				const command = prepared.command;
				const write = isNativeWriteCommand(command);
				const expect = typeof params.expect === "string" && params.expect.trim() ? params.expect.trim() : undefined;
				if (params.expect !== undefined && !expect) throw new BrowserBridgeError("INVALID_RULE", "browser_command expect must be a non-empty JavaScript expression", { commandName: "browser_command" });
				if (expect && !write) throw new BrowserBridgeError("INVALID_RULE", "browser_command expect is only valid for writes", { commandName: "browser_command" });
				const server = await ensureStarted();
				const timeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
				const rawTarget = targetTabId(params, command);
				const resolvedTarget = resolveRefExecutionTarget(server, prepared.refs, { rawTarget });
				const target = isNativeTabScopedCommand(command) ? pinTabExecutionTarget(server, resolvedTarget) : resolvedTarget;
				if (expect && target.tabId === undefined) throw new BrowserBridgeError("INVALID_RULE", "browser_command expect requires a tab-scoped write", { commandName: "browser_command" });
				const commandName = String(command.cmd || "");
				const dispatch = ({ signal: dispatchSignal }: { signal?: AbortSignal }) => server.sendCommand(command, {
					browserSessionId: target.browserSessionId,
					tabId: target.rawTarget,
					timeoutMs,
					accessMode: write ? "write" : "read",
					signal: dispatchSignal,
				});
				const dispatchWrite = async ({ signal: operationSignal, deadlineAt }: { signal: AbortSignal; deadlineAt: number }) => {
					const run = () => dispatch({ signal: operationSignal });
					return target.tabId === undefined
						? { result: await run() }
						: await withCommandEffect(server, {
							browserSessionId: target.browserSessionId,
							tabId: target.tabId,
							timeoutMs,
							deadlineAt,
							signal: operationSignal,
							...(expect ? { verify: async () => (await server.executeJavaScript(`return Boolean(await (${expect}));`, { browserSessionId: target.browserSessionId, tabId: target.rawTarget, timeoutMs, accessMode: "read", signal: operationSignal })).data === true } : {}),
						}, run);
				};
				const outcome = write
					? await withBrowserOperation({ server, browserSessionId: target.browserSessionId, tabId: target.tabId, targetRef: target.rawTarget, timeoutMs, signal }, dispatchWrite)
					: { result: await dispatch({ signal }) };
				const value = "effect" in outcome ? { ...outcome.result, effect: outcome.effect } : outcome.result;
				return jsonResult(value, { mode: "command", command: commandName });
			});
		},
	});
}
