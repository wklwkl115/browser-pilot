import { asArray, isRecord, summaryTable, textPreview, type Summary } from "./common.js";

export function summarizePickData(data: unknown): Summary {
	if (!isRecord(data)) return { type: typeof data };
	const selections = asArray(data.selections).filter(isRecord).map((item) => ({
		selector: item.selector,
		tag: item.tag,
		id: item.id,
		role: item.role,
		text: typeof item.text === "string" ? textPreview(item.text, 160) : item.text,
		rect: item.rect,
	}));
	return {
		url: data.url,
		title: data.title,
		message: data.message,
		cancelled: data.cancelled,
		reason: data.reason,
		selectedCount: data.selectedCount ?? selections.length,
		selectors: asArray(data.selectors).slice(0, 20),
		selections: summaryTable(selections, [
			{ key: "selector", value: (item) => item.selector },
			{ key: "tag", value: (item) => item.tag },
			{ key: "id", value: (item) => item.id },
			{ key: "role", value: (item) => item.role },
			{ key: "text", value: (item) => item.text },
		], 10),
	};
}
