import { Type } from "typebox";
import { createCodedError } from "../../../utils/codedError";
import { runWebSecurityTool as runWebSecurityToolAdapter, sharedTabScopedToolParams, type ToolOnUpdate } from "../../toolAdapter";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE } from "../../toolShared";
import type { EnsureStarted } from "../../toolShared";
import { browserCookiesToHeader } from "../../webSecurityCore";
import type { CookieProvider, RawCallbackOastOptions, RawCookieAnalyzeOptions, RawCrawlOptions, RawFuzzParamsOptions, RawFuzzPathsOptions, RawFuzzVhostsOptions, RawNucleiBridgeOptions, RawProbeOptions, RawReplayOptions, RawSqliProbeOptions, RawSqlmapBridgeOptions, RawTemplateCheckOptions } from "../shared/types";
import type { ToolResultBudgetName } from "../../budgets";
import { webSecurityToolError } from "../shared/diagnostics";

export { TAB_SCOPED_TOOL_GUIDELINE };

const STRING_LIKE_SCHEMA = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);
const STRING_LIKE_ARRAY_SCHEMA = Type.Array(STRING_LIKE_SCHEMA);
const STRING_OR_STRING_ARRAY_SCHEMA = Type.Union([Type.String(), Type.Array(Type.String())]);
const STRING_OR_NUMBER_OR_LIST_SCHEMA = Type.Union([Type.String(), Type.Number(), Type.Array(Type.Union([Type.String(), Type.Number()]))]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function provided(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.length > 0;
	return true;
}

function nestedProvided(value: unknown, key: string, nestedKey: string): boolean {
	return isRecord(value) && isRecord(value[key]) && provided(value[key][nestedKey]);
}

function anyProvided(value: unknown, keys: string[]): boolean {
	return isRecord(value) && keys.some((key) => provided(value[key]));
}

function presentFields(value: unknown, fields: string[]): string[] {
	if (!isRecord(value)) return [];
	return fields.filter((field) => provided(value[field]));
}

function validationError(message: string, details: Record<string, unknown> = {}, nextActions: string[] = []): Error {
	return createCodedError({
		name: "WebSecurityValidationError",
		code: "INVALID_RULE",
		message,
		details: {
			...details,
			...(nextActions.length ? { recovery: { nextActions } } : {}),
		},
		suppressStack: false,
	});
}

function rejectFields(context: string, value: unknown, fields: string[], nextActions: string[]): void {
	const invalidFields = presentFields(value, fields);
	if (!invalidFields.length) return;
	throw validationError(`${context} does not accept ${invalidFields.join(", ")}`, { invalidFields, context }, nextActions);
}

function requireAny(context: string, ok: boolean, fields: string[], nextActions: string[]): void {
	if (ok) return;
	throw validationError(`${context} requires ${fields.join(" or ")}`, { field: fields.join("|") }, nextActions);
}

function hasUrlScope(value: unknown): boolean {
	return anyProvided(value, ["url", "urls"]);
}

function hasRequestTemplateSource(value: unknown): boolean {
	return anyProvided(value, ["url", "rawRequest", "request"]) || nestedProvided(value, "mutations", "url");
}

function hasBridgeTarget(value: unknown): boolean {
	return hasRequestTemplateSource(value) || anyProvided(value, ["urls", "requests", "sequence", "har", "harPath"]);
}

function hasTemplateSelection(value: unknown): boolean {
	return anyProvided(value, ["templatePaths", "workflowPaths", "templateIds", "tags", "severities", "authors"]);
}

export function headerRecordParam(description: string) {
	return Type.Optional(Type.Record(Type.String(), Type.Union([STRING_LIKE_SCHEMA, STRING_LIKE_ARRAY_SCHEMA]), { description }));
}

export function stringOrStringArrayParam(description: string) {
	return Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description }));
}

export function stringNumberOrListParam(description: string) {
	return Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Array(Type.Union([Type.String(), Type.Number()]))], { description }));
}

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
		headers: Type.Optional(Type.Record(Type.String(), Type.Union([STRING_LIKE_SCHEMA, STRING_LIKE_ARRAY_SCHEMA]), { description: options.headersDescription })),
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

export function validateCrawlParams(action: string, params: unknown): void {
	requireAny(`browser_crawl action=${action}`, hasUrlScope(params), ["url", "urls"], ["pass explicit url or urls before crawling or fingerprinting"]);
}

export function validateFuzzParams(mode: string, params: unknown): void {
	requireAny(`browser_fuzz mode=${mode}`, hasUrlScope(params), ["url", "urls"], ["pass explicit url or urls before fuzzing"]);
	if (mode === "vhost") {
		requireAny(`browser_fuzz mode=${mode}`, anyProvided(params, ["hosts", "words", "wordlist", "wordlistPath"]), ["hosts", "words", "wordlist", "wordlistPath"], ["provide host candidates or a bounded wordlist before vhost fuzzing"]);
		rejectFields(`browser_fuzz mode=${mode}`, params, ["baseUrl", "paths", "extensions", "appendSlash", "recursive", "maxDepth", "baselinePath", "rawRequest", "request", "body", "bodyBase64", "mutations", "locations", "paramNames", "values", "jsonValues", "operations", "contentTypeVariants", "maxCases"], ["remove path-mode or param-mode fields, or switch to mode=path or mode=param"]);
		return;
	}
	if (mode === "param") {
		requireAny(`browser_fuzz mode=${mode}`, hasRequestTemplateSource(params), ["url", "rawRequest", "request", "mutations.url"], ["capture a request template with browser_network or pass url/rawRequest/request before parameter fuzzing"]);
		rejectFields(`browser_fuzz mode=${mode}`, params, ["paths", "extensions", "appendSlash", "recursive", "maxDepth", "filterBaseline", "baselinePath", "baselineStrategy", "maxCandidates", "hosts", "baseDomain", "template", "baselineHost", "baselineHosts", "sniMode", "sniName"], ["remove path-mode or vhost-mode fields, or switch to mode=path or mode=vhost"]);
		return;
	}
	requireAny(`browser_fuzz mode=${mode}`, anyProvided(params, ["paths", "words", "wordlist", "wordlistPath"]), ["paths", "words", "wordlist", "wordlistPath"], ["provide path candidates or a bounded wordlist before path fuzzing"]);
	rejectFields(`browser_fuzz mode=${mode}`, params, ["baseUrl", "hosts", "baseDomain", "template", "baselineHost", "baselineHosts", "sniMode", "sniName", "rawRequest", "request", "body", "bodyBase64", "mutations", "locations", "paramNames", "values", "jsonValues", "operations", "contentTypeVariants", "maxCases"], ["remove vhost-mode or param-mode fields, or switch to mode=vhost or mode=param"]);
}

export function validateSqliParams(engine: string, params: unknown): void {
	if (engine === "sqlmap") {
		requireAny(`browser_sqli engine=${engine}`, hasBridgeTarget(params), ["url", "rawRequest", "request", "requests", "sequence", "har", "harPath"], ["provide a scoped target or request template before sqlmap automation"]);
		rejectFields(`browser_sqli engine=${engine}`, params, ["locations", "probeTypes", "payloadMode", "booleanPayloadPairs", "errorPayloads", "timePayloads", "unionPayloads", "unionEcho", "orderByMax", "unionColumnMax", "extractExpression", "extractMaxLength", "extractCharset", "payloads", "timeThresholdMs", "baselineRepeats", "stopOnFirstMatch", "followRedirects", "maxRedirects", "maxCases", "rateLimitPerSecond"], ["remove builtin-only probe fields, or switch to engine=builtin"]);
		return;
	}
	requireAny(`browser_sqli engine=${engine}`, hasRequestTemplateSource(params), ["url", "rawRequest", "request", "mutations.url"], ["capture a request template with browser_network or pass url/rawRequest/request before SQLi probing"]);
	rejectFields(`browser_sqli engine=${engine}`, params, ["har", "harPath", "harEntryIndex", "harUrlPattern", "harMaxEntries", "requests", "sequence", "sqlmapPath", "sqlmapArgs", "extraArgs", "allowLauncherOverride", "technique", "level", "risk", "threads", "timeoutSeconds", "retries", "batch", "flushSession", "answers", "currentDb", "currentUser", "isDba", "banner", "tamper"], ["remove sqlmap-only fields, or switch to engine=sqlmap"]);
}

export function validateTemplateParams(engine: string, params: unknown): void {
	const hasBuiltinTarget = hasRequestTemplateSource(params) || anyProvided(params, ["urls"]);
	if (engine === "nuclei") {
		requireAny(`browser_template engine=${engine}`, hasBridgeTarget(params), ["url", "urls", "rawRequest", "request", "requests", "sequence", "har", "harPath"], ["provide a scoped target or request template before nuclei automation"]);
		requireAny(`browser_template engine=${engine}`, hasTemplateSelection(params), ["templatePaths", "workflowPaths", "templateIds", "tags", "severities", "authors"], ["pass explicit template selection before engine=nuclei"]);
		rejectFields(`browser_template engine=${engine}`, params, ["templates", "templatePath", "variables", "tech", "maxTemplates", "maxRequests"], ["remove builtin-only template fields, or switch to engine=builtin"]);
		return;
	}
	requireAny(`browser_template engine=${engine}`, hasBuiltinTarget, ["url", "urls", "rawRequest", "request", "mutations.url"], ["pass explicit url/urls or a captured request before template checks"]);
	rejectFields(`browser_template engine=${engine}`, params, ["templatePaths", "workflowPaths", "tags", "excludeTags", "severities", "authors", "har", "harPath", "harEntryIndex", "harUrlPattern", "harMaxEntries", "requests", "sequence", "timeoutSeconds", "retries", "concurrency", "bulkSize", "nucleiPath", "nucleiArgs", "extraArgs", "allowLauncherOverride"], ["remove nuclei-only fields, or switch to engine=nuclei"]);
}

export function validateOastParams(action: string, params: unknown): void {
	const allowedActions = new Set(["start", "list", "status", "collect", "clear", "trigger", "stop"]);
	if (!allowedActions.has(action)) throw validationError(`browser_callback_oast action=${action} is invalid`, { action, allowedActions: Array.from(allowedActions) }, ["use start, list, status, collect, clear, trigger, or stop"]);
	if (["status", "collect", "clear", "trigger", "stop"].includes(action)) {
		requireAny(`browser_callback_oast action=${action}`, anyProvided(params, ["sessionId"]), ["sessionId"], ["start or list a callback session first, then pass sessionId"]);
	}
	if (action !== "trigger") {
		rejectFields(`browser_callback_oast action=${action}`, params, ["mode", "target", "method", "requestHeaders", "body", "bodyBase64", "queryName", "queryType", "resolverHost", "resolverPort", "rejectUnauthorized", "triggerTimeoutMs"], ["remove trigger-only fields, or switch to action=trigger"]);
	}
}

export function validateHttpReplayParams(params: unknown): void {
	requireAny("browser_http_replay", hasBridgeTarget(params), ["url", "rawRequest", "request", "requests", "sequence", "har", "harPath"], ["pass an explicit request target, raw request, captured request, request sequence, or HAR before replaying"]);
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
