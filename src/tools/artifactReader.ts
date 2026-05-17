import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { asPositiveInt, normalizeArtifactMode } from "../utils/params";

export const MAX_ARTIFACT_READ_BYTES = 25 * 1024 * 1024;

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
type SampleSnippet = TextSnippet & { section: string };

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
		if (used + value.length + 1 > maxChars) return { text: out.join("\n"), lineEnd, truncated: true };
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

async function readTextRange(absPath: string, fileSize: number, params: BrowserArtifactParams, maxChars: number) {
	const offset = Math.max(1, Math.floor(Number(params.offset || 1)));
	const limit = Math.max(1, Math.floor(Number(params.limit || 120)));
	const selected: Array<{ line: number; text: string }> = [];
	const lineCount = await eachLine(absPath, (line, lineNumber) => {
		if (lineNumber >= offset && lineNumber < offset + limit) selected.push({ line: lineNumber, text: line });
	});
	const joined = boundedJoin(selected, maxChars);
	const nextOffset = offset - 1 + selected.length < lineCount ? joined.lineEnd + 1 : null;
	return {
		mode: "text" as const,
		summary: summaryFromStats(fileSize, absPath, lineCount),
		offset,
		limit,
		nextOffset,
		snippets: [{ lineStart: offset, lineEnd: joined.lineEnd, text: joined.text, truncated: joined.truncated }],
	};
}

async function searchText(absPath: string, fileSize: number, params: BrowserArtifactParams, maxChars: number) {
	const query = String(params.query || "");
	if (!query) throw new ArtifactReaderError("ARTIFACT_SEARCH_QUERY_REQUIRED", "browser_artifact search mode requires query");
	const offset = Math.max(1, Math.floor(Number(params.offset || 1)));
	const contextLines = Math.max(0, Math.floor(Number(params.contextLines ?? 2)));
	const maxMatches = Math.max(1, Math.floor(Number(params.maxMatches || 20)));
	const flags = params.ignoreCase === false ? "" : "i";
	let pattern: RegExp | undefined;
	try { pattern = params.regex ? new RegExp(query, flags) : undefined; }
	catch (error) {
		throw new ArtifactReaderError("ARTIFACT_SEARCH_REGEX_INVALID", error instanceof Error ? error.message : String(error), { query, flags });
	}
	const needle = params.ignoreCase === false ? query : query.toLowerCase();
	const matches: SearchSnippet[] = [];
	const ring: Array<{ line: number; text: string }> = [];
	let pending: { matchLine: number; lines: Array<{ line: number; text: string }>; remainingAfter: number } | undefined;
	let used = 0;
	let lastRangeEnd = 0;
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
		const haystack = params.ignoreCase === false ? line : line.toLowerCase();
		const matched = pattern ? pattern.test(line) : haystack.includes(needle);
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
	return {
		mode: "search" as const,
		summary: summaryFromStats(fileSize, absPath, lineCount),
		query,
		regex: params.regex === true,
		offset,
		matches: matches.length,
		nextOffset: matches.length ? matches[matches.length - 1].lineEnd + 1 : null,
		snippets: matches,
	};
}

async function sampleText(absPath: string, fileSize: number, params: BrowserArtifactParams, maxChars: number) {
	const perSection = Math.max(1, Math.floor(Number(params.limit || 20)));
	let lineCount = 0;
	await eachLine(absPath, () => { lineCount += 1; });
	const sections = [
		{ name: "head", start: 1 },
		{ name: "middle", start: Math.max(1, Math.floor(lineCount / 2) - Math.floor(perSection / 2)) },
		{ name: "tail", start: Math.max(1, lineCount - perSection + 1) },
	];
	const snippets: SampleSnippet[] = [];
	let used = 0;
	for (const section of sections) {
		const selected: Array<{ line: number; text: string }> = [];
		await eachLine(absPath, (line, lineNumber) => {
			if (lineNumber >= section.start && lineNumber < section.start + perSection) selected.push({ line: lineNumber, text: line });
		});
		const joined = boundedJoin(selected, Math.max(0, maxChars - used));
		if (!joined.text && snippets.length) break;
		snippets.push({ section: section.name, lineStart: section.start, lineEnd: joined.lineEnd, text: joined.text, truncated: joined.truncated });
		used += joined.text.length + 1;
		if (joined.truncated || used >= maxChars) break;
	}
	return { mode: "sample" as const, summary: summaryFromStats(fileSize, absPath, lineCount), limit: perSection, snippets };
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

function getJsonPath(value: unknown, jsonPath: string | undefined): unknown {
	let current = value;
	for (const token of parseJsonPath(jsonPath || "$")) {
		if (current === null || current === undefined) return undefined;
		current = (current as Record<string, unknown> | unknown[])[token as never];
	}
	return current;
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
	let selected: unknown;
	if (Array.isArray(params.pick) && params.pick.length) {
		selected = Object.fromEntries(params.pick.map((item) => [item, getJsonPath(parsed, item)]));
	} else {
		selected = getJsonPath(parsed, params.jsonPath);
	}
	return {
		mode: "json" as const,
		summary: summarizeJsonValue(selected, absPath, fileSize),
		jsonPath: params.jsonPath || (params.pick?.length ? undefined : "$"),
		pick: params.pick,
		value: compactJsonValue(selected, params),
	};
}

export async function readBrowserArtifact(params: BrowserArtifactParams, ctx?: BrowserArtifactContext): Promise<BrowserArtifactReadResult> {
	const mode = normalizeArtifactMode(params.mode);
	const absPath = resolveInputPath(ctx, params.path);
	const info = await stat(absPath);
	if (info.size > MAX_ARTIFACT_READ_BYTES) {
		throw new ArtifactReaderError("ARTIFACT_TOO_LARGE", "Artifact is too large for browser_artifact text/json reader", { path: absPath, bytes: info.size, maxBytes: MAX_ARTIFACT_READ_BYTES });
	}
	const maxChars = asPositiveInt(params.maxChars, 8_000);
	if (mode === "json") return readJson(await readFile(absPath, "utf8"), info.size, absPath, params);
	if (mode === "search") return searchText(absPath, info.size, params, maxChars);
	if (mode === "sample") return sampleText(absPath, info.size, params, maxChars);
	return readTextRange(absPath, info.size, params, maxChars);
}
