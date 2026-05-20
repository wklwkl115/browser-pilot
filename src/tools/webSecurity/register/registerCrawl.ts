import { Type } from "typebox";
import { summarizeBrowserCrawlData } from "../../summaries/index";
import { runBrowserCrawl } from "../../webSecurityCore";
import { TAB_SCOPED_TOOL_GUIDELINE, executeWebSecurityToolShell, sharedWebSecurityParams, normalizeWebSecurityToolParams, type CrawlToolParams } from "./shared";
import type { ToolRegistrarContext } from "../../toolShared";

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
			return executeWebSecurityToolShell(ensureStarted, normalizeWebSecurityToolParams<CrawlToolParams>(params), ctx, {
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
