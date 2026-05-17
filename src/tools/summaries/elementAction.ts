import { asArray, isRecord, type Summary } from "./common";

function htmlSnippet(raw: Record<string, unknown>): string | undefined {
	return typeof raw.outerHtmlSnippet === "string" ? raw.outerHtmlSnippet.slice(0, 180) : undefined;
}

function compactElement(raw: unknown): Record<string, unknown> | undefined {
	if (!isRecord(raw)) return undefined;
	return {
		index: raw.index,
		selector: raw.selector,
		tagName: raw.tagName,
		id: raw.id,
		classes: asArray(raw.classes).slice(0, 6),
		role: raw.role,
		text: raw.text,
		visible: raw.visible,
		disabled: raw.disabled,
		type: raw.type,
		valueLength: raw.valueLength,
		rect: raw.rect,
		htmlSnippet: htmlSnippet(raw),
	};
}

export function summarizeElementActionData(data: unknown): Summary {
	if (!isRecord(data)) return { type: typeof data };
	const matches = asArray(data.matches).map(compactElement).filter(Boolean).slice(0, 20);
	const target = compactElement(data.target);
	return {
		action: data.action,
		url: data.url,
		title: data.title,
		selector: data.selector,
		index: data.index,
		visibleOnly: data.visibleOnly,
		totalMatches: data.totalMatches,
		filteredMatches: data.filteredMatches,
		returnedMatches: data.returnedMatches,
		clicked: data.clicked,
		submitted: data.submitted,
		redacted: data.redacted,
		valueLength: data.valueLength,
		finalValuePreview: typeof data.finalValue === "string" ? data.finalValue.slice(0, 300) : undefined,
		matches,
		target,
	};
}
