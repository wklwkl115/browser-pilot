import { asArray, isRecord, type Summary } from "./common";

export function summarizePickData(data: unknown): Summary {
	if (!isRecord(data)) return { type: typeof data };
	const selections = asArray(data.selections).filter(isRecord);
	return {
		url: data.url,
		title: data.title,
		message: data.message,
		cancelled: data.cancelled,
		reason: data.reason,
		selectedCount: data.selectedCount ?? selections.length,
		selectors: asArray(data.selectors).slice(0, 20),
		selections: selections.slice(0, 10).map((item) => ({
			selector: item.selector,
			tag: item.tag,
			id: item.id,
			role: item.role,
			text: item.text,
			rect: item.rect,
		})),
	};
}
