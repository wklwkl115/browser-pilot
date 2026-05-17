import { Type } from "typebox";
import { buildPickScript } from "../pick/buildPickScript";
import { errorResult } from "../utils/toolResult";
import { defaultResultBudget } from "./budgets";
import { distilledJsonResult } from "./resultMiddleware";
import { summarizePickData } from "./summaries/index";
import { asPositiveInt, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function unwrapRuntimeEvaluateValue(result: unknown): unknown {
	if (!isRecord(result)) return result;
	const data = isRecord(result.data) ? result.data : result;
	if (data.exceptionDetails) throw new Error(`browser_pick Runtime.evaluate failed: ${JSON.stringify(data.exceptionDetails)}`);
	const remote = isRecord(data.result) ? data.result : data;
	if (remote.value !== undefined) return remote.value;
	if (remote.unserializableValue !== undefined) return remote.unserializableValue;
	if (remote.description !== undefined) return remote.description;
	return data;
}

export function registerPickTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_pick",
		label: "Browser Pick",
		description: "Interactively pick DOM elements in the real browser and return stable CSS selectors plus element summaries.",
		promptSnippet: "Ask the user to click elements in the browser; returns CSS selectors for selected elements.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_pick when the user needs to identify a specific visible element; it blocks until click/Enter/Escape/timeout."],
		parameters: Type.Object({
			message: Type.String({ description: "Instruction shown to the user in the page picker overlay" }),
			tabId: optionalTargetTabId(),
			multiple: Type.Optional(Type.Boolean({ description: "Allow Cmd/Ctrl+click multi-select; default true" })),
			focus: Type.Optional(Type.Boolean({ description: "Focus/switch to tabId before picking; default true when tabId is provided" })),
			detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
			outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
			timeoutMs: Type.Optional(Type.Number({ description: "Interactive picker timeout in milliseconds" })),
			maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const message = String(params.message || "").trim();
				if (!message) throw new Error("browser_pick requires message");
				const server = await ensureStarted();
				const timeoutMs = asPositiveInt(params.timeoutMs, 120_000);
				const maxChars = asPositiveInt(params.maxChars, defaultResultBudget("browser_pick"));
				if (params.tabId !== undefined && params.focus !== false) await server.switchTab(params.tabId, 5_000);
				const script = buildPickScript({ message, multiple: params.multiple, timeoutMs });
				const raw = await server.sendCommand({
					cmd: "cdp",
					method: "Runtime.evaluate",
					params: { expression: script, awaitPromise: true, returnByValue: true, userGesture: true },
					timeoutMs,
				}, { tabId: params.tabId, timeoutMs: timeoutMs + 1_000 });
				const value = unwrapRuntimeEvaluateValue(raw);
				return await distilledJsonResult(value, {
					toolName: "browser_pick",
					command: "pick",
					detailLevel: params.detailLevel,
					maxChars,
					ctx,
					outputPath: params.outputPath,
					fallbackName: `pick-${Date.now()}.json`,
					details: { command: "Runtime.evaluate", message },
					distill: summarizePickData,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}
