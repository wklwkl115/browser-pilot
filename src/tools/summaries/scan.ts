import { asArray, isRecord, summaryTable, textPreview, type Summary } from "./common";

export function summarizeScanData(data: unknown, tabs: unknown[] = []): Summary {
	const item = isRecord(data) ? data : {};
	const content = typeof item.content === "string" ? item.content : "";
	const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const interactive = lines.filter((line) => /^<(a|button|input|textarea|select|option)\b/i.test(line)).slice(0, 40);
	const headings = lines.filter((line) => /^<h[1-6]\b/i.test(line) || /^#{1,6}\s/.test(line)).slice(0, 20);
	const actionables = asArray(item.actionables).filter(isRecord);
	const listHints = asArray(item.list_hints).filter(isRecord);
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
		top_layer: item.top_layer,
		tabs_count: tabs.length,
		list_hints: summaryTable(listHints, [
			{ key: "selector", value: (node) => node.selector },
			{ key: "itemCount", value: (node) => node.itemCount },
			{ key: "hiddenCount", value: (node) => node.hiddenCount },
			{ key: "firstItemPreview", value: (node) => node.firstItemPreview },
		], 12),
		actionables: summaryTable(actionables, [
			{ key: "index", value: (node) => node.index },
			{ key: "tag", value: (node) => node.tag },
			{ key: "role", value: (node) => node.role },
			{ key: "action", value: (node) => node.action || "" },
			{ key: "label", value: (node) => node.label || node.text },
			{ key: "selector", value: (node) => node.selector },
			{ key: "point", value: (node) => node.point },
			{ key: "hitOk", value: (node) => node.hitOk },
		], 30),
		interactive,
		headings,
		textPreview: textPreview(content, 1_500),
	};
}
