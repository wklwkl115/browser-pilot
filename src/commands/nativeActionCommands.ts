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
	commandExecutor?: (server: Awaited<ReturnType<CommandRegistrarContext["ensureStarted"]>>, command: BridgeCommand, options: { browserSessionId?: string; tabId?: string | number; timeoutMs: number; signal?: AbortSignal }) => Promise<BrowserBridgeExecutionResult>;
	artifactPrefix: string;
	budgetName: ToolResultBudgetName;
	defaultDetailLevel?: DetailLevel;
	actionMetadata?: readonly CommandOwnedActionMetadata[];
};

function actionTimeoutMs(value: unknown, fallback: number, allowZero: boolean): number {
	return commandTimeoutMs(value, fallback, { allowZero });
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

function nativeActionValidation(config: ActionToolConfig, args: Record<string, unknown>): ValidationIssue[] {
	const actions = publicActionsForDefinition({ name: config.name, actionMetadata: config.actionMetadata });
	const action = actions.find((candidate) => candidate.action === args.action);
	if (!action) return [{ code: "ACTION_UNKNOWN", path: "/action", message: `Unsupported ${config.name} action "${String(args.action)}"; expected one of ${actions.map((candidate) => candidate.action).join(", ")}` }];
	return [];
}

function mergeCommandDiagnostics(result: BrowserBridgeExecutionResult, diagnostics: Record<string, unknown>): Record<string, unknown> {
	return { ...(result.diagnostics || {}), ...diagnostics };
}

function recorderHighWater(value: unknown, depth = 0, seen = new WeakSet<object>()): number | undefined {
	if (depth > 6 || !value || typeof value !== "object" || seen.has(value)) return undefined;
	seen.add(value);
	const candidates: number[] = [];
	if (isRecord(value)) {
		for (const key of ["lastSeq", "last_seq", "seq", "eventSeq", "event_seq"]) {
			const candidate = Number(value[key]);
			if (Number.isFinite(candidate) && candidate >= 0) candidates.push(Math.floor(candidate));
		}
		for (const key of ["data", "result", "results", "items", "events"]) {
			const nested = recorderHighWater(value[key], depth + 1, seen);
			if (nested !== undefined) candidates.push(nested);
		}
	} else if (Array.isArray(value)) {
		for (const item of value.slice(0, 1_000)) {
			const nested = recorderHighWater(item, depth + 1, seen);
			if (nested !== undefined) candidates.push(nested);
		}
	}
	seen.delete(value);
	return candidates.length ? Math.max(...candidates) : undefined;
}

function recorderKind(config: ActionToolConfig): "network" | "hook" | undefined {
	if (config.name === "browser_network") return "network";
	if (config.name === "browser_hook") return "hook";
	return undefined;
}

function recorderActiveState(action: unknown, data: Record<string, unknown>, fallback: boolean): boolean {
	const actionName = String(action ?? "");
	if (actionName === "stop" || actionName === "uninstall") return false;
	if (actionName === "start" || actionName === "captureReload" || actionName === "install" || actionName === "installTargets") return true;
	if (typeof data.active === "boolean") return data.active;
	if (typeof data.state === "string") return !/uninstalled|stopped|inactive/i.test(data.state);
	return fallback;
}

function recordKnownRecorderState(server: Awaited<ReturnType<CommandRegistrarContext["ensureStarted"]>>, config: ActionToolConfig, action: unknown, result: BrowserBridgeExecutionResult, browserSessionId: string | undefined, tabId: number | undefined): void {
	const kind = recorderKind(config);
	if (!kind || !server.recordKnownRecorderState) return;
	const data = isRecord(result.data) ? result.data : {};
	const known = server.getKnownRecorderState?.(kind, browserSessionId, tabId);
	const active = recorderActiveState(action, data, known?.active ?? false);
	const lastSeq = recorderHighWater(data) ?? known?.lastSeq;
	server.recordKnownRecorderState(kind, browserSessionId, tabId, { active, ...(lastSeq !== undefined ? { lastSeq } : {}) });
}

function defineNativeActionCommand({ commands, ensureStarted }: CommandRegistrarContext, config: ActionToolConfig) {
	const parameterProperties = {
		action: Type.String({ description: config.actionDescription }),
		params: Type.Optional(NativeCommandParamsSchema),
		...sharedTabScopedToolParams(),
		browserSessionId: Type.Optional(Type.String({ description: "Browser automation session id" })),
		...(config.sessionIdDescription ? { sessionId: Type.Optional(Type.String({ description: config.sessionIdDescription })) } : {}),
		timeoutMs: Type.Optional(Type.Number({ description: "Hard action deadline in milliseconds" })),
		maxChars: Type.Optional(Type.Number({ description: "Maximum inline JSON characters" })),
		outputPath: Type.Optional(Type.String({ description: "Optional artifact output path" })),
		detailLevel: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("preview"), Type.Literal("full")])),
		redact: Type.Optional(Type.Boolean({ description: "Redact sensitive values in persisted and inline output" })),
	};
	defineBrowserCommand(commands, {
		name: config.name,
		label: config.label,
		description: config.description,
		promptSnippet: config.promptSnippet,
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, config.promptGuideline],
		actionMetadata: config.actionMetadata,
		parameters: strictCommandParameters(parameterProperties),
		validateArguments: (args) => nativeActionValidation(config, args),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return await runCommandHandler(async () => {
				const actionIssues = nativeActionValidation(config, params as Record<string, unknown>);
				if (actionIssues.length) throw new Error(actionIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
				const server = await ensureStarted();
				const body = objectParam(params.params);
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
				const dispatch = async (dispatchContext?: { signal: AbortSignal }) => {
					const dispatchSignal = dispatchContext?.signal ?? signal;
					let dispatched: BrowserBridgeExecutionResult;
					if (captureReload) {
						dispatched = await server.sendCommand({ cmd: "batch", commands: networkCaptureReloadCommands(body, resolvedTabId, timeoutMs) }, { browserSessionId, tabId: resolvedTabId, timeoutMs, accessMode: "write", signal: dispatchSignal });
						assertBridgeBatchSucceeded(dispatched, "network.captureReload");
					} else {
						dispatched = config.commandExecutor
							? await config.commandExecutor(server, command, { browserSessionId, tabId: resolvedTabId, timeoutMs, signal: dispatchSignal })
							: await server.sendCommand(command, { browserSessionId, tabId: resolvedTabId, timeoutMs, signal: dispatchSignal });
					}
					recordKnownRecorderState(server, config, params.action, dispatched, browserSessionId, trackedTabId);
					return dispatched;
				};
				const writeCommand = captureReload || isNativeWriteCommand(command);
				if (writeCommand) {
					const outcome = await withBrowserOperation({ server, commandName: config.name, command: commandName, action: String(params.action || ""), browserSessionId, tabId: trackedTabId, targetRef: typeof params.targetRef === "string" ? params.targetRef : undefined, timeoutMs, ctx, onUpdate: _onUpdate, signal }, dispatch);
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
		actionMetadata: [{
			action: "captureReload",
			cliAction: "capture-reload",
			schemaRef: "command:browser_network#captureReload",
			paramsSchema: {
				type: "object",
				properties: {
					url: { type: "string" }, waitCondition: { type: "string" }, idleMs: { type: "number" }, waitTimeoutMs: { type: "number" },
					criteria: { type: "object" }, limit: { type: "number" }, includeDetails: { type: "boolean" }, ignoreCache: { type: "boolean" },
					captureBodies: { type: "boolean" }, captureRequestPostData: { type: "boolean" }, includeWebSocketFrames: { type: "boolean" }, includeSse: { type: "boolean" },
					maxEntries: { type: "number" }, maxAgeMs: { type: "number" }, maxBodyBytes: { type: "number" }, maxPostDataBytes: { type: "number" },
					maxFrames: { type: "number" }, maxFrameBytes: { type: "number" }, maxSseEvents: { type: "number" }, bodyTimeoutMs: { type: "number" },
					bodyMimeAllow: { type: "array", items: { type: "string" } }, includeUrls: { type: "array", items: { type: "string" } },
					excludeUrls: { type: "array", items: { type: "string" } }, resourceTypes: { type: "array", items: { type: "string" } },
					methods: { type: "array", items: { type: "string" } }, statuses: { type: "array", items: { type: "number" } }, storeHeaders: { type: "boolean" }, clear: { type: "boolean" }, reconfigure: { type: "boolean" },
				},
				additionalProperties: false,
			},
		}],
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
