import { Type } from "typebox";
import { runWebSecurityTool as runWebSecurityToolAdapter, sharedTabScopedToolParams, type ToolOnUpdate } from "../../toolAdapter";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE } from "../../toolShared";
import type { EnsureStarted } from "../../toolShared";
import { browserCookiesToHeader } from "../../webSecurityCore";
import type { CookieProvider, RawCallbackOastOptions, RawCookieAnalyzeOptions, RawCrawlOptions, RawFuzzParamsOptions, RawFuzzPathsOptions, RawFuzzVhostsOptions, RawNucleiBridgeOptions, RawProbeOptions, RawReplayOptions, RawSqliProbeOptions, RawSqlmapBridgeOptions, RawTemplateCheckOptions } from "../shared/types";
import type { ToolResultBudgetName } from "../../budgets";
import { webSecurityToolError } from "../shared/diagnostics";

export { TAB_SCOPED_TOOL_GUIDELINE };

export function sharedWebSecurityBrowserSessionParams(timeoutDescription: string) {
	return sharedTabScopedToolParams({
		tabIdDescription: "Target tab id used when bindBrowserSession injects browser cookies into HTTP requests; otherwise omitted is allowed.",
		timeoutDescription,
	});
}

export function sharedWebSecurityResultParams() {
	return sharedTabScopedToolParams({ includeTabId: false, includeTimeout: false });
}

export function sharedWebSecurityParams() {
	return {
		...sharedTabScopedToolParams({
			tabIdDescription: "Target tab id used when bindBrowserSession injects browser cookies into HTTP requests; otherwise omitted is allowed.",
			timeoutDescription: "Per-request timeout in milliseconds",
		}),
		maxBodyBytes: Type.Optional(Type.Number({ description: "Maximum response body bytes stored per request before truncation; default 256000." })),
		allowPrivateTargets: Type.Optional(Type.Boolean({ description: "Allow requests to private, link-local, or cloud-metadata-adjacent targets. Default false; loopback remains allowed for local fixtures and callback listeners." })),
	};
}

export function browserCookieBindingParams(bindBrowserSessionDescription: string, options: { includeCookieMode?: boolean } = {}) {
	return {
		bindBrowserSession: Type.Optional(Type.Boolean({ description: bindBrowserSessionDescription })),
		...(options.includeCookieMode === false ? {} : { cookieMode: Type.Optional(Type.String({ description: "merge | replace | preserve for browser cookie injection into HTTP requests; default merge." })) }),
	};
}

export function harReplayParams(options: { harDescription: string; harPathDescription: string }) {
	return {
		har: Type.Optional(Type.Any({ description: options.harDescription })),
		harPath: Type.Optional(Type.String({ description: options.harPathDescription })),
		harEntryIndex: Type.Optional(Type.Number({ description: "Zero-based HAR entry index to replay." })),
		harUrlPattern: Type.Optional(Type.String({ description: "Bounded safe-regex or substring filter for HAR request URLs; unsafe regex falls back to substring and candidate entries are capped." })),
		harMaxEntries: Type.Optional(Type.Number({ description: "Maximum HAR entries to replay; default 20, hard-capped at 100." })),
	};
}

export function rawRequestParams(options: { urlDescription: string; rawRequestDescription: string; requestDescription: string; headersDescription: string; mutationsDescription: string }, config: { section?: "all" | "target" | "overrides"; includeUrl?: boolean } = {}) {
	const targetParams = {
		...(config.includeUrl === false ? {} : { url: Type.Optional(Type.String({ description: options.urlDescription })) }),
		baseUrl: Type.Optional(Type.String({ description: "Base URL for relative raw request targets." })),
		rawRequest: Type.Optional(Type.String({ description: options.rawRequestDescription })),
		request: Type.Optional(Type.Any({ description: options.requestDescription })),
	};
	const overrideParams = {
		method: Type.Optional(Type.String({ description: "Override HTTP method." })),
		headers: Type.Optional(Type.Any({ description: options.headersDescription })),
		body: Type.Optional(Type.String({ description: "Text request body override." })),
		bodyBase64: Type.Optional(Type.String({ description: "Base64 request body override for binary-ish payloads." })),
		mutations: Type.Optional(Type.Any({ description: options.mutationsDescription })),
		defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
	};
	if (config.section === "target") return targetParams;
	if (config.section === "overrides") return overrideParams;
	return { ...targetParams, ...overrideParams };
}

export function requestSequenceParams(options: { requestsDescription: string; sequenceDescription: string }) {
	return {
		requests: Type.Optional(Type.Array(Type.Any(), { description: options.requestsDescription })),
		sequence: Type.Optional(Type.Array(Type.Any(), { description: options.sequenceDescription })),
	};
}

export function boundedExecutionParams(options: { timeoutSecondsDescription: string }) {
	return {
		timeoutSeconds: Type.Optional(Type.Number({ description: options.timeoutSecondsDescription })),
	};
}

export function redirectControlParams(options: { followRedirectsDescription: string; maxRedirectsDescription: string }) {
	return {
		followRedirects: Type.Optional(Type.Boolean({ description: options.followRedirectsDescription })),
		maxRedirects: Type.Optional(Type.Number({ description: options.maxRedirectsDescription })),
	};
}

export function rateLimitPerSecondParam(description: string) {
	return {
		rateLimitPerSecond: Type.Optional(Type.Number({ description })),
	};
}

export function maxCasesParam(description: string) {
	return {
		maxCases: Type.Optional(Type.Number({ description })),
	};
}

export function maxCandidatesParam(description: string) {
	return {
		maxCandidates: Type.Optional(Type.Number({ description })),
	};
}

export function maxDepthParam(description: string) {
	return {
		maxDepth: Type.Optional(Type.Number({ description })),
	};
}

export function maxPagesParam(description: string) {
	return {
		maxPages: Type.Optional(Type.Number({ description })),
	};
}

export function maxTemplatesParam(description: string) {
	return {
		maxTemplates: Type.Optional(Type.Number({ description })),
	};
}

export type WebSecuritySharedToolParams = {
	browserSessionId?: string;
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
export type CallbackOastToolParams = WebSecuritySharedToolParams & RawCallbackOastOptions & { triggerTimeoutMs?: unknown };
export type CookieAnalyzeToolParams = WebSecuritySharedToolParams & RawCookieAnalyzeOptions;
export type FuzzParamsToolParams = WebSecuritySharedToolParams & RawFuzzParamsOptions;
export type HttpReplayToolParams = WebSecuritySharedToolParams & RawReplayOptions;

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
		const cookies = await server.sendCommand({ cmd: "cookies", url, timeoutMs }, { browserSessionId: params.browserSessionId, tabId: params.tabId, timeoutMs });
		return browserCookiesToHeader(cookies.data);
	};
}

export type WebSecurityToolContext = { cwd?: string };

export async function runWebSecurityTool<TParams extends WebSecuritySharedToolParams, TRunParams extends object, TResult>(ensureStarted: EnsureStarted, params: TParams, ctx: WebSecurityToolContext | undefined, config: WebSecurityShellConfig<TParams, TRunParams, TResult>, onUpdate?: ToolOnUpdate) {
	return await runWebSecurityToolAdapter<TParams, TRunParams, TResult>({
		ensureStarted,
		params,
		ctx,
		onUpdate,
		toolName: config.toolName,
		command: config.command,
		fallbackPrefix: config.fallbackPrefix,
		defaultMaxBodyBytes: config.defaultMaxBodyBytes,
		defaultTimeoutMs: config.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
		includeTimeout: config.includeTimeout,
		includeCookieProvider: config.includeCookieProvider,
		augmentParams: config.augmentParams,
		createCookieProvider: config.includeCookieProvider ? (currentParams, timeoutMs) => createBrowserCookieProvider(ensureStarted, currentParams, timeoutMs) : undefined,
		run: config.run,
		details: config.details,
		distill: config.distill,
		error: { map: (error) => webSecurityToolError(error, { toolName: config.toolName, command: config.command }) },
	});
}

export const executeWebSecurityToolShell = runWebSecurityTool;
