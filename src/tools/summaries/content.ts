import { truncateText } from "../../utils/json";
import { asArray, isRecord, type Summary } from "./common";

export function summarizeContentData(data: unknown): Summary {
	if (!isRecord(data)) return { type: typeof data };
	const stats = isRecord(data.stats) ? data.stats : {};
	const markdown = typeof data.markdown === "string" ? data.markdown : "";
	const textPreview = typeof data.textPreview === "string" ? data.textPreview : markdown;
	return {
		url: data.url,
		title: data.title,
		selector: data.selector,
		rootTag: data.rootTag,
		rootId: data.rootId,
		rootClass: data.rootClass,
		markdownChars: stats.markdownChars ?? markdown.length,
		originalMarkdownChars: stats.originalMarkdownChars,
		textChars: stats.textChars,
		links: stats.links,
		images: stats.images,
		paragraphs: stats.paragraphs,
		headingsCount: stats.headings,
		truncated: stats.truncated,
		headings: asArray(data.headings).slice(0, 20),
		textPreview: truncateText(String(textPreview).replace(/\s+/g, " ").trim(), 1_000).text,
	};
}
