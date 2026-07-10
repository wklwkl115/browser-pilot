import { Type } from "typebox";
import { summarizeNucleiBridgeData, summarizeTemplateCheckData } from "../../summaries/index.js";
import { runNucleiBridge } from "../bridges/nucleiBridge.js";
import { runTemplateCheck } from "../browserNative/templateCheck.js";
import { TAB_SCOPED_TOOL_GUIDELINE, browserCookieBindingParams, executeWebSecurityToolShell, harReplayParams, requestSequenceParams, resolveBooleanParam, sharedWebSecurityBrowserSessionParams, normalizeWebSecurityToolParams, validateTemplateParams, headerRecordParam, stringOrStringArrayParam, type WebSecuritySharedToolParams } from "./shared.js";
import type { CommandRegistrarContext } from "../../commandShared.js";
import { strictCommandParameters } from "../../commandShared.js";
import type { RawNucleiBridgeOptions, RawTemplateCheckOptions } from "../shared/types.js";
import { validateOptionalParams } from "../../validationMiddleware.js";
import { HttpRequestSchema, FuzzMutationsSchema, TemplatesInputSchema, VariablesSchema, TechHintsSchema } from "../../../validation/schemas.js";

type TemplateToolParams = WebSecuritySharedToolParams & RawTemplateCheckOptions & RawNucleiBridgeOptions & { engine?: unknown };

export function defineTemplateCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	commands.define({
		name: "browser_template",
		label: "Browser Template",
		description: "Run bounded built-in/custom HTTP template checks or mature nuclei template automation against scoped targets or request templates with structured matches and artifacts.",
		promptSnippet: "Run bounded built-in/custom HTTP template checks or mature nuclei template automation with structured evidence.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_template with explicit scope. engine:builtin is the default small exposure/API baseline or custom template path; engine:nuclei is the deeper mature template path.", "HTTP target execution uses Node.js fetch directly, not the browser bridge; requests originate from the Node.js process with optional browser-session cookie injection."],
		parameters: strictCommandParameters({
			engine: Type.Optional(Type.Union([Type.Literal("builtin"), Type.Literal("nuclei")], { description: "Template engine (default: builtin). builtin: lightweight matchers; nuclei: external binary." })),
			...sharedWebSecurityBrowserSessionParams("Process timeout in milliseconds; default 120000 for engine:nuclei, per-request timeout for engine:builtin."),
			allowPrivateTargets: Type.Optional(Type.Boolean({ description: "Allow requests to private, link-local, or cloud-metadata-adjacent targets. Default false; loopback remains allowed for local fixtures." })),
			url: Type.Optional(Type.String({ description: "Single target URL or host. Host-only input uses defaultScheme." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Bounded list of target URLs or hosts." })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Optional paths to resolve against each target URL before template expansion or nuclei replay." })),
			rawRequest: Type.Optional(Type.String({ description: "Raw HTTP request text used as the base request or nuclei request template." })),
			request: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Captured request-like object from browser_network/HAR." })),
			method: Type.Optional(Type.String({ description: "Default HTTP method; template method overrides it or request override for nuclei." })),
			headers: headerRecordParam("Base request headers; template headers merge over them or nuclei replay override."),
			body: Type.Optional(Type.String({ description: "Base text request body for raw/captured replay mode." })),
			bodyBase64: Type.Optional(Type.String({ description: "Base64 request body for raw/captured replay mode." })),
			mutations: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Optional base mutation object with url, method, headers, body, or bodyBase64." })),
			templateIds: stringOrStringArrayParam("builtin mode: built-in template ids or tags to run. Omit templateIds/templates/templatePath to run the small built-in exposure/API baseline; use all for every built-in template. nuclei mode: optional nuclei template ids passed via -id."),
			templates: Type.Optional(Type.Object({}, { additionalProperties: true, description: "builtin mode only: inline custom template object or array. Fields: id, paths/url, method, headers, body, matchStatus, bounded bodyRegex, bodyIncludes, bounded headerRegex, bounded extractRegex, matchers, extractors." })),
			templatePath: Type.Optional(Type.String({ description: "builtin mode only: local JSON or YAML template file path containing a template object, array, or {templates}." })),
			variables: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]), { description: "builtin mode only: template variable values for {{name}} substitution." })),
			tech: Type.Optional(Type.Object({}, { additionalProperties: true, description: "builtin mode only: optional technology hints retained for template selection workflows." })),
			maxRequests: Type.Optional(Type.Number({ description: "builtin mode only: maximum total HTTP requests across all expanded template/target combinations; default 2000, hard-capped at 10000." })),
			nucleiPath: Type.Optional(Type.String({ description: "nuclei mode only: optional nuclei executable or launcher command. Default auto-detects nuclei in PATH." })),
			nucleiArgs: Type.Optional(Type.Array(Type.String(), { description: "nuclei mode only: optional launcher arguments prepended before generated nuclei flags." })),
			extraArgs: Type.Optional(Type.Array(Type.String(), { description: "nuclei mode only: additional nuclei CLI arguments appended after generated flags." })),
			allowLauncherOverride: Type.Optional(Type.Boolean({ description: "nuclei mode only: required when nucleiPath or BROWSER_PILOT_NUCLEI_PATH overrides the auto-detected launcher. Default false." })),
			templatePaths: Type.Optional(Type.Array(Type.String(), { description: "nuclei mode only: local nuclei template file or directory paths passed via -t." })),
			workflowPaths: Type.Optional(Type.Array(Type.String(), { description: "nuclei mode only: local nuclei workflow file or directory paths passed via -w." })),
			tags: stringOrStringArrayParam("nuclei mode only: optional nuclei tag selector list passed via -tags."),
			excludeTags: stringOrStringArrayParam("nuclei mode only: optional nuclei exclude-tag selector list passed via -etags."),
			severities: stringOrStringArrayParam("nuclei mode only: optional nuclei severity selector list passed via -severity."),
			authors: stringOrStringArrayParam("nuclei mode only: optional nuclei author selector list passed via -author."),
			...harReplayParams({
				harDescription: "nuclei mode only: HAR object; selected entries are replayed as nuclei bridge targets.",
				harPathDescription: "nuclei mode only: local HAR JSON file path; selected entries are replayed as nuclei bridge targets.",
			}),
			...requestSequenceParams({
				requestsDescription: "nuclei mode only: request sequence entries: raw request strings, captured requests, HAR entries, or replay option objects. Each selected entry is sent to nuclei as a separate target.",
				sequenceDescription: "nuclei mode only: alias for requests; each selected entry is sent to nuclei as a separate target.",
			}),
			retries: Type.Optional(Type.Number({ description: "nuclei mode only: retry count; default 1." })),
			concurrency: Type.Optional(Type.Number({ description: "nuclei mode only: concurrency via -c; default 10, clamped to 1-100." })),
			bulkSize: Type.Optional(Type.Number({ description: "nuclei mode only: bulk size via -bs; default 10, clamped to 1-100." })),
			...browserCookieBindingParams("Merge browser cookies into outgoing HTTP request headers for request URLs; default false."),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = normalizeWebSecurityToolParams<TemplateToolParams>(params);
			const engine = String(current.engine || "builtin").toLowerCase() === "nuclei" ? "nuclei" : "builtin";
			validateTemplateParams(engine, current);

			// Runtime validation for structured object parameters
			if (current.request !== undefined) {
				validateOptionalParams(HttpRequestSchema, current.request);
			}
			if (current.mutations !== undefined) {
				validateOptionalParams(FuzzMutationsSchema, current.mutations);
			}
			if (current.templates !== undefined) {
				validateOptionalParams(TemplatesInputSchema, current.templates);
			}
			if (current.variables !== undefined) {
				validateOptionalParams(VariablesSchema, current.variables);
			}
			if (current.tech !== undefined) {
				validateOptionalParams(TechHintsSchema, current.tech);
			}

			if (engine === "nuclei") {
				return executeWebSecurityToolShell(ensureStarted, current, ctx, {
					commandName: "browser_template",
					command: "web.nuclei_bridge",
					fallbackPrefix: "nuclei-bridge",
					defaultTimeoutMs: 120_000,
					includeCookieProvider: true,
					augmentParams: (value) => ({ followRedirects: resolveBooleanParam(value.followRedirects, false) }),
					run: runNucleiBridge,
					details: (result) => ({ engine: "nuclei", runCount: result.runCount, matchCount: result.matchCount, matchedRunCount: result.matchedRunCount }),
					distill: summarizeNucleiBridgeData,
				}, _onUpdate);
			}
			return executeWebSecurityToolShell(ensureStarted, current, ctx, {
				commandName: "browser_template",
				command: "web.template_check",
				fallbackPrefix: "template-check",
				defaultMaxBodyBytes: 128_000,
				includeCookieProvider: true,
				augmentParams: (value) => ({ followRedirects: resolveBooleanParam(value.followRedirects, false) }),
				run: runTemplateCheck,
				details: (result) => ({ engine: "builtin", requestCount: result.requestCount, matchedCount: result.matchedCount }),
				distill: summarizeTemplateCheckData,
			}, _onUpdate);
		},
	});
}
