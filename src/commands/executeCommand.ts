import { Type } from "typebox";
import { prepareExecuteStdlib } from "../browser-command-runtime/executeStdlib.js";
import { MAX_EXECUTION_REFS } from "../browser-command-runtime/executionRef.js";
import { BrowserBridgeError } from "../utils/errors.js";
import { tryJson } from "../utils/json.js";
import { redactSensitiveValue } from "../utils/redaction.js";
import { isRecord } from "../utils/records.js";
import { jsonResult } from "../utils/toolResult.js";
import { withBrowserOperation } from "./browserOperation.js";
import { defineBrowserCommand, resolveRefExecutionTarget, runCommandHandler, sharedTabScopedToolParams, targetTabId } from "./commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import type { ValidationIssue } from "./commandDefinition.js";

type ExecuteParams = {
	script?: string;
	refs?: Record<string, string>;
	readOnly?: unknown;
	targetRef?: string;
};

function detectCommandLikeScript(script: string): boolean {
	const trimmed = script.trim();
	if (!trimmed.startsWith("{")) return false;
	const parsed = tryJson(trimmed);
	return isRecord(parsed) && typeof parsed.cmd === "string";
}

function prepareExecute(params: ExecuteParams): { script: string; refs: Record<string, string>; readOnly: boolean } {
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
	return { script, refs, readOnly: params.readOnly === true };
}

export function validateExecuteArguments(args: Record<string, unknown>): ValidationIssue[] {
	if (typeof args.script !== "string" || !args.script.length) return [{ code: "EXECUTE_SCRIPT_REQUIRED", path: "/script", message: "browser_execute requires script" }];
	const script = args.script;
	if (detectCommandLikeScript(script)) return [{ code: "EXECUTE_COMMAND_SHAPED_SCRIPT", path: "/script", message: "browser_execute only accepts JavaScript; use browser_command for bridge commands" }];
	return [];
}

async function executePrepared(
	prepared: { script: string; readOnly: boolean },
	server: Awaited<ReturnType<CommandRegistrarContext["ensureStarted"]>>,
	options: { browserSessionId?: string; rawTarget?: string | number; timeoutMs: number; signal: AbortSignal },
) {
	return await server.executeJavaScript(prepared.script, { browserSessionId: options.browserSessionId, tabId: options.rawTarget, timeoutMs: options.timeoutMs, accessMode: prepared.readOnly ? "read" : "write", signal: options.signal });
}

export function defineExecuteCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_execute",
		label: "Browser Execute",
		description: "Execute JavaScript in the selected or ref-owning tab, with bp-ref bindings resolved by Browser Pilot.",
		promptSnippet: "Execute JavaScript; bind observed elements through refs instead of copying selectors or native target fields.",
		promptGuidelines: [
			TAB_SCOPED_TOOL_GUIDELINE,
			"Pass observed bp-ref URIs through refs; each entry is available as browserPilot.refs.<name>, and its owner selects the tab automatically. Use browser_command input.ref for trusted native input.",
			"Use readOnly:true for queries; mutating calls are serialized per target and bounded by the execution deadline.",
		],
		parameters: strictCommandParameters({
			script: Type.String({ description: "JavaScript to execute." }),
			refs: Type.Optional(Type.Record(
				Type.String({ pattern: "^[A-Za-z_$][A-Za-z0-9_$]*$", maxLength: 64 }),
				Type.String({ pattern: "^bp-ref://", description: "Observed bp-ref URI bound into browserPilot.refs under this key." }),
				{ additionalProperties: false, maxProperties: MAX_EXECUTION_REFS, description: "Named observed refs to resolve, inject, and use for automatic tab/session routing." },
			)),
			readOnly: Type.Optional(Type.Boolean({ description: "Declare that the script does not mutate browser state." })),
			...sharedTabScopedToolParams(),
		}),
		validateArguments: validateExecuteArguments,
		async execute(_toolCallId, params: ExecuteParams, signal) {
			return await runCommandHandler(async () => {
				const input = prepareExecute(params);
				const prepared = prepareExecuteStdlib(input.script, { refs: input.refs });
				const server = await ensureStarted();
				const timeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
				const rawTarget = targetTabId(params as { targetRef?: string });
				const target = resolveRefExecutionTarget(server, prepared.targetRefs, { rawTarget });
				const result = await withBrowserOperation({
					server,
					browserSessionId: target.browserSessionId,
					tabId: target.tabId,
					timeoutMs,
					signal,
				}, ({ signal: operationSignal }) => executePrepared({ script: prepared.script, readOnly: input.readOnly }, server, { browserSessionId: target.browserSessionId, rawTarget: target.rawTarget, timeoutMs, signal: operationSignal }));
				return jsonResult(redactSensitiveValue(result), { mode: "javascript", refsBound: Object.keys(input.refs).length });
			});
		},
	});
}
