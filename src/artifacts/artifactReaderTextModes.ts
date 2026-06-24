import type { BrowserArtifactParams, SampleSnippet } from "./artifactReaderShared.js";
import { summaryFromStats } from "./artifactReaderShared.js";
import { boundedJoin, eachLine, lineWindow, positiveIntParam, textLineWindow } from "./artifactReaderLineUtils.js";

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

export async function sampleText(absPath: string, fileSize: number, params: BrowserArtifactParams, maxChars: number) {
	const perSection = Math.max(1, Math.floor(Number(params.limit || 20)));
	let onlyLine = "";
	const stats = await eachLine(absPath, (line, lineNumber) => { if (lineNumber === 1) onlyLine = line; });
	const { lineCount, chars } = stats;
	if (lineCount === 0) return { mode: "sample" as const, summary: summaryFromStats(fileSize, absPath, lineCount, chars), limit: perSection, snippets: [] };
	if (lineCount === 1) return singleLineSample(absPath, fileSize, params, maxChars, perSection, onlyLine, chars);
	return multiLineSample(absPath, fileSize, perSection, lineCount, maxChars, chars);
}

function singleLineSample(absPath: string, fileSize: number, params: BrowserArtifactParams, maxChars: number, perSection: number, onlyLine: string, chars: number) {
	const windowLength = positiveIntParam(params.contextChars ?? params.columnLimit, Math.max(1, Math.floor(maxChars / 3)), 40, Math.max(40, onlyLine.length));
	const candidates = [{ section: "head", start: 0 }, { section: "middle", start: Math.max(0, Math.floor(onlyLine.length / 2) - Math.floor(windowLength / 2)) }, { section: "tail", start: Math.max(0, onlyLine.length - windowLength) }];
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
	return { mode: "sample" as const, summary: { ...summaryFromStats(fileSize, absPath, 1, chars), sample: { requestedSections: candidates.length, returnedSections: snippets.length, singleLineWindows: true } }, limit: perSection, snippets };
}

async function multiLineSample(absPath: string, fileSize: number, perSection: number, lineCount: number, maxChars: number, chars: number) {
	const sections = [{ section: "head", start: 1, end: Math.min(lineCount, perSection) }, { section: "middle", start: Math.max(1, Math.floor(lineCount / 2) - Math.floor(perSection / 2)), end: Math.min(lineCount, Math.max(1, Math.floor(lineCount / 2) - Math.floor(perSection / 2)) + perSection - 1) }, { section: "tail", start: Math.max(1, lineCount - perSection + 1), end: lineCount }];
	const selectedRanges = dedupedRanges(sections);
	const selectedBySection = new Map<string, Array<{ line: number; text: string }>>();
	if (selectedRanges.length) await eachLine(absPath, (line, lineNumber) => collectSectionLines(selectedRanges, selectedBySection, line, lineNumber));
	const snippets = sectionSnippets(selectedRanges, selectedBySection, maxChars);
	return { mode: "sample" as const, summary: { ...summaryFromStats(fileSize, absPath, lineCount, chars), sample: { requestedSections: sections.length, returnedSections: snippets.length, dedupedSections: sections.length - selectedRanges.length } }, limit: perSection, snippets };
}

function dedupedRanges(sections: Array<{ section: string; start: number; end: number }>) {
	const usedRanges: Array<{ start: number; end: number }> = [];
	const selectedRanges: Array<{ section: string; requestedStart: number; start: number; end: number; dedupedSections: number }> = [];
	let dedupedSections = 0;
	for (const section of sections) {
		let start = section.start;
		let end = section.end;
		for (const range of usedRanges) if (!(range.end < start || range.start > end)) {
			if (range.start <= start) start = Math.max(start, range.end + 1);
			if (range.end >= end) end = Math.min(end, range.start - 1);
		}
		if (start > end) { dedupedSections += 1; continue; }
		selectedRanges.push({ section: section.section, requestedStart: section.start, start, end, dedupedSections });
		usedRanges.push({ start, end });
	}
	return selectedRanges;
}

function collectSectionLines(selectedRanges: Array<{ section: string; start: number; end: number }>, selectedBySection: Map<string, Array<{ line: number; text: string }>>, line: string, lineNumber: number): void {
	for (const section of selectedRanges) if (lineNumber >= section.start && lineNumber <= section.end) {
		const selected = selectedBySection.get(section.section) || [];
		selected.push({ line: lineNumber, text: line });
		selectedBySection.set(section.section, selected);
	}
}

function sectionSnippets(selectedRanges: Array<{ section: string; requestedStart: number; start: number; end: number; dedupedSections: number }>, selectedBySection: Map<string, Array<{ line: number; text: string }>>, maxChars: number) {
	const snippets: SampleSnippet[] = [];
	let used = 0;
	for (const section of selectedRanges) {
		const selected = selectedBySection.get(section.section) || [];
		const joined = boundedJoin(selected, Math.max(0, maxChars - used));
		if (!joined.text && snippets.length) break;
		snippets.push({ section: section.section, lineStart: section.start, lineEnd: joined.lineEnd, text: joined.text, truncated: joined.truncated, deduped: section.start !== section.requestedStart || section.end !== joined.lineEnd || section.dedupedSections > 0 });
		used += joined.text.length + 1;
		if (joined.truncated || used >= maxChars) break;
	}
	return snippets;
}
