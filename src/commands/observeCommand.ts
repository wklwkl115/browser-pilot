import { Type } from "typebox";
import { BrowserBridgeError } from "../utils/errors.js";
import { runContentObservation } from "./observe/contentRunner.js";
import { runHtmlObservation } from "./observe/htmlRunner.js";
import { observeErrorResult, runScanObservation } from "./observe/scanRunner.js";
import type { ObserveMode, ObserveToolParams } from "./observe/common.js";
import { defineBrowserCommand, resolveLocalTargetTabId, runCommandHandler, sharedTabScopedToolParams, targetTabId } from "./commandRuntime.js";
import { NativeCommandParamsSchema, TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";

const OBSERVE_MODES = new Set<ObserveMode>(["scan", "content", "html", "text", "tabs"]);

type ModeInference = { mode: ObserveMode; reason: string } | null;
type NormalizedObserveMode = { mode: ObserveMode; inferred: ModeInference; explicit: boolean };

function explicitMode(value: unknown): ObserveMode | undefined {
	if (value === undefined || value === null) return undefined;
	const raw = String(value).trim();
	if (!raw) return undefined;
	const mode = raw.toLowerCase();
	if (OBSERVE_MODES.has(mode as ObserveMode)) return mode as ObserveMode;
	throw new BrowserBridgeError("INVALID_RULE", "browser_observe mode must be one of scan, content, html, text, or tabs", {
		mode: value,
		allowedModes: Array.from(OBSERVE_MODES),
	});
}

export function normalizeObserveMode(value: unknown, _params: ObserveToolParams): NormalizedObserveMode {
	const explicit = explicitMode(value);
	if (explicit) return { mode: explicit, inferred: null, explicit: true };
	return { mode: "scan", inferred: null, explicit: false };
}

function rejectModeParam(mode: ObserveMode, param: string, reason: string): never {
	throw new BrowserBridgeError("INVALID_RULE", `browser_observe mode=${mode} does not accept ${param}`, {
		mode,
		param,
		reason,
	});
}

export function validateObserveParams(mode: ObserveMode, params: ObserveToolParams): void {
	const explicitModeSelected = params.modeExplicit === true;
	if (params.fresh === true && (params.baseline !== undefined || params.baselineSnapshotId !== undefined || params.baselinePath !== undefined)) rejectModeParam(mode, "fresh", "fresh:true cannot be combined with baseline/baselineSnapshotId/baselinePath");
	if (params.fresh === true && mode !== "scan" && mode !== "text") rejectModeParam(mode, "fresh", "fresh:true is only valid for scan/text re-anchor observations");
	if ((mode !== "scan" || explicitModeSelected) && params.diff === true) rejectModeParam(mode, "diff", "diff auto-baseline is only valid for the canonical no-mode observation path");
	if (params.fresh === true && params.diff === true) rejectModeParam(mode, "fresh", "fresh:true cannot be combined with diff:true");
	if ((mode !== "scan" || explicitModeSelected) && params.baseline !== undefined) rejectModeParam(mode, "baseline", "baseline diff is only valid for the canonical no-mode observation path");
	if ((mode !== "scan" || explicitModeSelected) && params.baselineSnapshotId !== undefined) rejectModeParam(mode, "baselineSnapshotId", "baselineSnapshotId diff is only valid for the canonical no-mode observation path");
	if ((mode !== "scan" || explicitModeSelected) && params.baselinePath !== undefined) rejectModeParam(mode, "baselinePath", "baselinePath diff is only valid for the canonical no-mode observation path");
	if ((mode !== "scan" || explicitModeSelected) && params.actionRef !== undefined) rejectModeParam(mode, "actionRef", "actionRef causal attribution is only valid for the canonical no-mode observation path");
	if ((mode === "scan" || mode === "text" || mode === "tabs") && params.selector !== undefined) rejectModeParam(mode, "selector", "selector is only valid for explicit legacy content/html projection modes");
	if (mode === "tabs" && params.url !== undefined) rejectModeParam(mode, "url", "url navigation is only valid for canonical scan or explicit legacy content/html/text projection modes");
	if ((mode === "scan" || mode === "text" || mode === "tabs" || mode === "html") && params.includeLinks !== undefined) rejectModeParam(mode, "includeLinks", "includeLinks is only valid for explicit legacy content projection mode");
	if ((mode === "content" || mode === "html") && params.maxNodes !== undefined) rejectModeParam(mode, "maxNodes", "maxNodes is only valid for canonical scan/text observations");
	if ((mode === "content" || mode === "html") && params.includeIframes !== undefined) rejectModeParam(mode, "includeIframes", "includeIframes is only valid for canonical scan/text observations");
	if ((mode === "scan" || mode === "text" || mode === "tabs" || mode === "content") && params.htmlMode !== undefined) rejectModeParam(mode, "htmlMode", "htmlMode is only valid for explicit legacy html projection mode");
	const paramsAllowed = mode === "html" || (mode === "scan" && !explicitModeSelected);
	if (!paramsAllowed && params.params !== undefined) rejectModeParam(mode, "params", "params is only valid for canonical no-mode observation add-ons or explicit legacy html projection mode");
	if ((mode !== "scan" || explicitModeSelected) && (params.content !== undefined || params.readability !== undefined)) rejectModeParam(mode, "readability", "Readability content provider is only valid for the canonical no-mode observation path");
	if ((mode === "content" || mode === "html" || mode === "tabs") && params.intent !== undefined) rejectModeParam(mode, "intent", "intent relevance is only valid for canonical scan/text observations");
	if ((mode !== "scan" || explicitModeSelected) && (params.diagnostics !== undefined || params.debug !== undefined || params.axe !== undefined || params.axeDiagnostics !== undefined)) rejectModeParam(mode, "diagnostics", "axe/accessibility diagnostics are only valid for the canonical no-mode observation path");
	if (mode === "tabs" && params.maxNodes !== undefined) rejectModeParam(mode, "maxNodes", "tabs mode only returns tab inventory");
	if (mode === "tabs" && params.includeIframes !== undefined) rejectModeParam(mode, "includeIframes", "tabs mode only returns tab inventory");
}

export function selectDiffBaselineSnapshot(server: BrowserCommandRuntimePort, params: ObserveToolParams): string | undefined {
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const effectiveTabId = resolveLocalTargetTabId(server, targetTabId(params), params.browserSessionId) ?? bridge.defaultTabId;
	const browserSessionId = bridge.browserSessionId;
	return server.listObservationSnapshots()
		.filter((snap) => snap.browserSessionId === browserSessionId && snap.tabId === effectiveTabId && snap.sourceMode === "scan" && !snap.expired && Boolean(snap.saved?.path))
		.reduce((latest, snap) => latest === undefined || snap.capturedAt > latest.capturedAt ? snap : latest, undefined as ReturnType<BrowserCommandRuntimePort["listObservationSnapshots"]>[number] | undefined)
		?.snapshotId;
}

export function defineObserveCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_observe",
		label: "Browser Observe",
		description: "Return the canonical ABML page observation model for the current browser state. Any explicit mode value is a legacy/debug/projection override, including explicit mode=scan.",
		promptSnippet: "Observe the current page as the canonical ABML page model with structure, actionables, refs, context, evidence, deltas, and diagnostics.",
		promptGuidelines: [
			TAB_SCOPED_TOOL_GUIDELINE,
			"Call browser_observe without choosing a mode for normal page understanding. Use canonical-only target/time/budget/delta boundaries such as tabId, targetRef, url, fresh, diff, baseline, baselineSnapshotId, baselinePath, actionRef, timeoutMs, maxChars, detailLevel, outputPath, or explicit optional add-ons such as readability:true/content=readability only on the omitted-mode path. Any explicit mode value, including mode=scan, is marked legacy/debug/projection and rejects canonical-only diff/baseline/actionRef parameters; explicit content/html/text/tabs remain only for compatibility projections.",
		],
		parameters: strictCommandParameters({
			mode: Type.Optional(Type.Union([Type.Literal("scan"), Type.Literal("content"), Type.Literal("html"), Type.Literal("text"), Type.Literal("tabs")], { description: "Legacy/debug/projection override. Omit for the canonical ABML PageObservation; any explicit mode value, including scan, is marked as non-canonical compatibility/debug semantics and cannot use canonical-only diff/baseline/actionRef parameters." })),
			selector: Type.Optional(Type.String({ description: "Legacy content/html projection only: CSS selector for a target readable root or exact HTML/text slice; not accepted on the canonical no-mode path" })),
			content: Type.Optional(Type.Literal("readability", { description: "Canonical no-mode content-plane add-on: run bounded Mozilla Readability and attach provider diagnostics/artifact without changing the structural model." })),
			readability: Type.Optional(Type.Boolean({ description: "Canonical no-mode content-plane add-on: true runs bounded Mozilla Readability and attaches provider diagnostics/artifact without changing actionables, refs, entities, relations, or collections." })),
			url: Type.Optional(Type.String({ description: "Optional URL to navigate to before returning the canonical no-mode ABML page model" })),
			includeLinks: Type.Optional(Type.Boolean({ description: "Legacy content projection only: include Markdown links; default true" })),
			maxNodes: Type.Optional(Type.Number({ description: "Canonical scan/text budget: maximum DOM nodes visited" })),
			includeIframes: Type.Optional(Type.Boolean({ description: "Canonical scan/text boundary: include same-origin iframe content" })),
			baseline: Type.Optional(Type.Union([Type.Array(Type.Object({}, { additionalProperties: true })), Type.Object({}, { additionalProperties: true })], { description: "Canonical no-mode ABML diff baseline: prior ABML entity list or prior scan summary/envelope used to compute envelope.diff. CLI-friendlier: use --baseline-snapshot-id or --baseline-path instead of inlining a large prior envelope. Rejected when any mode is explicit, including mode=scan." })),
			baselineSnapshotId: Type.Optional(Type.String({ description: "Canonical no-mode ABML diff baseline: snapshotId from a prior browser_observe scan; the daemon resolves it to that scan's saved entities. CLI-friendly by-reference alternative to passing the full prior envelope inline as `baseline`. Rejected when any mode is explicit, including mode=scan." })),
			baselinePath: Type.Optional(Type.String({ description: "Canonical no-mode ABML diff baseline: filesystem path to a prior scan's saved artifact. No-state by-reference alternative to inlining `baseline`. Rejected when any mode is explicit, including mode=scan." })),
			actionRef: Type.Optional(Type.String({ description: "Canonical no-mode ABML causal attribution: bp-ref:// of the control you just activated; attributes the baseline network-delta to it as `triggered` relations. Falls back to the focused control when omitted. Rejected when any mode is explicit, including mode=scan." })),
			htmlMode: Type.Optional(Type.Union([Type.Literal("fragment"), Type.Literal("raw"), Type.Literal("text"), Type.Literal("inner"), Type.Literal("outer")], { description: "Legacy html projection only: fragment | raw | text | inner | outer; not accepted on the canonical no-mode path" })),
			params: Type.Optional(NativeCommandParamsSchema),
			intent: Type.Optional(Type.String({ description: "Legacy/debug relevance signal for scan/text ranking; not a required strategy selector for canonical observation" })),
			fresh: Type.Optional(Type.Boolean({ description: "Canonical no-mode ABML observation, or explicit text re-anchor: force a fresh full-frame observation for this call; ignores the session-delta baseline and render cache without disabling relevance or memory" })),
			diff: Type.Optional(Type.Boolean({ description: "Canonical no-mode ABML observation only: compute envelope.diff/treeDiff against the most recent prior scan snapshot for this tab as the baseline (auto-resolved; no snapshotId to thread). Explicit baseline/baselineSnapshotId/baselinePath override it; not combinable with fresh:true; rejected when any mode is explicit, including mode=scan." })),
			diagnostics: Type.Optional(Type.Union([Type.Literal("axe"), Type.Literal("accessibility")], { description: "Canonical no-mode diagnostics-only add-on. Use axe/accessibility to run bounded axe-core diagnostics; results are provider diagnostics/artifact only and never alter actionables, refs, entities, relations, or collections." })),
			debug: Type.Optional(Type.Union([Type.Literal("axe"), Type.Literal("accessibility")], { description: "Debug alias for diagnostics=axe/accessibility on the canonical no-mode observation path." })),
			axe: Type.Optional(Type.Boolean({ description: "Canonical no-mode diagnostics-only add-on: true runs bounded axe-core accessibility diagnostics without changing the canonical structural model." })),
			axeDiagnostics: Type.Optional(Type.Boolean({ description: "Canonical no-mode diagnostics-only add-on: true runs bounded axe-core accessibility diagnostics without changing the canonical structural model." })),
			...sharedTabScopedToolParams(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runCommandHandler(async (): Promise<import("../utils/toolResult.js").BrowserTextCommandResult> => {
				const toolCtx = ctx ?? {};
				const server = await ensureStarted();
				const observeParams = params as ObserveToolParams;
				const normalized = normalizeObserveMode(observeParams.mode, observeParams);
				const mode = normalized.mode;
				observeParams.mode = mode;
				observeParams.modeExplicit = normalized.explicit;
				observeParams.modeInferred = normalized.inferred;
				if (observeParams.baseline === undefined && !normalized.explicit) {
					const raw = params as Record<string, unknown>;
					const baselinePath = typeof raw.baselinePath === "string" ? raw.baselinePath.trim() : "";
					const baselineSnapshotId = typeof raw.baselineSnapshotId === "string" ? raw.baselineSnapshotId.trim() : "";
					if (baselinePath) observeParams.baseline = { saved: { path: baselinePath } };
					else if (baselineSnapshotId) observeParams.baseline = { snapshotId: baselineSnapshotId };
				}
				validateObserveParams(mode, observeParams);
				// --diff: keep the choice (do I want a diff?) with the agent but resolve the bookkeeping
				// (which snapshotId) here — pick the most recent prior scan snapshot for this tab. Explicit
				// baseline still wins; if no prior scan exists, leave baseline unset (full scan, no error).
				if (mode === "scan" && observeParams.baseline === undefined && observeParams.diff === true) {
					const latestSnapshotId = selectDiffBaselineSnapshot(server, observeParams);
					if (latestSnapshotId) observeParams.baseline = { snapshotId: latestSnapshotId };
				}
				if (mode === "scan" || mode === "text" || mode === "tabs") return await runScanObservation(server, observeParams, toolCtx, mode, _onUpdate);
				if (mode === "content") return await runContentObservation(server, observeParams, toolCtx, _onUpdate);
				return await runHtmlObservation(server, observeParams, toolCtx, _onUpdate);
			}, observeErrorResult);
		},
	});
}
