import { Type } from "typebox";
import { errorResult } from "../utils/toolResult";
import { defaultResultBudget, type ToolResultBudgetName } from "./budgets";
import { distilledJsonResult } from "./resultMiddleware";
import { summarizeBrowserCrawlData, summarizeCallbackOastData, summarizeCookieAnalyzeData, summarizeFuzzParamsData, summarizeFuzzPathsData, summarizeFuzzVhostsData, summarizeHttpReplayData, summarizeNucleiBridgeData, summarizeSqlmapBridgeData, summarizeSqliProbeData, summarizeTemplateCheckData, summarizeWebReconProbeData } from "./summaries/index";
import { browserCookiesToHeader, runBrowserCrawl, runCallbackOast, runCookieAnalyze, runFuzzParams, runFuzzPaths, runFuzzVhosts, runHttpReplay, runNucleiBridge, runReconProbe, runSqlmapBridge, runSqliProbe, runTemplateCheck } from "./webSecurityCore";
import { asPositiveInt, DEFAULT_TOOL_TIMEOUT_MS, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { EnsureStarted, ToolRegistrarContext } from "./toolShared";

function sharedWebSecurityParams() {
	return {
		tabId: optionalTargetTabId("Target tab id used when bindBrowserSession needs browser cookies; otherwise omitted is allowed."),
		detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
		outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
		timeoutMs: Type.Optional(Type.Number({ description: "Per-request timeout in milliseconds" })),
		maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
		maxBodyBytes: Type.Optional(Type.Number({ description: "Maximum response body bytes stored per request before truncation; default 256000." })),
	};
}

type WebSecurityToolParams = {
	tabId?: number | string;
	detailLevel?: string;
	outputPath?: string;
	timeoutMs?: number;
	maxChars?: number;
	maxBodyBytes?: number;
	[key: string]: unknown;
};

type WebSecurityShellConfig<TResult> = {
	toolName: ToolResultBudgetName;
	command: string;
	fallbackPrefix: string;
	defaultMaxBodyBytes?: number;
	defaultTimeoutMs?: number;
	includeTimeout?: boolean;
	includeCookieProvider?: boolean;
	augmentParams?: (params: WebSecurityToolParams) => Record<string, unknown>;
	run: (params: Record<string, unknown>) => Promise<TResult>;
	details: (result: TResult) => Record<string, unknown>;
	distill: (result: TResult) => unknown;
};

function resolveBooleanParam(value: unknown, defaultValue: boolean) {
	return value === undefined ? defaultValue : value === true;
}

function createBrowserCookieProvider(ensureStarted: EnsureStarted, params: WebSecurityToolParams, timeoutMs: number) {
	return async (url: string) => {
		const server = await ensureStarted();
		const cookies = await server.sendCommand({ cmd: "cookies", url, timeoutMs }, { tabId: params.tabId, timeoutMs });
		return browserCookiesToHeader(cookies.data);
	};
}

async function executeWebSecurityToolShell<TResult>(ensureStarted: EnsureStarted, params: WebSecurityToolParams, ctx: unknown, config: WebSecurityShellConfig<TResult>) {
	try {
		const timeoutMs = asPositiveInt(params.timeoutMs, config.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
		const maxChars = asPositiveInt(params.maxChars, defaultResultBudget(config.toolName));
		const runParams: Record<string, unknown> = {
			...params,
			...(config.augmentParams?.(params) || {}),
		};
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

export function registerReconProbeTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_recon_probe",
		label: "Browser Recon Probe",
		description: "Probe scoped HTTP(S) URLs for status, title, headers, technology hints, redirect chains, and response artifacts.",
		promptSnippet: "Run controlled live URL probing for Web recon baselines and store response evidence.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_recon_probe for small scoped URL/path baselines before crawl/fuzz stages; keep urls/paths explicit and bounded."],
		parameters: Type.Object({
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Single target URL or host. Host-only input uses defaultScheme." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Bounded list of target URLs or hosts." })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Optional paths to resolve against each target URL, e.g. /robots.txt." })),
			ports: Type.Optional(Type.Array(Type.Number(), { description: "Optional ports to apply to each target URL." })),
			schemes: Type.Optional(Type.Array(Type.String(), { description: "Optional schemes to expand, e.g. [http, https]." })),
			method: Type.Optional(Type.String({ description: "HTTP method for probing; default GET." })),
			headers: Type.Optional(Type.Any({ description: "Optional request headers object." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
			followRedirects: Type.Optional(Type.Boolean({ description: "Follow redirects and record the chain; default true." })),
			maxRedirects: Type.Optional(Type.Number({ description: "Maximum redirects per URL; default 5 when followRedirects is true." })),
			includeFaviconHash: Type.Optional(Type.Boolean({ description: "Fetch /favicon.ico for each final origin and include favicon hash metadata; default false." })),
			includeTlsCertificate: Type.Optional(Type.Boolean({ description: "Inspect HTTPS peer certificate metadata for final URLs; default false." })),
			bindBrowserSession: Type.Optional(Type.Boolean({ description: "Attach browser cookies for each probed URL using the connected browser session; default false." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, params, ctx, {
				toolName: "browser_recon_probe",
				command: "web.recon_probe",
				fallbackPrefix: "recon-probe",
				defaultMaxBodyBytes: 256_000,
				includeCookieProvider: true,
				augmentParams: (current) => ({ followRedirects: resolveBooleanParam(current.followRedirects, true) }),
				run: runReconProbe,
				details: (result) => ({ count: result.count }),
				distill: summarizeWebReconProbeData,
			});
		},
	});
}

export function registerCrawlTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_crawl",
		label: "Browser Crawl",
		description: "Run a bounded scoped crawl for links, forms, known files, JavaScript-discovered endpoints, OpenAPI schema summaries, passive GraphQL schema parsing, active GraphQL introspection probes, source-map reverse-source archives, service-worker cache/version summaries, and response evidence.",
		promptSnippet: "Crawl scoped targets, known files, forms, links, JS endpoint hints, source maps, service workers, and structured API discovery with evidence artifact output.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_crawl after browser_recon_probe and before fuzzing; keep maxDepth/maxPages explicit and scope bounded. activeGraphqlIntrospection defaults true and only POSTs a standard introspection query to URLs/content-types that look like GraphQL; set false for passive-only crawl."],
		parameters: Type.Object({
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Single seed URL or host. Host-only input uses defaultScheme." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Bounded list of seed URLs or hosts." })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Optional seed paths to resolve against each target URL." })),
			headers: Type.Optional(Type.Any({ description: "Optional request headers object." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
			maxDepth: Type.Optional(Type.Number({ description: "Maximum crawl depth; default 2, hard-capped at 5." })),
			maxPages: Type.Optional(Type.Number({ description: "Maximum pages/resources fetched; default 50, hard-capped at 500." })),
			sameOrigin: Type.Optional(Type.Boolean({ description: "Stay within seed origins; default true." })),
			knownFiles: Type.Optional(Type.String({ description: "none | robotstxt | sitemapxml | all. Adds common known-file seeds." })),
			extractJs: Type.Optional(Type.Boolean({ description: "Extract JS endpoint hints and crawl same-origin script files; default true." })),
			activeGraphqlIntrospection: Type.Optional(Type.Boolean({ description: "Actively POST a standard GraphQL introspection query only to URLs/content-types that look like GraphQL; default true. Set false for passive-only GraphQL parsing." })),
			bindBrowserSession: Type.Optional(Type.Boolean({ description: "Attach browser cookies for crawled URLs using the connected browser session; default false." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, params, ctx, {
				toolName: "browser_crawl",
				command: "web.crawl",
				fallbackPrefix: "crawl",
				defaultMaxBodyBytes: 256_000,
				includeCookieProvider: true,
				run: runBrowserCrawl,
				details: (result) => ({ pageCount: result.pageCount, endpointCount: result.endpointCount }),
				distill: summarizeBrowserCrawlData,
			});
		},
	});
}

export function registerFuzzPathsTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_fuzz_paths",
		label: "Browser Fuzz Paths",
		description: "Fuzz scoped HTTP paths, files, routes, and extensions with recursive depth, baseline-cluster filtering, match/filter/rate controls, response evidence, and artifact output.",
		promptSnippet: "Run bounded path/file/route fuzzing against scoped targets with structured response evidence, recursive depth, and baseline clustering.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_fuzz_paths only with explicit target scope and bounded wordlists; set match/filter/rate controls before increasing breadth."],
		parameters: Type.Object({
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Single base target URL or URL containing FUZZ. Host-only input uses defaultScheme." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Bounded list of base target URLs or FUZZ URLs." })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Explicit candidate paths/routes to request." })),
			words: Type.Optional(Type.Array(Type.String(), { description: "Candidate words appended to each base URL or substituted into FUZZ. For multiple FUZZ tokens, use word tuples separated by ::." })),
			wordlist: Type.Optional(Type.Array(Type.String(), { description: "Inline wordlist entries; aliases words." })),
			wordlistPath: Type.Optional(Type.String({ description: "Optional local wordlist file path; one entry per line." })),
			extensions: Type.Optional(Type.Array(Type.String(), { description: "Optional extensions to add for extension fuzzing, e.g. php,json,txt." })),
			appendSlash: Type.Optional(Type.Boolean({ description: "Also test trailing-slash directory variants." })),
			recursive: Type.Optional(Type.Boolean({ description: "Recursively fuzz discovered directory-like paths; default false." })),
			maxDepth: Type.Optional(Type.Number({ description: "Maximum recursive directory depth when recursive is enabled; default 2, hard-capped at 5." })),
			method: Type.Optional(Type.String({ description: "HTTP method; default GET." })),
			headers: Type.Optional(Type.Any({ description: "Optional request headers object." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
			followRedirects: Type.Optional(Type.Boolean({ description: "Follow redirects; default false for stable status matching." })),
			maxRedirects: Type.Optional(Type.Number({ description: "Maximum redirects when followRedirects is true; default 3." })),
			matchStatus: Type.Optional(Type.Any({ description: "Optional status matcher list/string, e.g. [200,204,301,302,403]." })),
			filterStatus: Type.Optional(Type.Any({ description: "Optional status filter list/string, e.g. [404]." })),
			filterBodyBytes: Type.Optional(Type.Any({ description: "Optional body byte-size filter list/string for noisy baselines." })),
			filterBaseline: Type.Optional(Type.Boolean({ description: "Only return candidates that differ from the auto baseline status/title/body/hash; default false." })),
			baselinePath: Type.Optional(Type.String({ description: "Optional baseline path/word used for automatic baseline comparison." })),
			baselineStrategy: Type.Optional(Type.String({ description: "Baseline comparison mode: exact | cluster | auto. Default auto." })),
			maxCandidates: Type.Optional(Type.Number({ description: "Maximum candidates per base after extension/slash expansion; default 500, hard-capped at 5000." })),
			rateLimitPerSecond: Type.Optional(Type.Number({ description: "Sequential request rate cap per second; default unlimited sequential." })),
			bindBrowserSession: Type.Optional(Type.Boolean({ description: "Attach browser cookies for fuzz requests using the connected browser session; default false." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, params, ctx, {
				toolName: "browser_fuzz_paths",
				command: "web.fuzz_paths",
				fallbackPrefix: "fuzz-paths",
				defaultMaxBodyBytes: 128_000,
				includeCookieProvider: true,
				run: runFuzzPaths,
				details: (result) => ({ requestCount: result.requestCount, matchedCount: result.matchedCount }),
				distill: summarizeFuzzPathsData,
			});
		},
	});
}

export function registerFuzzVhostsTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_fuzz_vhosts",
		label: "Browser Fuzz Vhosts",
		description: "Fuzz virtual hosts with Host header candidates, HTTPS SNI/certificate summaries, baseline-cluster filtering, response evidence, and artifact output.",
		promptSnippet: "Run bounded Host-header virtual-host discovery with baseline clustering, SNI, certificate summaries, and evidence artifacts.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_fuzz_vhosts only with explicit target scope and bounded host candidates; keep baseline filtering enabled unless diagnosing."],
		parameters: Type.Object({
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Single base target URL to connect to." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Bounded list of base target URLs to connect to." })),
			hosts: Type.Optional(Type.Array(Type.String(), { description: "Explicit Host header candidate values." })),
			words: Type.Optional(Type.Array(Type.String(), { description: "Candidate words; combined with baseDomain/template when provided." })),
			wordlist: Type.Optional(Type.Array(Type.String(), { description: "Inline wordlist entries; aliases words." })),
			wordlistPath: Type.Optional(Type.String({ description: "Optional local wordlist file path; one entry per line." })),
			baseDomain: Type.Optional(Type.String({ description: "Base domain used to expand words as word.baseDomain." })),
			template: Type.Optional(Type.String({ description: "Host template containing FUZZ, e.g. FUZZ.example.test." })),
			baselineHost: Type.Optional(Type.String({ description: "Baseline Host header; default is a generated invalid-looking host." })),
			baselineHosts: Type.Optional(Type.Array(Type.String(), { description: "Additional baseline Host header values used for wildcard response clustering." })),
			sniMode: Type.Optional(Type.String({ description: "HTTPS SNI mode: target | host | custom | none. Default target." })),
			sniName: Type.Optional(Type.String({ description: "Custom HTTPS SNI servername when sniMode/custom behavior is needed." })),
			method: Type.Optional(Type.String({ description: "HTTP method; default GET." })),
			headers: Type.Optional(Type.Any({ description: "Optional request headers except Host; Host is controlled by candidates." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only base targets; default https." })),
			followRedirects: Type.Optional(Type.Boolean({ description: "Follow redirects; default false." })),
			maxRedirects: Type.Optional(Type.Number({ description: "Maximum redirects when followRedirects is true; default 3." })),
			matchStatus: Type.Optional(Type.Any({ description: "Optional status matcher list/string, e.g. [200,301,302,403]." })),
			filterStatus: Type.Optional(Type.Any({ description: "Optional status filter list/string, e.g. [404]." })),
			filterBodyBytes: Type.Optional(Type.Any({ description: "Optional body byte-size filter list/string for noisy baselines." })),
			filterBaseline: Type.Optional(Type.Boolean({ description: "Only return candidates that differ from baseline status/title/body length; default true." })),
			baselineStrategy: Type.Optional(Type.String({ description: "Baseline comparison mode: exact | cluster | auto. Default auto." })),
			maxCandidates: Type.Optional(Type.Number({ description: "Maximum host candidates per base; default 500, hard-capped at 5000." })),
			rateLimitPerSecond: Type.Optional(Type.Number({ description: "Sequential request rate cap per second; default unlimited sequential." })),
			bindBrowserSession: Type.Optional(Type.Boolean({ description: "Attach browser cookies for fuzz requests using the connected browser session; default false." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, params, ctx, {
				toolName: "browser_fuzz_vhosts",
				command: "web.fuzz_vhosts",
				fallbackPrefix: "fuzz-vhosts",
				defaultMaxBodyBytes: 128_000,
				includeCookieProvider: true,
				run: runFuzzVhosts,
				details: (result) => ({ requestCount: result.requestCount, matchedCount: result.matchedCount }),
				distill: summarizeFuzzVhostsData,
			});
		},
	});
}

export function registerSqliProbeTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_sqli_probe",
		label: "Browser SQLi Probe",
		description: "Run SQL injection oracle probes from URL/raw/captured request templates with boolean, error, time, and union evidence.",
		promptSnippet: "Probe SQLi boolean/error/time/union oracles from scoped HTTP request templates with structured evidence.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_sqli_probe from a captured or raw request template for SQLi oracle evidence; keep param names, probe types, and maxCases bounded, and retain outputPath/artifact evidence for follow-up judgment."],
		parameters: Type.Object({
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Absolute URL or host/path target. Required unless rawRequest or request supplies a URL." })),
			baseUrl: Type.Optional(Type.String({ description: "Base URL for relative raw request targets." })),
			rawRequest: Type.Optional(Type.String({ description: "Raw HTTP request text used as the probe template." })),
			request: Type.Optional(Type.Any({ description: "Captured request-like object from browser_network/HAR." })),
			method: Type.Optional(Type.String({ description: "Override HTTP method." })),
			headers: Type.Optional(Type.Any({ description: "Headers to merge or override on the template." })),
			body: Type.Optional(Type.String({ description: "Text request body override." })),
			bodyBase64: Type.Optional(Type.String({ description: "Base64 request body override for binary-ish payloads." })),
			mutations: Type.Optional(Type.Any({ description: "Optional base mutation object with url, method, headers, body, or bodyBase64." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
			locations: Type.Optional(Type.Any({ description: "Parameter locations: query, json, form, header, or all. Default inferred from template." })),
			paramNames: Type.Optional(Type.Array(Type.String(), { description: "Parameter names to probe. If omitted, existing template params are used." })),
			probeTypes: Type.Optional(Type.Any({ description: "Probe families: boolean, error, time, union, or all. Default all." })),
			payloadMode: Type.Optional(Type.String({ description: "append | replace. Default append." })),
			dbms: Type.Optional(Type.Any({ description: "Optional DBMS payload pack: mysql, postgresql, sqlite, mssql, oracle, or comma/array combination." })),
			booleanPayloadPairs: Type.Optional(Type.Any({ description: "Boolean payload pairs as objects with truePayload/falsePayload or strings separated by ||, =>, or comma." })),
			errorPayloads: Type.Optional(Type.Array(Type.String(), { description: "Error oracle payloads." })),
			timePayloads: Type.Optional(Type.Array(Type.String(), { description: "Time oracle payloads." })),
			unionPayloads: Type.Optional(Type.Array(Type.String(), { description: "Union/order payloads. If omitted, ORDER BY and UNION SELECT payloads are generated." })),
			unionEcho: Type.Optional(Type.Boolean({ description: "Enumerate reflected UNION SELECT column positions when column count hints are available; default true." })),
			orderByMax: Type.Optional(Type.Number({ description: "Maximum ORDER BY index for generated union probes; default 3, hard-capped at 64." })),
			unionColumnMax: Type.Optional(Type.Number({ description: "Maximum UNION SELECT column count for generated probes; default 3, hard-capped at 64." })),
			extractExpression: Type.Optional(Type.String({ description: "Optional SQL expression for boolean-blind character extraction." })),
			extractMaxLength: Type.Optional(Type.Number({ description: "Maximum extracted characters; default 32, hard-capped at 256." })),
			extractCharset: Type.Optional(Type.String({ description: "Candidate charset for boolean-blind extraction." })),
			payloads: Type.Optional(Type.Array(Type.String(), { description: "Additional payloads appended to error probes." })),
			timeThresholdMs: Type.Optional(Type.Number({ description: "Elapsed-time delta threshold for time oracle matches; default 2000." })),
			baselineRepeats: Type.Optional(Type.Number({ description: "Baseline request repetitions; default 1, hard-capped at 10." })),
			stopOnFirstMatch: Type.Optional(Type.Boolean({ description: "Stop probing a confirmed vulnerable parameter after the first oracle match; default false." })),
			followRedirects: Type.Optional(Type.Boolean({ description: "Follow redirects; default false." })),
			maxRedirects: Type.Optional(Type.Number({ description: "Maximum redirects when followRedirects is true; default 3." })),
			maxCases: Type.Optional(Type.Number({ description: "Maximum probe cases; default 100, hard-capped at 5000." })),
			rateLimitPerSecond: Type.Optional(Type.Number({ description: "Sequential request rate cap per second; default unlimited sequential." })),
			bindBrowserSession: Type.Optional(Type.Boolean({ description: "Merge browser cookies for request URLs; default false." })),
			cookieMode: Type.Optional(Type.String({ description: "merge | replace | preserve for browser cookie binding; default merge." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, params, ctx, {
				toolName: "browser_sqli_probe",
				command: "web.sqli_probe",
				fallbackPrefix: "sqli-probe",
				defaultMaxBodyBytes: 128_000,
				includeCookieProvider: true,
				augmentParams: (current) => ({ followRedirects: resolveBooleanParam(current.followRedirects, false) }),
				run: runSqliProbe,
				details: (result) => ({ requestCount: result.requestCount, matchedCount: result.matchedCount }),
				distill: summarizeSqliProbeData,
			});
		},
	});
}

export function registerSqlmapBridgeTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_sqlmap_bridge",
		label: "Browser SQLMap Bridge",
		description: "Run deep SQL injection automation through a sqlmap bridge from URL, raw, captured, or HAR request inputs with structured findings and artifacts.",
		promptSnippet: "Run a Pi-native sqlmap bridge for deep SQLi automation with structured findings and artifacts.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_sqlmap_bridge for deep SQLi automation from explicit scoped request templates; keep bounded target scope explicit and retain request/stdout/stderr artifacts for follow-up evidence."],
		parameters: Type.Object({
			tabId: optionalTargetTabId("Target tab id used when bindBrowserSession needs browser cookies; otherwise omitted is allowed."),
			detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
			outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
			timeoutMs: Type.Optional(Type.Number({ description: "Process timeout in milliseconds; default 120000." })),
			maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
			sqlmapPath: Type.Optional(Type.String({ description: "Optional sqlmap executable or launcher command. Default auto-detects sqlmap in PATH or python -m sqlmap." })),
			sqlmapArgs: Type.Optional(Type.Array(Type.String(), { description: "Optional launcher arguments prepended before generated sqlmap flags, e.g. [-m, sqlmap]." })),
			extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Additional sqlmap CLI arguments appended after generated flags." })),
			url: Type.Optional(Type.String({ description: "Absolute URL or host/path target. Required unless rawRequest, request, requests, sequence, or HAR input supplies a target." })),
			baseUrl: Type.Optional(Type.String({ description: "Base URL for relative raw request targets." })),
			rawRequest: Type.Optional(Type.String({ description: "Raw HTTP request text used as the sqlmap request template." })),
			request: Type.Optional(Type.Any({ description: "Captured request-like object from browser_network/HAR." })),
			har: Type.Optional(Type.Any({ description: "HAR object; selected entries are replayed as sqlmap bridge targets." })),
			harPath: Type.Optional(Type.String({ description: "Local HAR JSON file path; selected entries are replayed as sqlmap bridge targets." })),
			harEntryIndex: Type.Optional(Type.Number({ description: "Zero-based HAR entry index to replay." })),
			harUrlPattern: Type.Optional(Type.String({ description: "Bounded safe-regex or substring filter for HAR request URLs; unsafe regex falls back to substring and candidate entries are capped." })),
			harMaxEntries: Type.Optional(Type.Number({ description: "Maximum HAR entries to replay; default 20, hard-capped at 100." })),
			requests: Type.Optional(Type.Array(Type.Any(), { description: "Request sequence entries: raw request strings, captured requests, HAR entries, or replay option objects. Each selected entry is sent to sqlmap as a separate target." })),
			sequence: Type.Optional(Type.Array(Type.Any(), { description: "Alias for requests; each selected entry is sent to sqlmap as a separate target." })),
			method: Type.Optional(Type.String({ description: "Override HTTP method." })),
			headers: Type.Optional(Type.Any({ description: "Headers to merge or override on the template." })),
			body: Type.Optional(Type.String({ description: "Text request body override." })),
			bodyBase64: Type.Optional(Type.String({ description: "Base64 request body override for binary-ish payloads." })),
			mutations: Type.Optional(Type.Any({ description: "Optional base mutation object with url, method, headers, body, or bodyBase64." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
			paramNames: Type.Optional(Type.Array(Type.String(), { description: "Optional parameter names passed to sqlmap -p." })),
			technique: Type.Optional(Type.String({ description: "Optional sqlmap technique letters, e.g. BEUSTQ or B,U." })),
			dbms: Type.Optional(Type.String({ description: "Optional backend DBMS hint passed to sqlmap --dbms." })),
			level: Type.Optional(Type.Number({ description: "sqlmap --level; default 1, clamped to 1-5." })),
			risk: Type.Optional(Type.Number({ description: "sqlmap --risk; default 1, clamped to 1-3." })),
			threads: Type.Optional(Type.Number({ description: "sqlmap --threads; default 1, clamped to 1-10." })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "sqlmap per-request timeout seconds; default derived from timeoutMs." })),
			retries: Type.Optional(Type.Number({ description: "sqlmap --retries; default 3." })),
			batch: Type.Optional(Type.Boolean({ description: "Run sqlmap in batch mode; default true." })),
			flushSession: Type.Optional(Type.Boolean({ description: "Pass --flush-session before testing; default false." })),
			answers: Type.Optional(Type.String({ description: "Optional sqlmap --answers string for scripted prompts." })),
			currentDb: Type.Optional(Type.Boolean({ description: "Request current database metadata via --current-db." })),
			currentUser: Type.Optional(Type.Boolean({ description: "Request current user metadata via --current-user." })),
			isDba: Type.Optional(Type.Boolean({ description: "Request DBA capability metadata via --is-dba." })),
			banner: Type.Optional(Type.Boolean({ description: "Request DBMS banner metadata via --banner." })),
			tamper: Type.Optional(Type.Any({ description: "Optional sqlmap tamper script list or comma string passed to --tamper." })),
			bindBrowserSession: Type.Optional(Type.Boolean({ description: "Merge browser cookies for request URLs; default false." })),
			cookieMode: Type.Optional(Type.String({ description: "merge | replace | preserve for browser cookie binding; default merge." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, params, ctx, {
				toolName: "browser_sqlmap_bridge",
				command: "web.sqlmap_bridge",
				fallbackPrefix: "sqlmap-bridge",
				defaultTimeoutMs: 120_000,
				includeCookieProvider: true,
				run: runSqlmapBridge,
				details: (result) => ({ runCount: result.runCount, findingCount: result.findingCount, vulnerableRunCount: result.vulnerableRunCount }),
				distill: summarizeSqlmapBridgeData,
			});
		},
	});
}

export function registerNucleiBridgeTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_nuclei_bridge",
		label: "Browser Nuclei Bridge",
		description: "Run template and fingerprint automation through a nuclei bridge from scoped URL, raw, captured, or HAR request inputs with structured matches and artifacts.",
		promptSnippet: "Run a Pi-native nuclei bridge for deep template, fingerprint, and CVE-style automation with structured matches and artifacts.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_nuclei_bridge for deep template and fingerprint sweeps from explicit scope and template selectors; keep bounded target scope explicit and retain request/stdout/stderr artifacts for follow-up evidence."],
		parameters: Type.Object({
			tabId: optionalTargetTabId("Target tab id used when bindBrowserSession needs browser cookies; otherwise omitted is allowed."),
			detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
			outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
			timeoutMs: Type.Optional(Type.Number({ description: "Process timeout in milliseconds; default 120000." })),
			maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
			nucleiPath: Type.Optional(Type.String({ description: "Optional nuclei executable or launcher command. Default auto-detects nuclei in PATH." })),
			nucleiArgs: Type.Optional(Type.Array(Type.String(), { description: "Optional launcher arguments prepended before generated nuclei flags." })),
			extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Additional nuclei CLI arguments appended after generated flags." })),
			url: Type.Optional(Type.String({ description: "Absolute URL or host/path target. Required unless rawRequest, request, requests, sequence, or HAR input supplies a target." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Bounded list of target URLs or hosts." })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Optional paths resolved against each target URL before nuclei replay." })),
			baseUrl: Type.Optional(Type.String({ description: "Base URL for relative raw request targets." })),
			rawRequest: Type.Optional(Type.String({ description: "Raw HTTP request text used as the nuclei request template." })),
			request: Type.Optional(Type.Any({ description: "Captured request-like object from browser_network/HAR." })),
			har: Type.Optional(Type.Any({ description: "HAR object; selected entries are replayed as nuclei bridge targets." })),
			harPath: Type.Optional(Type.String({ description: "Local HAR JSON file path; selected entries are replayed as nuclei bridge targets." })),
			harEntryIndex: Type.Optional(Type.Number({ description: "Zero-based HAR entry index to replay." })),
			harUrlPattern: Type.Optional(Type.String({ description: "Bounded safe-regex or substring filter for HAR request URLs; unsafe regex falls back to substring and candidate entries are capped." })),
			harMaxEntries: Type.Optional(Type.Number({ description: "Maximum HAR entries to replay; default 20, hard-capped at 100." })),
			requests: Type.Optional(Type.Array(Type.Any(), { description: "Request sequence entries: raw request strings, captured requests, HAR entries, or replay option objects. Each selected entry is sent to nuclei as a separate target." })),
			sequence: Type.Optional(Type.Array(Type.Any(), { description: "Alias for requests; each selected entry is sent to nuclei as a separate target." })),
			method: Type.Optional(Type.String({ description: "Override HTTP method." })),
			headers: Type.Optional(Type.Any({ description: "Headers to merge or override on the template." })),
			body: Type.Optional(Type.String({ description: "Text request body override." })),
			bodyBase64: Type.Optional(Type.String({ description: "Base64 request body override for binary-ish payloads." })),
			mutations: Type.Optional(Type.Any({ description: "Optional base mutation object with url, method, headers, body, or bodyBase64." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
			templatePaths: Type.Optional(Type.Array(Type.String(), { description: "Local nuclei template file or directory paths passed via -t." })),
			workflowPaths: Type.Optional(Type.Array(Type.String(), { description: "Local nuclei workflow file or directory paths passed via -w." })),
			templateIds: Type.Optional(Type.Any({ description: "Optional nuclei template ids passed via -id." })),
			tags: Type.Optional(Type.Any({ description: "Optional nuclei tag selector list passed via -tags." })),
			excludeTags: Type.Optional(Type.Any({ description: "Optional nuclei exclude-tag selector list passed via -etags." })),
			severities: Type.Optional(Type.Any({ description: "Optional nuclei severity selector list passed via -severity." })),
			authors: Type.Optional(Type.Any({ description: "Optional nuclei author selector list passed via -author." })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "nuclei per-request timeout seconds; default derived from timeoutMs." })),
			retries: Type.Optional(Type.Number({ description: "nuclei retry count; default 1." })),
			rateLimitPerSecond: Type.Optional(Type.Number({ description: "nuclei request rate cap per second via -rl; default unlimited." })),
			concurrency: Type.Optional(Type.Number({ description: "nuclei concurrency via -c; default 10, clamped to 1-100." })),
			bulkSize: Type.Optional(Type.Number({ description: "nuclei bulk size via -bs; default 10, clamped to 1-100." })),
			followRedirects: Type.Optional(Type.Boolean({ description: "Follow redirects; default false." })),
			maxRedirects: Type.Optional(Type.Number({ description: "Maximum redirects when followRedirects is true; default 3." })),
			bindBrowserSession: Type.Optional(Type.Boolean({ description: "Merge browser cookies for request URLs; default false." })),
			cookieMode: Type.Optional(Type.String({ description: "merge | replace | preserve for browser cookie binding; default merge." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, params, ctx, {
				toolName: "browser_nuclei_bridge",
				command: "web.nuclei_bridge",
				fallbackPrefix: "nuclei-bridge",
				defaultTimeoutMs: 120_000,
				includeCookieProvider: true,
				augmentParams: (current) => ({ followRedirects: resolveBooleanParam(current.followRedirects, false) }),
				run: runNucleiBridge,
				details: (result) => ({ runCount: result.runCount, matchCount: result.matchCount, matchedRunCount: result.matchedRunCount }),
				distill: summarizeNucleiBridgeData,
			});
		},
	});
}

export function registerTemplateCheckTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_template_check",
		label: "Browser Template Check",
		description: "Run template, configuration, and CVE-shaped HTTP checks against scoped targets or request templates with bounded safe-regex matcher evidence; omitting templateIds/templates/templatePath runs the small built-in exposure/API baseline.",
		promptSnippet: "Validate scoped targets or captured requests with the default built-in exposure/API baseline or explicit custom HTTP templates, bounded matchers, variables, and evidence artifacts.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_template_check with explicit templateIds/templates/templatePath when selecting checks; omitted template selectors run the small built-in exposure/API baseline. Keep target scope, maxTemplates, rate controls, bounded safe regex, and artifact evidence explicit."],
		parameters: Type.Object({
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Single target URL or host. Host-only input uses defaultScheme." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Bounded list of target URLs or hosts." })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Optional paths to resolve against each target URL before template expansion." })),
			rawRequest: Type.Optional(Type.String({ description: "Raw HTTP request text used as the base request template." })),
			request: Type.Optional(Type.Any({ description: "Captured request-like object from browser_network/HAR." })),
			method: Type.Optional(Type.String({ description: "Default HTTP method; template method overrides it." })),
			headers: Type.Optional(Type.Any({ description: "Base request headers; template headers merge over them." })),
			body: Type.Optional(Type.String({ description: "Base text request body for raw/captured replay mode." })),
			bodyBase64: Type.Optional(Type.String({ description: "Base64 request body for raw/captured replay mode." })),
			mutations: Type.Optional(Type.Any({ description: "Optional base mutation object with url, method, headers, body, or bodyBase64." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
			templateIds: Type.Optional(Type.Any({ description: "Built-in template ids or tags to run. Omit templateIds/templates/templatePath to run the small built-in exposure/API baseline; use all for every built-in template." })),
			templates: Type.Optional(Type.Any({ description: "Inline custom template object or array. Fields: id, paths/url, method, headers, body, matchStatus, bounded bodyRegex, bodyIncludes, bounded headerRegex, bounded extractRegex, matchers, extractors." })),
			templatePath: Type.Optional(Type.String({ description: "Local JSON or YAML template file path containing a template object, array, or {templates}." })),
			variables: Type.Optional(Type.Any({ description: "Template variable values for {{name}} substitution." })),
			tech: Type.Optional(Type.Any({ description: "Optional technology hints retained for template selection workflows." })),
			followRedirects: Type.Optional(Type.Boolean({ description: "Follow redirects; default false." })),
			maxRedirects: Type.Optional(Type.Number({ description: "Maximum redirects when followRedirects is true; default 3." })),
			maxTemplates: Type.Optional(Type.Number({ description: "Maximum templates to run; default 100, hard-capped at 1000." })),
			rateLimitPerSecond: Type.Optional(Type.Number({ description: "Sequential request rate cap per second; default unlimited sequential." })),
			bindBrowserSession: Type.Optional(Type.Boolean({ description: "Merge browser cookies for request URLs; default false." })),
			cookieMode: Type.Optional(Type.String({ description: "merge | replace | preserve for browser cookie binding; default merge." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, params, ctx, {
				toolName: "browser_template_check",
				command: "web.template_check",
				fallbackPrefix: "template-check",
				defaultMaxBodyBytes: 128_000,
				includeCookieProvider: true,
				augmentParams: (current) => ({ followRedirects: resolveBooleanParam(current.followRedirects, false) }),
				run: runTemplateCheck,
				details: (result) => ({ requestCount: result.requestCount, matchedCount: result.matchedCount }),
				distill: summarizeTemplateCheckData,
			});
		},
	});
}

export function registerCallbackOastTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_callback_oast",
		label: "Browser Callback OAST",
		description: "Run local HTTP/HTTPS/DNS callback listeners with correlation IDs, trigger helpers, persisted events, and external callback metadata.",
		promptSnippet: "Start, inspect, trigger, collect, clear, or stop callback listener sessions for SSRF, blind injection, and deserialization evidence.",
		promptGuidelines: ["Use browser_callback_oast to create callback URLs/hosts, trigger and collect correlated HTTP/HTTPS/DNS callbacks, keep maxEvents/maxBodyBytes bounded, and archive persisted callback evidence artifacts."],
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "start | list | status | collect | clear | trigger | stop. Default start." })),
			sessionId: Type.Optional(Type.String({ description: "Logical callback listener session id. Required for status/collect/clear/trigger/stop." })),
			listenHost: Type.Optional(Type.String({ description: "Local listen host; default 127.0.0.1. Use 0.0.0.0 to listen on all interfaces." })),
			port: Type.Optional(Type.Number({ description: "Local HTTP listen port; default 0 chooses an ephemeral port." })),
			publicBaseUrl: Type.Optional(Type.String({ description: "Optional externally reachable HTTP base URL to combine with the generated callback path." })),
			publicHttpsBaseUrl: Type.Optional(Type.String({ description: "Optional externally reachable HTTPS base URL to combine with the generated callback path." })),
			basePath: Type.Optional(Type.String({ description: "Callback path template. {{correlationId}} is replaced; default /__pi_oast/{{correlationId}}." })),
			correlationId: Type.Optional(Type.String({ description: "Correlation id to embed in generated callback URLs/hosts; default random." })),
			responseStatus: Type.Optional(Type.Number({ description: "HTTP/HTTPS status returned by the callback listener; default 200." })),
			responseBody: Type.Optional(Type.String({ description: "HTTP/HTTPS response body returned by the callback listener; default ok." })),
			responseHeaders: Type.Optional(Type.Any({ description: "HTTP/HTTPS response headers returned by the callback listener." })),
			enableHttps: Type.Optional(Type.Boolean({ description: "Also start a local HTTPS callback listener with a self-signed certificate." })),
			httpsPort: Type.Optional(Type.Number({ description: "Local HTTPS listen port; default 0 chooses an ephemeral port." })),
			enableDns: Type.Optional(Type.Boolean({ description: "Also start a local UDP DNS callback listener." })),
			dnsListenHost: Type.Optional(Type.String({ description: "Local DNS listen host; defaults to listenHost." })),
			dnsPort: Type.Optional(Type.Number({ description: "Local DNS listen port; default 0 chooses an ephemeral port." })),
			dnsBaseDomain: Type.Optional(Type.String({ description: "Generated DNS callback base domain used for dnsCallbackHost, e.g. oast.test." })),
			publicDnsBaseDomain: Type.Optional(Type.String({ description: "Optional externally reachable DNS base domain used for publicDnsCallbackHost." })),
			dnsResponseAddress: Type.Optional(Type.String({ description: "IPv4 address returned for A queries handled by the local DNS listener; default 127.0.0.1." })),
			externalMetadata: Type.Optional(Type.Any({ description: "Optional external tunnel/provider metadata stored with the session and returned in status/list results." })),
			mode: Type.Optional(Type.String({ description: "trigger only: http | https | dns. Default http." })),
			target: Type.Optional(Type.String({ description: "trigger only: explicit target URL or DNS name; otherwise the current session callback URL/host is used." })),
			method: Type.Optional(Type.String({ description: "trigger only: HTTP/HTTPS method; default POST." })),
			requestHeaders: Type.Optional(Type.Any({ description: "trigger only: HTTP/HTTPS request headers." })),
			body: Type.Optional(Type.String({ description: "trigger only: HTTP/HTTPS text body." })),
			bodyBase64: Type.Optional(Type.String({ description: "trigger only: HTTP/HTTPS base64 body for binary-ish payloads." })),
			queryName: Type.Optional(Type.String({ description: "trigger only: DNS query name override; aliases target for dns mode." })),
			queryType: Type.Optional(Type.String({ description: "trigger only: DNS query type; default A." })),
			resolverHost: Type.Optional(Type.String({ description: "trigger only: DNS resolver host override; defaults to the current session DNS listener host." })),
			resolverPort: Type.Optional(Type.Number({ description: "trigger only: DNS resolver port override; defaults to the current session DNS listener port." })),
			rejectUnauthorized: Type.Optional(Type.Boolean({ description: "trigger only: HTTPS certificate verification flag. Default false for the local self-signed listener." })),
			maxEvents: Type.Optional(Type.Number({ description: "Maximum persisted callback events per session; default 1000, hard-capped at 100000." })),
			maxBodyBytes: Type.Optional(Type.Number({ description: "Maximum request body bytes stored per callback event; default 64000." })),
			afterSeq: Type.Optional(Type.Number({ description: "collect only: return callback events with seq greater than this value." })),
			timeoutMs: Type.Optional(Type.Number({ description: "trigger only: wait timeout in milliseconds for the triggered callback event to be persisted." })),
			detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
			outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
			maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, params, ctx, {
				toolName: "browser_callback_oast",
				command: "web.callback_oast",
				fallbackPrefix: "callback-oast",
				includeTimeout: true,
				includeCookieProvider: false,
				run: runCallbackOast,
				details: (result) => ({ action: result.action, sessionId: result.sessionId, eventCount: result.eventCount ?? result.count }),
				distill: summarizeCallbackOastData,
			});
		},
	});
}

export function registerCookieAnalyzeTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_cookie_analyze",
		label: "Browser Cookie Analyze",
		description: "Analyze Cookie, Set-Cookie, JWT, JWE, PASETO, and signed or encrypted session values with decoding, signature/decryption checks, claim mutation generation, claim replay validation, browser-session cookie binding, and Rails AES-GCM/AES-CBC/direct-key evidence.",
		promptSnippet: "Analyze cookies/JWT/session values, verify signing or decryption candidates, generate claim-mutation tokens, validate claim replays, and store structured evidence.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_cookie_analyze for cookie/JWT/JWE/PASETO/session decoding, signature or decryption candidate checks, Rails AES-GCM/AES-CBC/direct-key evidence, claim mutation generation, browser-session cookie collection, bounded claim replay validation, and outputPath artifacts for follow-up evidence."],
		parameters: Type.Object({
			tabId: optionalTargetTabId("Target tab id used when bindBrowserSession needs browser cookies; otherwise omitted is allowed."),
			detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
			outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
			timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds for browser-session cookie collection." })),
			maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
			url: Type.Optional(Type.String({ description: "URL used when bindBrowserSession collects browser cookies." })),
			cookie: Type.Optional(Type.String({ description: "Single Cookie header, Set-Cookie line, or name=value string." })),
			cookies: Type.Optional(Type.Any({ description: "Cookie header string, array of strings, or browser-cookie-like objects with name/value." })),
			setCookie: Type.Optional(Type.String({ description: "Single Set-Cookie header line." })),
			setCookies: Type.Optional(Type.Any({ description: "Set-Cookie header string or array of Set-Cookie lines." })),
			jwt: Type.Optional(Type.String({ description: "Single JWT value." })),
			jwts: Type.Optional(Type.Array(Type.String(), { description: "JWT values." })),
			values: Type.Optional(Type.Array(Type.String(), { description: "Raw cookie/session values to analyze." })),
			secretCandidates: Type.Optional(Type.Array(Type.String(), { description: "HMAC secret candidates for HS256/HS384/HS512 verification." })),
			secrets: Type.Optional(Type.Array(Type.String(), { description: "Alias for secretCandidates." })),
			wordlist: Type.Optional(Type.Array(Type.String(), { description: "Inline HMAC secret candidate wordlist." })),
			wordlistPath: Type.Optional(Type.String({ description: "Local HMAC secret candidate wordlist file path; one entry per line." })),
			maxSecretCandidates: Type.Optional(Type.Number({ description: "Maximum HMAC secret candidates to test; default 10000, hard-capped at 100000." })),
			claimMutations: Type.Optional(Type.Any({ description: "Claims to merge into decoded JWT/JWE/session payloads when generating a mutated token." })),
			claimReplay: Type.Optional(Type.Any({ description: "Optional bounded replay check for generated claim mutations. Supports url, method, headers, body/bodyBase64, cookieName, matchStatus, maxCases, followRedirects, timeoutMs, and maxBodyBytes." })),
			bindBrowserSession: Type.Optional(Type.Boolean({ description: "Collect browser cookies for url using the connected browser session; default false." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, params, ctx, {
				toolName: "browser_cookie_analyze",
				command: "web.cookie_analyze",
				fallbackPrefix: "cookie-analyze",
				includeCookieProvider: true,
				run: runCookieAnalyze,
				details: (result) => ({ inputCount: result.inputCount, tokenCount: result.tokenCount, claimReplayCount: result.claimReplayCount }),
				distill: summarizeCookieAnalyzeData,
			});
		},
	});
}

export function registerFuzzParamsTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_fuzz_params",
		label: "Browser Fuzz Params",
		description: "Fuzz query, JSON, form, multipart, and header parameters from raw/captured HTTP request templates with delta evidence and artifact output.",
		promptSnippet: "Run bounded parameter fuzzing from URL/raw/captured requests with matcher/filter controls and response evidence.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_fuzz_params from a captured or raw request template; keep param names, values, and maxCases bounded, and preserve artifact evidence for response deltas."],
		parameters: Type.Object({
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Absolute URL or host/path target. Required unless rawRequest or request supplies a URL." })),
			baseUrl: Type.Optional(Type.String({ description: "Base URL for relative raw request targets." })),
			rawRequest: Type.Optional(Type.String({ description: "Raw HTTP request text used as the fuzz template." })),
			request: Type.Optional(Type.Any({ description: "Captured request-like object from browser_network/HAR." })),
			method: Type.Optional(Type.String({ description: "Override HTTP method." })),
			headers: Type.Optional(Type.Any({ description: "Headers to merge or override on the template." })),
			body: Type.Optional(Type.String({ description: "Text request body override." })),
			bodyBase64: Type.Optional(Type.String({ description: "Base64 request body override for binary-ish payloads." })),
			mutations: Type.Optional(Type.Any({ description: "Optional base mutation object with url, method, headers, body, bodyBase64, or multipart." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
			locations: Type.Optional(Type.Any({ description: "Parameter locations: query, json, form, multipart, header, or all. Default inferred from template." })),
			paramNames: Type.Optional(Type.Array(Type.String(), { description: "Parameter names to fuzz. If omitted, existing template params are used." })),
			values: Type.Optional(Type.Array(Type.String(), { description: "Candidate values to assign to each parameter." })),
			jsonValues: Type.Optional(Type.Any({ description: "JSON values for JSON or multipart parameter fuzzing; multipart values may use arrays for repeated same-name parts, nested {multipart:{...}} descriptors, or file objects like {filename, contentType, content, bodyBase64}." })),
			words: Type.Optional(Type.Array(Type.String(), { description: "Alias for values." })),
			wordlist: Type.Optional(Type.Array(Type.String(), { description: "Inline wordlist entries; aliases values." })),
			wordlistPath: Type.Optional(Type.String({ description: "Optional local wordlist file path; one entry per line." })),
			operations: Type.Optional(Type.Array(Type.String(), { description: "Parameter operations: set, add, delete. Default set." })),
			contentTypeVariants: Type.Optional(Type.Array(Type.String(), { description: "Multipart Content-Type variants: normal, quoted, missing-boundary, mismatch." })),
			followRedirects: Type.Optional(Type.Boolean({ description: "Follow redirects; default false for stable matching." })),
			maxRedirects: Type.Optional(Type.Number({ description: "Maximum redirects when followRedirects is true; default 3." })),
			matchStatus: Type.Optional(Type.Any({ description: "Optional status matcher list/string, e.g. [200,201,302]." })),
			filterStatus: Type.Optional(Type.Any({ description: "Optional status filter list/string, e.g. [403,404]." })),
			filterBodyBytes: Type.Optional(Type.Any({ description: "Optional body byte-size filter list/string for noisy baselines." })),
			maxCases: Type.Optional(Type.Number({ description: "Maximum location*param*operation*value cases; default 500, hard-capped at 5000." })),
			rateLimitPerSecond: Type.Optional(Type.Number({ description: "Sequential request rate cap per second; default unlimited sequential." })),
			bindBrowserSession: Type.Optional(Type.Boolean({ description: "Merge browser cookies for request URLs; default false." })),
			cookieMode: Type.Optional(Type.String({ description: "merge | replace | preserve for browser cookie binding; default merge." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, params, ctx, {
				toolName: "browser_fuzz_params",
				command: "web.fuzz_params",
				fallbackPrefix: "fuzz-params",
				defaultMaxBodyBytes: 128_000,
				includeCookieProvider: true,
				augmentParams: (current) => ({ followRedirects: resolveBooleanParam(current.followRedirects, false) }),
				run: runFuzzParams,
				details: (result) => ({ caseCount: result.caseCount, matchedCount: result.matchedCount }),
				distill: summarizeFuzzParamsData,
			});
		},
	});
}

export function registerHttpReplayTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_http_replay",
		label: "Browser HTTP Replay",
		description: "Replay raw or structured HTTP requests with method/header/body mutation, HAR dependency graph evidence, artifact output, and optional browser-session cookie binding.",
		promptSnippet: "Replay captured/raw HTTP requests, mutate method/headers/body, and store bounded response evidence artifacts.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_http_replay for focused bounded request variants from captured evidence; keep mutations narrow, preserve artifacts, and verify response deltas."],
		parameters: Type.Object({
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Absolute URL or host/path target. Required unless rawRequest or request supplies a URL." })),
			baseUrl: Type.Optional(Type.String({ description: "Base URL for relative raw request targets." })),
			rawRequest: Type.Optional(Type.String({ description: "Raw HTTP request text: request line, headers, blank line, optional body." })),
			request: Type.Optional(Type.Any({ description: "Captured request-like object from browser_network/HAR; url/method/headers/postData are recognized." })),
			har: Type.Optional(Type.Any({ description: "HAR object; selected entries are replayed as a request sequence." })),
			harPath: Type.Optional(Type.String({ description: "Local HAR JSON file path; selected entries are replayed as a request sequence." })),
			harEntryIndex: Type.Optional(Type.Number({ description: "Zero-based HAR entry index to replay." })),
			harUrlPattern: Type.Optional(Type.String({ description: "Bounded safe-regex or substring filter for HAR request URLs; unsafe regex falls back to substring and candidate entries are capped." })),
			harMaxEntries: Type.Optional(Type.Number({ description: "Maximum HAR entries to replay; default 20, hard-capped at 100." })),
			requests: Type.Optional(Type.Array(Type.Any(), { description: "Request sequence entries: raw request strings, captured requests, HAR entries, or replay option objects. Step objects may include variables, variableScope, and extractors/captures for later-step injection." })),
			sequence: Type.Optional(Type.Array(Type.Any(), { description: "Alias for requests; replayed sequentially with optional step-variable extraction/injection." })),
			multipart: Type.Optional(Type.Any({ description: "Multipart body builder: fields object/array and files with inline content/bodyBase64. fileFieldMatrix can expand focused multipart file-field replay cases from one template file." })),
			compareBaseline: Type.Optional(Type.Boolean({ description: "When true, replay an unmutated baseline request and include response delta evidence." })),
			sequenceCookies: Type.Optional(Type.Boolean({ description: "Carry Set-Cookie values between sequence steps; default true for sequences." })),
			continueOnError: Type.Optional(Type.Boolean({ description: "Continue sequence replay after a failed step; default false." })),
			variables: Type.Optional(Type.Any({ description: "Initial replay variables for {{name}} injection across raw/url/header/body/multipart strings." })),
			variableScope: Type.Optional(Type.String({ description: "Captured replay variable scope: sequence | step. Default sequence; step objects may override." })),
			method: Type.Optional(Type.String({ description: "Override HTTP method." })),
			headers: Type.Optional(Type.Any({ description: "Headers to merge or override." })),
			body: Type.Optional(Type.String({ description: "Text request body override." })),
			bodyBase64: Type.Optional(Type.String({ description: "Base64 request body override for binary-ish payloads." })),
			mutations: Type.Optional(Type.Any({ description: "Optional mutation object with url, method, headers, body, bodyBase64, or multipart." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
			followRedirects: Type.Optional(Type.Boolean({ description: "Follow redirects; default false for replay determinism." })),
			maxRedirects: Type.Optional(Type.Number({ description: "Maximum redirects when followRedirects is true." })),
			bindBrowserSession: Type.Optional(Type.Boolean({ description: "Merge browser cookies for the request URL; default false." })),
			cookieMode: Type.Optional(Type.String({ description: "merge | replace | preserve for browser cookie binding; default merge." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, params, ctx, {
				toolName: "browser_http_replay",
				command: "web.http_replay",
				fallbackPrefix: "http-replay",
				defaultMaxBodyBytes: 256_000,
				includeCookieProvider: true,
				augmentParams: (current) => ({ followRedirects: resolveBooleanParam(current.followRedirects, false) }),
				run: runHttpReplay,
				details: (result) => ({ status: result.response?.status, stepCount: result.stepCount }),
				distill: summarizeHttpReplayData,
			});
		},
	});
}
