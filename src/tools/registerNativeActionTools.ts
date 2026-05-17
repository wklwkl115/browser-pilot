import { Type } from "typebox";
import { errorResult } from "../utils/toolResult";
import { frameCommandForAction, hookCommandForAction, networkCommandForAction, waitCommandForAction } from "./actionCommands";
import type { DetailLevel } from "../utils/params";
import { defaultResultBudget, type ToolResultBudgetName } from "./budgets";
import { distilledJsonResult } from "./resultMiddleware";
import { asPositiveInt, DEFAULT_TOOL_TIMEOUT_MS, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, NativeCommandParamsSchema, objectParam, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
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
	artifactPrefix: string;
	budgetName: ToolResultBudgetName;
	defaultDetailLevel?: DetailLevel;
};

function registerNativeActionTool({ pi, ensureStarted }: ToolRegistrarContext, config: ActionToolConfig) {
	const parameterProperties = {
		action: Type.String({ description: config.actionDescription }),
		params: Type.Optional(NativeCommandParamsSchema),
		tabId: optionalTargetTabId(),
		...(config.sessionIdDescription ? { sessionId: Type.Optional(Type.String({ description: config.sessionIdDescription })) } : {}),
		detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
		outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
		timeoutMs: Type.Optional(Type.Number({ description: "Bridge timeout in milliseconds" })),
		maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
	};
	pi.registerTool({
		name: config.name,
		label: config.label,
		description: config.description,
		promptSnippet: config.promptSnippet,
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, config.promptGuideline],
		parameters: Type.Object(parameterProperties),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const server = await ensureStarted();
				const body = objectParam(params.params);
				const commandName = config.commandForAction(params.action);
				const tabId = params.tabId ?? body.tabId;
				if (params.sessionId && body.sessionId === undefined && body.session_id === undefined) body.sessionId = params.sessionId;
				const timeoutMs = asPositiveInt(params.timeoutMs, config.timeoutForCommand?.(commandName) ?? DEFAULT_TOOL_TIMEOUT_MS);
				if (body.timeoutMs === undefined && body.timeout_ms === undefined) body.timeoutMs = timeoutMs;
				const maxChars = asPositiveInt(params.maxChars, defaultResultBudget(config.budgetName));
				const result = await server.sendCommand({ ...body, cmd: commandName }, { tabId, timeoutMs });
				return await distilledJsonResult(result, {
					toolName: config.name,
					command: commandName,
					detailLevel: params.detailLevel ?? config.defaultDetailLevel,
					maxChars,
					ctx,
					outputPath: params.outputPath,
					fallbackName: `${config.artifactPrefix}-${Date.now()}.json`,
					details: { command: commandName, action: params.action },
					artifactValue: result.data ?? result,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}

export function registerWaitTool(context: ToolRegistrarContext) {
	registerNativeActionTool(context, {
		name: "browser_wait",
		label: "Browser Wait",
		description: "Native wait/navigation commands: navigate, navigateAndWait, loadState, networkIdle, selector, any, all, cancel, diagnose.",
		promptSnippet: "Run browser wait/navigation commands with typed action names.",
		promptGuideline: "Use browser_wait instead of manual sleep loops when waiting for page navigation, selectors, load state, or network idle.",
		actionDescription: "navigate | navigateAndWait | navigation | loadState | networkIdle | selector | any | all | cancel | diagnose",
		sessionIdDescription: "Logical wait session id",
		commandForAction: waitCommandForAction,
		budgetName: "browser_wait",
		artifactPrefix: "wait-result",
		defaultDetailLevel: "preview",
		timeoutForCommand: (commandName) => commandName.includes("wait") || commandName.includes("navigateAndWait") ? 35_000 : DEFAULT_TOOL_TIMEOUT_MS,
	});
}

export function registerNetworkTool(context: ToolRegistrarContext) {
	registerNativeActionTool(context, {
		name: "browser_network",
		label: "Browser Network",
		description: "Native Network recorder commands: start, stop, status, clear, list, get, body, exportHar, wait.",
		promptSnippet: "Control Browser Network recorder and inspect captured requests/bodies/HAR.",
		promptGuideline: "Use browser_network for request/response observation instead of ad-hoc page fetch monkeypatches.",
		actionDescription: "start | stop | status | clear | list | get | body | exportHar | wait",
		sessionIdDescription: "Recorder session id",
		commandForAction: networkCommandForAction,
		budgetName: "browser_network",
		timeoutForCommand: (commandName) => commandName.endsWith(".wait") ? 35_000 : DEFAULT_TOOL_TIMEOUT_MS,
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
