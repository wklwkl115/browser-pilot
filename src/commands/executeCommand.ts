import { Type } from "typebox";
import { prepareExecuteStdlib } from "../browser-command-runtime/executeStdlib.js";
import { executeProgram, type ProgramContext } from "../browser-command-runtime/programEngine.js";
import { validateProgram } from "../browser-command-runtime/programDispatcher.js";
import { BrowserBridgeError } from "../utils/errors.js";
import { tryJson } from "../utils/json.js";
import { isRecord } from "../utils/records.js";
import { withBrowserOperation } from "./browserOperation.js";
import { browserOperationCommandResult } from "./browserOperationResult.js";
import { commandMaxChars, commandTimeoutMs, defineBrowserCommand, resolveLocalTargetTabId, runCommandHandler, sharedTabScopedToolParams, targetTabId } from "./commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import type { ValidationIssue } from "./commandDefinition.js";

const PROGRAM_MAX_FRAMES = 60;

type ExecuteParams = {
	script?: unknown;
	program?: unknown;
	browserSessionId?: unknown;
	tabId?: number | string;
	targetRef?: string;
	timeoutMs?: number;
	maxChars?: number;
};

type PreparedExecute =
	| { mode: "javascript"; script: string }
	| { mode: "program"; program: unknown[]; physical: boolean };

function detectCommandLikeScript(script: string): boolean {
	const trimmed = script.trim();
	if (!trimmed.startsWith("{")) return false;
	const parsed = tryJson(trimmed);
	return isRecord(parsed) && typeof parsed.cmd === "string";
}

function prepareExecute(params: ExecuteParams): PreparedExecute {
	const program = Array.isArray(params.program) && params.program.length ? params.program : undefined;
	const script = typeof params.script === "string" && params.script.length ? params.script : undefined;
	if (program && script) throw new BrowserBridgeError("INVALID_RULE", "browser_execute accepts either script or program, not both", { commandName: "browser_execute" });
	if (program) {
		if (program.length > PROGRAM_MAX_FRAMES) throw new BrowserBridgeError("INVALID_RULE", `browser_execute program exceeds ${PROGRAM_MAX_FRAMES} frame limit (got ${program.length})`, { commandName: "browser_execute", frameCount: program.length });
		const validation = validateProgram(program);
		if (!validation.ok) throw new BrowserBridgeError("INVALID_RULE", validation.error, { commandName: "browser_execute", step: validation.step });
		return { mode: "program", program, physical: program.some((frame) => isRecord(frame) && (frame.mouse !== undefined || frame.key !== undefined || frame.text !== undefined)) };
	}
	if (!script) throw new BrowserBridgeError("INVALID_RULE", "browser_execute requires script or program", { commandName: "browser_execute" });
	if (detectCommandLikeScript(script)) throw new BrowserBridgeError("INVALID_RULE", "browser_execute only accepts JavaScript; use browser_command for bridge commands", { commandName: "browser_execute", recovery: { useTool: "browser_command" } });
	return { mode: "javascript", script };
}

export function validateExecuteArguments(args: Record<string, unknown>): ValidationIssue[] {
	const hasScript = typeof args.script === "string" && args.script.length > 0;
	const hasProgram = Array.isArray(args.program) && args.program.length > 0;
	if (hasScript === hasProgram) {
		return [{
			code: "EXECUTE_EXACTLY_ONE_INPUT",
			path: "/",
			message: hasScript ? "browser_execute accepts exactly one of script or program" : "browser_execute requires exactly one of script or program",
		}];
	}
	if (hasProgram) {
		const program = args.program as unknown[];
		if (program.length > PROGRAM_MAX_FRAMES) return [{ code: "EXECUTE_PROGRAM_TOO_LARGE", path: "/program", message: `browser_execute program exceeds ${PROGRAM_MAX_FRAMES} frame limit (got ${program.length})` }];
		const validation = validateProgram(program);
		if (!validation.ok) return [{ code: "EXECUTE_PROGRAM_INVALID", path: validation.step === undefined ? "/program" : `/program/${validation.step}`, message: validation.error }];
	}
	if (hasScript && detectCommandLikeScript(args.script as string)) return [{ code: "EXECUTE_COMMAND_SHAPED_SCRIPT", path: "/script", message: "browser_execute only accepts JavaScript; use browser_command for bridge commands" }];
	return [];
}

async function executePrepared(
	prepared: PreparedExecute,
	server: Awaited<ReturnType<CommandRegistrarContext["ensureStarted"]>>,
	options: { browserSessionId?: string; rawTarget?: string | number; tabId?: number; timeoutMs: number; signal?: AbortSignal },
) {
	if (prepared.mode === "javascript") {
		const script = prepareExecuteStdlib(prepared.script).script;
		return await server.executeJavaScript(script, { browserSessionId: options.browserSessionId, tabId: options.rawTarget, timeoutMs: options.timeoutMs });
	}
	const context: ProgramContext = {
		server,
		tabId: options.tabId,
		browserSessionId: options.browserSessionId,
		targetRef: typeof options.rawTarget === "string" ? options.rawTarget : undefined,
		refRegistry: {},
		contextVars: new Map(),
		lastEvalResult: undefined,
		evalTimeoutMs: options.timeoutMs,
		signal: options.signal ?? new AbortController().signal,
	};
	return await executeProgram(prepared.program, context);
}

export function defineExecuteCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_execute",
		label: "Browser Execute",
		description: "Execute JavaScript or a trusted physical-input program as one event-driven browser operation transaction and return browser-operation/v2 at its proven terminal state.",
		promptSnippet: "Execute one JavaScript or trusted input transaction; consume its browser-operation/v2 outcome, continuation, and artifact hints without a follow-up wait or sleep.",
		promptGuidelines: [
			TAB_SCOPED_TOOL_GUIDELINE,
			"Use script for JavaScript or program for trusted CDP mouse/key/text frames; pass exactly one.",
			"The call remains open until completed, effect_observed, no_effect, stalled, target_lost, failed, ambiguous, or deadline. effect_observed is browser evidence, not proof of business success; no_effect and stalled are not success.",
			"Follow continuation before another mutation. Large resolved values stay in saved.path and are addressed by artifact_hints; inspect them instead of replaying the execute call.",
		],
		parameters: strictCommandParameters({
			script: Type.Optional(Type.String({ description: "JavaScript to execute. A non-undefined resolved value is mechanical completed/script-resolved evidence." })),
			program: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }), { description: "Trusted CDP input/eval frames. Physical frames require an observed browser effect." })),
			...sharedTabScopedToolParams(),
		}),
		validateArguments: validateExecuteArguments,
		async execute(_toolCallId, params: ExecuteParams, signal, onUpdate, ctx) {
			return await runCommandHandler(async () => {
				const prepared = prepareExecute(params);
				const server = await ensureStarted();
				const timeoutMs = commandTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = commandMaxChars(params, "browser_execute");
				const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
				const rawTarget = targetTabId(params as { tabId?: number | string; targetRef?: string });
				const tabId = resolveLocalTargetTabId(server, rawTarget, browserSessionId);
				const outcome = await withBrowserOperation({
					server,
					commandName: "browser_execute",
					command: prepared.mode === "program" ? "program" : "javascript",
					mode: prepared.mode,
					physicalProgram: prepared.mode === "program" ? prepared.physical : false,
					browserSessionId,
					tabId,
					targetRef: typeof rawTarget === "string" ? rawTarget : undefined,
					timeoutMs,
					ctx,
					onUpdate,
				}, () => executePrepared(prepared, server, { browserSessionId, rawTarget: rawTarget as string | number | undefined, tabId, timeoutMs, signal }));
				return await browserOperationCommandResult(outcome, {
					budgetName: "browser_execute",
					maxChars,
					ctx,
					details: { mode: prepared.mode, operationId: outcome.operationId, status: outcome.status },
				});
			});
		},
	});
}
