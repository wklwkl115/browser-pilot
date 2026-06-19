import { createReadStream } from "node:fs";
import readline from "node:readline";
import { unsafeRegexReason } from "../utils/safeRegex.js";
import { ArtifactReaderError, MAX_ARTIFACT_SEARCH_REGEX_CHARS, MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS, type BrowserArtifactParams } from "./artifactReaderShared.js";

export function boundedJoin(lines: Array<{ line: number; text: string }>, maxChars: number): { text: string; lineEnd: number; truncated: boolean } {
	const out: string[] = [];
	let used = 0;
	let lineEnd = lines[0]?.line || 0;
	for (const item of lines) {
		const value = `${item.line}: ${item.text}`;
		if (used + value.length + 1 > maxChars) return truncatedJoin(out, value, item.line, used, maxChars, lineEnd);
		out.push(value);
		used += value.length + 1;
		lineEnd = item.line;
	}
	return { text: out.join("\n"), lineEnd, truncated: false };
}

function truncatedJoin(out: string[], value: string, line: number, used: number, maxChars: number, lineEnd: number) {
	const remaining = Math.max(0, maxChars - used - (out.length ? 1 : 0));
	if (remaining > 0) {
		out.push(value.slice(0, remaining));
		lineEnd = line;
	}
	return { text: out.join("\n"), lineEnd, truncated: true };
}

export function positiveIntParam(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function lineWindow(line: string, start: number, length: number) {
	const lineLength = line.length;
	const columnStart = Math.max(0, Math.min(lineLength, Math.floor(start)));
	const columnEnd = Math.max(columnStart, Math.min(lineLength, columnStart + Math.max(0, Math.floor(length))));
	return { text: line.slice(columnStart, columnEnd), columnStart, columnEnd, lineLength, truncatedBefore: columnStart > 0, truncatedAfter: columnEnd < lineLength };
}

export function textLineWindow(line: string, params: BrowserArtifactParams, maxChars: number) {
	if (params.columnOffset === undefined && params.columnLimit === undefined) return lineWindow(line, 0, line.length);
	const start = Math.max(0, Math.floor(Number(params.columnOffset || 0)));
	const limit = positiveIntParam(params.columnLimit, Math.max(1, maxChars), 1, Math.max(1, line.length));
	return lineWindow(line, start, limit);
}

export function searchLineWindow(line: string, matchStart: number, matchEnd: number, params: BrowserArtifactParams, maxChars: number) {
	const matchLength = Math.max(1, matchEnd - matchStart);
	const contextChars = positiveIntParam(params.contextChars, 800, 80, 20_000);
	const displayBudget = Math.max(matchLength, maxChars - 20);
	if (line.length <= Math.min(contextChars, displayBudget)) return lineWindow(line, 0, line.length);
	const windowLength = Math.min(line.length, Math.max(matchLength, Math.min(contextChars, displayBudget)));
	const side = Math.floor(Math.max(0, windowLength - matchLength) / 2);
	const start = Math.max(0, Math.min(line.length - windowLength, matchStart - side));
	return lineWindow(line, start, windowLength);
}

export function matchColumns(line: string, params: BrowserArtifactParams, pattern: RegExp | undefined, needle: string) {
	if (pattern) return matchRegex(line, pattern);
	const haystack = params.ignoreCase === false ? line : line.toLowerCase();
	const index = haystack.indexOf(needle);
	return index >= 0 ? { matched: true, start: index, end: index + needle.length } : { matched: false };
}

function matchRegex(line: string, pattern: RegExp) {
	const regexLine = line.length > MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS ? line.slice(0, MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS) : line;
	const match = pattern.exec(regexLine);
	pattern.lastIndex = 0;
	return match?.index !== undefined ? { matched: true, start: match.index, end: match.index + match[0].length } : { matched: false };
}

export async function eachLine(absPath: string, onLine: (line: string, lineNumber: number) => void | Promise<void>): Promise<{ lineCount: number; chars: number }> {
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

function describeUnsafeRegexReason(reason: string, query: string): string {
	if (reason === "pattern_too_long") return `regex exceeds ${MAX_ARTIFACT_SEARCH_REGEX_CHARS} characters`;
	if (reason === "input_too_long") return `regex input exceeds ${MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS} characters`;
	return `unsafe regex pattern: ${query}`;
}

export function compileArtifactSearchRegex(query: string, flags: string): RegExp {
	if (query.length > MAX_ARTIFACT_SEARCH_REGEX_CHARS) throw new ArtifactReaderError("ARTIFACT_SEARCH_REGEX_UNSAFE", describeUnsafeRegexReason("pattern_too_long", query), { maxChars: MAX_ARTIFACT_SEARCH_REGEX_CHARS, queryPreview: query.slice(0, 120) });
	const reason = unsafeRegexReason(query, MAX_ARTIFACT_SEARCH_REGEX_CHARS);
	if (reason) throw new ArtifactReaderError("ARTIFACT_SEARCH_REGEX_UNSAFE", describeUnsafeRegexReason(reason, query), { reason, queryPreview: query.slice(0, 120) });
	try {
		return new RegExp(query, flags);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ArtifactReaderError("ARTIFACT_SEARCH_REGEX_INVALID", `invalid regex: ${message}`, { queryPreview: query.slice(0, 120) });
	}
}
