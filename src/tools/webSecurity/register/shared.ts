import { Type } from "typebox";
import { errorResult } from "../../../utils/toolResult";
import { defaultResultBudget, type ToolResultBudgetName } from "../../budgets";
import { distilledJsonResult } from "../../resultMiddleware";
import { asPositiveInt, DEFAULT_TOOL_TIMEOUT_MS, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION, TAB_SCOPED_TOOL_GUIDELINE } from "../../toolShared";
import type { EnsureStarted } from "../../toolShared";
import { browserCookiesToHeader } from "../../webSecurityCore";
import type { CookieProvider, RawCallbackOastOptions, RawCookieAnalyzeOptions, RawCrawlOptions, RawFuzzParamsOptions, RawFuzzPathsOptions, RawFuzzVhostsOptions, RawNucleiBridgeOptions, RawProbeOptions, RawReplayOptions, RawSqliProbeOptions, RawSqlmapBridgeOptions, RawTemplateCheckOptions } from "../shared/types";

export { DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION, TAB_SCOPED_TOOL_GUIDELINE };

export function sharedWebSecurityParams() {
	return {
		tabId: optionalTargetTabId("Target tab id used when bindBrowserSession needs browser cookies; otherwise omitted is allowed."),
		detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
		outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
		timeoutMs: Type.Optional(Type.Number({ description: "Per-request timeout in milliseconds" })),
		maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
		maxBodyBytes: Type.Optional(Type.Number({ description: "Maximum response body bytes stored per request before truncation; default 256000." })),
	};
}

export type WebSecuritySharedToolParams = {
	tabId?: number | string;
	detailLevel?: string;
	outputPath?: string;
	timeoutMs?: number;
	maxChars?: number;
	maxBodyBytes?: number;
};

export type ReconProbeToolParams = WebSecuritySharedToolParams & RawProbeOptions;
export type CrawlToolParams = WebSecuritySharedToolParams & RawCrawlOptions;
export type FuzzPathsToolParams = WebSecuritySharedToolParams & RawFuzzPathsOptions;
export type FuzzVhostsToolParams = WebSecuritySharedToolParams & RawFuzzVhostsOptions;
export type SqliProbeToolParams = WebSecuritySharedToolParams & RawSqliProbeOptions;
export type SqlmapBridgeToolParams = WebSecuritySharedToolParams & RawSqlmapBridgeOptions;
export type NucleiBridgeToolParams = WebSecuritySharedToolParams & RawNucleiBridgeOptions;
export type TemplateCheckToolParams = WebSecuritySharedToolParams & RawTemplateCheckOptions;
export type CallbackOastToolParams = WebSecuritySharedToolParams & RawCallbackOastOptions;
export type CookieAnalyzeToolParams = WebSecuritySharedToolParams & RawCookieAnalyzeOptions;
export type FuzzParamsToolParams = WebSecuritySharedToolParams & RawFuzzParamsOptions;
export type HttpReplayToolParams = WebSecuritySharedToolParams & RawReplayOptions;

type RunParamMutation = {
	timeoutMs?: number;
	maxBodyBytes?: number;
	cookieProvider?: CookieProvider;
};

type WebSecurityShellConfig<TParams extends WebSecuritySharedToolParams, TRunParams extends object, TResult> = {
	toolName: ToolResultBudgetName;
	command: string;
	fallbackPrefix: string;
	defaultMaxBodyBytes?: number;
	defaultTimeoutMs?: number;
	includeTimeout?: boolean;
	includeCookieProvider?: boolean;
	augmentParams?: (params: TParams) => Partial<TRunParams>;
	run: (params: TRunParams) => Promise<TResult>;
	details: (result: TResult) => Record<string, unknown>;
	distill: (result: TResult) => Record<string, unknown>;
};

export function normalizeWebSecurityToolParams<TParams extends WebSecuritySharedToolParams>(params: unknown): TParams {
	return (params && typeof params === "object" && !Array.isArray(params) ? params : {}) as TParams;
}

export function resolveBooleanParam(value: unknown, defaultValue: boolean) {
	return value === undefined ? defaultValue : value === true;
}

function createBrowserCookieProvider(ensureStarted: EnsureStarted, params: WebSecuritySharedToolParams, timeoutMs: number): CookieProvider {
	return async (url: string) => {
		const server = await ensureStarted();
		const cookies = await server.sendCommand({ cmd: "cookies", url, timeoutMs }, { tabId: params.tabId, timeoutMs });
		return browserCookiesToHeader(cookies.data);
	};
}

export type WebSecurityToolContext = { cwd?: string };

export async function executeWebSecurityToolShell<TParams extends WebSecuritySharedToolParams, TRunParams extends object, TResult>(ensureStarted: EnsureStarted, params: TParams, ctx: WebSecurityToolContext | undefined, config: WebSecurityShellConfig<TParams, TRunParams, TResult>) {
	try {
		const timeoutMs = asPositiveInt(params.timeoutMs, config.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
		const maxChars = asPositiveInt(params.maxChars, defaultResultBudget(config.toolName));
		const runParams: TRunParams & RunParamMutation = {
			...params,
			...(config.augmentParams?.(params) || {}),
		} as unknown as TRunParams & RunParamMutation;
		if (config.includeTimeout !== false) runParams.timeoutMs = timeoutMs;
		if (config.defaultMaxBodyBytes !== undefined) runParams.maxBodyBytes = asPositiveInt(params.maxBodyBytes, config.defaultMaxBodyBytes);
		if (config.includeCookieProvider) runParams.cookieProvider = createBrowserCookieProvider(ensureStarted, params, timeoutMs);
		const result = await config.run(runParams);
		return await distilledJsonResult(result, {
			toolName: config.toolName,
			command: config.command,
			detailLevel: params.detailLevel,
			maxChars,
			ctx,
			outputPath: params.outputPath,
			fallbackName: `${config.fallbackPrefix}-${Date.now()}.json`,
			details: { command: config.command, ...config.details(result) },
			artifactValue: result,
			distill: config.distill,
		});
	} catch (error) {
		return errorResult(error);
	}
}
