import { isRecord, toTabId } from "./records.js";

export type DetailLevel = "summary" | "preview" | "full";
export type ArtifactMode = "text" | "json" | "search" | "sample";

export function asPositiveInt(value: unknown, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.ceil(n) : fallback;
}

export function normalizeDetailLevel(value: unknown): DetailLevel {
	const text = String(value || "summary").trim().toLowerCase();
	if (text === "full") return "full";
	if (text === "preview") return "preview";
	return "summary";
}

export function normalizeArtifactMode(value: unknown): ArtifactMode {
	const mode = String(value || "text").trim().toLowerCase();
	if (mode === "json" || mode === "search" || mode === "sample") return mode;
	return "text";
}

export { isRecord };

export function normalizeTabId(value: unknown): number | undefined {
	return toTabId(value);
}
