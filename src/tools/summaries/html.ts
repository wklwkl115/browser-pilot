import { BROWSER_NOISE_ATTRIBUTE_NAMES, BROWSER_NOISE_ATTRIBUTE_PREFIXES, BROWSER_NOISE_CLASS_PATTERNS } from "../../scan/noiseRules.js";
import { truncateText } from "../../utils/json.js";
import { recordValue } from "../../utils/records.js";
import type { Summary } from "./common.js";

const NOISE_CLASS_PATTERN = BROWSER_NOISE_CLASS_PATTERNS.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const NOISE_ATTR_PATTERN = [...BROWSER_NOISE_ATTRIBUTE_NAMES, ...BROWSER_NOISE_ATTRIBUTE_PREFIXES.map((prefix) => `${prefix}(?:-[\\w:-]+)?`)]
	.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\\\(\?:-\[\\\\w:-\]\+\)\?/g, "(?:-[\\w:-]+)?"))
	.join("|");

function removeElementByClassPattern(html: string): string {
	if (!NOISE_CLASS_PATTERN) return html;
	let current = html;
	const classRe = new RegExp(`<([a-z0-9:-]+)\\b(?=[^>]*class=["'][^"']*(?:${NOISE_CLASS_PATTERN})[^"']*["'])[^>]*>[\\s\\S]*?<\\/\\1>`, "gi");
	for (let i = 0; i < 8; i += 1) {
		const next = current.replace(classRe, " ");
		if (next === current) break;
		current = next;
	}
	return current;
}

function stripNoiseAttributes(html: string): string {
	if (!NOISE_ATTR_PATTERN) return html;
	const attrRe = new RegExp(`\\s+(?:${NOISE_ATTR_PATTERN})(?:=["'][^"']*["']|=[^\\s>]+)?`, "gi");
	return html.replace(attrRe, "");
}

function removeKnownNoiseHtml(html: string): string {
	return stripNoiseAttributes(removeElementByClassPattern(html)
		.replace(/<read-frog\b[^>]*>[\s\S]*?<\/read-frog>/gi, " ")
		.replace(/<[^>]+id=["']aix-drop-panel["'][^>]*>[\s\S]*?(?=<[^>]+id=["']aix-supported-by["']|<\/body>|$)/gi, " ")
		.replace(/<[^>]+id=["']aix-supported-by["'][^>]*>[\s\S]*?<\/[^>]+>/gi, " ")
		.replace(/<[^>]+id=["']pi-browser-bridge-ind["'][^>]*>[\s\S]*?<\/[^>]+>/gi, " ")
		.replace(/<[^>]+id=["']goog-gt-tt["'][^>]*>[\s\S]*?<\/[^>]+>/gi, " ")
		.replace(/<[^>]+id=["']immersive-translate-popup["'][^>]*>[\s\S]*?<\/[^>]+>/gi, " "));
}

function stripHtml(html: string): string {
	return removeKnownNoiseHtml(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function numberValue(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() !== "") {
			const n = Number(value);
			if (Number.isFinite(n)) return n;
		}
	}
	return undefined;
}

export function summarizeHtmlSnapshot(html: string, meta: Record<string, unknown> = {}): Summary {
	const cleanedHtml = removeKnownNoiseHtml(html);
	const text = stripHtml(cleanedHtml);
	const tagCount = (name: string) => (cleanedHtml.match(new RegExp(`<${name}\\b`, "gi")) || []).length;
	const structure = recordValue(meta.structure);
	const metaCounts = recordValue(meta.counts) || recordValue(structure?.counts);
	const countValue = (key: string, fallbackTag: string) => numberValue(metaCounts?.[key]) ?? tagCount(fallbackTag);
	const metaTitles = Array.isArray(meta.titles) ? meta.titles : Array.isArray(structure?.titles) ? structure.titles : undefined;
	const titles = (metaTitles ? metaTitles.map((item) => String(item).slice(0, 200)) : Array.from(cleanedHtml.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)).map((match) => stripHtml(match[1]).slice(0, 200))).filter(Boolean).slice(0, 3);
	const textChars = numberValue(meta.text_length, meta.textLength, structure?.text_length, structure?.textLength) ?? text.length;
	return {
		selector: meta.selector,
		mode: meta.mode,
		chars: html.length,
		textChars,
		truncated: meta.truncated,
		original_length: meta.original_length,
		original_bytes: meta.original_bytes,
		titles,
		counts: {
			links: countValue("links", "a"),
			buttons: countValue("buttons", "button"),
			inputs: countValue("inputs", "input"),
			forms: countValue("forms", "form"),
			images: countValue("images", "img"),
		},
		textPreview: truncateText(text, 1_000).text,
	};
}
