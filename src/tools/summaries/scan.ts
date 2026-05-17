import { isRecord, textPreview, type Summary } from "./common";

export function summarizeScanData(data: unknown, tabs: unknown[] = []): Summary {
	const item = isRecord(data) ? data : {};
	const content = typeof item.content === "string" ? item.content : "";
	const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const interactive = lines.filter((line) => /^<(a|button|input|textarea|select|option)\b/i.test(line)).slice(0, 40);
	const headings = lines.filter((line) => /^<h[1-6]\b/i.test(line) || /^#{1,6}\s/.test(line)).slice(0, 20);
	return {
		url: item.url,
		title: item.title,
		readyState: item.readyState,
		text_only: item.text_only,
		contentChars: content.length,
		lineCount: lines.length,
		truncated: item.truncated,
		node_count: item.node_count,
		iframe_notes: item.iframe_notes,
		tabs_count: tabs.length,
		interactive,
		headings,
		textPreview: textPreview(content, 1_500),
	};
}
