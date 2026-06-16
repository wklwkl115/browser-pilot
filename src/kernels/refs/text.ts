import { isBrowserPilotRef } from "./core.js";

const REF_TEXT_PATTERN = /\bbp-ref:\/\/[^\s)]+/g;

export function extractRefsFromText(text: string): string[] {
	const refs: string[] = [];
	for (const match of text.matchAll(REF_TEXT_PATTERN)) {
		const ref = match[0];
		if (isBrowserPilotRef(ref)) refs.push(ref);
	}
	return refs;
}

export function collectRefs(value: unknown): string[] {
	const refs: string[] = [];
	const walk = (item: unknown): void => {
		if (typeof item === "string") {
			if (isBrowserPilotRef(item)) refs.push(item);
			return;
		}
		if (!item || typeof item !== "object") return;
		if (Array.isArray(item)) {
			for (const child of item) walk(child);
			return;
		}
		for (const child of Object.values(item as Record<string, unknown>)) walk(child);
	};
	walk(value);
	return refs;
}
