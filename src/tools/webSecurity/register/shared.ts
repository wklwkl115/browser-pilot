import { Type } from "typebox";
import { artifactFallbackName, jsonToolResult, runTool, sharedTabScopedToolParams, toolMaxChars, toolPositiveInt, toolTimeoutMs } from "../../toolAdapter";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE } from "../../toolShared";
import type { EnsureStarted } from "../../toolShared";
import { browserCookiesToHeader } from "../../webSecurityCore";
import type { CookieProvider, RawCallbackOastOptions, RawCookieAnalyzeOptions, RawCrawlOptions, RawFuzzParamsOptions, RawFuzzPathsOptions, RawFuzzVhostsOptions, RawNucleiBridgeOptions, RawProbeOptions, RawReplayOptions, RawSqliProbeOptions, RawSqlmapBridgeOptions, RawTemplateCheckOptions } from "../shared/types";
import type { ToolResultBudgetName } from "../../budgets";
import { webSecurityToolError } from "../shared/diagnostics";

export { TAB_SCOPED_TOOL_GUIDELINE };

export function sharedWebSecurityBrowserSessionParams(timeoutDescription: string) {
	return sharedTabScopedToolParams({
		tabIdDescription: "Target tab id used when bindBrowserSession needs browser cookies; otherwise omitted is allowed.",
		timeoutDescription,
	});
}

export function sharedWebSecurityResultParams() {
	return sharedTabScopedToolParams({ includeTabId: false, includeTimeout: false });
}

export function sharedWebSecurityParams() {
	return {
		...sharedTabScopedToolParams({
			tabIdDescription: "Target tab id used when bindBrowserSession needs browser cookies; otherwise omitted is allowed.",
			timeoutDescription: "Per-request timeout in milliseconds",
		}),
		maxBodyBytes: Type.Optional(Type.Number({ description: "Maximum response body bytes stored per request before truncation; default 256000." })),
	};
}

export type WebSecuritySharedToolParams = {
	tabId?: number | string;
	target?: unknown;
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
		const cookies = await server.sendCommand({ cmd: "cookies", url, timeoutMs }, { tabId: params.tabId, target: params.target, timeoutMs, toolName: "webSecurity.cookieProvider", commandName: "cookies" });
		return browserCookiesToHeader(cookies.data);
	};
}

export type WebSecurityToolContext = { cwd?: string };

export async function executeWebSecurityToolShell<TParams extends WebSecuritySharedToolParams, TRunParams extends object, TResult>(ensureStarted: EnsureStarted, params: TParams, ctx: WebSecurityToolContext | undefined, config: WebSecurityShellConfig<TParams, TRunParams, TResult>) {
	return await runTool(async () => {
		try {
			const timeoutMs = toolTimeoutMs(params.timeoutMs, config.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
			const maxChars = toolMaxChars(params, config.toolName);
			const runParams: TRunParams & RunParamMutation = {
				...params,
				...(config.augmentParams?.(params) || {}),
			} as unknown as TRunParams & RunParamMutation;
			if (config.includeTimeout !== false) runParams.timeoutMs = timeoutMs;
			if (config.defaultMaxBodyBytes !== undefined) runParams.maxBodyBytes = toolPositiveInt(params.maxBodyBytes, config.defaultMaxBodyBytes);
			if (config.includeCookieProvider) runParams.cookieProvider = createBrowserCookieProvider(ensureStarted, params, timeoutMs);
			const result = await config.run(runParams);
			return await jsonToolResult(result, params, ctx, {
				toolName: config.toolName,
				command: config.command,
				maxChars,
				fallbackName: artifactFallbackName(config.fallbackPrefix),
				details: { command: config.command, ...config.details(result) },
				artifactValue: result,
				distill: config.distill,
			});
		} catch (error) {
			throw webSecurityToolError(error, config);
		}
	});
}
