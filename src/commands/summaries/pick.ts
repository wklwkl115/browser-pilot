import { asArray, isRecord, summaryTable, textPreview, type Summary } from "./common.js";

export function summarizePickData(data: unknown): Summary {
	if (!isRecord(data)) return { type: typeof data };
	const selections = asArray(data.selections).filter(isRecord).map((item) => {
		const attrs = isRecord(item.attributes) ? item.attributes : {};
		return {
			selector: item.selector,
			tagName: item.tag,
			id: item.id,
			role: item.role ?? attrs.role ?? null,
			textPreview: typeof item.text === "string" ? textPreview(item.text, 160) : item.text,
			ariaLabel: attrs["aria-label"] ?? null,
			type: attrs.type ?? null,
			href: attrs.href ?? null,
		};
	});
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
			{ key: "tagName", value: (item) => item.tagName },
			{ key: "role", value: (item) => item.role },
			{ key: "textPreview", value: (item) => item.textPreview },
			{ key: "ariaLabel", value: (item) => item.ariaLabel },
			{ key: "type", value: (item) => item.type },
			{ key: "href", value: (item) => item.href },
		], 10),
	};
}
