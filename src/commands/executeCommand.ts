import { Type } from "typebox";
import type { BrowserBridgeExecutionResult } from "../ports/BrowserRuntimeTypes.js";
import { BrowserBridgeError } from "../utils/errors.js";
import { nextActionsForExecutionEffect } from "../kernels/evidence/distill/recovery.js";
import { buildScanScript } from "../scan/buildScanScript.js";
import { createBrowserAbmlIntegration } from "../browser-command-runtime/abml/integration.js";
import { compactError } from "../utils/errors.js";
import { tryJson } from "../utils/json.js";
import { isRecord } from "../utils/records.js";
import { compactExecutionEffect, buildExecutionJournal, type ExecuteEffect } from "./executionJournal.js";
import { withExecutionEffect } from "./executionEffect.js";
import { prepareExecuteStdlib, type ExecuteStdlibTargetRef } from "../browser-command-runtime/executeStdlib.js";
import { executeProgram, collectProgramTargetRefs, type ProgramContext } from "../browser-command-runtime/programEngine.js";
import { validateProgram } from "../browser-command-runtime/programDispatcher.js";
import { summarizeGenericValue } from "./summaries/index.js";
import { artifactFallbackName, buildActiveContext, defineBrowserCommand, jsonCommandResult, resolveLocalTargetTabId, runCommandHandler, sharedTabScopedToolParams, targetTabId, commandMaxChars, commandTimeoutMs, withTrackedOperation } from "./commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";

const PROGRAM_MAX_FRAMES = 60;
const PROGRAM_WARNING_THRESHOLD = 30;
const PROGRAM_NAV_WARNING = "page navigated — changed count is unreliable; use browser_wait + baseline observe for post-navigation change detection";

type MonitorScanResult = {
	ok: boolean;
	content?: string;
	url?: string;
	error?: Record<string, unknown>;
	source?: "abml-read" | "legacy-scan";
};

type MonitorMetadata = {
	url?: string;
	beforeOk: boolean;
	afterOk: boolean;
	beforeChars: number;
	afterChars: number;
	changed: number;
	top_change?: string;
	navigated?: boolean;
	/** When true, `changed` is unreliable due to page navigation. */
	changedReliable?: boolean;
	/** Human-readable warning surfaced when the monitor detects navigation. */
	warning?: string;
	afterUnreliable?: boolean;
	urlBefore?: string;
	urlAfter?: string;
	beforeError?: Record<string, unknown>;
	afterError?: Record<string, unknown>;
	beforeSource?: "abml-read" | "legacy-scan";
	afterSource?: "abml-read" | "legacy-scan";
};

function textLines(value: unknown): string[] {
	return String(value || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function diffScanContent(before: unknown, after: unknown): { changed: number; top_change?: string } {
	const beforeSet = new Set(textLines(before));
	const added = textLines(after).filter((line) => !beforeSet.has(line));
	return { changed: added.length, top_change: added[0]?.slice(0, 2_000) };
}

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
	return preferredReads.length ? { preferredReads } : undefined;
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

async function monitorScan(server: Awaited<ReturnType<CommandRegistrarContext["ensureStarted"]>>, scanScript: string, options: { browserSessionId?: string; tabId?: unknown; timeoutMs: number }): Promise<MonitorScanResult> {
	try {
		const runtime = createBrowserAbmlIntegration(server, { browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs, maxChars: 50_000 });
		const abml = await runtime.readStructure({ browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs, maxChars: 50_000 });
		if (abml?.ok && abml.data && typeof abml.data === "object") {
			const summary = (abml.data as Record<string, unknown>).summary as Record<string, unknown> | undefined;
			const content = typeof summary?.textPreview === "string" ? summary.textPreview : JSON.stringify(abml.entities ?? [], null, 2);
			const url = typeof summary?.url === "string" ? summary.url : undefined;
			return { ok: true, content, url, source: "abml-read" };
		}
		const result = await server.executeJavaScript(scanScript, { browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs });
		const content = (result.data as Record<string, unknown> | undefined)?.content;
		return { ok: true, content: typeof content === "string" ? content : undefined, source: "legacy-scan" };
	} catch (error) {
		return { ok: false, error: compactError(error, "MONITOR_SCAN_FAILED") };
	}
}

type ExecuteResultWithFeedback = BrowserBridgeExecutionResult & {
	effect?: ExecuteEffect;
	monitor?: MonitorMetadata;
};

async function executeJavaScriptWithMonitor(server: Awaited<ReturnType<CommandRegistrarContext["ensureStarted"]>>, script: string, options: { browserSessionId?: string; tabId?: unknown; timeoutMs: number; targetRefs?: ExecuteStdlibTargetRef[] }): Promise<ExecuteResultWithFeedback> {
	const monitorTimeoutMs = Math.min(Math.max(500, options.timeoutMs), 5_000);
	const scanScript = buildScanScript({ textOnly: false, maxChars: 50_000, maxNodes: 3_000 });
	const before = await monitorScan(server, scanScript, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: monitorTimeoutMs });
	const effectTabId = resolveLocalTargetTabId(server, options.tabId, options.browserSessionId);
	const executed = await withExecutionEffect(server, { browserSessionId: options.browserSessionId, tabId: effectTabId, timeoutMs: options.timeoutMs, targetRefs: options.targetRefs }, () => server.executeJavaScript(script, { browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs }));
	const after = await monitorScan(server, scanScript, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: monitorTimeoutMs });
	const diff = before.ok && after.ok ? diffScanContent(before.content, after.content) : { changed: 0, top_change: undefined };
	// A script that navigates/reloads makes the same-document line diff meaningless: the after-read
	// races the navigation and often sees no NEW lines → a misleading `changed: 0`. `summary.url` comes
	// from the page's location.href (updated synchronously on assignment), so a url change is the reliable
	// signal. Flag it so `changed: 0` is never read as "nothing happened" (observed in a real agent
	// session: a click that navigated to the next chapter reported changed:0). For navigation-level change
	// detection use browser_wait + a baseline observe (treeDiff), not monitor.
	const navigated = !!(before.url && after.url && before.url !== after.url);
	const afterUnreliable = before.ok && !after.ok;
	return {
		...executed.result,
		effect: executed.effect,
		monitor: {
			...(after.url || before.url ? { url: after.url ?? before.url } : {}),
			beforeOk: before.ok,
			afterOk: after.ok,
			beforeChars: typeof before.content === "string" ? before.content.length : 0,
			afterChars: typeof after.content === "string" ? after.content.length : 0,
			...diff,
			...(navigated ? { navigated: true, changedReliable: false, warning: "page navigated — changed count is unreliable; use browser_wait + baseline observe for post-navigation change detection", urlBefore: before.url, urlAfter: after.url } : {}),
			...(afterUnreliable ? { afterUnreliable: true } : {}),
			beforeError: before.error,
			afterError: after.error,
			beforeSource: before.source,
			afterSource: after.source,
		},
	};
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return await runCommandHandler(async () => {
				const program = Array.isArray(params.program) && params.program.length > 0 ? (params.program as unknown[]) : undefined;
				const script = typeof params.script === "string" && params.script.length > 0 ? params.script : undefined;
				if (program && script) throw new BrowserBridgeError("INVALID_RULE", "browser_execute accepts either script or program, not both", { commandName: "browser_execute" });
				const server = await ensureStarted();
				if (program) {
					if (program.length > PROGRAM_MAX_FRAMES) throw new BrowserBridgeError("INVALID_RULE", `browser_execute program exceeds ${PROGRAM_MAX_FRAMES} frame limit (got ${program.length})`, { commandName: "browser_execute", frameCount: program.length });
					const validation = validateProgram(program);
					if (!validation.ok) throw new BrowserBridgeError("INVALID_RULE", validation.error, { commandName: "browser_execute", step: validation.step });
					const timeoutMs = commandTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
					const maxChars = commandMaxChars(params, "browser_execute");
					const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
					const rawTargetRef = targetTabId(params);
					const tabId = resolveLocalTargetTabId(server, rawTargetRef, browserSessionId);
					const monitorRequested = params.monitor === true;
					const scanScript = monitorRequested ? buildScanScript({ textOnly: false, maxChars: 50_000, maxNodes: 3_000 }) : undefined;
					const monitorTimeoutMs = Math.min(Math.max(500, timeoutMs), 5_000);
					const { result: programOutcome, operation } = await withTrackedOperation(server, {
						commandName: "browser_execute",
						command: "program",
						browserSessionId,
						tabId,
						phase: "running",
						progress: 5,
						queueDepth: server.queueDepth(browserSessionId, tabId),
						leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
					}, _onUpdate, async (handle) => {
						await handle.update({ progress: 15 });
						const before = scanScript ? await monitorScan(server, scanScript, { browserSessionId, tabId: rawTargetRef, timeoutMs: monitorTimeoutMs }) : undefined;
						const programCtx: ProgramContext = {
							server,
							tabId,
							browserSessionId,
							targetRef: typeof rawTargetRef === "string" ? rawTargetRef : undefined,
							refRegistry: {},
							contextVars: new Map(),
							lastEvalResult: undefined,
							evalTimeoutMs: timeoutMs,
							signal: signal ?? new AbortController().signal,
						};
						// Aggregate effect tracking across the whole program (same signal machinery as the script path).
						const { result: programResult, effect } = await withExecutionEffect(server, { browserSessionId, tabId, timeoutMs, targetRefs: collectProgramTargetRefs(program) as unknown as ExecuteStdlibTargetRef[] }, () => executeProgram(program, programCtx));
						const after = scanScript ? await monitorScan(server, scanScript, { browserSessionId, tabId: rawTargetRef, timeoutMs: monitorTimeoutMs }) : undefined;
						await handle.update({ progress: 85 });
						return { programResult, effect, before, after };
					});
					const { programResult, effect, before, after } = programOutcome;
					const frames = Array.isArray(programResult.frames) ? programResult.frames : [];
					let monitor: MonitorMetadata | undefined;
					if (monitorRequested && before && after) {
						const diff = before.ok && after.ok ? diffScanContent(before.content, after.content) : { changed: 0, top_change: undefined };
						const navigated = !!(before.url && after.url && before.url !== after.url);
						monitor = {
							...(after.url || before.url ? { url: after.url ?? before.url } : {}),
							beforeOk: before.ok,
							afterOk: after.ok,
							beforeChars: typeof before.content === "string" ? before.content.length : 0,
							afterChars: typeof after.content === "string" ? after.content.length : 0,
							...diff,
							...(navigated ? { navigated: true, changedReliable: false, warning: PROGRAM_NAV_WARNING, urlBefore: before.url, urlAfter: after.url } : {}),
							beforeError: before.error,
							afterError: after.error,
							beforeSource: before.source,
							afterSource: after.source,
						};
					}
					let actionRef: string | undefined;
					const lastPhysical = [...frames].reverse().find((f) => { const k = String(f.kind ?? ""); return k.startsWith("mouse:") || k.startsWith("key:") || k === "text"; });
					if (lastPhysical) for (const element of program) if (isRecord(element) && typeof element.ref === "string" && element.ref.startsWith("bp-ref://")) actionRef = element.ref;
					const execution = buildExecutionJournal({
						operationId: operation.operationId,
						dispatch: { kind: "program", command: "program" },
						effect,
						monitor,
						stdlib: { used: frames.some((f) => f.kind === "eval") },
					});
					const frameCount = frames.length;
					const warning = frameCount > PROGRAM_WARNING_THRESHOLD ? `program contains ${frameCount} frames — consider splitting into multiple observe+program cycles` : undefined;
					const resultValue = { executed: frames, result: programResult.result, aborted: programResult.aborted ?? null, ...(effect ? { effect } : {}), ...(monitor ? { monitor } : {}), execution, actionRef: actionRef ?? null };
					if (typeof server.buildTemporalProfileSample === "function" && typeof server.recordTemporalProfileSample === "function") {
						void server.recordTemporalProfileSample(server.buildTemporalProfileSample({
							operationId: operation.operationId,
							tool: "browser_execute",
							command: "program",
							target: { browserSessionId, tabId, targetRef: typeof rawTargetRef === "string" ? rawTargetRef : undefined },
							deadlineMs: timeoutMs,
							elapsedMs: Math.max(0, operation.updatedAt - operation.startedAt),
							diagnostics: { aborted: !!programResult.aborted, frameCount: frames.length },
						}), { cwd: ctx?.cwd });
					}
					const needsArtifact = frames.some((f) => { if (f.result === undefined) return false; try { return JSON.stringify(f.result).length > 1_000; } catch { return false; } });
					return await jsonCommandResult(resultValue, params, ctx, {
						commandName: "browser_execute",
						command: "program",
						defaultDetailLevel: "preview",
						maxChars,
						fallbackName: artifactFallbackName("execute"),
						artifactThreshold: needsArtifact ? 1 : undefined,
						details: { mode: "program", frameCount, aborted: !!programResult.aborted, monitor: monitorRequested, ...(warning ? { warning } : {}) },
						operation,
						activeContext: buildActiveContext(server, params),
						artifactValue: { ...resultValue, operation },
						distill: (value) => {
							const record = isRecord(value) ? value : {};
							const generic = summarizeGenericValue(record.result);
							const aborted = isRecord(record.aborted) ? record.aborted : undefined;
							const executedFrames = Array.isArray(record.executed) ? record.executed : [];
							const okFrames = executedFrames.filter((f: unknown) => isRecord(f) && f.ok === true).length;
							const failedFrames = executedFrames.filter((f: unknown) => isRecord(f) && f.ok === false).length;
							const eff = isRecord(record.effect) ? compactExecutionEffect(record.effect as ExecuteEffect) : undefined;
							const effHints = nextActionsForExecutionEffect(record.effect as ExecuteEffect | undefined);
							const base = {
								...generic,
								operationId: operation.operationId,
								sourceMode: operation.sourceMode,
								mode: "program",
								frameCount: executedFrames.length,
								framesOk: okFrames,
								framesFailed: failedFrames,
								...(eff ? { effect: eff } : {}),
								...(aborted ? { aborted: true, abortReason: aborted.reason, abortStep: aborted.atStep, ...(aborted.newUrl ? { newUrl: aborted.newUrl } : {}) } : {}),
								...(record.actionRef ? { actionRef: record.actionRef } : {}),
								...(warning ? { warning } : {}),
							} as Record<string, unknown>;
							if (effHints) base.nextActions = [...(Array.isArray(base.nextActions) ? base.nextActions : []), ...effHints];
							const mon = isRecord(record.monitor) ? record.monitor : undefined;
							if (mon) base.monitorSource = { before: mon.beforeSource, after: mon.afterSource, changed: mon.changed, top_change: mon.top_change, ...(mon.navigated === true ? { navigated: true, urlBefore: mon.urlBefore, urlAfter: mon.urlAfter } : {}) };
							return base;
						},
					});
				}
				if (!script) throw new BrowserBridgeError("INVALID_RULE", "browser_execute requires script or program", { commandName: "browser_execute" });
				if (detectCommandLikeScript(script)) {
					throw new BrowserBridgeError("INVALID_RULE", "browser_execute only accepts JavaScript; use browser_command for bridge commands", { commandName: "browser_execute", recovery: { useTool: "browser_command" } });
				}
				const timeoutMs = commandTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = commandMaxChars(params, "browser_execute");
				const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
				const rawTargetRef = targetTabId(params);
				const tabId = resolveLocalTargetTabId(server, rawTargetRef, browserSessionId);
				const preparedScript = prepareExecuteStdlib(script);
				const { result: jsResult, operation } = await withTrackedOperation(server, {
					commandName: "browser_execute",
					command: "javascript",
					browserSessionId,
					tabId,
					phase: "running",
					progress: 5,
					queueDepth: server.queueDepth(browserSessionId, tabId),
					leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
				}, _onUpdate, async (handle) => {
					await handle.update({ progress: params.monitor === true ? 15 : 35 });
					const result = params.monitor === true
						? await executeJavaScriptWithMonitor(server, preparedScript.script, { browserSessionId, tabId: rawTargetRef, timeoutMs, targetRefs: preparedScript.stdlib?.targetRefs })
						: await (async () => {
							const executed = await withExecutionEffect(server, { browserSessionId, tabId, timeoutMs, targetRefs: preparedScript.stdlib?.targetRefs }, () => server.executeJavaScript(preparedScript.script, { browserSessionId, tabId: rawTargetRef as number | string | undefined, timeoutMs }));
							return { ...executed.result, effect: executed.effect };
						})();
					await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target } });
					return result;
				});
				const jsFeedback = jsResult as ExecuteResultWithFeedback;
				const executeDiagnostics = isRecord(jsFeedback.diagnostics) ? jsFeedback.diagnostics : undefined;
				const execution = buildExecutionJournal({
					operationId: operation.operationId,
					target: jsFeedback.target,
					dispatch: { kind: "javascript", command: "javascript" },
					effect: jsFeedback.effect,
					monitor: jsFeedback.monitor,
					stdlib: preparedScript.stdlib ? { used: true, refsEmbedded: preparedScript.stdlib.refsEmbedded, resolveMisses: preparedScript.stdlib.resolveMisses.length } : undefined,
				});
				const resultValue = { ...jsResult, execution, ...(preparedScript.stdlib ? { browserPilotRuntime: "1" } : {}) };
				if (typeof server.buildTemporalProfileSample === "function" && typeof server.recordTemporalProfileSample === "function") {
					void server.recordTemporalProfileSample(server.buildTemporalProfileSample({
						operationId: operation.operationId,
						tool: "browser_execute",
						command: "javascript",
						target: { browserSessionId, tabId, targetRef: typeof rawTargetRef === "string" ? rawTargetRef : undefined },
						deadlineMs: timeoutMs,
						elapsedMs: Math.max(0, operation.updatedAt - operation.startedAt),
						result: jsResult,
						diagnostics: executeDiagnostics,
					}), { cwd: ctx?.cwd });
				}
				const needsResultArtifact = executeResultNeedsArtifact(resultValue);
				return await jsonCommandResult(resultValue, params, ctx, {
					commandName: "browser_execute",
					command: "javascript",
					defaultDetailLevel: "preview",
					maxChars,
					fallbackName: artifactFallbackName("execute"),
					artifactThreshold: needsResultArtifact ? 1 : undefined,
					details: { mode: "javascript", monitor: params.monitor === true, ...(executeDiagnostics ? { diagnostics: executeDiagnostics } : {}), ...(preparedScript.stdlib ? { browserPilotRuntime: "1" } : {}) },
					operation,
					activeContext: buildActiveContext(server, params),
					diagnostics: executeDiagnostics,
					artifactValue: { ...resultValue, operation },
					distill: (value) => {
						const generic = summarizeGenericValue(value);
						// H1: mark when the script's return value is already fully inline in summary.data so
						// artifactReadActions can suppress the misleading correlation-ID nextActions hints
						// (blind-eval H1, n=2). The generic summarizer inlines small values; large ones
						// collapse to shape placeholders — detect inline by checking data is not a shape.
						const data = generic.data;
						const dataInline = executeSummaryDataInline(data);
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
					},
				});
			});
		},
	});
}
