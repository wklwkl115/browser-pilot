import { isBrowserPilotRef } from "./core.js";

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
