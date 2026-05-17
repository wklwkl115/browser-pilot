import { Type } from "typebox";
import { buildElementActionScript, type ElementActionOptions } from "../actions/buildElementActionScript";
import { errorResult } from "../utils/toolResult";
import { defaultResultBudget, type ToolResultBudgetName } from "./budgets";
import { distilledJsonResult } from "./resultMiddleware";
import { summarizeElementActionData } from "./summaries/index";
import { asPositiveInt, DEFAULT_TOOL_TIMEOUT_MS, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeElementActionError(error: unknown): unknown {
	if (!(error instanceof Error)) return error;
	const extra = error as Error & { code?: unknown; details?: unknown };
	const details = isRecord(extra.details) ? extra.details : {};
	const nested = isRecord(details.error) ? details.error : undefined;
	if (!nested || typeof nested.code !== "string") return error;
	const mapped = new Error(typeof nested.message === "string" ? nested.message : error.message) as Error & { code?: string; details?: Record<string, unknown> };
	mapped.name = "ElementActionError";
	mapped.code = nested.code;
	mapped.details = { ...(isRecord(nested.details) ? nested.details : {}), bridgeCode: extra.code, browserError: nested };
	return mapped;
}

type ElementToolConfig = {
	name: "browser_query" | "browser_click" | "browser_type";
	label: string;
	description: string;
	promptSnippet: string;
	promptGuideline: string;
	budgetName: ToolResultBudgetName;
	buildOptions: (params: Record<string, unknown>) => ElementActionOptions;
	parameters: Record<string, unknown>;
};

function selectorParam() {
	return Type.String({ description: "CSS selector for the target element(s), e.g. button.primary or input[name=email]" });
}

function sharedParams() {
	return {
		selector: selectorParam(),
		tabId: optionalTargetTabId(),
		detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
		outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
		timeoutMs: Type.Optional(Type.Number({ description: "Bridge timeout in milliseconds" })),
		maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
	};
}

function registerElementActionTool({ pi, ensureStarted }: ToolRegistrarContext, config: ElementToolConfig) {
	pi.registerTool({
		name: config.name,
		label: config.label,
		description: config.description,
		promptSnippet: config.promptSnippet,
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, config.promptGuideline],
		parameters: Type.Object(config.parameters),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const selector = String(params.selector || "").trim();
				if (!selector) throw new Error(`${config.name} requires selector`);
				const server = await ensureStarted();
				const timeoutMs = asPositiveInt(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = asPositiveInt(params.maxChars, defaultResultBudget(config.budgetName));
				const options = config.buildOptions({ ...params, selector });
				const result = await server.executeJavaScript(buildElementActionScript(options), { tabId: params.tabId, timeoutMs });
				const data = result.data;
				return await distilledJsonResult(data, {
					toolName: config.name,
					command: options.action,
					detailLevel: params.detailLevel,
					maxChars,
					ctx,
					outputPath: params.outputPath,
					fallbackName: `${options.action}-${Date.now()}.json`,
					details: { action: options.action, selector },
					distill: summarizeElementActionData,
				});
			} catch (error) {
				return errorResult(normalizeElementActionError(error));
			}
		},
	});
}

export function registerQueryTool(context: ToolRegistrarContext) {
	registerElementActionTool(context, {
		name: "browser_query",
		label: "Browser Query",
		description: "Find elements on the target page by CSS selector and return compact element summaries.",
		promptSnippet: "Query DOM elements by CSS selector before clicking or typing.",
		promptGuideline: "Use browser_query before browser_click/browser_type when selector correctness is uncertain.",
		budgetName: "browser_query",
		parameters: {
			...sharedParams(),
			all: Type.Optional(Type.Boolean({ description: "Return multiple matches; default true. false returns the first match only." })),
			limit: Type.Optional(Type.Number({ description: "Maximum matches returned when all=true; default 10, max 100." })),
			visibleOnly: Type.Optional(Type.Boolean({ description: "Only return visible matches; default false." })),
		},
		buildOptions: (params) => ({ action: "query", selector: String(params.selector), all: params.all as boolean | undefined, limit: params.limit as number | undefined, visibleOnly: params.visibleOnly as boolean | undefined }),
	});
}

export function registerClickTool(context: ToolRegistrarContext) {
	registerElementActionTool(context, {
		name: "browser_click",
		label: "Browser Click",
		description: "Click an element matching a CSS selector in the target page, after scrolling it into view.",
		promptSnippet: "Click a DOM element by CSS selector and optional match index.",
		promptGuideline: "Use browser_wait after browser_click when the click is expected to navigate or update asynchronously.",
		budgetName: "browser_click",
		parameters: {
			...sharedParams(),
			index: Type.Optional(Type.Number({ description: "Zero-based match index when multiple elements match; default 0." })),
		},
		buildOptions: (params) => ({ action: "click", selector: String(params.selector), index: params.index as number | undefined }),
	});
}

export function registerTypeTool(context: ToolRegistrarContext) {
	registerElementActionTool(context, {
		name: "browser_type",
		label: "Browser Type",
		description: "Type text into an input, textarea, or contenteditable element matching a CSS selector.",
		promptSnippet: "Type into a DOM input/textarea/contenteditable by selector; optionally clear or submit.",
		promptGuideline: "Use browser_type for form fields; do not submit forms unless the user explicitly requests it.",
		budgetName: "browser_type",
		parameters: {
			...sharedParams(),
			text: Type.String({ description: "Text to enter into the target element." }),
			index: Type.Optional(Type.Number({ description: "Zero-based match index when multiple elements match; default 0." })),
			clear: Type.Optional(Type.Boolean({ description: "Clear existing value before typing; default true." })),
			submit: Type.Optional(Type.Boolean({ description: "Submit the form or send Enter after typing; default false." })),
		},
		buildOptions: (params) => ({ action: "type", selector: String(params.selector), index: params.index as number | undefined, text: String(params.text ?? ""), clear: params.clear as boolean | undefined, submit: params.submit as boolean | undefined }),
	});
}
