import { Type } from "typebox";
import { prepareExecuteStdlib } from "../browser-command-runtime/executeStdlib.js";
import { executeProgram, type ProgramContext } from "../browser-command-runtime/programEngine.js";
import { validateProgram } from "../browser-command-runtime/programDispatcher.js";
import { BrowserBridgeError } from "../utils/errors.js";
import type { BrowserBridgeExecutionResult } from "../ports/BrowserRuntimeTypes.js";
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
	postcondition?: unknown;
	intentId?: unknown;
	browserSessionId?: unknown;
	tabId?: number | string;
	targetRef?: string;
	timeoutMs?: number;
	maxChars?: number;
};

type PreparedExecute =
	| { mode: "javascript"; script: string; postcondition?: string }
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
	const postcondition = typeof params.postcondition === "string" && params.postcondition.trim() ? params.postcondition.trim() : undefined;
	if (typeof params.intentId === "string" && !postcondition) throw new BrowserBridgeError("INVALID_RULE", "browser_execute script mutations with intentId require a business postcondition", { commandName: "browser_execute", field: "postcondition" });
	return { mode: "javascript", script, postcondition };
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
	if (hasProgram && args.postcondition !== undefined) return [{ code: "EXECUTE_POSTCONDITION_REQUIRES_SCRIPT", path: "/postcondition", message: "browser_execute postcondition is only valid with script" }];
	if (hasScript && detectCommandLikeScript(args.script as string)) return [{ code: "EXECUTE_COMMAND_SHAPED_SCRIPT", path: "/script", message: "browser_execute only accepts JavaScript; use browser_command for bridge commands" }];
	if (hasScript && typeof args.intentId === "string" && (typeof args.postcondition !== "string" || !args.postcondition.trim())) return [{ code: "EXECUTE_INTENT_REQUIRES_POSTCONDITION", path: "/postcondition", message: "browser_execute script mutations with intentId require a business postcondition" }];
	return [];
}

function postconditionScript(source: string, timeoutMs: number): string {
	return `
const __bpStartedAt = Date.now();
const __bpTimeoutMs = ${Math.max(0, Math.floor(timeoutMs))};
const __bpPassed = (value) => value === true || (value && typeof value === 'object' && value.verified === true);
const __bpRun = async () => await (${source});
const __bpResult = await new Promise((resolve) => {
  let observer;
  let timer;
  let settled = false;
  let checking = false;
  let rerun = false;
  let attempts = 0;
  let value;
  let error;
  const finish = (verified) => {
    if (settled) return;
    settled = true;
    if (observer) observer.disconnect();
    if (timer) clearTimeout(timer);
    resolve({ verified, value, attempts, elapsedMs: Date.now() - __bpStartedAt, ...(error ? { error } : {}) });
  };
  const check = async () => {
    if (settled) return;
    if (checking) { rerun = true; return; }
    checking = true;
    do {
      rerun = false;
      attempts += 1;
      try {
        value = await __bpRun();
        error = undefined;
        if (__bpPassed(value)) { finish(true); break; }
      } catch (caught) {
        error = String(caught && caught.message ? caught.message : caught).slice(0, 500);
      }
    } while (rerun && !settled);
    checking = false;
  };
  if (typeof MutationObserver === 'function' && document && document.documentElement) {
    observer = new MutationObserver(() => { void check(); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  timer = setTimeout(() => finish(false), __bpTimeoutMs);
  void check();
});
return __bpResult;`;
}

function postconditionPassed(value: unknown): boolean {
	return value === true || (isRecord(value) && value.verified === true);
}

type ScriptPostconditionResult = BrowserBridgeExecutionResult & {
	businessVerification: { passed: boolean; result: unknown };
};

async function executePrepared(
	prepared: PreparedExecute,
	server: Awaited<ReturnType<CommandRegistrarContext["ensureStarted"]>>,
	options: { browserSessionId?: string; rawTarget?: string | number; tabId?: number; timeoutMs: number; signal: AbortSignal; deadlineAt: number },
) {
	if (prepared.mode === "javascript") {
		const script = prepareExecuteStdlib(prepared.script).script;
		const action = await server.executeJavaScript(script, { browserSessionId: options.browserSessionId, tabId: options.rawTarget, timeoutMs: options.timeoutMs, signal: options.signal });
		if (!prepared.postcondition) return action;
		const remainingMs = Math.max(0, options.deadlineAt - Date.now());
		const verificationWindowMs = Math.max(0, remainingMs - Math.min(250, Math.floor(remainingMs / 4)));
		try {
			const verificationScript = prepareExecuteStdlib(postconditionScript(prepared.postcondition, verificationWindowMs), { enabled: true }).script;
			const verification = await server.executeJavaScript(verificationScript, {
				browserSessionId: options.browserSessionId,
				tabId: options.rawTarget,
				timeoutMs: Math.max(100, remainingMs),
				accessMode: "read",
				signal: options.signal,
			});
			return {
				...action,
				acknowledged: action.acknowledged || verification.acknowledged,
				businessVerification: { passed: postconditionPassed(verification.data), result: verification.data },
			} as ScriptPostconditionResult;
		} catch (error) {
			throw new BrowserBridgeError(options.signal.aborted ? "BRIDGE_TIMEOUT" : "BROWSER_EXECUTION_ERROR", "Business postcondition could not be proven after the script action was dispatched", {
				acked: action.acknowledged,
				dispatchStarted: true,
				postcondition: true,
				cause: error instanceof Error ? { name: error.name, message: error.message } : String(error),
			});
		}
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
		signal: options.signal,
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
			"For non-idempotent mutations, supply a stable intentId and keep both it and the script/program payload unchanged across recovery attempts. A physical program can complete only through navigation/download evidence or the sole final eval frame with verify:true whose value is true or {verified:true}; the fully expanded sequence is revalidated. Within the current daemon process, the same completed intent+payload is reused without dispatch, while uncertain replay or payload conflict is blocked.",
			"A scripted mutation with intentId must include postcondition, a read-only JavaScript predicate. Browser Pilot observes DOM mutations and reports completed only when that predicate returns true or {verified:true}; a false, lost, or timed-out proof is ambiguous and must not be replayed blindly.",
		],
		parameters: strictCommandParameters({
			script: Type.Optional(Type.String({ description: "JavaScript to execute. A non-undefined resolved value is mechanical completed/script-resolved evidence." })),
			program: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }), { description: "Trusted CDP input/eval frames. Physical mutations should end with an explicit eval frame verify:true; it passes only on true or {verified:true}." })),
			postcondition: Type.Optional(Type.String({ minLength: 1, description: "Read-only JavaScript predicate expression for script business success. It passes only on true or {verified:true}; required when script uses intentId." })),
			intentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", description: "Stable daemon-process idempotency intent for a non-idempotent mutation. Reuse it only with the identical script/program/postcondition payload; completed results are reused and uncertain/conflicting repeats are not dispatched." })),
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
					postcondition: prepared.mode === "javascript" && prepared.postcondition !== undefined,
					physicalProgram: prepared.mode === "program" ? prepared.physical : false,
					intentId: typeof params.intentId === "string" ? params.intentId : undefined,
					intentPayload: prepared.mode === "program" ? { mode: prepared.mode, program: prepared.program } : { mode: prepared.mode, script: prepared.script, postcondition: prepared.postcondition },
					browserSessionId,
					tabId,
					targetRef: typeof rawTarget === "string" ? rawTarget : undefined,
					timeoutMs,
					ctx,
					onUpdate,
					signal,
				}, ({ signal: operationSignal, deadlineAt }) => executePrepared(prepared, server, { browserSessionId, rawTarget: rawTarget as string | number | undefined, tabId, timeoutMs, signal: operationSignal, deadlineAt }));
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
