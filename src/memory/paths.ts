import path from "node:path";

export const BROWSER_MEMORY_ROOT = ".browser-pilot/memory";

export function resolveMemoryRoot(cwd?: string): string {
	return path.resolve(cwd || process.cwd(), BROWSER_MEMORY_ROOT);
}

export function resolveMemoryPath(cwd: string | undefined, ...parts: string[]): string {
	return path.join(resolveMemoryRoot(cwd), ...parts);
}

export function memoryEntryDir(): string {
	return "facts";
}
