import { createReadStream, type Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { stableJson, tryJson } from "../utils/json.js";
import { getJsonPath, parseJsonPath, type JsonPathToken } from "../utils/jsonPath.js";
import { asPositiveInt, normalizeArtifactMode } from "../utils/params.js";
import { SAFE_REGEX_DEFAULT_MAX_INPUT_CHARS, SAFE_REGEX_DEFAULT_MAX_PATTERN_CHARS, unsafeRegexReason } from "../utils/safeRegex.js";
import { projectJsonValue } from "../kernels/evidence/distill/projection.js";
import { browserArtifactPrivacyMetadata, redactSensitiveText, redactSensitiveValue } from "./artifactPrivacy.js";

export const MAX_ARTIFACT_READ_BYTES = 25 * 1024 * 1024;
export const MAX_ARTIFACT_SEARCH_REGEX_CHARS = SAFE_REGEX_DEFAULT_MAX_PATTERN_CHARS;
export const MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS = SAFE_REGEX_DEFAULT_MAX_INPUT_CHARS;
export const MAX_MULTI_ARTIFACT_FILES = 100;
export const MAX_MULTI_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_MULTI_ARTIFACT_MATCHES_PER_FILE = 20;
export const MAX_MULTI_ARTIFACT_TOTAL_MATCHES = 100;

export type ArtifactReaderErrorCode =
	| "ARTIFACT_NOT_FOUND"
	| "ARTIFACT_PATH_REQUIRED"
	| "ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT"
	| "ARTIFACT_SEARCH_QUERY_REQUIRED"
	| "ARTIFACT_SEARCH_REGEX_UNSAFE"
	| "ARTIFACT_SEARCH_REGEX_INVALID"
	| "ARTIFACT_MULTI_SEARCH_MODE_INVALID"
	| "ARTIFACT_QUERY_REQUIRES_SEARCH_MODE"
	| "ARTIFACT_JSON_INVALID"
	| "ARTIFACT_TOO_LARGE";

export class ArtifactReaderError extends Error {
	readonly code: ArtifactReaderErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: ArtifactReaderErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "ArtifactReaderError";
		this.code = code;
		this.details = details;
	}
}

export type BrowserArtifactParams = {
	path?: string;
	paths?: string[];
	root?: string;
	glob?: string;
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
	contextChars?: number;
	columnOffset?: number;
	columnLimit?: number;
	maxMatches?: number;
	maxFiles?: number;
	maxBytes?: number;
	maxMatchesPerFile?: number;
	maxTotalMatches?: number;
	redact?: boolean;
};

type BrowserArtifactContext = { cwd?: string } | undefined;

type TextSnippet = { lineStart: number; lineEnd: number; text: string; truncated: boolean; columnStart?: number; columnEnd?: number; lineLength?: number; truncatedBefore?: boolean; truncatedAfter?: boolean };
type SearchSnippet = TextSnippet & { matchLine: number; path?: string; matchColumnStart?: number; matchColumnEnd?: number };
type SampleSnippet = TextSnippet & { section: string; deduped?: boolean };

type SkippedFile = { path: string; reason: string; size: number };

type TruncationInfo = {
	truncated: true;
	truncationReason: string;
	bytesRead?: number;
	byteLimit?: number;
	matchesFound?: number;
	matchLimit?: number;
	totalMatches?: number;
	skippedFiles?: SkippedFile[];
};

export type BrowserArtifactReadResult =
	| { mode: "text"; summary: Record<string, unknown>; offset: number; limit: number; nextOffset: number | null; snippets: TextSnippet[]; truncation?: TruncationInfo }
	| { mode: "search"; summary: Record<string, unknown>; query: string; regex: boolean; offset: number; matches: number; nextOffset: number | null; snippets: SearchSnippet[]; truncation?: TruncationInfo }
	| { mode: "sample"; summary: Record<string, unknown>; limit: number; snippets: SampleSnippet[]; truncation?: TruncationInfo }
	| { mode: "json"; summary: Record<string, unknown>; jsonPath?: string; pick?: string[]; value: unknown; truncation?: TruncationInfo };

function isInsideOrEqual(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function allowedArtifactRoot(ctx: BrowserArtifactContext): string {
	const base = path.resolve(ctx?.cwd || process.cwd());
	return path.resolve(base, ".browser-pilot", "artifacts");
}

function resolveInputPath(ctx: BrowserArtifactContext, requested: unknown): string {
	const text = String(requested || "").trim();
	if (!text) throw new ArtifactReaderError("ARTIFACT_PATH_REQUIRED", "browser_artifact requires path");
	if (path.isAbsolute(text)) return path.normalize(text);
	const base = path.resolve(ctx?.cwd || process.cwd());
	const target = path.resolve(base, text);
	const allowed = allowedArtifactRoot(ctx);
	if (!isInsideOrEqual(allowed, target)) {
		throw new ArtifactReaderError("ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT", "Relative browser_artifact paths must stay under .browser-pilot/artifacts; use an absolute path for explicit files", { requested: text, allowedRoot: allowed });
	}
	return target;
}

function resolveSearchRoot(ctx: BrowserArtifactContext, requested: unknown): string {
	const allowed = allowedArtifactRoot(ctx);
	const text = String(requested || "").trim();
	if (!text) return allowed;
	const base = path.resolve(ctx?.cwd || process.cwd());
	const target = path.isAbsolute(text) ? path.normalize(text) : path.resolve(base, text);
	if (!isInsideOrEqual(allowed, target)) {
		throw new ArtifactReaderError("ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT", "browser_artifact root must stay under .browser-pilot/artifacts", { requested: text, allowedRoot: allowed });
	}
	return target;
}

function summaryFromStats(fileSize: number, absPath: string, lineCount: number | null, chars: number | null = fileSize) {
	return { path: absPath, bytes: fileSize, chars, lineCount };
}

function privacySummary(redacted: boolean, targetedRaw = false) {
	return redacted ? { redaction: "default", ...browserArtifactPrivacyMetadata() } : { redaction: targetedRaw ? "targeted_raw" : "disabled", localOnly: true };
}

function redactSnippetText(text: string): string {
	return redactSensitiveText(text)
		.replace(/(^|[\r\n])(\s*\d+:\s*(?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-aws-ec2-metadata-token)\s*:\s*)[^\r\n]*/gi, "$1$2[redacted]");
}

function redactTextSnippet<T extends TextSnippet>(snippet: T): T {
	return { ...snippet, text: redactSnippetText(snippet.text) };
}

function searchQueryLooksSecretProbe(query: string): boolean {
	const trimmed = query.trim();
	if (!trimmed) return false;
	if (/\b(?:Bearer\s+\S+|Basic\s+[A-Za-z0-9+/=]+)\b/i.test(trimmed)) return true;
	if (/\b(?:cookie|authorization|proxy-authorization|auth|token|secret|password|passwd|pwd|csrf|xsrf|api[_-]?key|session(?:id)?)\b\s*[:=]\s*\S+/i.test(trimmed)) return true;
	if (/\b(?:cookie|auth|token|secret|password|passwd|pwd|csrf|xsrf|api[_-]?key|session(?:id)?)[_-]+[a-z0-9_-]*(?:secret|token|key|pwd|session|cookie|live|value)\b/i.test(trimmed)) return true;
	if (!/\s/.test(trimmed) && trimmed.length >= 20 && /\d/.test(trimmed) && /[a-z]/i.test(trimmed) && /[A-Z_-]/.test(trimmed)) return true;
	return false;
}

function redactSearchQuery(query: string): string {
	const redacted = redactSensitiveText(query);
	if (redacted !== query) return redacted;
	// A search query is not a payload field. Keep ordinary terms visible so parallel
	// search results remain attributable, but hide credential-shaped probes.
	return searchQueryLooksSecretProbe(query) ? "[redacted]" : query;
}

function redactArtifactResult<T extends BrowserArtifactReadResult>(result: T, redacted: boolean, targetedRaw = false): T {
	const summary = { ...result.summary, privacy: privacySummary(redacted, targetedRaw) };
	if (!redacted) return { ...result, summary } as T;
	if (result.mode === "text") return { ...result, summary, snippets: result.snippets.map(redactTextSnippet) } as T;
	if (result.mode === "search") return { ...result, summary, query: redactSearchQuery(result.query), snippets: result.snippets.map(redactTextSnippet) } as T;
	if (result.mode === "sample") return { ...result, summary, snippets: result.snippets.map(redactTextSnippet) } as T;
	return { ...result, summary, value: redactSensitiveValue(result.value) } as T;
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

function positiveIntParam(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function lineWindow(line: string, start: number, length: number): { text: string; columnStart: number; columnEnd: number; lineLength: number; truncatedBefore: boolean; truncatedAfter: boolean } {
	const lineLength = line.length;
	const columnStart = Math.max(0, Math.min(lineLength, Math.floor(start)));
	const columnEnd = Math.max(columnStart, Math.min(lineLength, columnStart + Math.max(0, Math.floor(length))));
	return {
		text: line.slice(columnStart, columnEnd),
		columnStart,
		columnEnd,
		lineLength,
		truncatedBefore: columnStart > 0,
		truncatedAfter: columnEnd < lineLength,
	};
}

function textLineWindow(line: string, params: BrowserArtifactParams, maxChars: number) {
	const hasColumnWindow = params.columnOffset !== undefined || params.columnLimit !== undefined;
	if (!hasColumnWindow) return lineWindow(line, 0, line.length);
	const start = Math.max(0, Math.floor(Number(params.columnOffset || 0)));
	const fallbackLimit = Math.max(1, maxChars);
	const limit = positiveIntParam(params.columnLimit, fallbackLimit, 1, Math.max(1, line.length));
	return lineWindow(line, start, limit);
}

function searchLineWindow(line: string, matchStart: number, matchEnd: number, params: BrowserArtifactParams, maxChars: number) {
	const matchLength = Math.max(1, matchEnd - matchStart);
	const contextChars = positiveIntParam(params.contextChars, 800, 80, 20_000);
	const displayBudget = Math.max(matchLength, maxChars - 20);
	if (line.length <= Math.min(contextChars, displayBudget)) return lineWindow(line, 0, line.length);
	const windowLength = Math.min(line.length, Math.max(matchLength, Math.min(contextChars, displayBudget)));
	const side = Math.floor(Math.max(0, windowLength - matchLength) / 2);
	const start = Math.max(0, Math.min(line.length - windowLength, matchStart - side));
	return lineWindow(line, start, windowLength);
}

function matchColumns(line: string, params: BrowserArtifactParams, pattern: RegExp | undefined, needle: string): { matched: boolean; start?: number; end?: number } {
	if (pattern) {
		const regexLine = line.length > MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS ? line.slice(0, MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS) : line;
		const match = pattern.exec(regexLine);
		pattern.lastIndex = 0;
		return match?.index !== undefined ? { matched: true, start: match.index, end: match.index + match[0].length } : { matched: false };
	}
	const haystack = params.ignoreCase === false ? line : line.toLowerCase();
	const index = haystack.indexOf(needle);
	return index >= 0 ? { matched: true, start: index, end: index + needle.length } : { matched: false };
}

async function eachLine(absPath: string, onLine: (line: string, lineNumber: number) => void | Promise<void>): Promise<{ lineCount: number; chars: number }> {
	const input = createReadStream(absPath, { encoding: "utf8" });
	let chars = 0;
	input.on("data", (chunk) => { chars += String(chunk).length; });
	const rl = readline.createInterface({ input, crlfDelay: Infinity });
	let lineNumber = 0;
	for await (const line of rl) {
		lineNumber += 1;
		await onLine(line, lineNumber);
	}
	return { lineCount: lineNumber, chars };
}

export function isSafeArtifactSearchRegexPattern(pattern: unknown): boolean {
	return unsafeRegexReason(pattern, MAX_ARTIFACT_SEARCH_REGEX_CHARS) === undefined;
}

function describeUnsafeRegexReason(reason: string, query: string): string {
	switch (reason) {
		case "pattern_too_long": return `pattern too long (${query.length} chars, max ${MAX_ARTIFACT_SEARCH_REGEX_CHARS})`;
		case "backreference": return "catastrophic backtracking risk: backreference detected";
		case "lookaround_or_special_group": return "catastrophic backtracking risk: lookaround or special group detected";
		case "nested_quantifier": return "catastrophic backtracking risk: nested quantifier detected";
		case "quantified_alternation": return "catastrophic backtracking risk: quantified alternation detected";
		case "too_many_wildcards": return "catastrophic backtracking risk: too many .* wildcards";
		case "empty_pattern": return "empty pattern";
		default: return reason;
	}
}

function compileArtifactSearchRegex(query: string, flags: string): RegExp {
	const unsafeReason = unsafeRegexReason(query, MAX_ARTIFACT_SEARCH_REGEX_CHARS);
	if (unsafeReason) {
		const detail = describeUnsafeRegexReason(unsafeReason, query);
		throw new ArtifactReaderError("ARTIFACT_SEARCH_REGEX_UNSAFE", `browser_artifact search regex rejected: ${detail}`, {
			query,
			flags,
			reason: unsafeReason,
			reasonDetail: detail,
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
	const selected: Array<{ line: number; text: string; window?: ReturnType<typeof textLineWindow> }> = [];
	const stats = await eachLine(absPath, (line, lineNumber) => {
		if (lineNumber >= offset && lineNumber < offset + limit) {
			const window = textLineWindow(line, params, maxChars);
			selected.push({ line: lineNumber, text: window.text, window });
		}
	});
	const { lineCount, chars } = stats;
	if (!selected.length) return { mode: "text" as const, summary: summaryFromStats(fileSize, absPath, lineCount, chars), offset, limit, nextOffset: null, snippets: [] };
	const joined = boundedJoin(selected, maxChars);
	const nextOffset = offset - 1 + selected.length < lineCount ? joined.lineEnd + 1 : null;
	const firstWindow = selected[0].window;
	return {
		mode: "text" as const,
		summary: summaryFromStats(fileSize, absPath, lineCount, chars),
		offset,
		limit,
		nextOffset,
		snippets: [{
			lineStart: selected[0].line,
			lineEnd: joined.lineEnd,
			text: joined.text,
			truncated: joined.truncated || !!firstWindow?.truncatedBefore || !!firstWindow?.truncatedAfter,
			...(firstWindow ? { columnStart: firstWindow.columnStart, columnEnd: firstWindow.columnEnd, lineLength: firstWindow.lineLength, truncatedBefore: firstWindow.truncatedBefore, truncatedAfter: firstWindow.truncatedAfter } : {}),
		}],
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
	let pending: { matchLine: number; lines: Array<{ line: number; text: string }>; remainingAfter: number; window: ReturnType<typeof searchLineWindow>; matchStart: number; matchEnd: number } | undefined;
	let used = 0;
	let lastRangeEnd = 0;
	let regexTruncatedLines = 0;
	let hitMatchLimit = false;
	let hitCharsLimit = false;
	const flushPending = () => {
		if (!pending) return;
		const budgetLeft = Math.max(0, maxChars - used);
		const joined = boundedJoin(pending.lines, budgetLeft);
		if (joined.text || !matches.length) {
			matches.push({
				lineStart: pending.lines[0]?.line || pending.matchLine,
				lineEnd: joined.lineEnd || pending.matchLine,
				matchLine: pending.matchLine,
				text: joined.text,
				truncated: joined.truncated || pending.window.truncatedBefore || pending.window.truncatedAfter,
				columnStart: pending.window.columnStart,
				columnEnd: pending.window.columnEnd,
				lineLength: pending.window.lineLength,
				truncatedBefore: pending.window.truncatedBefore,
				truncatedAfter: pending.window.truncatedAfter,
				matchColumnStart: pending.matchStart,
				matchColumnEnd: pending.matchEnd,
			});
			used += joined.text.length + 1;
		}
		lastRangeEnd = pending.lines[pending.lines.length - 1]?.line || pending.matchLine;
		pending = undefined;
	};
	const stats = await eachLine(absPath, (line, lineNumber) => {
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
		if (pattern && line.length > MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS) regexTruncatedLines += 1;
		const match = matchColumns(line, params, pattern, needle);
		if (!match.matched || match.start === undefined || match.end === undefined) {
			ring.push({ line: lineNumber, text: line });
			if (ring.length > contextLines) ring.shift();
			return;
		}
		const before = ring.filter((item) => item.line > lastRangeEnd);
		const window = searchLineWindow(line, match.start, match.end, params, Math.max(0, maxChars - used));
		pending = { matchLine: lineNumber, lines: [...before, { line: lineNumber, text: window.text }], remainingAfter: contextLines, window, matchStart: match.start, matchEnd: match.end };
		if (contextLines === 0) flushPending();
		ring.splice(0, ring.length, { line: lineNumber, text: line });
	});
	flushPending();
	if (matches.length >= maxMatches) hitMatchLimit = true;
	if (used >= maxChars) hitCharsLimit = true;
	const { lineCount, chars } = stats;
	const nextOffset = matches.length && matches[matches.length - 1].lineEnd < lineCount ? matches[matches.length - 1].lineEnd + 1 : null;
	const truncation: TruncationInfo | undefined = hitMatchLimit
		? { truncated: true, truncationReason: "per_file_match_limit", matchesFound: matches.length, matchLimit: maxMatches }
		: hitCharsLimit
			? { truncated: true, truncationReason: "chars_budget", matchesFound: matches.length, bytesRead: chars, byteLimit: maxChars }
			: undefined;
	return {
		mode: "search" as const,
		summary: {
			...summaryFromStats(fileSize, absPath, lineCount, chars),
			search: {
				...(pattern ? { regexMaxPatternChars: MAX_ARTIFACT_SEARCH_REGEX_CHARS, regexMaxLineChars: MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS, regexTruncatedLines } : {}),
				contextChars: positiveIntParam(params.contextChars, 800, 80, 20_000),
			},
		},
		query,
		regex: params.regex === true,
		offset,
		matches: matches.length,
		nextOffset,
		snippets: matches,
		...(truncation ? { truncation } : {}),
	};
}

async function sampleText(absPath: string, fileSize: number, params: BrowserArtifactParams, maxChars: number) {
	const perSection = Math.max(1, Math.floor(Number(params.limit || 20)));
	let onlyLine = "";
	const stats = await eachLine(absPath, (line, lineNumber) => {
		if (lineNumber === 1) onlyLine = line;
	});
	const { lineCount, chars } = stats;
	if (lineCount === 0) return { mode: "sample" as const, summary: summaryFromStats(fileSize, absPath, lineCount, chars), limit: perSection, snippets: [] };
	if (lineCount === 1) {
		const windowLength = positiveIntParam(params.contextChars ?? params.columnLimit, Math.max(1, Math.floor(maxChars / 3)), 40, Math.max(40, onlyLine.length));
		const candidates = [
			{ section: "head", start: 0 },
			{ section: "middle", start: Math.max(0, Math.floor(onlyLine.length / 2) - Math.floor(windowLength / 2)) },
			{ section: "tail", start: Math.max(0, onlyLine.length - windowLength) },
		];
		const snippets: SampleSnippet[] = [];
		const ranges: Array<{ start: number; end: number }> = [];
		let used = 0;
		for (const candidate of candidates) {
			const window = lineWindow(onlyLine, candidate.start, windowLength);
			if (ranges.some((range) => window.columnStart >= range.start && window.columnEnd <= range.end)) continue;
			const joined = boundedJoin([{ line: 1, text: window.text }], Math.max(0, maxChars - used));
			if (!joined.text && snippets.length) break;
			snippets.push({ section: candidate.section, lineStart: 1, lineEnd: 1, text: joined.text, truncated: joined.truncated || window.truncatedBefore || window.truncatedAfter, columnStart: window.columnStart, columnEnd: window.columnEnd, lineLength: window.lineLength, truncatedBefore: window.truncatedBefore, truncatedAfter: window.truncatedAfter });
			ranges.push({ start: window.columnStart, end: window.columnEnd });
			used += joined.text.length + 1;
			if (joined.truncated || used >= maxChars) break;
		}
		return {
			mode: "sample" as const,
			summary: { ...summaryFromStats(fileSize, absPath, lineCount, chars), sample: { requestedSections: candidates.length, returnedSections: snippets.length, singleLineWindows: true } },
			limit: perSection,
			snippets,
		};
	}
	const sections = [
		{ name: "head", start: 1, end: Math.min(lineCount, perSection) },
		{ name: "middle", start: Math.max(1, Math.floor(lineCount / 2) - Math.floor(perSection / 2)), end: Math.min(lineCount, Math.max(1, Math.floor(lineCount / 2) - Math.floor(perSection / 2)) + perSection - 1) },
		{ name: "tail", start: Math.max(1, lineCount - perSection + 1), end: lineCount },
	];
	const snippets: SampleSnippet[] = [];
	const usedRanges: Array<{ start: number; end: number }> = [];
	const selectedRanges: Array<{ section: string; requestedStart: number; start: number; end: number; dedupedSections: number }> = [];
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
		selectedRanges.push({ section: section.name, requestedStart: section.start, start, end, dedupedSections });
		usedRanges.push({ start, end });
	}
	const selectedBySection = new Map<string, Array<{ line: number; text: string }>>();
	if (selectedRanges.length) {
		await eachLine(absPath, (line, lineNumber) => {
			for (const section of selectedRanges) {
				if (lineNumber >= section.start && lineNumber <= section.end) {
					const selected = selectedBySection.get(section.section) || [];
					selected.push({ line: lineNumber, text: line });
					selectedBySection.set(section.section, selected);
				}
			}
		});
	}
	for (const section of selectedRanges) {
		const selected = selectedBySection.get(section.section) || [];
		const joined = boundedJoin(selected, Math.max(0, maxChars - used));
		if (!joined.text && snippets.length) break;
		snippets.push({ section: section.section, lineStart: section.start, lineEnd: joined.lineEnd, text: joined.text, truncated: joined.truncated, deduped: section.start !== section.requestedStart || section.end !== joined.lineEnd || section.dedupedSections > 0 });
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

const JSON_INLINE_STRING_CHARS = 800;
const JSON_STRING_WINDOW_MAX_CHARS = 100_000;

function jsonStringWindow(value: string, params: BrowserArtifactParams): unknown {
	const hasWindow = params.offset !== undefined || params.limit !== undefined;
	if (!hasWindow && value.length <= JSON_INLINE_STRING_CHARS) return value;
	const offset = Math.max(0, Math.min(value.length, Math.floor(Number(params.offset || 0))));
	const fallbackLimit = asPositiveInt(params.maxChars, 8_000);
	const limit = positiveIntParam(params.limit, fallbackLimit, 1, JSON_STRING_WINDOW_MAX_CHARS);
	const end = Math.max(offset, Math.min(value.length, offset + limit));
	return {
		type: "string",
		text: value.slice(offset, end),
		offset,
		limit,
		nextOffset: end < value.length ? end : null,
		originalLength: value.length,
		truncated: end < value.length || offset > 0,
		truncatedBefore: offset > 0,
		truncatedAfter: end < value.length,
	};
}

function compactJsonValue(value: unknown, params: BrowserArtifactParams, depth = 0): unknown {
	const limit = Math.max(1, Math.floor(Number(params.limit || 40)));
	const offset = Math.max(0, Math.floor(Number(params.offset || 0)));
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return value.length > JSON_INLINE_STRING_CHARS ? { preview: value.slice(0, JSON_INLINE_STRING_CHARS), originalLength: value.length, truncated: true } : value;
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "object") return String(value);
	if (depth >= 5) return "[MaxDepth]";
	if (Array.isArray(value)) {
		if (value.length === 0) return [];
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

function jsonProjectionEnabled(): boolean {
	return process.env.BROWSER_PILOT_JSON_PROJECTION !== "0";
}

function projectedArraySourceCost(value: unknown, params: BrowserArtifactParams): number {
	if (!Array.isArray(value) || value.length === 0) return Number.POSITIVE_INFINITY;
	const offset = Math.max(0, Math.floor(Number(params.offset || 0)));
	const limit = Math.max(1, Math.floor(Number(params.limit ?? Math.max(1, value.length - offset))));
	const selected = value.slice(offset, offset + limit);
	return stableJson({
		type: "array",
		count: value.length,
		offset,
		limit,
		nextOffset: offset + limit < value.length ? offset + limit : null,
		items: selected,
	}).length;
}

function compactJsonValueForArtifact(value: unknown, params: BrowserArtifactParams, jsonPath?: string): unknown {
	const legacy = compactJsonValue(value, params);
	if (!jsonProjectionEnabled() || typeof value === "string") return legacy;
	const budget = asPositiveInt(params.maxChars, 8_000);
	const projection = projectJsonValue(value, {
		jsonPath,
		offset: params.offset,
		limit: params.limit,
		maxChars: budget,
	});
	if (!projection) return legacy;
	const projectedLength = stableJson(projection).length;
	return projectedLength < projectedArraySourceCost(value, params) ? projection : legacy;
}

function formatJsonPath(tokens: JsonPathToken[]): string {
	if (!tokens.length) return "$";
	return tokens.map((token, index) => {
		if (typeof token === "number") return `[${token}]`;
		if (/^[A-Za-z_$][\w$]*$/.test(token)) return index === 0 ? token : `.${token}`;
		return `['${token.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
	}).join("");
}

function jsonValueType(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value;
}

function nearestJsonPathInfo(root: unknown, jsonPath: string): Record<string, unknown> {
	const tokens = parseJsonPath(jsonPath);
	for (let length = tokens.length; length >= 0; length -= 1) {
		const path = formatJsonPath(tokens.slice(0, length));
		const selected = getJsonPath(root, path);
		if (!selected.exists) continue;
		const nearestType = jsonValueType(selected.value);
		const nearestKeys = selected.value && typeof selected.value === "object" ? Object.keys(selected.value).slice(0, 40) : undefined;
		return {
			nearestPath: path,
			nearestType,
			...(nearestKeys ? { nearestKeys } : {}),
		};
	}
	return {};
}

function missingJsonPathValue(root: unknown, jsonPath: string): Record<string, unknown> {
	const nearest = nearestJsonPathInfo(root, jsonPath);
	return { exists: false, notFound: true, jsonPath, ...nearest, value: null };
}

function correlationValueAtPath(root: unknown, jsonPath: string): unknown {
	const selected = getJsonPath(root, jsonPath);
	return selected.exists ? selected.value : undefined;
}

function extractArtifactCorrelation(value: unknown): { correlation?: Record<string, unknown>; correlationPaths?: Record<string, string> } {
	if (!value || typeof value !== "object") return {};
	const pathCandidates: Record<string, string[]> = {
		operationId: ["operation.operationId", "correlation.operationId", "operationId"],
		snapshotId: ["snapshot.snapshotId", "correlation.snapshotId", "snapshotId"],
		browserSessionId: ["target.browserSessionId", "browserSessionId", "data.browserSessionId"],
		sessionId: ["data.sessionId", "sessionId", "data.session_id", "session_id"],
		requestId: ["data.requestId", "requestId", "data.request_id", "request_id"],
		waitId: ["data.waitId", "waitId", "data.wait_id", "wait_id"],
		listenerId: ["data.listenerId", "listenerId", "data.listener_id", "listener_id"],
		selectionVersionAtDispatch: ["target.selectionVersionAtDispatch", "selectionVersionAtDispatch"],
		selectionVersionAtResolve: ["target.selectionVersionAtResolve", "selectionVersionAtResolve"],
		sourceMode: ["data.sourceMode", "sourceMode"],
		targetSource: ["target.source", "targetSource"],
		targetImplicit: ["target.implicit", "targetImplicit"],
	};
	const correlation: Record<string, unknown> = {};
	const correlationPaths: Record<string, string> = {};
	for (const [key, candidates] of Object.entries(pathCandidates)) {
		for (const jsonPath of candidates) {
			const selected = correlationValueAtPath(value, jsonPath);
			if (selected !== undefined && selected !== null && selected !== "") {
				correlation[key] = selected;
				correlationPaths[key] = jsonPath;
				break;
			}
		}
	}
	return Object.keys(correlation).length ? { correlation, correlationPaths } : {};
}

function summarizeJsonValue(value: unknown, absPath: string, fileSize: number): Record<string, unknown> {
	const correlation = extractArtifactCorrelation(value);
	if (Array.isArray(value)) return { path: absPath, bytes: fileSize, type: "array", count: value.length, ...correlation };
	if (value && typeof value === "object") return { path: absPath, bytes: fileSize, type: "object", keyCount: Object.keys(value).length, keys: Object.keys(value).slice(0, 40), ...correlation };
	return { path: absPath, bytes: fileSize, type: typeof value, ...correlation };
}

function readJson(text: string, fileSize: number, absPath: string, params: BrowserArtifactParams) {
	const parsed = tryJson(text);
	if (parsed === undefined) throw new ArtifactReaderError("ARTIFACT_JSON_INVALID", "Artifact JSON content is invalid", { path: absPath, bytes: fileSize });
	if (Array.isArray(params.pick) && params.pick.length) {
		const entries = params.pick.map((item) => {
			const selected = getJsonPath(parsed, item);
			return [item, selected.exists
				? { exists: true, jsonPath: item, value: compactJsonValueForArtifact(selected.value, params, item) }
				: missingJsonPathValue(parsed, item)];
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
		const value = missingJsonPathValue(parsed, jsonPath);
		return {
			mode: "json" as const,
			summary: {
				path: absPath,
				bytes: fileSize,
				type: "missing",
				exists: false,
				notFound: true,
				jsonPath,
				...(typeof value.nearestPath === "string" ? { nearestPath: value.nearestPath } : {}),
				...(typeof value.nearestType === "string" ? { nearestType: value.nearestType } : {}),
				...(Array.isArray(value.nearestKeys) ? { nearestKeys: value.nearestKeys } : {}),
			},
			jsonPath,
			value,
		};
	}
	const value = typeof selected.value === "string" ? jsonStringWindow(selected.value, params) : compactJsonValueForArtifact(selected.value, params, jsonPath);
	return {
		mode: "json" as const,
		summary: { ...summarizeJsonValue(selected.value, absPath, fileSize), exists: true, jsonPath },
		jsonPath,
		value,
	};
}

function globToRegExp(pattern: string): RegExp {
	const normalized = pattern.replace(/\\/g, "/");
	let out = "^";
	for (let i = 0; i < normalized.length; i += 1) {
		const ch = normalized[i];
		if (ch === "*") {
			if (normalized[i + 1] === "*") {
				out += ".*";
				i += 1;
			} else out += "[^/]*";
			continue;
		}
		if (ch === "?") {
			out += ".";
			continue;
		}
		out += /[|\\{}()[\]^$+?.]/.test(ch) ? `\\${ch}` : ch;
	}
	out += "$";
	return new RegExp(out, "i");
}

async function walkFiles(rootPath: string, out: string[]): Promise<void> {
	for (const entry of await readdir(rootPath, { withFileTypes: true })) {
		const child = path.join(rootPath, entry.name);
		if (entry.isDirectory()) await walkFiles(child, out);
		else out.push(child);
	}
}

async function resolveSearchPaths(params: BrowserArtifactParams, ctx?: BrowserArtifactContext): Promise<string[]> {
	if (Array.isArray(params.paths) && params.paths.length) return params.paths.map((item) => resolveInputPath(ctx, item));
	const root = resolveSearchRoot(ctx, params.root);
	const all: string[] = [];
	await walkFiles(root, all);
	const glob = String(params.glob || "**/*").trim() || "**/*";
	const matcher = globToRegExp(glob);
	return all.filter((file) => matcher.test(path.relative(root, file).replace(/\\/g, "/")));
}

async function searchMultipleArtifacts(params: BrowserArtifactParams, ctx?: BrowserArtifactContext) {
	const query = String(params.query || "");
	if (!query) throw new ArtifactReaderError("ARTIFACT_SEARCH_QUERY_REQUIRED", "browser_artifact search mode requires query");
	const files = await resolveSearchPaths(params, ctx);
	const maxFiles = Math.min(MAX_MULTI_ARTIFACT_FILES, Math.max(1, Math.floor(Number(params.maxFiles || 20))));
	const maxBytes = Math.min(MAX_ARTIFACT_READ_BYTES, Math.max(1, Math.floor(Number(params.maxBytes || MAX_MULTI_ARTIFACT_BYTES))));
	const maxMatchesPerFile = Math.min(MAX_MULTI_ARTIFACT_MATCHES_PER_FILE, Math.max(1, Math.floor(Number(params.maxMatchesPerFile || params.maxMatches || 10))));
	const maxTotalMatches = Math.min(MAX_MULTI_ARTIFACT_TOTAL_MATCHES, Math.max(1, Math.floor(Number(params.maxTotalMatches || 50))));
	const selected = files.slice(0, maxFiles);
	let consumedBytes = 0;
	let totalMatches = 0;
	let matchedFiles = 0;
	let truncatedFiles = 0;
	const snippets: SearchSnippet[] = [];
	const skippedFiles: SkippedFile[] = [];
	let hitByteLimit = false;
	let hitTotalMatchLimit = false;
	const perFileChars = Math.max(400, Math.floor(asPositiveInt(params.maxChars, 8_000) / Math.max(1, Math.min(selected.length, 4))));
	for (const file of selected) {
		const info = await stat(file);
		if (consumedBytes + info.size > maxBytes) {
			truncatedFiles += 1;
			hitByteLimit = true;
			skippedFiles.push({ path: file, reason: "exceeds_byte_limit", size: info.size });
			break;
		}
		consumedBytes += info.size;
		const single = await searchText(file, info.size, { ...params, path: file, maxMatches: Math.min(maxMatchesPerFile, maxTotalMatches - totalMatches) }, perFileChars);
		if (single.matches > 0) matchedFiles += 1;
		for (const snippet of single.snippets) {
			if (totalMatches >= maxTotalMatches) break;
			snippets.push({ ...snippet, path: file });
			totalMatches += 1;
		}
		if (single.matches >= maxMatchesPerFile) truncatedFiles += 1;
		if (totalMatches >= maxTotalMatches) {
			hitTotalMatchLimit = true;
			break;
		}
	}
	const truncation: TruncationInfo | undefined = hitTotalMatchLimit
		? { truncated: true, truncationReason: "total_match_limit", totalMatches, matchLimit: maxTotalMatches, ...(skippedFiles.length ? { skippedFiles } : {}) }
		: hitByteLimit
			? { truncated: true, truncationReason: "byte_limit", bytesRead: consumedBytes, byteLimit: maxBytes, skippedFiles }
			: undefined;
	return {
		mode: "search" as const,
		summary: {
			root: Array.isArray(params.paths) && params.paths.length ? undefined : resolveSearchRoot(ctx, params.root),
			glob: Array.isArray(params.paths) && params.paths.length ? undefined : String(params.glob || "**/*"),
			fileCount: files.length,
			searchedFiles: selected.length,
			matchedFiles,
			truncatedFiles,
			bytes: consumedBytes,
			limits: { maxFiles, maxBytes, maxMatchesPerFile, maxTotalMatches },
		},
		query,
		regex: params.regex === true,
		offset: Math.max(1, Math.floor(Number(params.offset || 1))),
		matches: totalMatches,
		nextOffset: null,
		snippets,
		...(truncation ? { truncation } : {}),
	};
}

function publicRequestedArtifactPath(requested: unknown): Record<string, unknown> {
	const text = String(requested || "").trim();
	if (!text) return {};
	return {
		requested: path.isAbsolute(text) ? "<absolute-path>" : text,
		...(path.isAbsolute(text) ? { requestedPathKind: "absolute" } : {}),
	};
}

async function statArtifact(absPath: string, requested: unknown): Promise<Stats> {
	try {
		return await stat(absPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			throw new ArtifactReaderError("ARTIFACT_NOT_FOUND", "Artifact path was not found", {
				...publicRequestedArtifactPath(requested),
				recovery: {
					nextActions: [
						"browser-pilot artifact --path <saved.path> --mode json --json-path data --json",
						"browser-pilot observe --mode scan --json",
					],
				},
			});
		}
		throw error;
	}
}

export async function readBrowserArtifact(params: BrowserArtifactParams, ctx?: BrowserArtifactContext): Promise<BrowserArtifactReadResult> {
	// H2: when --json-path (or --pick) is given without --mode, promote to json mode automatically.
	// Without this, --json-path was silently ignored and the full file was returned as text — agents
	// following the nextActions `read_saved_artifact mode=json jsonPath=X` hint, or just guessing
	// the flag, would get the whole file (blind-eval H2, n=2, bilibili+linux.do).
	const wantsJson = !!(params.jsonPath || (Array.isArray(params.pick) && params.pick.length));
	const hasQuery = typeof params.query === "string" && params.query.trim() !== "";
	// G-round mirror of H2: `query` is a search-mode param. When it is given without --mode (and not as a
	// targeted json read), promote to search mode instead of silently ignoring it and returning text from
	// offset 0 (blind-eval R-G Friction 6: agent passed query expecting it to locate text, got the file head).
	const modeParam = params.mode ?? (wantsJson ? "json" : hasQuery ? "search" : undefined);
	const mode = normalizeArtifactMode(modeParam);
	// `query` only does anything in search mode. Passing it alongside json/text/sample silently no-ops
	// (Friction 6). Fail with factual remediation pointing at the two real ways to find/window text.
	if (hasQuery && mode !== "search") {
		throw new ArtifactReaderError("ARTIFACT_QUERY_REQUIRES_SEARCH_MODE", "browser_artifact query is only used in mode=search; it is ignored in mode=" + mode, {
			mode,
			...(params.jsonPath ? { jsonPath: params.jsonPath } : {}),
			remediation: "To find text across the artifact run mode=search (a plain, non-regex query windows even a single very long line via contextChars). To window a known value instead, read it with jsonPath + columnOffset/columnLimit.",
		});
	}
	const maxChars = asPositiveInt(params.maxChars, 8_000);
	const targetedJsonRaw = mode === "json" && (
		(Array.isArray(params.pick) && params.pick.length > 0)
		|| (typeof params.jsonPath === "string" && params.jsonPath.trim() !== "" && params.jsonPath.trim() !== "$")
	);
	const redact = params.redact !== false && !targetedJsonRaw;
	if (mode !== "search" && (Array.isArray(params.paths) || params.root !== undefined || params.glob !== undefined)) {
		throw new ArtifactReaderError("ARTIFACT_MULTI_SEARCH_MODE_INVALID", "browser_artifact paths/root/glob are only valid for mode=search", { mode, root: params.root, glob: params.glob, pathCount: Array.isArray(params.paths) ? params.paths.length : 0 });
	}
	if (mode === "search" && ((Array.isArray(params.paths) && params.paths.length) || params.root !== undefined || params.glob !== undefined)) {
		return redactArtifactResult(await searchMultipleArtifacts(params, ctx), redact);
	}
	const absPath = resolveInputPath(ctx, params.path);
	const info = await statArtifact(absPath, params.path);
	let result: BrowserArtifactReadResult;
	if (mode === "json") {
		if (info.size > MAX_ARTIFACT_READ_BYTES) {
			throw new ArtifactReaderError("ARTIFACT_TOO_LARGE", `Artifact exceeds byte limit (${info.size} bytes, max ${MAX_ARTIFACT_READ_BYTES})`, { path: absPath, bytes: info.size, maxBytes: MAX_ARTIFACT_READ_BYTES });
		}
		result = readJson(await readFile(absPath, "utf8"), info.size, absPath, params);
		return redactArtifactResult(result, redact, targetedJsonRaw);
	}
	if (mode === "search") result = await searchText(absPath, info.size, params, maxChars);
	else if (mode === "sample") result = await sampleText(absPath, info.size, params, maxChars);
	else result = await readTextRange(absPath, info.size, params, maxChars);
	return redactArtifactResult(result, redact);
}
