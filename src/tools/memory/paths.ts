import path from "node:path";
import type { MemoryEntryKind } from "./types.js";

export const BROWSER_MEMORY_ROOT = ".pi/browser-memory";

export function resolveMemoryRoot(cwd?: string): string {
	return path.resolve(cwd || process.cwd(), BROWSER_MEMORY_ROOT);
}

export function resolveMemoryPath(cwd: string | undefined, ...parts: string[]): string {
	return path.join(resolveMemoryRoot(cwd), ...parts);
}

export function memoryEntryDir(kind: MemoryEntryKind): string {
	return kind === "sop" ? "sop" : "facts";
}

export function safeSlug(value: string): string {
	const normalized = String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return normalized || "entry";
}
