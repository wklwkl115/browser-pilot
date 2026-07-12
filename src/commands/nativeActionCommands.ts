import { Type } from "typebox";
import { executeBrowserWaitWithSupervisor } from "../browser-command-runtime/waitSupervisor.js";
import type { BrowserBridgeExecutionResult } from "../ports/BrowserRuntimeTypes.js";
import type { DetailLevel } from "../utils/params.js";
import { isRecord } from "../utils/params.js";
import type { BridgeCommand } from "../types/nativeProtocol.js";
import { nativeToolMetadata } from "./nativeActionMetadata.js";
import { frameCommandForAction, hookCommandForAction, networkCommandForAction } from "./actionCommands.js";
import { readFrameEntities } from "../browser-runtime/abml/frameRuntime.js";
import type { ToolResultBudgetName } from "./budgets.js";
import { applyDefaultTimeout, artifactFallbackName, bridgeNestedErrorResult, buildActiveContext, defineBrowserCommand, jsonCommandResult, resolveLocalTargetTabId, runCommandHandler, sharedTabScopedToolParams, targetTabId, commandMaxChars, commandTimeoutMs } from "./commandRuntime.js";
import { DEFAULT_OBSERVATION_TIMEOUT_MS, DEFAULT_TOOL_TIMEOUT_MS, NativeCommandParamsSchema, objectParam, TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import { withBrowserOperation } from "./browserOperation.js";
import { browserOperationCommandResult } from "./browserOperationResult.js";
import { isNativeWriteCommand } from "./operationResolvers.js";
import type { CommandOwnedActionMetadata, ValidationIssue } from "./commandDefinition.js";
import { publicActionsForDefinition } from "./publicActionCatalog.js";
import { assertBridgeBatchSucceeded } from "../utils/bridgeResultValidation.js";

// Registers the three public native bridge-backed tools (network/hook/frame); internal wait
// primitives remain implementation details of the operation supervisor.
// metadata come from src/commands/nativeActionMetadata.ts, generated from the native schema.
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
	commandExecutor?: (server: Awaited<ReturnType<CommandRegistrarContext["ensureStarted"]>>, command: BridgeCommand, options: { browserSessionId?: string; tabId?: string | number; timeoutMs: number }) => Promise<BrowserBridgeExecutionResult>;
	artifactPrefix: string;
	budgetName: ToolResultBudgetName;
	defaultDetailLevel?: DetailLevel;
	actionMetadata?: readonly CommandOwnedActionMetadata[];
};

function actionTimeoutMs(value: unknown, fallback: number, allowZero: boolean): number {
	return commandTimeoutMs(value, fallback, { allowZero });
}

// Reserved top-level keys an action tool already owns — never treated as a per-action passthrough.
const ACTION_RESERVED_KEYS = new Set(["action", "params", "browserSessionId", "tabId", "targetRef", "detailLevel", "outputPath", "timeoutMs", "maxChars", "redact", "sessionId"]);

// The per-action REQUIRED keys for a tool, derived from the generated native metadata (the same
// source-of-truth F4 surfaces in --help). Agents primed by other tools routinely place these at the
// TOP LEVEL instead of nesting them under `params`,
// and hit a hard `root: must not have additional properties` (real CTF session 2026-06-07, H2). We
// accept them as optional top-level aliases and fold them into `params` (below), keeping the schema
// strict — only these known keys are added, unknown typos are still rejected.
function actionPassthroughKeys(commandName: string): string[] {
	const tools = nativeToolMetadata.nativeActionTools as unknown as Record<string, { actions?: Array<{ required?: readonly string[]; requiredAny?: readonly (readonly string[])[] }> }>;
	const keys = new Set<string>();
	for (const a of tools[commandName]?.actions ?? []) {
		for (const k of a.required ?? []) keys.add(k);
		for (const g of a.requiredAny ?? []) for (const k of g) keys.add(k);
	}
	for (const r of ACTION_RESERVED_KEYS) keys.delete(r);
	return [...keys];
}

function nativeActionErrorResult(error: unknown) {
	return bridgeNestedErrorResult(error, { defaultMessage: "browser native action failed" });
}

function isNetworkCaptureReloadAction(commandName: string, action: unknown): boolean {
	return commandName === "browser_network" && action === "captureReload";
}

function networkCaptureReloadCommands(body: Record<string, unknown>, tabId: unknown, timeoutMs: number): BridgeCommand[] {
	const sessionId = typeof body.sessionId === "string" ? body.sessionId : typeof body.session_id === "string" ? body.session_id : undefined;
	const startParams: BridgeCommand = { ...body, ...(sessionId ? { sessionId } : {}), cmd: "network.start" };
	delete startParams.url;
	delete startParams.wait;
	delete startParams.waitCondition;
	delete startParams.wait_condition;
	delete startParams.reload;
	delete startParams.list;
	const url = typeof body.url === "string" && body.url.trim() ? body.url.trim() : undefined;
	const wait = isRecord(body.wait) ? body.wait as Record<string, unknown> : {};
	const condition = String(body.waitCondition ?? body.wait_condition ?? wait.condition ?? "idle");
	const waitParams: BridgeCommand = {
		cmd: "network.wait",
		...(sessionId ? { sessionId } : {}),
		condition,
		idleMs: body.idleMs ?? body.idle_ms ?? wait.idleMs ?? wait.idle_ms ?? 800,
		timeoutMs: body.waitTimeoutMs ?? body.wait_timeout_ms ?? timeoutMs,
		criteria: isRecord(wait.criteria) ? wait.criteria : isRecord(body.criteria) ? body.criteria : {},
	};
	const listParams: BridgeCommand = {
		cmd: "network.list",
		...(sessionId ? { sessionId } : {}),
		limit: body.limit ?? 100,
		includeDetails: body.includeDetails === true || body.include_details === true,
	};
	const navigation: BridgeCommand = url
		? { cmd: "wait.navigateAndWait", url, timeoutMs }
		: { cmd: "cdp", method: "Page.reload", params: { ignoreCache: body.ignoreCache === true || body.ignore_cache === true }, timeoutMs };
	return [startParams, navigation, waitParams, listParams].map((command) => tabId !== undefined ? { ...command, tabId: tabId as string | number } : command);
}

function networkCaptureReloadSummary(result: BrowserBridgeExecutionResult, commands: BridgeCommand[]): Record<string, unknown> {
	const data = isRecord(result.data) ? result.data : {};
	const results = Array.isArray(data.results) ? data.results : Array.isArray((result as unknown as Record<string, unknown>).results) ? (result as unknown as Record<string, unknown>).results as unknown[] : [];
	const list = results[3];
	const listData = isRecord(list) && isRecord(list.data) ? list.data : {};
	return {
		type: "networkCaptureReload",
		ok: results.every((entry) => isRecord(entry) ? entry.ok !== false : true),
		flow: commands.map((command) => command.cmd),
		startBeforeNavigation: commands[0]?.cmd === "network.start" && (commands[1]?.cmd === "wait.navigateAndWait" || commands[1]?.cmd === "cdp"),
		total: typeof listData.total === "number" ? listData.total : undefined,
		items: Array.isArray(listData.items) ? listData.items.slice(0, 20) : undefined,
		recovery: "To capture early page-load requests, use browser_network action=captureReload so network.start runs before reload/navigation; narrow with wait.criteria and then inspect saved.path with browser_artifact mode=paths.",
	};
}

function nativeActionValidation(config: ActionToolConfig, passthroughKeys: readonly string[], args: Record<string, unknown>): ValidationIssue[] {
	const actions = publicActionsForDefinition({ name: config.name, actionMetadata: config.actionMetadata });
	const action = actions.find((candidate) => candidate.action === args.action);
	if (!action) return [{ code: "ACTION_UNKNOWN", path: "/action", message: `Unsupported ${config.name} action "${String(args.action)}"; expected one of ${actions.map((candidate) => candidate.action).join(", ")}` }];
	const body = isRecord(args.params) ? args.params as Record<string, unknown> : {};
	const issues: ValidationIssue[] = [];
	const allowedTopLevel = new Set([...action.required, ...action.requiredAny.flatMap((group) => [...group])]);
	for (const key of passthroughKeys) {
		const topProvided = args[key] !== undefined;
		if (topProvided && body[key] !== undefined) issues.push({ code: "ACTION_ARGUMENT_DUPLICATE", path: `/${key}`, message: `Action argument "${key}" must be supplied either at the top level or in params, not both` });
		if (topProvided && !allowedTopLevel.has(key)) issues.push({ code: "ACTION_ARGUMENT_NOT_ALLOWED", path: `/${key}`, message: `Argument "${key}" is not valid for action ${action.action}` });
	}
	const present = (key: string) => args[key] !== undefined || body[key] !== undefined;
	for (const key of action.required) if (!present(key)) issues.push({ code: "ACTION_ARGUMENT_REQUIRED", path: `/${key}`, message: `Action ${action.action} requires argument "${key}"` });
	for (const group of action.requiredAny) if (!group.some(present)) issues.push({ code: "ACTION_ARGUMENT_REQUIRED_ANY", path: "/", message: `Action ${action.action} requires one of ${group.join(", ")}` });
	return issues;
}

function mergeCommandDiagnostics(result: BrowserBridgeExecutionResult, diagnostics: Record<string, unknown>): Record<string, unknown> {
	return { ...(result.diagnostics || {}), ...diagnostics };
}

function defineNativeActionCommand({ commands, ensureStarted }: CommandRegistrarContext, config: ActionToolConfig) {
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
	defineBrowserCommand(commands, {
		name: config.name,
		label: config.label,
		description: config.description,
		promptSnippet: config.promptSnippet,
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, config.promptGuideline],
		actionMetadata: config.actionMetadata,
		parameters: strictCommandParameters(parameterProperties),
		validateArguments: (args) => nativeActionValidation(config, passthroughKeys, args),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runCommandHandler(async () => {
				const actionIssues = nativeActionValidation(config, passthroughKeys, params as Record<string, unknown>);
				if (actionIssues.length) throw new Error(actionIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
				const server = await ensureStarted();
				const body = objectParam(params.params);
				// H2: fold any per-action key passed at the top level into params (params still wins if both set).
				for (const k of passthroughKeys) {
					const top = (params as Record<string, unknown>)[k];
					if (top !== undefined && body[k] === undefined) body[k] = top;
				}
				const captureReload = isNetworkCaptureReloadAction(config.name, params.action);
				const commandName = captureReload ? "network.captureReload" : config.commandForAction(params.action);
				const tabId = targetTabId(params, body);
				if (params.sessionId && body.sessionId === undefined && body.session_id === undefined) body.sessionId = params.sessionId;
				const timeoutMs = actionTimeoutMs(params.timeoutMs, config.timeoutForCommand?.(commandName) ?? DEFAULT_TOOL_TIMEOUT_MS, config.allowZeroTimeout === true);
				applyDefaultTimeout(body, timeoutMs);
				const maxChars = commandMaxChars(params, config.budgetName);
				const command = { ...body, cmd: commandName };
				const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
				const trackedTabId = resolveLocalTargetTabId(server, tabId, browserSessionId);
				const resolvedTabId = tabId as string | number | undefined;
				const dispatch = async () => {
					if (captureReload) {
						const result = await server.sendCommand({ cmd: "batch", commands: networkCaptureReloadCommands(body, resolvedTabId, timeoutMs) }, { browserSessionId, tabId: resolvedTabId, timeoutMs, accessMode: "write" });
						assertBridgeBatchSucceeded(result, "network.captureReload");
						return result;
					}
					return config.commandExecutor
						? await config.commandExecutor(server, command, { browserSessionId, tabId: resolvedTabId, timeoutMs })
						: await server.sendCommand(command, { browserSessionId, tabId: resolvedTabId, timeoutMs });
				};
				const writeCommand = captureReload || isNativeWriteCommand(command);
				if (writeCommand) {
					const outcome = await withBrowserOperation({ server, commandName: config.name, command: commandName, action: String(params.action || ""), browserSessionId, tabId: trackedTabId, targetRef: typeof params.targetRef === "string" ? params.targetRef : undefined, timeoutMs, ctx, onUpdate: _onUpdate }, dispatch);
					return await browserOperationCommandResult(outcome, {
						budgetName: config.budgetName,
						maxChars,
						ctx,
						details: { command: commandName, action: params.action, operationId: outcome.operationId, status: outcome.status },
					});
				}
				const result = await dispatch();
				return await jsonCommandResult(result, params, ctx, {
					commandName: config.name,
					budgetName: config.budgetName,
					command: commandName,
					defaultDetailLevel: config.defaultDetailLevel,
					maxChars,
					fallbackName: artifactFallbackName(config.artifactPrefix),
					details: { command: commandName, action: params.action },
					activeContext: buildActiveContext(server, params),
					diagnostics: mergeCommandDiagnostics(result, captureReload ? { networkCaptureReload: { oneShotBatch: true, startBeforeNavigation: true, guidance: "network.start ran before reload/navigation; inspect saved.path with browser_artifact mode=paths for available request paths." } } : {}),
					artifactValue: result,
					...(captureReload ? { distill: (value: unknown) => networkCaptureReloadSummary(value as BrowserBridgeExecutionResult, networkCaptureReloadCommands(body, resolvedTabId, timeoutMs)) } : {}),
				});
			}, nativeActionErrorResult);
		},
	});
}

export function defineNetworkCommand(context: CommandRegistrarContext) {
	defineNativeActionCommand(context, {
		name: "browser_network",
		label: "Browser Network",
		description: "Native Network recorder commands: start, stop, status, clear, list, get, body, exportHar, plus captureReload one-shot reload capture UX. Internal network wait remains operation-supervisor-only.",
		promptSnippet: "Control Browser Network recorder and inspect captured requests/bodies/HAR; use action=captureReload to start capture before reload/navigation in one round trip.",
		promptGuideline: "Use browser_network action=captureReload for page-load traffic so network.start runs before reload/navigation; use low-level start/list/stop for manual recorder control. Prefer this over ad-hoc page fetch monkeypatches.",
		actionDescription: "start | stop | status | clear | list | get | body | exportHar | captureReload",
		actionMetadata: [{ action: "captureReload", cliAction: "capture-reload", schemaRef: "command:browser_network#captureReload" }],
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

export function defineHookCommand(context: CommandRegistrarContext) {
	defineNativeActionCommand(context, {
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

export function defineFrameCommand(context: CommandRegistrarContext) {
	defineNativeActionCommand(context, {
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
