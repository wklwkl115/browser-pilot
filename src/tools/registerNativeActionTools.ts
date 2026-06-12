import { Type } from "typebox";
import { executeBrowserWaitWithSupervisor } from "../driver/BrowserWaitSupervisor.js";
import type { BrowserBridgeExecutionResult } from "../driver/types.js";
import type { DetailLevel } from "../utils/params.js";
import type { BridgeCommand } from "../protocol/nativeProtocol.js";
import { nativeToolMetadata } from "../protocol/nativeActionMetadata.js";
import { frameCommandForAction, hookCommandForAction, networkCommandForAction, waitCommandForAction } from "./actionCommands.js";
import { readFrameEntities } from "../abml/verbs/frameRuntime.js";
import type { ToolResultBudgetName } from "./budgets.js";
import { applyDefaultTimeout, artifactFallbackName, bridgeNestedErrorResult, defineBrowserTool, jsonToolResult, resolveLocalTargetTabId, runTool, sharedTabScopedToolParams, targetTabId, toolMaxChars, toolTimeoutMs, withTrackedOperation } from "./toolAdapter.js";
import { DEFAULT_OBSERVATION_TIMEOUT_MS, DEFAULT_TOOL_TIMEOUT_MS, NativeCommandParamsSchema, objectParam, TAB_SCOPED_TOOL_GUIDELINE, strictToolParameters } from "./toolShared.js";
import type { ToolRegistrarContext } from "./toolShared.js";

// Registers the four native bridge-backed tools (wait/network/hook/frame); command names and
// metadata come from src/protocol/nativeActionMetadata.ts, generated from the native schema.
type ActionToolConfig = {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuideline: string;
	actionDescription: string;
	sessionIdDescription?: string;
	commandForAction: (action: string) => string;
	timeoutForCommand?: (commandName: string) => number;
	allowZeroTimeout?: boolean;
	commandExecutor?: (server: Awaited<ReturnType<ToolRegistrarContext["ensureStarted"]>>, command: BridgeCommand, options: { browserSessionId?: string; tabId?: string | number; timeoutMs: number }) => Promise<BrowserBridgeExecutionResult>;
	artifactPrefix: string;
	budgetName: ToolResultBudgetName;
	defaultDetailLevel?: DetailLevel;
};

function actionTimeoutMs(value: unknown, fallback: number, allowZero: boolean): number {
	return toolTimeoutMs(value, fallback, { allowZero });
}

// Reserved top-level keys an action tool already owns — never treated as a per-action passthrough.
const ACTION_RESERVED_KEYS = new Set(["action", "params", "browserSessionId", "tabId", "targetRef", "detailLevel", "outputPath", "timeoutMs", "maxChars", "redact", "sessionId"]);

// The per-action REQUIRED keys for a tool, derived from the generated native metadata (the same
// source-of-truth F4 surfaces in --help). Agents primed by other tools routinely place these at the
// TOP LEVEL (e.g. browser_wait {action:"navigate", url:"…"}) instead of nesting them under `params`,
// and hit a hard `root: must not have additional properties` (real CTF session 2026-06-07, H2). We
// accept them as optional top-level aliases and fold them into `params` (below), keeping the schema
// strict — only these known keys are added, unknown typos are still rejected.
function actionPassthroughKeys(toolName: string): string[] {
	const tools = nativeToolMetadata.nativeActionTools as unknown as Record<string, { actions?: Array<{ required?: readonly string[]; requiredAny?: readonly (readonly string[])[] }> }>;
	const keys = new Set<string>();
	for (const a of tools[toolName]?.actions ?? []) {
		for (const k of a.required ?? []) keys.add(k);
		for (const g of a.requiredAny ?? []) for (const k of g) keys.add(k);
	}
	for (const r of ACTION_RESERVED_KEYS) keys.delete(r);
	return [...keys];
}

function nativeActionErrorResult(error: unknown) {
	return bridgeNestedErrorResult(error, { defaultMessage: "browser native action failed" });
}

function registerNativeActionTool({ pi, ensureStarted }: ToolRegistrarContext, config: ActionToolConfig) {
	const passthroughKeys = actionPassthroughKeys(config.name);
	const parameterProperties = {
		action: Type.String({ description: config.actionDescription }),
		params: Type.Optional(NativeCommandParamsSchema),
		...sharedTabScopedToolParams(),
		...(config.sessionIdDescription ? { sessionId: Type.Optional(Type.String({ description: config.sessionIdDescription })) } : {}),
		// H2: accept each per-action required key at the top level too (folded into params at execute) so
		// the natural `{action, <key>}` call works instead of hard-rejecting; primary path stays `params`.
		...Object.fromEntries(passthroughKeys.map((k) => [k, Type.Optional(Type.Unknown({ description: `Per-action '${k}' — pass here or inside params; folded into params.` }))])),
	};
	defineBrowserTool(pi, {
		name: config.name,
		label: config.label,
		description: config.description,
		promptSnippet: config.promptSnippet,
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, config.promptGuideline],
		parameters: strictToolParameters(parameterProperties),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				const server = await ensureStarted();
				const body = objectParam(params.params);
				// H2: fold any per-action key passed at the top level into params (params still wins if both set).
				for (const k of passthroughKeys) {
					const top = (params as Record<string, unknown>)[k];
					if (top !== undefined && body[k] === undefined) body[k] = top;
				}
				const commandName = config.commandForAction(params.action);
				const tabId = targetTabId(params, body);
				if (params.sessionId && body.sessionId === undefined && body.session_id === undefined) body.sessionId = params.sessionId;
				const timeoutMs = actionTimeoutMs(params.timeoutMs, config.timeoutForCommand?.(commandName) ?? DEFAULT_TOOL_TIMEOUT_MS, config.allowZeroTimeout === true);
				applyDefaultTimeout(body, timeoutMs);
				const maxChars = toolMaxChars(params, config.budgetName);
				const command = { ...body, cmd: commandName };
				const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
				const trackedTabId = resolveLocalTargetTabId(server, tabId, browserSessionId);
				const resolvedTabId = tabId as string | number | undefined;
				const { result, operation } = await withTrackedOperation(server, {
					toolName: config.name,
					command: commandName,
					browserSessionId,
					tabId: trackedTabId,
					phase: "running",
					progress: 10,
					queueDepth: server.queueDepth(browserSessionId, trackedTabId),
					leaseOwnerHash: server.leaseOwnerHash(browserSessionId, trackedTabId),
				}, _onUpdate, async (handle) => {
					await handle.update({ progress: 45 });
					const result = config.commandExecutor
						? await config.commandExecutor(server, command, { browserSessionId, tabId: resolvedTabId, timeoutMs })
						: await server.sendCommand(command, { browserSessionId, tabId: resolvedTabId, timeoutMs });
					await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target } });
					return result;
				});
				return await jsonToolResult(result, params, ctx, {
					toolName: config.name,
					budgetName: config.budgetName,
					command: commandName,
					defaultDetailLevel: config.defaultDetailLevel,
					maxChars,
					fallbackName: artifactFallbackName(config.artifactPrefix),
					details: { command: commandName, action: params.action },
					operation,
					artifactValue: { ...result, operation },
				});
			}, nativeActionErrorResult);
		},
	});
}

export function registerWaitTool(context: ToolRegistrarContext) {
	registerNativeActionTool(context, {
		name: "browser_wait",
		label: "Browser Wait",
		description: "Native wait/navigation commands: navigate, navigateAndWait, loadState, networkIdle, selector, any, all, cancel, diagnose. Composite any/all require non-empty waits or conditions.",
		promptSnippet: "Run browser wait/navigation commands with typed action names.",
		promptGuideline: "Use browser_wait instead of manual sleep loops when waiting for page navigation, selectors, load state, or network idle.",
		actionDescription: nativeToolMetadata.nativeActionTools.browser_wait.actionDescription,
		sessionIdDescription: "Logical wait session id",
		commandForAction: waitCommandForAction,
		commandExecutor: executeBrowserWaitWithSupervisor,
		allowZeroTimeout: true,
		budgetName: "browser_wait",
		artifactPrefix: "wait-result",
		defaultDetailLevel: "preview",
		timeoutForCommand: (commandName) => commandName.includes("wait") || commandName.includes("navigateAndWait") ? DEFAULT_OBSERVATION_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS,
	});
}

export function registerNetworkTool(context: ToolRegistrarContext) {
	registerNativeActionTool(context, {
		name: "browser_network",
		label: "Browser Network",
		description: "Native Network recorder commands: start, stop, status, clear, list, get, body, exportHar, wait.",
		promptSnippet: "Control Browser Network recorder and inspect captured requests/bodies/HAR.",
		promptGuideline: "Use browser_network for request/response observation instead of ad-hoc page fetch monkeypatches.",
		actionDescription: nativeToolMetadata.nativeActionTools.browser_network.actionDescription,
		sessionIdDescription: "Recorder session id",
		commandForAction: networkCommandForAction,
		budgetName: "browser_network",
		allowZeroTimeout: true,
		commandExecutor: async (server, command, options) => command.cmd === "network.wait"
			? await executeBrowserWaitWithSupervisor(server, command, options)
			: await server.sendCommand(command, options),
		timeoutForCommand: (commandName) => commandName.endsWith(".wait") || commandName.endsWith(".list") || commandName.endsWith(".body") || commandName.endsWith(".exportHar") ? DEFAULT_OBSERVATION_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS,
		artifactPrefix: "network-result",
	});
}

export function registerHookTool(context: ToolRegistrarContext) {
	registerNativeActionTool(context, {
		name: "browser_hook",
		label: "Browser Hook",
		description: "Native browser event hook commands: listTargets, installTargets, install, collect, status, clear, pause, resume, uninstall, evaluate, event listener, performance entries.",
		promptSnippet: "Install and collect native browser hooks for network/dom/console/error/storage/websocket/crypto/dom_sinks events.",
		promptGuideline: "Use browser_hook when page-side event collection is needed across actions. Use listTargets/installTargets for static, explicit hook target expansion instead of strategy presets.",
		actionDescription: nativeToolMetadata.nativeActionTools.browser_hook.actionDescription,
		sessionIdDescription: "Hook session id",
		commandForAction: hookCommandForAction,
		budgetName: "browser_hook",
		artifactPrefix: "hook-result",
		defaultDetailLevel: "preview",
	});
}

export function registerFrameTool(context: ToolRegistrarContext) {
	registerNativeActionTool(context, {
		name: "browser_frame",
		label: "Browser Frame",
		description: "Native frame commands: list frames, evaluate in a frame, add/remove new-document scripts.",
		promptSnippet: "Inspect browser frames or evaluate JavaScript in a target frame.",
		promptGuideline: "Use browser_frame for cross-frame work instead of guessing iframe DOM access.",
		actionDescription: nativeToolMetadata.nativeActionTools.browser_frame.actionDescription,
		commandForAction: frameCommandForAction,
		commandExecutor: async (server, command, options) => {
			// Ergonomics: browser_execute takes `script`; the frame.evaluate protocol field is `expression`.
			// Agents primed by browser_execute routinely pass `script` here and hit a hard schema error
			// (frame.evaluate missing required fields: expression). Accept `script` as an alias so the
			// natural call just works (observed wasting a round in a real agent session, 2026-06-05).
			const c = command as Record<string, unknown>;
			if (c.cmd === "frame.evaluate" && typeof c.script === "string" && c.expression === undefined) { c.expression = c.script; delete c.script; }
			const result = await server.sendCommand(command, options);
			if ((command.cmd === "frame.list" || command.cmd === "frame.evaluate") && result.data && typeof result.data === "object") {
				const tabId = typeof result.tabId === "number" ? result.tabId : typeof options.tabId === "number" ? options.tabId : typeof command.tabId === "number" ? command.tabId : undefined;
				const commandOptions = command.options && typeof command.options === "object" ? command.options as Record<string, unknown> : undefined;
				if (tabId) {
					const frames = await readFrameEntities(server, { browserSessionId: options.browserSessionId, tabId, observationId: `frame-list:${tabId}`, depth: typeof commandOptions?.depth === "number" ? commandOptions.depth : undefined }).catch(() => undefined);
					if (frames) {
						const frameId = typeof command.frameId === "string" ? command.frameId : undefined;
						result.data = {
							...(result.data as Record<string, unknown>),
							entities: frameId ? frames.entities.filter((entity) => entity.hints?.frameId === frameId || entity.value === frameId) : frames.entities,
							entityCount: frameId ? frames.entities.filter((entity) => entity.hints?.frameId === frameId || entity.value === frameId).length : frames.entities.length,
							frameCount: frames.frames.length,
							abmlIntegrated: true,
						};
					}
				}
			}
			return result;
		},
		budgetName: "browser_frame",
		artifactPrefix: "frame-result",
		defaultDetailLevel: "preview",
	});
}
