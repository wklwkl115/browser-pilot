import { ArtifactReaderError, MAX_ARTIFACT_SEARCH_REGEX_CHARS, MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS, type BrowserArtifactParams, type SearchSnippet, type TruncationInfo } from "./artifactReaderShared.js";
import { boundedJoin, compileArtifactSearchRegex, eachLine, matchColumns, positiveIntParam, searchLineWindow } from "./artifactReaderLineUtils.js";
import { summaryFromStats } from "./artifactReaderShared.js";

export async function searchText(absPath: string, fileSize: number, params: BrowserArtifactParams, maxChars: number) {
	const query = String(params.query || "");
	if (!query) throw new ArtifactReaderError("ARTIFACT_SEARCH_QUERY_REQUIRED", "browser_artifact search mode requires query");
	const offset = Math.max(1, Math.floor(Number(params.offset || 1)));
	const contextLines = Math.max(0, Math.floor(Number(params.contextLines ?? 2)));
	const maxMatches = Math.max(1, Math.floor(Number(params.maxMatches || 20)));
	const flags = params.ignoreCase === false ? "" : "i";
	const pattern = params.regex ? compileArtifactSearchRegex(query, flags) : undefined;
	const needle = params.ignoreCase === false ? query : query.toLowerCase();
	const state = { matches: [] as SearchSnippet[], ring: [] as Array<{ line: number; text: string }>, pending: undefined as undefined | { matchLine: number; lines: Array<{ line: number; text: string }>; remainingAfter: number; window: ReturnType<typeof searchLineWindow>; matchStart: number; matchEnd: number }, used: 0, lastRangeEnd: 0, regexTruncatedLines: 0 };
	const flushPending = () => {
		if (!state.pending) return;
		const joined = boundedJoin(state.pending.lines, Math.max(0, maxChars - state.used));
		if (joined.text || !state.matches.length) {
			state.matches.push({ lineStart: state.pending.lines[0]?.line || state.pending.matchLine, lineEnd: joined.lineEnd || state.pending.matchLine, matchLine: state.pending.matchLine, text: joined.text, truncated: joined.truncated || state.pending.window.truncatedBefore || state.pending.window.truncatedAfter, columnStart: state.pending.window.columnStart, columnEnd: state.pending.window.columnEnd, lineLength: state.pending.window.lineLength, truncatedBefore: state.pending.window.truncatedBefore, truncatedAfter: state.pending.window.truncatedAfter, matchColumnStart: state.pending.matchStart, matchColumnEnd: state.pending.matchEnd });
			state.used += joined.text.length + 1;
		}
		state.lastRangeEnd = state.pending.lines[state.pending.lines.length - 1]?.line || state.pending.matchLine;
		state.pending = undefined;
	};
	const stats = await eachLine(absPath, (line, lineNumber) => {
		if (state.pending) {
			state.pending.lines.push({ line: lineNumber, text: line });
			state.pending.remainingAfter -= 1;
			if (state.pending.remainingAfter <= 0) flushPending();
			if (state.matches.length >= maxMatches || state.used >= maxChars) return;
		}
		if (lineNumber < offset || state.matches.length >= maxMatches || state.used >= maxChars) return pushRing(state.ring, contextLines, lineNumber, line);
		if (pattern && line.length > MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS) state.regexTruncatedLines += 1;
		const match = matchColumns(line, params, pattern, needle);
		if (!match.matched || match.start === undefined || match.end === undefined) return pushRing(state.ring, contextLines, lineNumber, line);
		const before = state.ring.filter((item) => item.line > state.lastRangeEnd);
		const window = searchLineWindow(line, match.start, match.end, params, Math.max(0, maxChars - state.used));
		state.pending = { matchLine: lineNumber, lines: [...before, { line: lineNumber, text: window.text }], remainingAfter: contextLines, window, matchStart: match.start, matchEnd: match.end };
		if (contextLines === 0) flushPending();
		state.ring.splice(0, state.ring.length, { line: lineNumber, text: line });
	});
	flushPending();
	return finalizeSearch(absPath, fileSize, params, query, pattern, offset, maxMatches, maxChars, state, stats);
}

function pushRing(ring: Array<{ line: number; text: string }>, contextLines: number, lineNumber: number, line: string): void {
	ring.push({ line: lineNumber, text: line });
	if (ring.length > contextLines) ring.shift();
}

function finalizeSearch(absPath: string, fileSize: number, params: BrowserArtifactParams, query: string, pattern: RegExp | undefined, offset: number, maxMatches: number, maxChars: number, state: { matches: SearchSnippet[]; used: number; regexTruncatedLines: number }, stats: { lineCount: number; chars: number }) {
	const nextOffset = state.matches.length && state.matches[state.matches.length - 1].lineEnd < stats.lineCount ? state.matches[state.matches.length - 1].lineEnd + 1 : null;
	const truncation: TruncationInfo | undefined = state.matches.length >= maxMatches ? { truncated: true, truncationReason: "per_file_match_limit", matchesFound: state.matches.length, matchLimit: maxMatches } : state.used >= maxChars ? { truncated: true, truncationReason: "chars_budget", matchesFound: state.matches.length, bytesRead: stats.chars, byteLimit: maxChars } : undefined;
	return { mode: "search" as const, summary: { ...summaryFromStats(fileSize, absPath, stats.lineCount, stats.chars), search: { ...(pattern ? { regexMaxPatternChars: MAX_ARTIFACT_SEARCH_REGEX_CHARS, regexMaxLineChars: MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS, regexTruncatedLines: state.regexTruncatedLines } : {}), contextChars: positiveIntParam(params.contextChars, 800, 80, 20_000) } }, query, regex: params.regex === true, offset, matches: state.matches.length, nextOffset, snippets: state.matches, ...(truncation ? { truncation } : {}) };
}
