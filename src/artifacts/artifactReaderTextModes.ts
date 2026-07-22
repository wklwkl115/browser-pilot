import type { BrowserArtifactParams } from "./artifactReaderShared.js";
import { summaryFromStats } from "./artifactReaderShared.js";
import { boundedJoin, eachLine, textLineWindow } from "./artifactReaderLineUtils.js";

export async function readTextRange(absPath: string, fileSize: number, params: BrowserArtifactParams, maxChars: number) {
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
	const firstWindow = selected[0].window;
	return {
		mode: "text" as const,
		summary: summaryFromStats(fileSize, absPath, lineCount, chars),
		offset,
		limit,
		nextOffset: offset - 1 + selected.length < lineCount ? joined.lineEnd + 1 : null,
		snippets: [{ lineStart: selected[0].line, lineEnd: joined.lineEnd, text: joined.text, truncated: joined.truncated || !!firstWindow?.truncatedBefore || !!firstWindow?.truncatedAfter, ...(firstWindow ? { columnStart: firstWindow.columnStart, columnEnd: firstWindow.columnEnd, lineLength: firstWindow.lineLength, truncatedBefore: firstWindow.truncatedBefore, truncatedAfter: firstWindow.truncatedAfter } : {}) }],
	};
}
