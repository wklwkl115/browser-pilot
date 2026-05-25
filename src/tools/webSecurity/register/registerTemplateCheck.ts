import { Type } from "typebox";
import { summarizeTemplateCheckData } from "../../summaries/index";
import { runTemplateCheck } from "../../webSecurityCore";
import { TAB_SCOPED_TOOL_GUIDELINE, browserCookieBindingParams, executeWebSecurityToolShell, maxTemplatesParam, rateLimitPerSecondParam, redirectControlParams, resolveBooleanParam, sharedWebSecurityParams, normalizeWebSecurityToolParams, type TemplateCheckToolParams } from "./shared";
import type { ToolRegistrarContext } from "../../toolShared";

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
			...redirectControlParams({
				followRedirectsDescription: "Follow redirects; default false.",
				maxRedirectsDescription: "Maximum redirects when followRedirects is true; default 3.",
			}),
			...maxTemplatesParam("Maximum templates to run; default 100, hard-capped at 1000."),
			...rateLimitPerSecondParam("Sequential request rate cap per second; default unlimited sequential."),
			...browserCookieBindingParams("Merge browser cookies for request URLs; default false."),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, normalizeWebSecurityToolParams<TemplateCheckToolParams>(params), ctx, {
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
