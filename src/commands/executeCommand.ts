import { Type } from "typebox";
import { prepareExecuteStdlib } from "../browser-command-runtime/executeStdlib.js";
import { MAX_EXECUTION_REFS, resolveExecutionRef } from "../browser-command-runtime/executionRef.js";
import { prepareAbmlVerification } from "../browser-command-runtime/abml/verification.js";
import { isAbmlStateExpectation } from "../kernels/abml/verification.js";
import { BrowserBridgeError } from "../utils/errors.js";
import { tryJson } from "../utils/json.js";
import { isRecord } from "../utils/records.js";
import { jsonResult } from "../utils/toolResult.js";
import { withBrowserOperation } from "./browserOperation.js";
import { withCommandEffect } from "./commandEffect.js";
import { commandExpectationSchema, javascriptVerificationResult, prepareCommandExpectation, type PreparedCommandExpectation } from "./commandExpectation.js";
import { defineBrowserCommand, pinTabExecutionTarget, resolveRefExecutionTarget, runCommandHandler, sharedTabScopedToolParams, targetTabId } from "./commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import type { ValidationIssue } from "./commandDefinition.js";

type ExecuteParams = {
	script?: string;
	refs?: Record<string, string>;
	readOnly?: unknown;
	expect?: unknown;
	targetRef?: string;
};

function detectCommandLikeScript(script: string): boolean {
	const trimmed = script.trim();
	if (!trimmed.startsWith("{")) return false;
	const parsed = tryJson(trimmed);
	return isRecord(parsed) && typeof parsed.cmd === "string";
}

function prepareExecute(params: ExecuteParams): { script: string; refs: Record<string, string>; readOnly: boolean; expect?: PreparedCommandExpectation } {
	const script = typeof params.script === "string" && params.script.length ? params.script : undefined;
	if (!script) throw new BrowserBridgeError("INVALID_RULE", "browser_execute requires script", { commandName: "browser_execute" });
	if (detectCommandLikeScript(script)) throw new BrowserBridgeError("INVALID_RULE", "browser_execute only accepts JavaScript; use browser_command for bridge commands", { commandName: "browser_execute", recovery: { useTool: "browser_command" } });
	if (params.refs !== undefined && !isRecord(params.refs)) throw new BrowserBridgeError("INVALID_RULE", "browser_execute refs must be an object", { commandName: "browser_execute" });
	const refs = params.refs ?? {};
	if (Object.keys(refs).length > MAX_EXECUTION_REFS) throw new BrowserBridgeError("INVALID_RULE", `browser_execute accepts at most ${MAX_EXECUTION_REFS} refs`, { refCount: Object.keys(refs).length });
	for (const [name, ref] of Object.entries(refs)) {
		if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || typeof ref !== "string" || !ref.startsWith("bp-ref://")) {
			throw new BrowserBridgeError("INVALID_RULE", "browser_execute refs must map JavaScript identifiers to bp-ref URIs", { commandName: "browser_execute", name, ref });
		}
	}
	const expect = prepareCommandExpectation(params.expect, "browser_execute");
	if (expect && params.readOnly === true) throw new BrowserBridgeError("INVALID_RULE", "browser_execute expect is only valid for writes", { commandName: "browser_execute" });
	return { script, refs, readOnly: params.readOnly === true, expect };
}

export function validateExecuteArguments(args: Record<string, unknown>): ValidationIssue[] {
	if (typeof args.script !== "string" || !args.script.length) return [{ code: "EXECUTE_SCRIPT_REQUIRED", path: "/script", message: "browser_execute requires script" }];
	const script = args.script;
	if (detectCommandLikeScript(script)) return [{ code: "EXECUTE_COMMAND_SHAPED_SCRIPT", path: "/script", message: "browser_execute only accepts JavaScript; use browser_command for bridge commands" }];
	if (args.expect !== undefined && !(typeof args.expect === "string" && args.expect.trim()) && !isAbmlStateExpectation(args.expect)) return [{ code: "EXECUTE_EXPECT_INVALID", path: "/expect", message: "browser_execute expect must be a non-empty JavaScript expression or structured ABML postcondition" }];
	if (args.expect !== undefined && args.readOnly === true) return [{ code: "EXECUTE_EXPECT_READ_ONLY", path: "/expect", message: "browser_execute expect is only valid for writes" }];
	return [];
}

async function executePrepared(
	prepared: { script: string; readOnly: boolean },
	server: Awaited<ReturnType<CommandRegistrarContext["ensureStarted"]>>,
	options: { browserSessionId?: string; rawTarget?: string | number; timeoutMs: number; signal?: AbortSignal },
) {
	return await server.executeJavaScript(prepared.script, { browserSessionId: options.browserSessionId, tabId: options.rawTarget, timeoutMs: options.timeoutMs, accessMode: prepared.readOnly ? "read" : "write", signal: options.signal });
}

export function defineExecuteCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_execute",
		label: "Browser Execute",
		description: "Execute JavaScript in the selected or ref-owning tab. Browser Pilot resolves bp-ref bindings, serializes writes, handles CSP/CDP fallback, and can verify a declared postcondition.",
		promptSnippet: "Execute JavaScript directly; omit targetRef for the selected tab and bind observed elements through refs when available.",
		promptGuidelines: [
			TAB_SCOPED_TOOL_GUIDELINE,
			"Pass observed bp-ref URIs through refs; each entry is available as browserPilot.refs.<name>, and its owner selects the tab automatically. Use browser_command input.ref for trusted native input.",
			"The page runtime exposes browserPilot.refs, resolve(ref), box(ref), and setValue(target,value).",
			"Use readOnly:true for queries. For writes, expect may declare a JavaScript truth expression or structured ABML ref/state postcondition; Browser Pilot owns settlement and returns canonical verification evidence.",
		],
		parameters: strictCommandParameters({
			script: Type.String({ description: "JavaScript to execute." }),
			refs: Type.Optional(Type.Record(
				Type.String({ pattern: "^[A-Za-z_$][A-Za-z0-9_$]*$", maxLength: 64 }),
				Type.String({ pattern: "^bp-ref://", description: "Observed bp-ref URI bound into browserPilot.refs under this key." }),
				{ additionalProperties: false, maxProperties: MAX_EXECUTION_REFS, description: "Named observed refs to resolve, inject, and use for automatic tab/session routing." },
			)),
			readOnly: Type.Optional(Type.Boolean({ description: "Declare that the script does not mutate browser state." })),
			expect: Type.Optional(commandExpectationSchema),
			...sharedTabScopedToolParams(),
		}),
		validateArguments: validateExecuteArguments,
		async execute(params: ExecuteParams, signal) {
			return await runCommandHandler(async () => {
				const input = prepareExecute(params);
				const prepared = prepareExecuteStdlib(input.script, { refs: input.refs });
				const javascript = input.expect?.kind === "javascript" ? input.expect : undefined;
				const expected = javascript ? prepareExecuteStdlib(`return Boolean(await (${javascript.expression}));`, { refs: input.refs }) : undefined;
				const server = await ensureStarted();
				const timeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
				const rawTarget = targetTabId(params as { targetRef?: string });
				const expectationRefs = input.expect?.kind === "abml" ? [resolveExecutionRef(input.expect.expectation.ref).target] : [];
				const resolvedTarget = resolveRefExecutionTarget(server, prepared.targetRefs, { rawTarget, observedRefs: expectationRefs });
				const target = input.readOnly ? resolvedTarget : pinTabExecutionTarget(server, resolvedTarget);
				const dispatch = (dispatchSignal?: AbortSignal) => executePrepared({ script: prepared.script, readOnly: input.readOnly }, server, { browserSessionId: target.browserSessionId, rawTarget: target.rawTarget, timeoutMs, signal: dispatchSignal });
				const outcome = input.readOnly
					? { result: await dispatch(signal) }
					: await withBrowserOperation({
						server,
						browserSessionId: target.browserSessionId,
						tabId: target.tabId,
						targetRef: target.rawTarget,
						timeoutMs,
						signal,
					}, async ({ signal: operationSignal, deadlineAt }) => {
						const structured = input.expect?.kind === "abml" ? input.expect.expectation : undefined;
						const abmlVerification = structured ? await prepareAbmlVerification({ server, expectation: structured, verb: "browser_execute", browserSessionId: target.browserSessionId, tabId: target.tabId!, rawTarget: target.rawTarget!, timeoutMs, signal: operationSignal }) : undefined;
						const initialVerification = abmlVerification?.initialVerification ?? (javascript ? javascriptVerificationResult("browser_execute") : undefined);
						const effected = await withCommandEffect(server, {
							browserSessionId: target.browserSessionId,
							tabId: target.tabId,
							timeoutMs,
							deadlineAt,
							signal: operationSignal,
							...(initialVerification ? { initialVerification } : {}),
							...(expected ? { verify: async () => javascriptVerificationResult("browser_execute", (await executePrepared({ script: expected.script, readOnly: true }, server, { browserSessionId: target.browserSessionId, rawTarget: target.rawTarget, timeoutMs, signal: operationSignal })).data === true) } : {}),
							...(abmlVerification ? { verify: abmlVerification.verify } : {}),
						}, () => dispatch(operationSignal));
						const diff = abmlVerification?.diff();
						return { ...effected, ...(diff ? { diff } : {}) };
					});
				const value = "effect" in outcome ? {
					...outcome.result,
					effect: outcome.effect,
					...(outcome.verification ? { verification: outcome.verification } : {}),
					...("diff" in outcome && outcome.diff ? { diff: outcome.diff } : {}),
				} : outcome.result;
				return jsonResult(value, { mode: "javascript", refsBound: Object.keys(input.refs).length }, { preserveExecutionData: true });
			});
		},
	});
}
