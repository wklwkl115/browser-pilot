import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText } from "../../utils/fsAtomic.js";
import { stableJson } from "../../utils/json.js";
import { parseMemoryEntry, serializeMemoryEntry } from "../../memory/frontmatter.js";
import { browserMemoryUriForEntry, loadMemoryEntries, readMemoryIndex, withMemoryLock, writeDerivedMemoryIndex } from "../../memory/indexStore.js";
import { normalizeMemoryEntryId } from "../../memory/ids.js";
import { memoryEntryDir, resolveMemoryPath } from "../../memory/paths.js";
import type { MemoryEntry, MemoryTombstone } from "../../memory/types.js";

export async function loadMemoryRepositoryEntries(cwd: string | undefined): Promise<MemoryEntry[]> {
	return await loadMemoryEntries(cwd);
}

export async function readMemoryRepositoryIndex(cwd: string | undefined): Promise<Awaited<ReturnType<typeof readMemoryIndex>>> {
	return await readMemoryIndex(cwd);
}

export async function withMemoryRepositoryLock<T>(cwd: string | undefined, fn: () => Promise<T>): Promise<T> {
	return await withMemoryLock(cwd, fn);
}

async function writeTombstone(cwd: string | undefined, value: MemoryTombstone): Promise<string> {
	const rel = path.join("tombstones", `${value.createdAt.replace(/[:.]/g, "-")}-${value.id}.json`);
	const abs = resolveMemoryPath(cwd, rel);
	await atomicWriteText(abs, `${stableJson(value)}\n`);
	return abs;
}

export async function saveMemoryRecord(options: {
	cwd?: string;
	entry: Omit<MemoryEntry, "relPath" | "etag">;
	supersededIds: string[];
}): Promise<{ entry: MemoryEntry; index: Awaited<ReturnType<typeof readMemoryIndex>> }> {
	const relPath = path.join(memoryEntryDir(), `${options.entry.id}.md`);
	const absPath = resolveMemoryPath(options.cwd, relPath);
	await atomicWriteText(absPath, serializeMemoryEntry(options.entry));
	for (const existingId of options.supersededIds) {
		await writeTombstone(options.cwd, {
			schemaVersion: 1,
			id: existingId,
			replacedById: options.entry.id,
			status: "deprecated",
			createdAt: options.entry.updatedAt,
			reason: "superseded",
		});
	}
	const index = await writeDerivedMemoryIndex(options.cwd);
	return { entry: { ...options.entry, relPath }, index };
}

export async function readBoundedMemoryBody(cwd: string | undefined, id: string, limits: { maxLines: number; maxChars: number }): Promise<string | undefined> {
	const safeId = normalizeMemoryEntryId(id);
	const rel = path.join(memoryEntryDir(), `${safeId}.md`);
	const text = await readFile(resolveMemoryPath(cwd, rel), "utf8").catch(() => undefined);
	if (!text) return undefined;
	const lines = parseMemoryEntry(text, rel).body.split(/\r?\n/);
	let body = lines.slice(0, limits.maxLines).join("\n");
	if (body.length > limits.maxChars) body = `${body.slice(0, limits.maxChars)}…`;
	else if (lines.length > limits.maxLines) body = `${body}\n…`;
	return body;
}

export { browserMemoryUriForEntry };
