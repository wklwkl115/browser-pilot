import { Type } from "typebox";
import { summarizeBrowserCrawlData, summarizeWebReconProbeData } from "../../summaries/index";
import { runBrowserCrawl, runReconProbe } from "../../webSecurityCore";
import { TAB_SCOPED_TOOL_GUIDELINE, browserCookieBindingParams, executeWebSecurityToolShell, maxDepthParam, maxPagesParam, redirectControlParams, resolveBooleanParam, sharedWebSecurityParams, normalizeWebSecurityToolParams, type WebSecuritySharedToolParams } from "./shared";
import type { ToolRegistrarContext } from "../../toolShared";
import type { RawCrawlOptions, RawProbeOptions } from "../shared/types";

type CrawlUnifiedToolParams = WebSecuritySharedToolParams & RawCrawlOptions & RawProbeOptions & { action?: unknown };

export function registerCrawlTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_crawl",
		label: "Browser Crawl",
		description: "Collect scoped Web metadata through bounded fingerprint probing or recursive crawl for links, forms, known files, JS endpoints, OpenAPI/GraphQL, source maps, service workers, and response evidence.",
		promptSnippet: "Collect scoped Web metadata through fingerprint probing or recursive crawl with structured evidence artifacts.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_crawl with explicit scope and bounds. action:crawl is the default recursive discovery mode; action:fingerprint is the smaller baseline mode before fuzzing or deeper checks."],
		parameters: Type.Object({
			action: Type.Optional(Type.Union([Type.Literal("crawl"), Type.Literal("fingerprint")], { description: "Collection mode (default: crawl). crawl: recursive discovery; fingerprint: single-shot metadata." })),
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Single seed URL or host. Host-only input uses defaultScheme." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Bounded list of seed URLs or hosts." })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Optional seed paths to resolve against each target URL." })),
			headers: Type.Optional(Type.Any({ description: "Optional request headers object." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
			method: Type.Optional(Type.String({ description: "fingerprint mode only: HTTP method for probing; default GET." })),
			ports: Type.Optional(Type.Array(Type.Number(), { description: "fingerprint mode only: optional ports to apply to each target URL." })),
			schemes: Type.Optional(Type.Array(Type.String(), { description: "fingerprint mode only: optional schemes to expand, e.g. [http, https]." })),
			includeFaviconHash: Type.Optional(Type.Boolean({ description: "fingerprint mode only: fetch /favicon.ico for each final origin and include favicon hash metadata; default false." })),
			includeTlsCertificate: Type.Optional(Type.Boolean({ description: "fingerprint mode only: inspect HTTPS peer certificate metadata for final URLs; default false." })),
			...redirectControlParams({
				followRedirectsDescription: "fingerprint mode: follow redirects and record the chain; default true. crawl mode: internal fetch follows redirects for crawl collection.",
				maxRedirectsDescription: "fingerprint mode: maximum redirects per URL; default 5 when followRedirects is true.",
			}),
			...maxDepthParam("crawl mode only: maximum crawl depth; default 2, hard-capped at 5."),
			...maxPagesParam("crawl mode only: maximum pages/resources fetched; default 50, hard-capped at 500."),
			sameOrigin: Type.Optional(Type.Boolean({ description: "crawl mode only: stay within seed origins; default true." })),
			knownFiles: Type.Optional(Type.String({ description: "crawl mode only: none | robotstxt | sitemapxml | all. Adds common known-file seeds." })),
			extractJs: Type.Optional(Type.Boolean({ description: "crawl mode only: extract JS endpoint hints and crawl same-origin script files; default true." })),
			activeGraphqlIntrospection: Type.Optional(Type.Boolean({ description: "crawl mode only: actively POST a standard GraphQL introspection query only to URLs/content-types that look like GraphQL; default true. Set false for passive-only GraphQL parsing." })),
			...browserCookieBindingParams("Inject browser cookies for crawl/fingerprint requests into outgoing HTTP request headers; default false.", { includeCookieMode: false }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = normalizeWebSecurityToolParams<CrawlUnifiedToolParams>(params);
			const action = String(current.action || "crawl").toLowerCase() === "fingerprint" ? "fingerprint" : "crawl";
			if (action === "fingerprint") {
				return executeWebSecurityToolShell(ensureStarted, current, ctx, {
					toolName: "browser_crawl",
					command: "web.recon_probe",
					fallbackPrefix: "crawl-fingerprint",
					defaultMaxBodyBytes: 256_000,
					includeCookieProvider: true,
					augmentParams: (value) => ({ followRedirects: resolveBooleanParam(value.followRedirects, true) }),
					run: runReconProbe,
					details: (result) => ({ action, count: result.count }),
					distill: summarizeWebReconProbeData,
				}, _onUpdate);
			}
			return executeWebSecurityToolShell(ensureStarted, current, ctx, {
				toolName: "browser_crawl",
				command: "web.crawl",
				fallbackPrefix: "crawl",
				defaultMaxBodyBytes: 256_000,
				includeCookieProvider: true,
				run: runBrowserCrawl,
				details: (result) => ({ action, pageCount: result.pageCount, endpointCount: result.endpointCount }),
				distill: summarizeBrowserCrawlData,
			}, _onUpdate);
		},
	});
}
