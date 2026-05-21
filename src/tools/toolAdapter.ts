import { Type } from "typebox";
import { BrowserBridgeError } from "../driver/errors";
import type { DetailLevel } from "../utils/params";
import { errorResult, jsonResult, type PiTextToolResult } from "../utils/toolResult";
import { defaultResultBudget, type ToolResultBudgetName } from "./budgets";
import { distilledJsonResult, distilledTextResult } from "./resultMiddleware";
import { asPositiveInt, BrowserToolTargetRefSchema, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION, TARGET_DESCRIPTION } from "./toolShared";

export type ToolResultContext = { cwd?: string } | undefined;

export type StandardToolParams = {
	tabId?: number | string;
	target?: unknown;
	detailLevel?: string;
	outputPath?: string;
	timeoutMs?: number;
	maxChars?: number;
};

type SharedToolParamOptions = {
	tabIdDescription?: string;
	timeoutDescription?: string;
	outputPathDescription?: string;
	maxCharsDescription?: string;
	includeTabId?: boolean;
	includeTarget?: boolean;
	includeDetailLevel?: boolean;
	includeOutputPath?: boolean;
	includeTimeout?: boolean;
	includeMaxChars?: boolean;
};

type DistillFn = (value: unknown) => Record<string, unknown>;
type TextDistillFn = (text: string) => Record<string, unknown>;

type JsonToolResultOptions = {
	toolName: ToolResultBudgetName | string;
	budgetName?: ToolResultBudgetName;
	command?: string;
	defaultDetailLevel?: DetailLevel;
	fallbackName: string;
	details?: Record<string, unknown>;
	artifactValue?: unknown;
	distill?: DistillFn;
	artifactThreshold?: number;
	maxChars?: number;
};

type TextToolResultOptions = {
	toolName: ToolResultBudgetName | string;
	budgetName?: ToolResultBudgetName;
	command?: string;
	defaultDetailLevel?: DetailLevel;
	fallbackName: string;
	details?: Record<string, unknown>;
	artifactValue?: unknown;
	summary?: Record<string, unknown>;
	distill?: TextDistillFn;
	artifactThreshold?: number;
	maxChars?: number;
};


export function maxCharsParam(description = MAX_CHARS_DESCRIPTION) {
	return Type.Optional(Type.Number({ description }));
}

export function sharedTabScopedToolParams(options: SharedToolParamOptions = {}) {
	const params: Record<string, unknown> = {};
	if (options.includeTabId !== false) params.tabId = optionalTargetTabId(options.tabIdDescription);
	if (options.includeTarget !== false && options.includeTabId !== false) params.target = Type.Optional(BrowserToolTargetRefSchema, { description: TARGET_DESCRIPTION });
	if (options.includeDetailLevel !== false) params.detailLevel = Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION }));
	if (options.includeOutputPath !== false) params.outputPath = Type.Optional(Type.String({ description: options.outputPathDescription ?? OUTPUT_PATH_DESCRIPTION }));
	if (options.includeTimeout !== false) params.timeoutMs = Type.Optional(Type.Number({ description: options.timeoutDescription ?? "Bridge timeout in milliseconds" }));
	if (options.includeMaxChars !== false) params.maxChars = Type.Optional(Type.Number({ description: options.maxCharsDescription ?? MAX_CHARS_DESCRIPTION }));
	return params;
}

export function toolMaxChars(params: Pick<StandardToolParams, "maxChars">, budgetName: ToolResultBudgetName): number {
	return asPositiveInt(params.maxChars, defaultResultBudget(budgetName));
}

export function toolPositiveInt(value: unknown, fallback: number): number {
	return asPositiveInt(value, fallback);
}

export function toolTimeoutMs(value: unknown, fallback: number, options: { allowZero?: boolean } = {}): number {
	const n = Number(value);
	if (options.allowZero && Number.isFinite(n) && n === 0) return 0;
	return asPositiveInt(value, fallback);
}

export function artifactFallbackName(prefix: string, extension = "json"): string {
	return `${prefix}-${Date.now()}.${extension}`;
}

export function applyDefaultTimeout(body: Record<string, unknown>, timeoutMs: number): void {
	if (body.timeoutMs === undefined && body.timeout_ms === undefined) body.timeoutMs = timeoutMs;
}

export function targetTabId(params: Pick<StandardToolParams, "tabId">, body?: Record<string, unknown>): unknown {
	return params.tabId ?? body?.tabId;
}

export function targetRef(params: Pick<StandardToolParams, "target">): unknown {
	return params.target;
}

export async function runTool(handler: () => Promise<PiTextToolResult>, onError: (error: unknown) => PiTextToolResult = errorResult): Promise<PiTextToolResult> {
	try {
		return await handler();
	} catch (error) {
		return onError(error);
	}
}

export function bridgeNestedErrorResult(error: unknown, options: { command?: string; defaultMessage: string; includeCommandInDetails?: boolean }): PiTextToolResult {
	const details = error && typeof error === "object" && "details" in error ? (error as { details?: unknown }).details : undefined;
	const result = details && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>).result : undefined;
	if (result && typeof result === "object" && !Array.isArray(result)) {
		const record = result as Record<string, unknown>;
		if (typeof record.error_code === "string" && record.error_code) {
			const resultDetails = record.details && typeof record.details === "object" && !Array.isArray(record.details) ? record.details as Record<string, unknown> : {};
			return errorResult(new BrowserBridgeError(record.error_code, typeof record.error === "string" ? record.error : options.defaultMessage, {
				...(options.includeCommandInDetails && options.command ? { command: options.command } : {}),
				...resultDetails,
			}));
		}
	}
	return errorResult(error);
}

export function inlineJsonToolResult(value: unknown, details: Record<string, unknown>, params: Pick<StandardToolParams, "maxChars">, budgetName: ToolResultBudgetName): PiTextToolResult {
	return jsonResult(value, details, toolMaxChars(params, budgetName));
}

export async function jsonToolResult(value: unknown, params: Pick<StandardToolParams, "detailLevel" | "outputPath" | "maxChars">, ctx: ToolResultContext, options: JsonToolResultOptions): Promise<PiTextToolResult> {
	const budgetName = options.budgetName ?? (options.toolName as ToolResultBudgetName);
	return await distilledJsonResult(value, {
		toolName: String(options.toolName),
		command: options.command,
		detailLevel: params.detailLevel ?? options.defaultDetailLevel,
		maxChars: options.maxChars ?? toolMaxChars(params, budgetName),
		ctx,
		outputPath: params.outputPath,
		fallbackName: options.fallbackName,
		details: options.details,
		artifactValue: options.artifactValue,
		distill: options.distill,
		artifactThreshold: options.artifactThreshold,
	});
}

export async function textToolResult(text: string, params: Pick<StandardToolParams, "detailLevel" | "outputPath" | "maxChars">, ctx: ToolResultContext, options: TextToolResultOptions): Promise<PiTextToolResult> {
	const budgetName = options.budgetName ?? (options.toolName as ToolResultBudgetName);
	return await distilledTextResult(text, {
		toolName: String(options.toolName),
		command: options.command,
		detailLevel: params.detailLevel ?? options.defaultDetailLevel,
		maxChars: options.maxChars ?? toolMaxChars(params, budgetName),
		ctx,
		outputPath: params.outputPath,
		fallbackName: options.fallbackName,
		details: options.details,
		artifactValue: options.artifactValue,
		summary: options.summary,
		distill: options.distill,
		artifactThreshold: options.artifactThreshold,
	});
}
