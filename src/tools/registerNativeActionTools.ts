import { Type } from "typebox";
import { executeBrowserWaitWithSupervisor } from "../driver/BrowserWaitSupervisor";
import type { BrowserBridgeExecutionResult } from "../driver/types";
import type { DetailLevel } from "../utils/params";
import type { BridgeCommand } from "../protocol/nativeProtocol";
import { nativeToolMetadata } from "../protocol/nativeActionMetadata";
import { frameCommandForAction, hookCommandForAction, networkCommandForAction, waitCommandForAction } from "./actionCommands";
import { defaultResultBudget, type ToolResultBudgetName } from "./budgets";
import { applyDefaultTimeout, artifactFallbackName, bridgeNestedErrorResult, jsonToolResult, runTool, sharedTabScopedToolParams, targetTabId, toolMaxChars, toolTimeoutMs } from "./toolAdapter";
import { DEFAULT_OBSERVATION_TIMEOUT_MS, DEFAULT_TOOL_TIMEOUT_MS, NativeCommandParamsSchema, objectParam, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

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
	commandExecutor?: (server: Awaited<ReturnType<ToolRegistrarContext["ensureStarted"]>>, command: BridgeCommand, options: { browserSessionId?: string; tabId?: unknown; timeoutMs: number }) => Promise<BrowserBridgeExecutionResult>;
	artifactPrefix: string;
	budgetName: ToolResultBudgetName;
	defaultDetailLevel?: DetailLevel;
};

function actionTimeoutMs(value: unknown, fallback: number, allowZero: boolean): number {
	return toolTimeoutMs(value, fallback, { allowZero });
}

function nativeActionErrorResult(error: unknown) {
	return bridgeNestedErrorResult(error, { defaultMessage: "browser native action failed" });
}

function registerNativeActionTool({ pi, ensureStarted }: ToolRegistrarContext, config: ActionToolConfig) {
	const parameterProperties = {
		action: Type.String({ description: config.actionDescription }),
		params: Type.Optional(NativeCommandParamsSchema),
		...sharedTabScopedToolParams(),
		...(config.sessionIdDescription ? { sessionId: Type.Optional(Type.String({ description: config.sessionIdDescription })) } : {}),
	};
	pi.registerTool({
		name: config.name,
		label: config.label,
		description: config.description,
		promptSnippet: config.promptSnippet,
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, config.promptGuideline],
		parameters: Type.Object(parameterProperties),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				const server = await ensureStarted();
				const body = objectParam(params.params);
				const commandName = config.commandForAction(params.action);
				const tabId = targetTabId(params, body);
				if (params.sessionId && body.sessionId === undefined && body.session_id === undefined) body.sessionId = params.sessionId;
				const timeoutMs = actionTimeoutMs(params.timeoutMs, config.timeoutForCommand?.(commandName) ?? DEFAULT_TOOL_TIMEOUT_MS, config.allowZeroTimeout === true);
				applyDefaultTimeout(body, timeoutMs);
				const maxChars = toolMaxChars(params, config.budgetName);
				const command = { ...body, cmd: commandName };
				const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
				const result = config.commandExecutor
					? await config.commandExecutor(server, command, { browserSessionId, tabId, timeoutMs })
					: await server.sendCommand(command, { browserSessionId, tabId, timeoutMs });
				return await jsonToolResult(result, params, ctx, {
					toolName: config.name,
					budgetName: config.budgetName,
					command: commandName,
					defaultDetailLevel: config.defaultDetailLevel,
					maxChars,
					fallbackName: artifactFallbackName(config.artifactPrefix),
					details: { command: commandName, action: params.action },
					artifactValue: result,
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
		timeoutForCommand: (commandName) => commandName.endsWith(".wait") || commandName.endsWith(".list") || commandName.endsWith(".body") || commandName.endsWith(".exportHar") ? DEFAULT_OBSERVATION_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS,
		artifactPrefix: "network-result",
	});
}

export function registerHookTool(context: ToolRegistrarContext) {
	registerNativeActionTool(context, {
		name: "browser_hook",
		label: "Browser Hook",
		description: "Native browser event hook commands: install, collect, status, clear, pause, resume, uninstall, evaluate, event listener, performance entries.",
		promptSnippet: "Install and collect native browser hooks for network/dom/console/error/storage/websocket/crypto/dom_sinks events.",
		promptGuideline: "Use browser_hook when page-side event collection is needed across actions.",
		actionDescription: "install | collect | status | clear | pause | resume | uninstall | evaluate | addEventListener | removeEventListener | performance | listSessions",
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
		actionDescription: "list | evaluate | addNewDocumentScript | removeNewDocumentScript",
		commandForAction: frameCommandForAction,
		budgetName: "browser_frame",
		artifactPrefix: "frame-result",
		defaultDetailLevel: "preview",
	});
}
