import { Type } from "typebox";
import { summarizeHttpReplayData } from "../../summaries/index.js";
import { runHttpReplay } from "../browserNative/httpReplay.js";
import { TAB_SCOPED_TOOL_GUIDELINE, browserCookieBindingParams, executeWebSecurityToolShell, harReplayParams, requestSequenceParams, resolveBooleanParam, sharedWebSecurityParams, normalizeWebSecurityToolParams, validateHttpReplayParams, headerRecordParam, type HttpReplayToolParams } from "./shared.js";
import type { CommandRegistrarContext } from "../../commandShared.js";
import { strictCommandParameters } from "../../commandShared.js";
import { validateOptionalParams } from "../../validationMiddleware.js";
import { HttpRequestSchema, MultipartSchema, FuzzMutationsSchema, VariablesSchema } from "../../../validation/schemas.js";

export function defineHttpReplayCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	commands.define({
		name: "browser_http_replay",
		label: "Browser HTTP Replay",
		description: "Replay raw or structured HTTP requests with method/header/body mutation, HAR dependency graph evidence, artifact output, and optional browser-session cookie injection.",
		promptSnippet: "Replay captured/raw HTTP requests, mutate method/headers/body, and store bounded response evidence artifacts.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_http_replay for focused bounded request variants from captured evidence; keep mutations narrow, preserve artifacts, and verify response deltas.", "HTTP target execution uses Node.js fetch directly, not the browser bridge; requests originate from the Node.js process with optional browser-session cookie injection."],
		parameters: strictCommandParameters({
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Absolute URL or host/path target. Required unless rawRequest or request supplies a URL." })),
			baseUrl: Type.Optional(Type.String({ description: "Base URL for relative raw request targets." })),
			rawRequest: Type.Optional(Type.String({ description: "Raw HTTP request text: request line, headers, blank line, optional body." })),
			request: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Captured request-like object from browser_network/HAR; url/method/headers/postData are recognized." })),
			...harReplayParams({
				harDescription: "HAR object; selected entries are replayed as a request sequence.",
				harPathDescription: "Local HAR JSON file path; selected entries are replayed as a request sequence.",
			}),
			...requestSequenceParams({
				requestsDescription: "Request sequence entries: raw request strings, captured requests, HAR entries, or replay option objects. Step objects may include variables, variableScope, and extractors/captures for later-step injection.",
				sequenceDescription: "Alias for requests; replayed sequentially with optional step-variable extraction/injection.",
			}),
			multipart: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Multipart body builder: fields object/array and files with inline content/bodyBase64. fileFieldMatrix can expand focused multipart file-field replay cases from one template file." })),
			compareBaseline: Type.Optional(Type.Boolean({ description: "When true, replay an unmutated baseline request and include response delta evidence." })),
			sequenceCookies: Type.Optional(Type.Boolean({ description: "Carry Set-Cookie values between sequence steps; default true for sequences." })),
			continueOnError: Type.Optional(Type.Boolean({ description: "Continue sequence replay after a failed step; default false." })),
			variables: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]), { description: "Initial replay variables for {{name}} injection across raw/url/header/body/multipart strings." })),
			variableScope: Type.Optional(Type.String({ description: "Captured replay variable scope: sequence | step. Default sequence; step objects may override." })),
			method: Type.Optional(Type.String({ description: "Override HTTP method." })),
			headers: headerRecordParam("Headers to merge or override."),
			body: Type.Optional(Type.String({ description: "Text request body override." })),
			bodyBase64: Type.Optional(Type.String({ description: "Base64 request body override for binary-ish payloads." })),
			mutations: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Optional mutation object with url, method, headers, body, bodyBase64, or multipart." })),
			...browserCookieBindingParams("Merge browser cookies into outgoing HTTP request headers for the request URL; default false."),
			reflectCsrf: Type.Optional(Type.Boolean({ description: "When bindBrowserSession is true, reflect a double-submit CSRF cookie (e.g. XSRF-TOKEN) into its matching request header; default true. Set false to send the bound session without a CSRF header (e.g. to test CSRF protection)." })),
			csrfCookie: Type.Optional(Type.String({ description: "Exact CSRF cookie name to reflect, overriding auto-detection (xsrf-token/csrf-token/csrftoken/_csrf/csrf_token)." })),
			csrfHeader: Type.Optional(Type.String({ description: "Request header name to carry the reflected CSRF token, overriding the default (XSRF-TOKEN→X-XSRF-TOKEN, else X-CSRF-Token)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = normalizeWebSecurityToolParams<HttpReplayToolParams>(params);
			validateHttpReplayParams(current);

			// Runtime validation for structured object parameters
			if (current.request !== undefined) {
				validateOptionalParams(HttpRequestSchema, current.request);
			}
			if (current.multipart !== undefined) {
				validateOptionalParams(MultipartSchema, current.multipart);
			}
			if (current.mutations !== undefined) {
				validateOptionalParams(FuzzMutationsSchema, current.mutations);
			}
			if (current.variables !== undefined) {
				validateOptionalParams(VariablesSchema, current.variables);
			}

			return executeWebSecurityToolShell(ensureStarted, current, ctx, {
				commandName: "browser_http_replay",
				command: "web.http_replay",
				fallbackPrefix: "http-replay",
				defaultMaxBodyBytes: 256_000,
				includeCookieProvider: true,
				augmentParams: (value) => ({ followRedirects: resolveBooleanParam(value.followRedirects, false) }),
				run: runHttpReplay,
				details: (result) => ({
					status: "response" in result && result.response && typeof result.response === "object" ? (result.response as { status?: unknown }).status : undefined,
					stepCount: "stepCount" in result ? result.stepCount : undefined,
				}),
				distill: summarizeHttpReplayData,
			}, _onUpdate);
		},
	});
}
