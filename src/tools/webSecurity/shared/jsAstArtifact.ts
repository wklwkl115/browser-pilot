import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { analyzeJavaScriptSource, type JsAstAnalysis, type JsAstAnalysisOptions } from "./jsAst.js";

export const JS_AST_MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const JS_LEXICAL_MAX_INPUT_BYTES = 25 * 1024 * 1024;

export type JsAstArtifactErrorCode =
	| "JS_AST_INPUT_CONFLICT"
	| "JS_AST_INPUT_REQUIRED"
	| "JS_AST_INPUT_NOT_FILE"
	| "JS_AST_INPUT_TOO_LARGE";

export class JsAstArtifactError extends Error {
	readonly code: JsAstArtifactErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: JsAstArtifactErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "JsAstArtifactError";
		this.code = code;
		this.details = details;
	}
}

export type JsAstArtifactInput = {
	path?: string;
	text?: string;
	fileName?: string;
	maxBytes?: number;
	slice?: { offset?: number; length?: number };
	analysis?: JsAstAnalysisOptions;
};

export type JsLexicalMatch = { kind: string; value: string; line: number; column: number; source?: string; method?: string };

export type JsLexicalInventory = {
	ok: true;
	parser: "lexical";
	sourceType: "unknown";
	bytes: number;
	lines: number;
	summary: {
		endpoints: { count: number; truncated: boolean; entries: JsLexicalMatch[] };
		sinks: { count: number; truncated: boolean; entries: JsLexicalMatch[] };
		storage: { count: number; truncated: boolean; entries: JsLexicalMatch[] };
		riskyCalls: { count: number; truncated: boolean; entries: JsLexicalMatch[] };
		sourceMaps: { count: number; truncated: boolean; entries: JsLexicalMatch[] };
	};
};

export type JsAstArtifactAnalysis = {
	input: {
		mode: "path" | "text";
		path?: string;
		fileName: string;
		bytes: number;
		truncated: boolean;
		slice?: { offset: number; length: number };
		privacy: { localOnly: true; artifactFirst: true };
	};
	analysisMode: "ast" | "lexical";
	analysis?: JsAstAnalysis;
	lexical?: JsLexicalInventory;
};

function normalizeMaxBytes(value: unknown): { value: number; explicit: boolean } {
	const n = Number(value);
	if (!Number.isFinite(n)) return { value: JS_AST_MAX_INPUT_BYTES, explicit: false };
	return { value: Math.max(256, Math.min(JS_AST_MAX_INPUT_BYTES, Math.floor(n))), explicit: true };
}

function normalizeSlice(value: JsAstArtifactInput["slice"]): { offset: number; length: number } | undefined {
	if (!value) return undefined;
	const offset = Math.max(0, Math.floor(Number(value.offset || 0)));
	const length = Math.max(1, Math.floor(Number(value.length || 0)));
	return Number.isFinite(offset) && Number.isFinite(length) ? { offset, length } : undefined;
}

function applySlice(text: string, slice: ReturnType<typeof normalizeSlice>): { text: string; slice?: { offset: number; length: number } } {
	if (!slice) return { text };
	return { text: text.slice(slice.offset, slice.offset + slice.length), slice };
}

function defaultFileName(value: unknown, fallback = "inline.js"): string {
	const text = String(value || "").trim();
	return text || fallback;
}

function ensureExclusiveInput(input: JsAstArtifactInput): void {
	if (input.path && input.text !== undefined) throw new JsAstArtifactError("JS_AST_INPUT_CONFLICT", "Provide either path or text, not both", { hasPath: true, hasText: true });
	if (!input.path && input.text === undefined) throw new JsAstArtifactError("JS_AST_INPUT_REQUIRED", "Provide explicit JavaScript text or a local file path", {});
}

function lineStarts(text: string): number[] {
	const starts = [0];
	for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") starts.push(index + 1);
	return starts;
}

function locationFor(starts: number[], index: number): { line: number; column: number } {
	let low = 0;
	let high = starts.length - 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		if (starts[mid] <= index) low = mid + 1;
		else high = mid - 1;
	}
	const lineIndex = Math.max(0, high);
	return { line: lineIndex + 1, column: index - starts[lineIndex] };
}

function pushBounded(out: JsLexicalMatch[], item: JsLexicalMatch, limit: number): void {
	if (out.length < limit) out.push(item);
}

function lexicalMatches(text: string, kind: string, re: RegExp, starts: number[], limit: number, map: (match: RegExpExecArray) => Partial<JsLexicalMatch> = () => ({})): { entries: JsLexicalMatch[]; count: number; truncated: boolean } {
	const entries: JsLexicalMatch[] = [];
	let count = 0;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text))) {
		count += 1;
		const loc = locationFor(starts, match.index);
		pushBounded(entries, { kind, value: (match[1] || match[0]).slice(0, 240), line: loc.line, column: loc.column, ...map(match) }, limit);
		if (match[0] === "") re.lastIndex += 1;
	}
	return { entries, count, truncated: count > entries.length };
}

function analyzeJavaScriptLexically(text: string): JsLexicalInventory {
	const starts = lineStarts(text);
	const limit = 80;
	const endpointPatterns = [
		lexicalMatches(text, "fetch", /\bfetch\s*\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*([\s\S]{0,240}?))?\)/gi, starts, limit, (match) => ({ method: match[2]?.match(/\bmethod\s*:\s*["'`]([A-Z]+)["'`]/i)?.[1]?.toUpperCase() || "GET", source: "fetch" })),
		lexicalMatches(text, "axios", /\baxios(?:\s*\.\s*(get|post|put|patch|delete|head|options))?\s*\(\s*["'`]([^"'`]+)["'`]/gi, starts, limit, (match) => ({ value: match[2], method: (match[1] || "GET").toUpperCase(), source: "axios" })),
		lexicalMatches(text, "xhr", /\.open\s*\(\s*["'`]([A-Z]+)["'`]\s*,\s*["'`]([^"'`]+)["'`]/gi, starts, limit, (match) => ({ value: match[2], method: match[1].toUpperCase(), source: "xhr" })),
		lexicalMatches(text, "path-literal", /["'`](\/[^"'`\s<>{}\\]*(?:api|admin|debug|internal|graphql|openapi|swagger|api-docs|v\d|manifest\.json|site\.webmanifest|service-worker|sw\.js|\.json|\.map)[^"'`\s<>{}\\]*)["'`]/gi, starts, limit, () => ({ source: "literal" })),
	];
	const flatten = (items: Array<{ entries: JsLexicalMatch[]; count: number }>) => items.flatMap((item) => item.entries).slice(0, limit);
	const endpointCount = endpointPatterns.reduce((sum, item) => sum + item.count, 0);
	const sinks = lexicalMatches(text, "dom-sink", /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/gi, starts, limit);
	const storage = lexicalMatches(text, "storage", /\b(localStorage|sessionStorage|document\.cookie)\b/gi, starts, limit);
	const riskyCalls = lexicalMatches(text, "risky-call", /\b(eval|Function|atob|unescape)\s*\(/gi, starts, limit);
	const sourceMaps = lexicalMatches(text, "source-map", /[#@]\s*sourceMappingURL\s*=\s*([^\s*]+)/gi, starts, limit);
	return {
		ok: true,
		parser: "lexical",
		sourceType: "unknown",
		bytes: Buffer.byteLength(text, "utf8"),
		lines: starts.length,
		summary: {
			endpoints: { count: endpointCount, truncated: endpointCount > limit, entries: flatten(endpointPatterns) },
			sinks,
			storage,
			riskyCalls,
			sourceMaps,
		},
	};
}

function shouldUseLexical(bytes: number, maxBytes: { value: number; explicit: boolean }): boolean {
	return bytes > maxBytes.value && !maxBytes.explicit && bytes <= JS_LEXICAL_MAX_INPUT_BYTES;
}

export async function analyzeJavaScriptArtifactInput(input: JsAstArtifactInput): Promise<JsAstArtifactAnalysis> {
	ensureExclusiveInput(input);
	const maxBytes = normalizeMaxBytes(input.maxBytes);
	const slice = normalizeSlice(input.slice);
	if (input.path) {
		const absPath = path.resolve(input.path);
		const info = await stat(absPath);
		if (!info.isFile()) throw new JsAstArtifactError("JS_AST_INPUT_NOT_FILE", "JS AST input path must be a file", { path: absPath });
		if (!slice && info.size > JS_LEXICAL_MAX_INPUT_BYTES) throw new JsAstArtifactError("JS_AST_INPUT_TOO_LARGE", "JS AST input exceeds lexical byte limit", { path: absPath, bytes: info.size, maxBytes: JS_LEXICAL_MAX_INPUT_BYTES });
		if (!slice && info.size > maxBytes.value && maxBytes.explicit) throw new JsAstArtifactError("JS_AST_INPUT_TOO_LARGE", "JS AST input exceeds bounded byte limit", { path: absPath, bytes: info.size, maxBytes: maxBytes.value });
		const rawText = await readFile(absPath, "utf8");
		const sliced = applySlice(rawText, slice);
		const text = sliced.text;
		const bytes = Buffer.byteLength(text, "utf8");
		const fileName = defaultFileName(input.fileName, path.basename(absPath));
		const inputMeta = { mode: "path" as const, path: absPath, fileName, bytes, truncated: false, ...(sliced.slice ? { slice: sliced.slice } : {}), privacy: { localOnly: true as const, artifactFirst: true as const } };
		if (!slice && shouldUseLexical(info.size, maxBytes)) return { input: inputMeta, analysisMode: "lexical", lexical: analyzeJavaScriptLexically(text) };
		if (bytes > maxBytes.value && maxBytes.explicit) throw new JsAstArtifactError("JS_AST_INPUT_TOO_LARGE", "JS AST input exceeds bounded byte limit", { path: absPath, bytes, maxBytes: maxBytes.value });
		if (bytes > maxBytes.value) return { input: inputMeta, analysisMode: "lexical", lexical: analyzeJavaScriptLexically(text) };
		return { input: inputMeta, analysisMode: "ast", analysis: analyzeJavaScriptSource(text, { ...(input.analysis || {}), fileName }) };
	}
	const rawText = String(input.text || "");
	const sliced = applySlice(rawText, slice);
	const bytes = Buffer.byteLength(sliced.text, "utf8");
	if (!slice && Buffer.byteLength(rawText, "utf8") > JS_LEXICAL_MAX_INPUT_BYTES) throw new JsAstArtifactError("JS_AST_INPUT_TOO_LARGE", "JS AST text input exceeds lexical byte limit", { bytes: Buffer.byteLength(rawText, "utf8"), maxBytes: JS_LEXICAL_MAX_INPUT_BYTES });
	if (bytes > maxBytes.value && maxBytes.explicit) throw new JsAstArtifactError("JS_AST_INPUT_TOO_LARGE", "JS AST text input exceeds bounded byte limit", { bytes, maxBytes: maxBytes.value });
	const fileName = defaultFileName(input.fileName, "inline.js");
	const inputMeta = { mode: "text" as const, fileName, bytes, truncated: false, ...(sliced.slice ? { slice: sliced.slice } : {}), privacy: { localOnly: true as const, artifactFirst: true as const } };
	if (bytes > maxBytes.value) return { input: inputMeta, analysisMode: "lexical", lexical: analyzeJavaScriptLexically(sliced.text) };
	return { input: inputMeta, analysisMode: "ast", analysis: analyzeJavaScriptSource(sliced.text, { ...(input.analysis || {}), fileName }) };
}
