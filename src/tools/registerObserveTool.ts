import { Type } from "typebox";
import { BrowserBridgeError } from "../driver/errors";
import { runContentObservation, runHtmlObservation, runScanObservation, observeErrorResult, type ObserveMode, type ObserveToolParams } from "./observeRunners";
import { runTool, sharedTabScopedToolParams } from "./toolAdapter";
import { NativeCommandParamsSchema, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

const OBSERVE_MODES = new Set<ObserveMode>(["scan", "content", "html", "text", "tabs"]);

function normalizeObserveMode(value: unknown): ObserveMode {
	const mode = String(value || "scan").trim().toLowerCase();
	if (OBSERVE_MODES.has(mode as ObserveMode)) return mode as ObserveMode;
	throw new BrowserBridgeError("INVALID_RULE", "browser_observe mode must be one of scan, content, html, text, or tabs", {
		mode: value,
		allowedModes: Array.from(OBSERVE_MODES),
	});
}

function rejectModeParam(mode: ObserveMode, param: string, reason: string): never {
	throw new BrowserBridgeError("INVALID_RULE", `browser_observe mode=${mode} does not accept ${param}`, {
		mode,
		param,
		reason,
	});
}

function validateObserveParams(mode: ObserveMode, params: ObserveToolParams): void {
	if ((mode === "scan" || mode === "text" || mode === "tabs") && params.selector !== undefined) rejectModeParam(mode, "selector", "selector is only valid for content/html modes");
	if ((mode === "scan" || mode === "text" || mode === "tabs" || mode === "html") && params.url !== undefined) rejectModeParam(mode, "url", "url navigation is only valid for content mode");
	if ((mode === "scan" || mode === "text" || mode === "tabs" || mode === "html") && params.includeLinks !== undefined) rejectModeParam(mode, "includeLinks", "includeLinks is only valid for content mode");
	if ((mode === "content" || mode === "html") && params.maxNodes !== undefined) rejectModeParam(mode, "maxNodes", "maxNodes is only valid for scan/text modes");
	if ((mode === "content" || mode === "html") && params.includeIframes !== undefined) rejectModeParam(mode, "includeIframes", "includeIframes is only valid for scan/text modes");
	if ((mode === "scan" || mode === "text" || mode === "tabs" || mode === "content") && params.htmlMode !== undefined) rejectModeParam(mode, "htmlMode", "htmlMode is only valid for html mode");
	if ((mode === "scan" || mode === "text" || mode === "tabs" || mode === "content") && params.params !== undefined) rejectModeParam(mode, "params", "params is only valid for html mode");
	if (mode === "tabs" && params.maxNodes !== undefined) rejectModeParam(mode, "maxNodes", "tabs mode only returns tab inventory");
	if (mode === "tabs" && params.includeIframes !== undefined) rejectModeParam(mode, "includeIframes", "tabs mode only returns tab inventory");
}

export function registerObserveTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_observe",
		label: "Browser Observe",
		description: "Observe browser tabs, simplified page structure, readable content, or exact HTML/text through an explicit observation mode.",
		promptSnippet: "Observe browser tabs, page structure, readable content, or exact HTML via an explicit observation mode.",
		promptGuidelines: [
			TAB_SCOPED_TOOL_GUIDELINE,
			"Use browser_observe mode=scan for structure/actionables, mode=content for readable Markdown, mode=html for exact HTML/text snapshots, mode=text for visible text-first observation, and mode=tabs when the target tab is unclear.",
		],
		parameters: Type.Object({
			mode: Type.Optional(Type.String({ description: "scan | content | html | text | tabs. Default scan." })),
			selector: Type.Optional(Type.String({ description: "content/html modes: CSS selector for a target readable root or exact HTML/text slice" })),
			url: Type.Optional(Type.String({ description: "content mode only: optional URL to navigate to before extraction" })),
			includeLinks: Type.Optional(Type.Boolean({ description: "content mode only: include Markdown links; default true" })),
			maxNodes: Type.Optional(Type.Number({ description: "scan/text modes: maximum DOM nodes visited" })),
			includeIframes: Type.Optional(Type.Boolean({ description: "scan/text modes: include same-origin iframe content" })),
			htmlMode: Type.Optional(Type.String({ description: "html mode only: fragment | raw | text | inner | outer" })),
			params: Type.Optional(NativeCommandParamsSchema),
			...sharedTabScopedToolParams(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async (): Promise<import("../utils/toolResult").PiTextToolResult> => {
				const toolCtx = ctx ?? {};
				const server = await ensureStarted();
				const observeParams = params as ObserveToolParams;
				const mode = normalizeObserveMode(observeParams.mode);
				validateObserveParams(mode, observeParams);
				if (mode === "scan" || mode === "text" || mode === "tabs") return await runScanObservation(server, observeParams, toolCtx, mode, _onUpdate);
				if (mode === "content") return await runContentObservation(server, observeParams, toolCtx, _onUpdate);
				return await runHtmlObservation(server, observeParams, toolCtx, _onUpdate);
			}, observeErrorResult);
		},
	});
}
