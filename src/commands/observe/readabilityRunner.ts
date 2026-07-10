import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePageScriptDirect } from "../../browser-page-runtime/pageScriptEvaluation.js";
import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { compactError } from "../../utils/errors.js";
import { stableJson, truncateText } from "../../utils/json.js";
import { isRecord } from "../../utils/params.js";
import { redactSensitiveText } from "../../utils/redaction.js";

const DEFAULT_READABILITY_TIMEOUT_MS = 3_000;
const MIN_READABILITY_TIMEOUT_MS = 250;
const DEFAULT_MAX_INLINE_CHARS = 1_200;
const MAX_SAFE_INLINE_CHARS = 6_000;
const DEFAULT_MAX_CONTENT_CHARS = 120_000;
const DEFAULT_MAX_ELEMS_TO_PARSE = 8_000;
const READABILITY_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../node_modules/@mozilla/readability/Readability.js");
const READERABLE_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../node_modules/@mozilla/readability/Readability-readerable.js");
let readabilityScriptCache: string | undefined;
let readerableScriptCache: string | undefined;

export type ReadabilityProviderStatus = "executed" | "skipped" | "failed" | "degraded";

export type ReadabilitySummary = {
	provider: "readability";
	status: ReadabilityProviderStatus;
	requested: boolean;
	timedOut?: boolean;
	degraded?: boolean;
	truncated?: boolean;
	ms?: number;
	title?: string;
	byline?: string;
	excerpt?: string;
	textLength?: number;
	contentLength?: number;
	siteName?: string;
	lang?: string;
	dir?: string;
	publishedTime?: string;
	textPreview?: string;
	bounded?: { maxInlineChars: number };
	artifact?: { path: string; jsonPath: string; kind: "readability-content" };
	error?: Record<string, unknown>;
};

export type ReadabilityRunResult = {
	status: ReadabilityProviderStatus;
	summary: ReadabilitySummary;
	artifact?: Record<string, unknown>;
	failure?: {
		provider: "readability";
		code: string;
		message?: string;
		details?: Record<string, unknown>;
	};
};

type ReadabilityRunOptions = {
	requested?: boolean;
	timeoutMs?: number;
	maxInlineChars?: number;
	maxContentChars?: number;
	maxElemsToParse?: number;
	browserSessionId?: string;
	tabId?: number | string;
	artifactPath?: string;
};

type ReadabilityTextField = "title" | "byline" | "excerpt" | "siteName" | "lang" | "dir" | "publishedTime";
type ReadabilityTextFields = Partial<Record<ReadabilityTextField, string>>;
type ReadabilityFailureOptions = { timedOut?: boolean; ms?: number; details?: Record<string, unknown> };
const READABILITY_TEXT_LIMITS: ReadonlyArray<readonly [Exclude<ReadabilityTextField, "excerpt">, number]> = [["title", 240], ["byline", 160], ["siteName", 160], ["lang", 40], ["dir", 16], ["publishedTime", 80]];

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value ?? fallback); return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

function normalizedTimeoutMs(value: unknown): number { return boundedInteger(value, DEFAULT_READABILITY_TIMEOUT_MS, MIN_READABILITY_TIMEOUT_MS, DEFAULT_READABILITY_TIMEOUT_MS); }
function normalizedMaxInlineChars(value: unknown): number { return boundedInteger(value, DEFAULT_MAX_INLINE_CHARS, 120, MAX_SAFE_INLINE_CHARS); }
function normalizedMaxContentChars(value: unknown): number { return boundedInteger(value, DEFAULT_MAX_CONTENT_CHARS, 1_000, 500_000); }
function normalizedMaxElemsToParse(value: unknown): number { return boundedInteger(value, DEFAULT_MAX_ELEMS_TO_PARSE, 500, 50_000); }

function safeString(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const compact = redactSensitiveText(value.replace(/\s+/g, " ").trim());
	if (!compact) return undefined;
	return truncateText(compact, maxChars).text;
}

function stripUnsafeHtml(value: string): string {
	return value
		.replace(/<script\b[\s\S]*?<\/script>/gi, "")
		.replace(/<style\b[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
		.replace(/<template\b[\s\S]*?<\/template>/gi, "");
}

function safeArtifactContent(value: unknown): string { return typeof value === "string" ? redactSensitiveText(stripUnsafeHtml(value)) : ""; }

function normalizedArticleText(article: Record<string, unknown>, maxInlineChars: number): ReadabilityTextFields {
	const text: ReadabilityTextFields = {};
	for (const [field, maxChars] of READABILITY_TEXT_LIMITS) {
		const value = safeString(article[field], maxChars);
		if (value) text[field] = value;
	}
	const excerpt = safeString(article.excerpt, maxInlineChars);
	if (excerpt) text.excerpt = excerpt;
	return text;
}

function articleLength(article: Record<string, unknown>, lengthField: "textLength" | "contentLength", valueField: "textContent" | "content"): number | undefined {
	const length = article[lengthField], value = article[valueField];
	return typeof length === "number" ? length : typeof value === "string" ? value.length : undefined;
}

async function loadReadabilityScripts(): Promise<{ readability: string; readerable: string }> {
	readabilityScriptCache ??= await readFile(READABILITY_SCRIPT_PATH, "utf8");
	readerableScriptCache ??= await readFile(READERABLE_SCRIPT_PATH, "utf8");
	return { readability: readabilityScriptCache, readerable: readerableScriptCache };
}

function wrapCommonJsSource(source: string, globalName: string): string {
	return `(() => { const module = { exports: {} }; const exports = module.exports; ${source}\n; globalThis.${globalName} = module.exports; return module.exports; })()`;
}

function readabilityRunExpression(sources: { readability: string; readerable: string }, options: { timeoutMs: number; maxContentChars: number; maxElemsToParse: number }): string {
	return `(() => {
const options = ${stableJson(options)};
return Promise.race([
  (async () => {
    const startedAt = Date.now();
    if (typeof globalThis.Readability !== "function") {
      ${wrapCommonJsSource(sources.readability, "Readability")};
    }
    if (typeof globalThis.isProbablyReaderable !== "function") {
      ${wrapCommonJsSource(sources.readerable, "isProbablyReaderable")};
    }
    if (typeof globalThis.Readability !== "function") throw new Error("Readability did not initialize");
    const docClone = document.cloneNode(true);
    docClone.querySelectorAll("script,style,noscript,template,svg,canvas,iframe,object,embed").forEach((el) => el.remove());
    const probablyReaderable = typeof globalThis.isProbablyReaderable === "function" ? globalThis.isProbablyReaderable(docClone, { minContentLength: 80, minScore: 20 }) : undefined;
    const article = new globalThis.Readability(docClone, { maxElemsToParse: options.maxElemsToParse }).parse();
    if (!article) {
      return { ok: true, elapsedMs: Date.now() - startedAt, article: null, probablyReaderable };
    }
    const content = String(article.content || "").slice(0, options.maxContentChars);
    const textContent = String(article.textContent || "").slice(0, options.maxContentChars);
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      probablyReaderable,
      article: {
        title: article.title || "",
        byline: article.byline || "",
        excerpt: article.excerpt || "",
        textContent,
        content,
        textLength: Number(article.length || String(article.textContent || "").length || 0),
        contentLength: String(article.content || "").length,
        siteName: article.siteName || "",
        lang: article.lang || "",
        dir: article.dir || "",
        publishedTime: article.publishedTime || "",
        truncated: String(article.content || "").length > options.maxContentChars || String(article.textContent || "").length > options.maxContentChars
      }
    };
  })(),
  new Promise(resolve => setTimeout(() => resolve({ ok: false, timedOut: true, elapsedMs: options.timeoutMs, error: { code: "READABILITY_TIMEOUT", message: "Readability content provider timed out" } }), options.timeoutMs))
]);
})()`;
}

function readabilityFailure(status: "failed" | "degraded", requested: boolean, code: string, message: string, options: ReadabilityFailureOptions = {}): ReadabilityRunResult {
	const details = options.details ? { details: options.details } : {};
	return {
		status,
		summary: {
			provider: "readability", requested, status,
			...(status === "degraded" ? { degraded: true } : {}),
			...(options.timedOut ? { timedOut: true } : {}),
			...(options.ms !== undefined ? { ms: options.ms } : {}),
			error: { code, message, ...details },
		},
		failure: { provider: "readability", code, message, ...details },
	};
}

function failedReadabilityPayload(payload: unknown, requested: boolean): ReadabilityRunResult {
	const payloadRecord = isRecord(payload) ? payload : {};
	const timedOut = payloadRecord.timedOut === true;
	const error = isRecord(payloadRecord.error) ? payloadRecord.error : payloadRecord;
	const code = timedOut ? "READABILITY_TIMEOUT" : typeof error.code === "string" ? error.code : "READABILITY_FAILED";
	const message = typeof error.message === "string" ? error.message : timedOut ? "Readability content provider timed out" : "Readability content provider failed";
	return readabilityFailure(timedOut ? "degraded" : "failed", requested, code, message, { timedOut });
}

function normalizedReadabilityArticle(payload: Record<string, unknown>, article: Record<string, unknown>, options: { requested: boolean; maxInlineChars: number; artifactPath?: string }): ReadabilityRunResult {
	const elapsedMs = typeof payload.elapsedMs === "number" ? payload.elapsedMs : undefined;
	const textLength = articleLength(article, "textLength", "textContent");
	const contentLength = articleLength(article, "contentLength", "content");
	const textPreview = safeString(article.textContent, options.maxInlineChars);
	const text = normalizedArticleText(article, options.maxInlineChars);
	const truncated = article.truncated === true;
	const summary: ReadabilitySummary = {
		provider: "readability", requested: options.requested, status: truncated ? "degraded" : "executed",
		...(truncated ? { degraded: true, truncated: true } : {}),
		...(elapsedMs !== undefined ? { ms: elapsedMs } : {}),
		...text,
		...(textLength !== undefined ? { textLength } : {}),
		...(contentLength !== undefined ? { contentLength } : {}),
		...(textPreview ? { textPreview } : {}),
		bounded: { maxInlineChars: options.maxInlineChars },
		...(options.artifactPath ? { artifact: { path: options.artifactPath, jsonPath: "readability", kind: "readability-content" } } : {}),
	};
	return {
		status: summary.status,
		summary,
		artifact: {
			provider: "readability", summary,
			article: {
				title: text.title ?? "", byline: text.byline ?? "", excerpt: text.excerpt ?? "",
				textContent: safeArtifactContent(article.textContent), content: safeArtifactContent(article.content),
				textLength, contentLength,
				siteName: text.siteName ?? "", lang: text.lang ?? "", dir: text.dir ?? "", publishedTime: text.publishedTime ?? "",
			},
			bounded: { maxInlineChars: options.maxInlineChars },
		},
	};
}

function normalizeReadabilityPayload(payload: unknown, options: { requested: boolean; maxInlineChars: number; artifactPath?: string }): ReadabilityRunResult {
	if (!isRecord(payload) || payload.ok !== true) return failedReadabilityPayload(payload, options.requested);
	if (payload.article === null) {
		return readabilityFailure("degraded", options.requested, "READABILITY_NULL", "Readability returned no article", { ms: typeof payload.elapsedMs === "number" ? payload.elapsedMs : undefined });
	}
	if (!isRecord(payload.article)) return readabilityFailure("failed", options.requested, "READABILITY_FAILED", "Readability returned an invalid article");
	return normalizedReadabilityArticle(payload, payload.article, options);
}

export function shouldRunReadability(params: { content?: unknown; readability?: unknown; params?: unknown }): boolean {
	if (params.content === "readability" || params.readability === true) return true;
	const nested = isRecord(params.params) ? params.params : undefined;
	return nested?.content === "readability" || nested?.readability === true;
}

export async function runReadability(server: Pick<BrowserCommandRuntimePort, "sendCommand">, options: ReadabilityRunOptions): Promise<ReadabilityRunResult> {
	if (options.requested !== true) return { status: "skipped", summary: { provider: "readability", status: "skipped", requested: false } };
	const timeoutMs = normalizedTimeoutMs(options.timeoutMs);
	const maxInlineChars = normalizedMaxInlineChars(options.maxInlineChars);
	const maxContentChars = normalizedMaxContentChars(options.maxContentChars);
	const maxElemsToParse = normalizedMaxElemsToParse(options.maxElemsToParse);
	try {
		const script = readabilityRunExpression(await loadReadabilityScripts(), { timeoutMs, maxContentChars, maxElemsToParse });
		const result = await evaluatePageScriptDirect(server, script, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: timeoutMs + 500, name: "browser_observe.readability" });
		return normalizeReadabilityPayload(result.data, { requested: true, maxInlineChars, artifactPath: options.artifactPath });
	} catch (error) {
		const compact = compactError(error, "READABILITY_FAILED");
		const code = typeof compact.code === "string" ? compact.code : "READABILITY_FAILED";
		const message = typeof compact.message === "string" ? compact.message : "Readability content provider failed";
		return readabilityFailure("failed", true, code, message, { details: isRecord(compact.details) ? compact.details : undefined });
	}
}
