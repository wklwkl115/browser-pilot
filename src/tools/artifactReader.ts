import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { asPositiveInt, normalizeArtifactMode } from "../utils/params";
import { SAFE_REGEX_DEFAULT_MAX_INPUT_CHARS, SAFE_REGEX_DEFAULT_MAX_PATTERN_CHARS, unsafeRegexReason } from "../utils/safeRegex";

export const MAX_ARTIFACT_READ_BYTES = 25 * 1024 * 1024;
export const MAX_ARTIFACT_SEARCH_REGEX_CHARS = SAFE_REGEX_DEFAULT_MAX_PATTERN_CHARS;
export const MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS = SAFE_REGEX_DEFAULT_MAX_INPUT_CHARS;

export class ArtifactReaderError extends Error {
	readonly code: string;
	readonly details: Record<string, unknown>;

	constructor(code: string, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "ArtifactReaderError";
		this.code = code;
		this.details = details;
	}
}

export type BrowserArtifactParams = {
	path: string;
	mode?: string;
	offset?: number;
	limit?: number;
	maxChars?: number;
	jsonPath?: string;
	pick?: string[];
	query?: string;
	regex?: boolean;
	ignoreCase?: boolean;
	contextLines?: number;
	maxMatches?: number;
};

type BrowserArtifactContext = { cwd?: string } | undefined;

type TextSnippet = { lineStart: number; lineEnd: number; text: string; truncated: boolean };
type SearchSnippet = TextSnippet & { matchLine: number };
type SampleSnippet = TextSnippet & { section: string; deduped?: boolean };

export type BrowserArtifactReadResult =
	| { mode: "text"; summary: Record<string, unknown>; offset: number; limit: number; nextOffset: number | null; snippets: TextSnippet[] }
	| { mode: "search"; summary: Record<string, unknown>; query: string; regex: boolean; offset: number; matches: number; nextOffset: number | null; snippets: SearchSnippet[] }
	| { mode: "sample"; summary: Record<string, unknown>; limit: number; snippets: SampleSnippet[] }
	| { mode: "json"; summary: Record<string, unknown>; jsonPath?: string; pick?: string[]; value: unknown };

function isInsideOrEqual(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveInputPath(ctx: BrowserArtifactContext, requested: unknown): string {
	const text = String(requested || "").trim();
	if (!text) throw new ArtifactReaderError("ARTIFACT_PATH_REQUIRED", "browser_artifact requires path");
	if (path.isAbsolute(text)) return path.normalize(text);
	const base = path.resolve(ctx?.cwd || process.cwd());
	const target = path.resolve(base, text);
	const allowed = path.resolve(base, ".pi", "browser-artifacts");
	if (!isInsideOrEqual(allowed, target)) {
		throw new ArtifactReaderError("ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT", "Relative browser_artifact paths must stay under .pi/browser-artifacts; use an absolute path for explicit files", { requested: text, allowedRoot: allowed });
	}
	return target;
}

function summaryFromStats(fileSize: number, absPath: string, lineCount: number | null, chars: number | null = fileSize) {
	return { path: absPath, bytes: fileSize, chars, lineCount };
}

function boundedJoin(lines: Array<{ line: number; text: string }>, maxChars: number): { text: string; lineEnd: number; truncated: boolean } {
	const out: string[] = [];
	let used = 0;
	let lineEnd = lines[0]?.line || 0;
	for (const item of lines) {
		const value = `${item.line}: ${item.text}`;
		if (used + value.length + 1 > maxChars) {
			const remaining = Math.max(0, maxChars - used - (out.length ? 1 : 0));
			if (remaining > 0) {
				out.push(value.slice(0, remaining));
				lineEnd = item.line;
			}
			return { text: out.join("\n"), lineEnd, truncated: true };
		}
		out.push(value);
		used += value.length + 1;
		lineEnd = item.line;
	}
	return { text: out.join("\n"), lineEnd, truncated: false };
}

async function eachLine(absPath: string, onLine: (line: string, lineNumber: number) => void | Promise<void>): Promise<number> {
	const rl = readline.createInterface({ input: createReadStream(absPath, { encoding: "utf8" }), crlfDelay: Infinity });
	let lineNumber = 0;
	for await (const line of rl) {
		lineNumber += 1;
		await onLine(line, lineNumber);
	}
	return lineNumber;
}

async function countTextChars(absPath: string): Promise<number> {
	let chars = 0;
	for await (const chunk of createReadStream(absPath, { encoding: "utf8" })) chars += String(chunk).length;
	return chars;
}

export function isSafeArtifactSearchRegexPattern(pattern: unknown): boolean {
	return unsafeRegexReason(pattern, MAX_ARTIFACT_SEARCH_REGEX_CHARS) === undefined;
}

function compileArtifactSearchRegex(query: string, flags: string): RegExp {
	const unsafeReason = unsafeRegexReason(query, MAX_ARTIFACT_SEARCH_REGEX_CHARS);
	if (unsafeReason) {
		throw new ArtifactReaderError("ARTIFACT_SEARCH_REGEX_UNSAFE", "browser_artifact search regex is unsafe or exceeds limits", {
			query,
			flags,
			reason: unsafeReason,
			maxPatternChars: MAX_ARTIFACT_SEARCH_REGEX_CHARS,
			maxLineChars: MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS,
		});
	}
	try { return new RegExp(query, flags); }
	catch (error) {
		throw new ArtifactReaderError("ARTIFACT_SEARCH_REGEX_INVALID", error instanceof Error ? error.message : String(error), { query, flags });
	}
}

async function readTextRange(absPath: string, fileSize: number, params: BrowserArtifactParams, maxChars: number) {
	const offset = Math.max(1, Math.floor(Number(params.offset || 1)));
	const limit = Math.max(1, Math.floor(Number(params.limit || 120)));
	const selected: Array<{ line: number; text: string }> = [];
	const lineCount = await eachLine(absPath, (line, lineNumber) => {
		if (lineNumber >= offset && lineNumber < offset + limit) selected.push({ line: lineNumber, text: line });
	});
	const chars = await countTextChars(absPath);
	if (!selected.length) return { mode: "text" as const, summary: summaryFromStats(fileSize, absPath, lineCount, chars), offset, limit, nextOffset: null, snippets: [] };
	const joined = boundedJoin(selected, maxChars);
	const nextOffset = offset - 1 + selected.length < lineCount ? joined.lineEnd + 1 : null;
	return {
		mode: "text" as const,
		summary: summaryFromStats(fileSize, absPath, lineCount, chars),
		offset,
		limit,
		nextOffset,
		snippets: [{ lineStart: selected[0].line, lineEnd: joined.lineEnd, text: joined.text, truncated: joined.truncated }],
	};
}

async function searchText(absPath: string, fileSize: number, params: BrowserArtifactParams, maxChars: number) {
	const query = String(params.query || "");
	if (!query) throw new ArtifactReaderError("ARTIFACT_SEARCH_QUERY_REQUIRED", "browser_artifact search mode requires query");
	const offset = Math.max(1, Math.floor(Number(params.offset || 1)));
	const contextLines = Math.max(0, Math.floor(Number(params.contextLines ?? 2)));
	const maxMatches = Math.max(1, Math.floor(Number(params.maxMatches || 20)));
	const flags = params.ignoreCase === false ? "" : "i";
	const pattern = params.regex ? compileArtifactSearchRegex(query, flags) : undefined;
	const needle = params.ignoreCase === false ? query : query.toLowerCase();
	const matches: SearchSnippet[] = [];
	const ring: Array<{ line: number; text: string }> = [];
	let pending: { matchLine: number; lines: Array<{ line: number; text: string }>; remainingAfter: number } | undefined;
	let used = 0;
	let lastRangeEnd = 0;
	let regexTruncatedLines = 0;
	const flushPending = () => {
		if (!pending) return;
		const budgetLeft = Math.max(0, maxChars - used);
		const joined = boundedJoin(pending.lines, budgetLeft);
		if (joined.text || !matches.length) {
			matches.push({ lineStart: pending.lines[0]?.line || pending.matchLine, lineEnd: joined.lineEnd || pending.matchLine, matchLine: pending.matchLine, text: joined.text, truncated: joined.truncated });
			used += joined.text.length + 1;
		}
		lastRangeEnd = pending.lines[pending.lines.length - 1]?.line || pending.matchLine;
		pending = undefined;
	};
	const lineCount = await eachLine(absPath, (line, lineNumber) => {
		if (pending) {
			pending.lines.push({ line: lineNumber, text: line });
			pending.remainingAfter -= 1;
			if (pending.remainingAfter <= 0) flushPending();
			if (matches.length >= maxMatches || used >= maxChars) return;
		}
		if (lineNumber < offset || matches.length >= maxMatches || used >= maxChars) {
			ring.push({ line: lineNumber, text: line });
			if (ring.length > contextLines) ring.shift();
			return;
		}
		const regexLine = pattern && line.length > MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS ? line.slice(0, MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS) : line;
		if (pattern && regexLine.length !== line.length) regexTruncatedLines += 1;
		const haystack = params.ignoreCase === false ? line : line.toLowerCase();
		const matched = pattern ? pattern.test(regexLine) : haystack.includes(needle);
		if (pattern) pattern.lastIndex = 0;
		if (!matched) {
			ring.push({ line: lineNumber, text: line });
			if (ring.length > contextLines) ring.shift();
			return;
		}
		const before = ring.filter((item) => item.line > lastRangeEnd);
		pending = { matchLine: lineNumber, lines: [...before, { line: lineNumber, text: line }], remainingAfter: contextLines };
		if (contextLines === 0) flushPending();
		ring.splice(0, ring.length, { line: lineNumber, text: line });
	});
	flushPending();
	const chars = await countTextChars(absPath);
	const nextOffset = matches.length && matches[matches.length - 1].lineEnd < lineCount ? matches[matches.length - 1].lineEnd + 1 : null;
	return {
		mode: "search" as const,
		summary: {
			...summaryFromStats(fileSize, absPath, lineCount, chars),
			search: pattern ? {
				regexMaxPatternChars: MAX_ARTIFACT_SEARCH_REGEX_CHARS,
				regexMaxLineChars: MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS,
				regexTruncatedLines,
			} : undefined,
		},
		query,
		regex: params.regex === true,
		offset,
		matches: matches.length,
		nextOffset,
		snippets: matches,
	};
}

async function sampleText(absPath: string, fileSize: number, params: BrowserArtifactParams, maxChars: number) {
	const perSection = Math.max(1, Math.floor(Number(params.limit || 20)));
	let lineCount = 0;
	await eachLine(absPath, () => { lineCount += 1; });
	const chars = await countTextChars(absPath);
	if (lineCount === 0) return { mode: "sample" as const, summary: summaryFromStats(fileSize, absPath, lineCount, chars), limit: perSection, snippets: [] };
	const sections = [
		{ name: "head", start: 1, end: Math.min(lineCount, perSection) },
		{ name: "middle", start: Math.max(1, Math.floor(lineCount / 2) - Math.floor(perSection / 2)), end: Math.min(lineCount, Math.max(1, Math.floor(lineCount / 2) - Math.floor(perSection / 2)) + perSection - 1) },
		{ name: "tail", start: Math.max(1, lineCount - perSection + 1), end: lineCount },
	];
	const snippets: SampleSnippet[] = [];
	const usedRanges: Array<{ start: number; end: number }> = [];
	let dedupedSections = 0;
	let used = 0;
	for (const section of sections) {
		let start = section.start;
		let end = section.end;
		for (const range of usedRanges) {
			if (range.end < start || range.start > end) continue;
			if (range.start <= start) start = Math.max(start, range.end + 1);
			if (range.end >= end) end = Math.min(end, range.start - 1);
		}
		if (start > end) {
			dedupedSections += 1;
			continue;
		}
		const selected: Array<{ line: number; text: string }> = [];
		await eachLine(absPath, (line, lineNumber) => {
			if (lineNumber >= start && lineNumber <= end) selected.push({ line: lineNumber, text: line });
		});
		const joined = boundedJoin(selected, Math.max(0, maxChars - used));
		if (!joined.text && snippets.length) break;
		snippets.push({ section: section.name, lineStart: start, lineEnd: joined.lineEnd, text: joined.text, truncated: joined.truncated, deduped: start !== section.start || end !== section.end || dedupedSections > 0 });
		usedRanges.push({ start, end: joined.lineEnd });
		used += joined.text.length + 1;
		if (joined.truncated || used >= maxChars) break;
	}
	return {
		mode: "sample" as const,
		summary: {
			...summaryFromStats(fileSize, absPath, lineCount, chars),
			sample: { requestedSections: sections.length, returnedSections: snippets.length, dedupedSections },
		},
		limit: perSection,
		snippets,
	};
}

function parseJsonPath(jsonPath: string): Array<string | number> {
	const text = jsonPath.trim();
	if (!text || text === "$") return [];
	const normalized = text.startsWith("$.") ? text.slice(2) : text.startsWith("$") ? text.slice(1) : text;
	const tokens: Array<string | number> = [];
	for (const part of normalized.split(".")) {
		if (!part) continue;
		const re = /([^\[\]]+)|\[(\d+)\]/g;
		let match: RegExpExecArray | null;
		while ((match = re.exec(part))) tokens.push(match[1] !== undefined ? match[1] : Number(match[2]));
	}
	return tokens;
}

function getJsonPath(value: unknown, jsonPath: string | undefined): { exists: boolean; value: unknown } {
	let current = value;
	for (const token of parseJsonPath(jsonPath || "$")) {
		if (current === null || current === undefined || typeof current !== "object") return { exists: false, value: undefined };
		if (!Object.prototype.hasOwnProperty.call(current, token)) return { exists: false, value: undefined };
		current = (current as Record<string | number, unknown>)[token];
	}
	return { exists: true, value: current };
}

function compactJsonValue(value: unknown, params: BrowserArtifactParams, depth = 0): unknown {
	const maxString = 800;
	const limit = Math.max(1, Math.floor(Number(params.limit || 40)));
	const offset = Math.max(0, Math.floor(Number(params.offset || 0)));
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return value.length > maxString ? { preview: value.slice(0, maxString), originalLength: value.length, truncated: true } : value;
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "object") return String(value);
	if (depth >= 5) return "[MaxDepth]";
	if (Array.isArray(value)) {
		return {
			type: "array",
			count: value.length,
			offset,
			limit,
			nextOffset: offset + limit < value.length ? offset + limit : null,
			items: value.slice(offset, offset + limit).map((item) => compactJsonValue(item, params, depth + 1)),
		};
	}
	const entries = Object.entries(value as Record<string, unknown>);
	const out: Record<string, unknown> = {};
	for (const [key, item] of entries.slice(0, limit)) out[key] = compactJsonValue(item, params, depth + 1);
	if (entries.length > limit) out.truncatedKeys = entries.length - limit;
	return out;
}

function summarizeJsonValue(value: unknown, absPath: string, fileSize: number): Record<string, unknown> {
	if (Array.isArray(value)) return { path: absPath, bytes: fileSize, type: "array", count: value.length };
	if (value && typeof value === "object") return { path: absPath, bytes: fileSize, type: "object", keyCount: Object.keys(value).length, keys: Object.keys(value).slice(0, 40) };
	return { path: absPath, bytes: fileSize, type: typeof value };
}

function readJson(text: string, fileSize: number, absPath: string, params: BrowserArtifactParams) {
	const parsed = JSON.parse(text) as unknown;
	if (Array.isArray(params.pick) && params.pick.length) {
		const entries = params.pick.map((item) => {
			const selected = getJsonPath(parsed, item);
			return [item, selected.exists
				? { exists: true, jsonPath: item, value: compactJsonValue(selected.value, params) }
				: { exists: false, notFound: true, jsonPath: item, value: null }];
		});
		const value = Object.fromEntries(entries);
		const missingCount = Object.values(value).filter((item) => (item as { exists?: boolean }).exists === false).length;
		return {
			mode: "json" as const,
			summary: { path: absPath, bytes: fileSize, type: "object", keyCount: Object.keys(value).length, keys: Object.keys(value).slice(0, 40), picked: true, missingCount },
			pick: params.pick,
			value,
		};
	}
	const jsonPath = params.jsonPath || "$";
	const selected = getJsonPath(parsed, jsonPath);
	if (!selected.exists) {
		return {
			mode: "json" as const,
			summary: { path: absPath, bytes: fileSize, type: "missing", exists: false, notFound: true, jsonPath },
			jsonPath,
			value: { exists: false, notFound: true, jsonPath, value: null },
		};
	}
	return {
		mode: "json" as const,
		summary: { ...summarizeJsonValue(selected.value, absPath, fileSize), exists: true, jsonPath },
		jsonPath,
		value: compactJsonValue(selected.value, params),
	};
}

export async function readBrowserArtifact(params: BrowserArtifactParams, ctx?: BrowserArtifactContext): Promise<BrowserArtifactReadResult> {
	const mode = normalizeArtifactMode(params.mode);
	const absPath = resolveInputPath(ctx, params.path);
	const info = await stat(absPath);
	const maxChars = asPositiveInt(params.maxChars, 8_000);
	if (mode === "json") {
		if (info.size > MAX_ARTIFACT_READ_BYTES) {
			throw new ArtifactReaderError("ARTIFACT_TOO_LARGE", "Artifact is too large for browser_artifact json reader", { path: absPath, bytes: info.size, maxBytes: MAX_ARTIFACT_READ_BYTES });
		}
		return readJson(await readFile(absPath, "utf8"), info.size, absPath, params);
	}
	if (mode === "search") return searchText(absPath, info.size, params, maxChars);
	if (mode === "sample") return sampleText(absPath, info.size, params, maxChars);
	return readTextRange(absPath, info.size, params, maxChars);
}
