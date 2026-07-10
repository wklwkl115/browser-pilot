import { Type } from "typebox";
import type { CommandActiveOperationInfo, CommandTemporalProfileSampleInput } from "../ports/BrowserCommandRuntimePort.js";
import { BrowserBridgeError } from "../utils/errors.js";
import { nextActionsForExecutionEffect } from "../kernels/evidence/distill/recovery.js";
import { tryJson } from "../utils/json.js";
import { isRecord } from "../utils/records.js";
import { compactExecutionEffect, buildExecutionJournal, type ExecuteEffect } from "./executionJournal.js";
import { withExecutionEffect } from "./executionEffect.js";
import { prepareExecuteStdlib, type ExecuteStdlibTargetRef } from "../browser-command-runtime/executeStdlib.js";
import { executeProgram, collectProgramTargetRefs, type ProgramContext, type ProgramResult } from "../browser-command-runtime/programEngine.js";
import { validateProgram } from "../browser-command-runtime/programDispatcher.js";
import { summarizeGenericValue } from "./summaries/index.js";
import { artifactFallbackName, buildActiveContext, defineBrowserCommand, jsonCommandResult, runBrowserCommand, sharedTabScopedToolParams, targetTabId, type BrowserCommandRunArgs, type StandardToolParams } from "./commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import { buildExecuteMonitorMetadata, executeJavaScriptWithMonitor, monitorTimeoutMs, readExecuteMonitorScan, type ExecuteMonitorScanResult, type ExecuteResultWithMonitorFeedback } from "./execute/monitorAdapter.js";

const PROGRAM_MAX_FRAMES = 60;
const PROGRAM_WARNING_THRESHOLD = 30;
const PROGRAM_NAV_WARNING = "page navigated — changed count is unreliable; use browser_wait + baseline observe for post-navigation change detection";

type ExecuteParams = Partial<StandardToolParams> & { script?: unknown; program?: unknown; monitor?: unknown };
type PreparedExecuteParams = ExecuteParams & { executeMode: "program" | "javascript"; normalizedScript?: string; normalizedProgram?: unknown[] };
type PreparedExecuteScript = ReturnType<typeof prepareExecuteStdlib>;
type ExecuteRunArgs = BrowserCommandRunArgs<ExecuteParams, PreparedExecuteParams>;
type ProgramRunResult = { executeMode: "program"; programResult: ProgramResult; effect?: ExecuteEffect; before?: ExecuteMonitorScanResult; after?: ExecuteMonitorScanResult };
type JavaScriptRunResult = { executeMode: "javascript"; jsResult: ExecuteResultWithMonitorFeedback; preparedScript: PreparedExecuteScript };
type ExecuteRunResult = ProgramRunResult | JavaScriptRunResult;
type ExecuteFinalizeArgs = ExecuteRunArgs & { result: ExecuteRunResult; operation?: CommandActiveOperationInfo };

function detectCommandLikeScript(script: string): boolean {
	const trimmed = script.trim();
	if (!trimmed.startsWith("{")) return false;
	const parsed = tryJson(trimmed);
	return isRecord(parsed) && typeof parsed.cmd === "string";
}

export function executeSummaryPageUrl(value: unknown): string | undefined {
	const record = isRecord(value) ? value : undefined;
	const target = isRecord(record?.target) ? record.target : undefined;
	if (typeof target?.url === "string" && target.url) return target.url;
	const monitor = isRecord(record?.monitor) ? record.monitor : undefined;
	for (const key of ["url", "urlAfter", "urlBefore"]) {
		const candidate = monitor?.[key];
		if (typeof candidate === "string" && candidate) return candidate;
	}
	const effect = isRecord(record?.effect) ? record.effect : undefined;
	if (typeof effect?.url === "string" && effect.url) return effect.url;
	return undefined;
}

export function executeArtifactHints(data: unknown): Record<string, unknown> | undefined {
	const preferredReads: Array<{ label: string; jsonPath: string; kind?: string; count?: number }> = [];
	if (Array.isArray(data)) {
		preferredReads.push({ label: "script return array", jsonPath: "data", kind: "execute-result", count: data.length });
	} else if (isRecord(data)) {
		const keys = Object.keys(data).filter((key) => data[key] !== undefined).slice(0, 3);
		preferredReads.push({ label: "script return object", jsonPath: "data", kind: "execute-result", count: Object.keys(data).length });
		for (const key of keys) preferredReads.push({ label: `script return field ${key}`, jsonPath: `data.${key}`, kind: "execute-result-field" });
	} else if (data !== undefined) {
		preferredReads.push({ label: "script return value", jsonPath: "data", kind: "execute-result" });
	}
	if (!preferredReads.length) return undefined;
	return { jsonPaths: Object.fromEntries(preferredReads.map((read) => [read.label, read.jsonPath])), preferredReads };
}

export function executeSummaryDataInline(data: unknown): boolean {
	return data !== undefined && data !== null &&
		!(isRecord(data) && (data.type === "array" || data.type === "object" || data.type === "string"));
}

export function executeResultNeedsArtifact(value: unknown): boolean {
	const generic = summarizeGenericValue(value);
	if (executeSummaryDataInline(generic.data)) return false;
	return !!executeArtifactHints(isRecord(value) ? value.data : undefined);
}

function prepareExecuteParams(params: ExecuteParams): PreparedExecuteParams {
	const program = Array.isArray(params.program) && params.program.length > 0 ? params.program : undefined;
	const script = typeof params.script === "string" && params.script.length > 0 ? params.script : undefined;
	if (program && script) throw new BrowserBridgeError("INVALID_RULE", "browser_execute accepts either script or program, not both", { commandName: "browser_execute" });
	if (program) {
		if (program.length > PROGRAM_MAX_FRAMES) throw new BrowserBridgeError("INVALID_RULE", `browser_execute program exceeds ${PROGRAM_MAX_FRAMES} frame limit (got ${program.length})`, { commandName: "browser_execute", frameCount: program.length });
		const validation = validateProgram(program);
		if (!validation.ok) throw new BrowserBridgeError("INVALID_RULE", validation.error, { commandName: "browser_execute", step: validation.step });
		return { ...params, executeMode: "program", normalizedProgram: program };
	}
	if (!script) throw new BrowserBridgeError("INVALID_RULE", "browser_execute requires script or program", { commandName: "browser_execute" });
	if (detectCommandLikeScript(script)) throw new BrowserBridgeError("INVALID_RULE", "browser_execute only accepts JavaScript; use browser_command for bridge commands", { commandName: "browser_execute", recovery: { useTool: "browser_command" } });
	return { ...params, executeMode: "javascript", normalizedScript: script };
}

function findProgramActionRef(frames: ProgramResult["frames"], program: unknown[]): string | undefined {
	const physical = frames.some((frame) => {
		const kind = String(frame.kind ?? "");
		return kind.startsWith("mouse:") || kind.startsWith("key:") || kind === "text";
	});
	if (!physical) return undefined;
	for (let index = program.length - 1; index >= 0; index -= 1) {
		const element = program[index];
		if (isRecord(element) && typeof element.ref === "string" && element.ref.startsWith("bp-ref://")) return element.ref;
	}
	return undefined;
}

async function runProgramExecution(args: ExecuteRunArgs, signal?: AbortSignal): Promise<ProgramRunResult> {
	const { server, prepared, browserSessionId, rawTabId, tabId, timeoutMs } = args;
	const program = prepared.normalizedProgram!;
	const monitorRequested = prepared.monitor === true;
	const scanTimeoutMs = monitorTimeoutMs(timeoutMs);
	await args.handle!.update({ progress: 15 });
	const before = monitorRequested ? await readExecuteMonitorScan(server, { browserSessionId, tabId: rawTabId, timeoutMs: scanTimeoutMs }) : undefined;
	const programContext: ProgramContext = {
		server,
		tabId,
		browserSessionId,
		targetRef: typeof rawTabId === "string" ? rawTabId : undefined,
		refRegistry: {},
		contextVars: new Map(),
		lastEvalResult: undefined,
		evalTimeoutMs: timeoutMs,
		signal: signal ?? new AbortController().signal,
	};
	const { result: programResult, effect } = await withExecutionEffect(server, { browserSessionId, tabId, timeoutMs, targetRefs: collectProgramTargetRefs(program) as unknown as ExecuteStdlibTargetRef[] }, () => executeProgram(program, programContext));
	const after = monitorRequested ? await readExecuteMonitorScan(server, { browserSessionId, tabId: rawTabId, timeoutMs: scanTimeoutMs }) : undefined;
	await args.handle!.update({ progress: 85 });
	return { executeMode: "program", programResult, effect, before, after };
}

async function executeJavaScriptDirect(args: ExecuteRunArgs, preparedScript: PreparedExecuteScript): Promise<ExecuteResultWithMonitorFeedback> {
	const { server, browserSessionId, rawTabId, tabId, timeoutMs } = args;
	const executed = await withExecutionEffect(server, { browserSessionId, tabId, timeoutMs, targetRefs: preparedScript.stdlib?.targetRefs }, () => server.executeJavaScript(preparedScript.script, { browserSessionId, tabId: rawTabId as number | string | undefined, timeoutMs }));
	return { ...executed.result, effect: executed.effect };
}

async function runJavaScriptExecution(args: ExecuteRunArgs): Promise<JavaScriptRunResult> {
	const { server, prepared, browserSessionId, rawTabId, timeoutMs } = args;
	const preparedScript = prepareExecuteStdlib(prepared.normalizedScript!);
	await args.handle!.update({ progress: prepared.monitor === true ? 15 : 35 });
	const jsResult = prepared.monitor === true
		? await executeJavaScriptWithMonitor(server, preparedScript.script, { browserSessionId, tabId: rawTabId, timeoutMs, targetRefs: preparedScript.stdlib?.targetRefs })
		: await executeJavaScriptDirect(args, preparedScript);
	await args.handle!.update({ progress: 85, details: { acknowledged: jsResult.acknowledged, target: jsResult.target } });
	return { executeMode: "javascript", jsResult, preparedScript };
}

function recordExecuteTemporalSample(args: ExecuteRunArgs, operation: CommandActiveOperationInfo, sample: Pick<CommandTemporalProfileSampleInput, "command" | "result" | "diagnostics">): void {
	const { server, browserSessionId, rawTabId, tabId, timeoutMs } = args;
	if (typeof server.buildTemporalProfileSample !== "function" || typeof server.recordTemporalProfileSample !== "function") return;
	void server.recordTemporalProfileSample(server.buildTemporalProfileSample({
		operationId: operation.operationId,
		tool: "browser_execute",
		...sample,
		target: { browserSessionId, tabId, targetRef: typeof rawTabId === "string" ? rawTabId : undefined },
		deadlineMs: timeoutMs,
		elapsedMs: Math.max(0, operation.updatedAt - operation.startedAt),
	}), { cwd: args.ctx?.cwd });
}

function distillProgramResult(value: unknown, operation: CommandActiveOperationInfo, warning?: string): Record<string, unknown> {
	const record = isRecord(value) ? value : {};
	const generic = summarizeGenericValue(record.result);
	const aborted = isRecord(record.aborted) ? record.aborted : undefined;
	const executedFrames = Array.isArray(record.executed) ? record.executed : [];
	const okFrames = executedFrames.filter((frame: unknown) => isRecord(frame) && frame.ok === true).length;
	const failedFrames = executedFrames.filter((frame: unknown) => isRecord(frame) && frame.ok === false).length;
	const effect = isRecord(record.effect) ? compactExecutionEffect(record.effect as ExecuteEffect) : undefined;
	const effectHints = nextActionsForExecutionEffect(record.effect as ExecuteEffect | undefined);
	const base = {
		...generic,
		operationId: operation.operationId,
		sourceMode: operation.sourceMode,
		mode: "program",
		frameCount: executedFrames.length,
		framesOk: okFrames,
		framesFailed: failedFrames,
		...(effect ? { effect } : {}),
		...(aborted ? { aborted: true, abortReason: aborted.reason, abortStep: aborted.atStep, ...(aborted.newUrl ? { newUrl: aborted.newUrl } : {}) } : {}),
		...(record.actionRef ? { actionRef: record.actionRef } : {}),
		...(warning ? { warning } : {}),
	} as Record<string, unknown>;
	const monitor = isRecord(record.monitor) ? record.monitor : undefined;
	const artifactReads: Array<{ label: string; jsonPath: string; kind?: string; count?: number }> = [];
	if (executedFrames.length) artifactReads.push({ label: "program frames", jsonPath: "executed", kind: "program-frames", count: executedFrames.length });
	if (record.result !== undefined) artifactReads.push({ label: "program final result", jsonPath: "result", kind: "execute-result" });
	if (monitor) artifactReads.push({ label: "program monitor", jsonPath: "monitor", kind: "execute-monitor" });
	if (artifactReads.length) base.artifact_hints = { jsonPaths: Object.fromEntries(artifactReads.map((read) => [read.label, read.jsonPath])), preferredReads: artifactReads };
	if (effectHints) base.nextActions = [...(Array.isArray(base.nextActions) ? base.nextActions : []), ...effectHints];
	if (monitor) base.monitorSource = { before: monitor.beforeSource, after: monitor.afterSource, changed: monitor.changed, top_change: monitor.top_change, ...(monitor.navigated === true ? { navigated: true, urlBefore: monitor.urlBefore, urlAfter: monitor.urlAfter } : {}) };
	return base;
}

function executeResultBase(args: ExecuteRunArgs, operation: CommandActiveOperationInfo, command: string, resultValue: Record<string, unknown>) {
	return {
		commandName: "browser_execute", command, defaultDetailLevel: "preview" as const, maxChars: args.maxChars, fallbackName: artifactFallbackName("execute"),
		operation, activeContext: buildActiveContext(args.server, args.params), artifactValue: { ...resultValue, operation },
	};
}

async function finalizeProgramExecution(args: ExecuteFinalizeArgs, result: ProgramRunResult, operation: CommandActiveOperationInfo) {
	const { params, prepared, ctx } = args;
	const { programResult, effect, before, after } = result;
	const frames = Array.isArray(programResult.frames) ? programResult.frames : [];
	const monitorRequested = prepared.monitor === true;
	const monitor = monitorRequested && before && after ? buildExecuteMonitorMetadata(before, after, { navigationWarning: PROGRAM_NAV_WARNING }) : undefined;
	const actionRef = findProgramActionRef(frames, prepared.normalizedProgram!);
	const execution = buildExecutionJournal({
		operationId: operation.operationId,
		dispatch: { kind: "program", command: "program" },
		effect,
		monitor,
		stdlib: { used: frames.some((frame) => frame.kind === "eval") },
	});
	const frameCount = frames.length;
	const warning = frameCount > PROGRAM_WARNING_THRESHOLD ? `program contains ${frameCount} frames — consider splitting into multiple observe+program cycles` : undefined;
	const resultValue = { executed: frames, result: programResult.result, aborted: programResult.aborted ?? null, ...(effect ? { effect } : {}), ...(monitor ? { monitor } : {}), execution, actionRef: actionRef ?? null };
	recordExecuteTemporalSample(args, operation, { command: "program", diagnostics: { aborted: !!programResult.aborted, frameCount } });
	const needsArtifact = frames.some((frame) => { if (frame.result === undefined) return false; try { return JSON.stringify(frame.result).length > 1_000; } catch { return false; } });
	return await jsonCommandResult(resultValue, params, ctx, {
		...executeResultBase(args, operation, "program", resultValue),
		artifactThreshold: needsArtifact ? 1 : undefined,
		details: { mode: "program", frameCount, aborted: !!programResult.aborted, monitor: monitorRequested, ...(warning ? { warning } : {}) },
		distill: (value) => distillProgramResult(value, operation, warning),
	});
}

function distillJavaScriptResult(value: unknown, operation: CommandActiveOperationInfo, preparedScript: PreparedExecuteScript): Record<string, unknown> {
	const generic = summarizeGenericValue(value);
	const dataInline = executeSummaryDataInline(generic.data);
	const hints = dataInline ? undefined : executeArtifactHints(isRecord(value) ? value.data : undefined);
	const effect = isRecord(value) ? compactExecutionEffect(value.effect as ExecuteEffect | undefined) : undefined;
	const effectHints = isRecord(value) ? nextActionsForExecutionEffect(value.effect as ExecuteEffect | undefined) : undefined;
	const url = executeSummaryPageUrl(value);
	const base = { ...generic, operationId: operation.operationId, sourceMode: operation.sourceMode, ...(url ? { url } : {}), ...(effect ? { effect } : {}), ...(preparedScript.stdlib ? { browserPilotRuntime: "1", refsEmbedded: preparedScript.stdlib.refsEmbedded, resolveMisses: preparedScript.stdlib.resolveMisses.length } : {}), ...(dataInline ? { dataInline: true } : {}), ...(hints ? { artifact_hints: hints } : {}) } as Record<string, unknown>;
	if (effectHints) base.nextActions = [...(Array.isArray(base.nextActions) ? base.nextActions : []), ...effectHints];
	const monitor = isRecord(value) && isRecord(value.monitor) ? value.monitor : undefined;
	if (monitor) {
		base.monitorSource = {
			before: monitor.beforeSource,
			after: monitor.afterSource,
			changed: monitor.changed,
			top_change: monitor.top_change,
			...(monitor.navigated === true ? { navigated: true, urlBefore: monitor.urlBefore, urlAfter: monitor.urlAfter, note: "page navigated — the before/after DOM diff does not span navigation; use browser_wait + a baseline observe (treeDiff) for post-navigation change" } : {}),
			...(monitor.afterUnreliable === true ? { afterUnreliable: true } : {}),
			abmlIntegrated: monitor.beforeSource === "abml-read" || monitor.afterSource === "abml-read",
		};
	}
	return base;
}

async function finalizeJavaScriptExecution(args: ExecuteFinalizeArgs, result: JavaScriptRunResult, operation: CommandActiveOperationInfo) {
	const { params, ctx } = args;
	const { jsResult, preparedScript } = result;
	const executeDiagnostics = isRecord(jsResult.diagnostics) ? jsResult.diagnostics : undefined;
	const execution = buildExecutionJournal({
		operationId: operation.operationId,
		target: jsResult.target,
		dispatch: { kind: "javascript", command: "javascript" },
		effect: jsResult.effect,
		monitor: jsResult.monitor,
		stdlib: preparedScript.stdlib ? { used: true, refsEmbedded: preparedScript.stdlib.refsEmbedded, resolveMisses: preparedScript.stdlib.resolveMisses.length } : undefined,
	});
	const resultValue = { ...jsResult, execution, ...(preparedScript.stdlib ? { browserPilotRuntime: "1" } : {}) };
	recordExecuteTemporalSample(args, operation, { command: "javascript", result: jsResult, diagnostics: executeDiagnostics });
	return await jsonCommandResult(resultValue, params, ctx, {
		...executeResultBase(args, operation, "javascript", resultValue),
		artifactThreshold: executeResultNeedsArtifact(resultValue) ? 1 : undefined,
		details: { mode: "javascript", monitor: params.monitor === true, ...(executeDiagnostics ? { diagnostics: executeDiagnostics } : {}), ...(preparedScript.stdlib ? { browserPilotRuntime: "1" } : {}) },
		diagnostics: executeDiagnostics,
		distill: (value) => distillJavaScriptResult(value, operation, preparedScript),
	});
}

export function defineExecuteCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_execute",
		label: "Browser Execute",
		description: "Execute JavaScript, or a structured program of physical input frames (mouse/key/text/drag) and JS eval, in a connected real browser tab.",
		promptSnippet: "Execute JavaScript or a physical-input program in a real browser tab.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use program (ordered frames of mouse/key/text/drag + eval/wait) for page interaction via trusted CDP events; use script for pure async JavaScript. Provide exactly one of script or program."],
		parameters: strictCommandParameters({
			script: Type.Optional(Type.String({ description: "JavaScript source. Provide either script or program." })),
			program: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }), {
				description: "Ordered program of physical input frames and JS eval, executed as one atomic sequence via trusted CDP events. Each element has exactly one discriminator (eval/mouse/key/text/wait); delay is a universal modifier. Use for page interaction (clicks, typing, scrolling, drag); use script for pure JavaScript.",
				minItems: 1,
				maxItems: PROGRAM_MAX_FRAMES,
			})),
			...sharedTabScopedToolParams(),
			monitor: Type.Optional(Type.Boolean({ description: "Capture compact before/after scan diff. Default false to avoid token and latency overhead." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return await runBrowserCommand<ExecuteParams, PreparedExecuteParams, ExecuteRunResult>({
				ensureStarted,
				commandName: "browser_execute",
				budgetName: "browser_execute",
				params: params as ExecuteParams,
				ctx,
				onUpdate,
				defaultTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
				prepare: ({ params: current }) => prepareExecuteParams(current),
				operation: { command: (_current, prepared) => prepared.executeMode, tabId: (current) => targetTabId(current), initialProgress: 5 },
				run: (args) => args.prepared.executeMode === "program" ? runProgramExecution(args, signal) : runJavaScriptExecution(args),
				finalize: (args) => args.result.executeMode === "program"
					? finalizeProgramExecution(args, args.result, args.operation!)
					: finalizeJavaScriptExecution(args, args.result, args.operation!),
			});
		},
	});
}
