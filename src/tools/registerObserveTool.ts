import { Type } from "typebox";
import { BrowserBridgeError } from "../driver/errors.js";
import { runContentObservation, runHtmlObservation, runScanObservation, observeErrorResult, type ObserveMode, type ObserveToolParams } from "./observeRunners.js";
import { defineBrowserTool, runTool, sharedTabScopedToolParams } from "./toolAdapter.js";
import { NativeCommandParamsSchema, TAB_SCOPED_TOOL_GUIDELINE, strictToolParameters } from "./toolShared.js";
import type { ToolRegistrarContext } from "./toolShared.js";

const OBSERVE_MODES = new Set<ObserveMode>(["scan", "content", "html", "text", "tabs"]);
const ALL_OBSERVE_MODES: ObserveMode[] = ["scan", "content", "html", "text", "tabs"];

type ModeInference = { mode: ObserveMode; reason: string } | null;
type NormalizedObserveMode = { mode: ObserveMode; inferred: ModeInference };

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

function intersectModes(left: ObserveMode[], right: ObserveMode[]): ObserveMode[] {
	return left.filter((mode) => right.includes(mode));
}

function modeSetKey(modes: ObserveMode[]): string {
	return [...modes].sort().join("|");
}

function impliedModesForParam(param: string, params: ObserveToolParams): ObserveMode[] | undefined {
	switch (param) {
		case "htmlMode":
			return params.htmlMode !== undefined ? ["html"] : undefined;
		case "params":
			return params.params !== undefined ? ["html"] : undefined;
		case "includeLinks":
			return params.includeLinks !== undefined ? ["content"] : undefined;
		case "selector":
			return params.selector !== undefined ? ["content", "html"] : undefined;
		case "maxNodes":
			return params.maxNodes !== undefined ? ["scan", "text"] : undefined;
		case "includeIframes":
			return params.includeIframes !== undefined ? ["scan", "text"] : undefined;
		case "baseline":
			return params.baseline !== undefined ? ["scan"] : undefined;
		case "actionRef":
			return params.actionRef !== undefined ? ["scan"] : undefined;
		case "intent":
			return params.intent !== undefined ? ["scan", "text"] : undefined;
		case "url":
			return params.url !== undefined ? ["scan", "content", "html", "text"] : undefined;
		default:
			return undefined;
	}
}

function inferredModeFromParams(params: ObserveToolParams): ModeInference {
	let candidates = ALL_OBSERVE_MODES;
	const reasons: string[] = [];
	for (const param of ["htmlMode", "params", "includeLinks", "selector", "maxNodes", "includeIframes", "baseline", "actionRef", "intent", "url"]) {
		const implied = impliedModesForParam(param, params);
		if (!implied) continue;
		candidates = intersectModes(candidates, implied);
		reasons.push(param);
	}
	if (candidates.length === 0) {
		throw new BrowserBridgeError("INVALID_RULE", "browser_observe parameters imply incompatible observation modes", {
			params: reasons,
			reason: "cross-mode parameter combination has no valid observe mode",
		});
	}
	if (candidates.length === 1) {
		const mode = candidates[0]!;
		return mode === "scan" ? null : { mode, reason: reasons.join("+") };
	}
	if (modeSetKey(candidates) === "content|html") return { mode: "content", reason: reasons.join("+") };
	return null;
}

export function normalizeObserveMode(value: unknown, params: ObserveToolParams): NormalizedObserveMode {
	const explicit = explicitMode(value);
	if (explicit) return { mode: explicit, inferred: null };
	const inferred = inferredModeFromParams(params);
	return { mode: inferred?.mode ?? "scan", inferred };
}

function rejectModeParam(mode: ObserveMode, param: string, reason: string): never {
	throw new BrowserBridgeError("INVALID_RULE", `browser_observe mode=${mode} does not accept ${param}`, {
		mode,
		param,
		reason,
	});
}

export function validateObserveParams(mode: ObserveMode, params: ObserveToolParams): void {
	if (params.fresh === true && (params.baseline !== undefined || params.baselineSnapshotId !== undefined || params.baselinePath !== undefined)) rejectModeParam(mode, "fresh", "fresh:true cannot be combined with baseline/baselineSnapshotId/baselinePath");
	if (params.fresh === true && mode !== "scan" && mode !== "text") rejectModeParam(mode, "fresh", "fresh:true is only valid for scan/text re-anchor observations");
	if (mode !== "scan" && params.baseline !== undefined) rejectModeParam(mode, "baseline", "baseline diff is only valid for scan mode");
	if (mode !== "scan" && params.actionRef !== undefined) rejectModeParam(mode, "actionRef", "actionRef causal attribution is only valid for scan mode");
	if ((mode === "scan" || mode === "text" || mode === "tabs") && params.selector !== undefined) rejectModeParam(mode, "selector", "selector is only valid for content/html modes");
	if (mode === "tabs" && params.url !== undefined) rejectModeParam(mode, "url", "url navigation is only valid for scan/content/html/text modes");
	if ((mode === "scan" || mode === "text" || mode === "tabs" || mode === "html") && params.includeLinks !== undefined) rejectModeParam(mode, "includeLinks", "includeLinks is only valid for content mode");
	if ((mode === "content" || mode === "html") && params.maxNodes !== undefined) rejectModeParam(mode, "maxNodes", "maxNodes is only valid for scan/text modes");
	if ((mode === "content" || mode === "html") && params.includeIframes !== undefined) rejectModeParam(mode, "includeIframes", "includeIframes is only valid for scan/text modes");
	if ((mode === "scan" || mode === "text" || mode === "tabs" || mode === "content") && params.htmlMode !== undefined) rejectModeParam(mode, "htmlMode", "htmlMode is only valid for html mode");
	if ((mode === "scan" || mode === "text" || mode === "tabs" || mode === "content") && params.params !== undefined) rejectModeParam(mode, "params", "params is only valid for html mode");
	if ((mode === "content" || mode === "html" || mode === "tabs") && params.intent !== undefined) rejectModeParam(mode, "intent", "intent relevance is only valid for scan/text modes");
	if (mode === "tabs" && params.maxNodes !== undefined) rejectModeParam(mode, "maxNodes", "tabs mode only returns tab inventory");
	if (mode === "tabs" && params.includeIframes !== undefined) rejectModeParam(mode, "includeIframes", "tabs mode only returns tab inventory");
}

export function registerObserveTool({ pi, ensureStarted }: ToolRegistrarContext) {
	defineBrowserTool(pi, {
		name: "browser_observe",
		label: "Browser Observe",
		description: "Observe browser tabs, simplified page structure, readable content, or exact HTML/text through an explicit observation mode.",
		promptSnippet: "Observe browser tabs, page structure, readable content, or exact HTML via an explicit observation mode.",
		promptGuidelines: [
			TAB_SCOPED_TOOL_GUIDELINE,
			"Use browser_observe mode=scan for structure/actionables, mode=content for readable Markdown, mode=html for exact HTML/text snapshots, mode=text for visible text-first observation, and mode=tabs when the target tab is unclear. If mode is omitted, selector/includeLinks/htmlMode/params imply the narrowest compatible mode.",
		],
		parameters: strictToolParameters({
			mode: Type.Optional(Type.Union([Type.Literal("scan"), Type.Literal("content"), Type.Literal("html"), Type.Literal("text"), Type.Literal("tabs")], { description: "scan | content | html | text | tabs. Default scan." })),
			selector: Type.Optional(Type.String({ description: "content/html modes: CSS selector for a target readable root or exact HTML/text slice" })),
			url: Type.Optional(Type.String({ description: "scan/content/html/text modes: optional URL to navigate to before observation" })),
			includeLinks: Type.Optional(Type.Boolean({ description: "content mode only: include Markdown links; default true" })),
			maxNodes: Type.Optional(Type.Number({ description: "scan/text modes: maximum DOM nodes visited" })),
			includeIframes: Type.Optional(Type.Boolean({ description: "scan/text modes: include same-origin iframe content" })),
			baseline: Type.Optional(Type.Union([Type.Array(Type.Object({}, { additionalProperties: true })), Type.Object({}, { additionalProperties: true })], { description: "scan mode only: prior ABML entity list or prior scan summary/envelope used to compute envelope.diff. CLI-friendlier: use --baseline-snapshot-id or --baseline-path instead of inlining a large prior envelope." })),
			baselineSnapshotId: Type.Optional(Type.String({ description: "scan mode only: snapshotId from a prior browser_observe scan; the daemon resolves it to that scan's saved entities as the baseline. CLI-friendly by-reference alternative to passing the full prior envelope inline as `baseline`." })),
			baselinePath: Type.Optional(Type.String({ description: "scan mode only: filesystem path to a prior scan's saved artifact; used as the baseline. No-state by-reference alternative to inlining `baseline`." })),
			actionRef: Type.Optional(Type.String({ description: "scan mode only (R3.x P1): pi-ref:// of the control you just activated; attributes the baseline network-delta to it as `triggered` relations. Falls back to the focused control when omitted." })),
			htmlMode: Type.Optional(Type.Union([Type.Literal("fragment"), Type.Literal("raw"), Type.Literal("text"), Type.Literal("inner"), Type.Literal("outer")], { description: "html mode only: fragment | raw | text | inner | outer" })),
			params: Type.Optional(NativeCommandParamsSchema),
			intent: Type.Optional(Type.String({ description: "scan/text modes only: explicit task intent used as a relevance signal for ranking observation results" })),
			fresh: Type.Optional(Type.Boolean({ description: "scan/text modes only: force a fresh full-frame observation for this call; ignores the session-delta baseline and render cache without disabling relevance or memory" })),
			...sharedTabScopedToolParams(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async (): Promise<import("../utils/toolResult.js").PiTextToolResult> => {
				const toolCtx = ctx ?? {};
				const server = await ensureStarted();
				const observeParams = params as ObserveToolParams;
				// M1: CLI-friendly by-reference baseline — map the scalar --baseline-snapshot-id / --baseline-path
				// flags onto the existing baseline resolution (daemon resolves snapshotId from its observation
				// store; path is read as a saved artifact). Avoids inlining a multi-hundred-KB prior envelope on
				// the CLI (hit the OS argv limit — blind-eval M1). Explicit `baseline` still wins if provided.
				if (observeParams.baseline === undefined) {
					const raw = params as Record<string, unknown>;
					const baselinePath = typeof raw.baselinePath === "string" ? raw.baselinePath.trim() : "";
					const baselineSnapshotId = typeof raw.baselineSnapshotId === "string" ? raw.baselineSnapshotId.trim() : "";
					if (baselinePath) observeParams.baseline = { saved: { path: baselinePath } };
					else if (baselineSnapshotId) observeParams.baseline = { snapshotId: baselineSnapshotId };
				}
				const normalized = normalizeObserveMode(observeParams.mode, observeParams);
				const mode = normalized.mode;
				observeParams.mode = mode;
				observeParams.modeInferred = normalized.inferred;
				validateObserveParams(mode, observeParams);
				if (mode === "scan" || mode === "text" || mode === "tabs") return await runScanObservation(server, observeParams, toolCtx, mode, _onUpdate);
				if (mode === "content") return await runContentObservation(server, observeParams, toolCtx, _onUpdate);
				return await runHtmlObservation(server, observeParams, toolCtx, _onUpdate);
			}, observeErrorResult);
		},
	});
}
