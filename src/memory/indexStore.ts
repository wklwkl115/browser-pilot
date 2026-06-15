import path from "node:path";
import { readdir, readFile, mkdir, rm, stat, open } from "node:fs/promises";
import { parseJsonOrThrow, stableJson } from "../utils/json.js";
import { computeEtag } from "../utils/fileFreshness.js";
import { createCodedError } from "../utils/codedError.js";
import { atomicWriteText } from "../utils/fsAtomic.js";
import { parseMemoryEntry } from "./frontmatter.js";
import { memoryEntryDir, resolveMemoryPath } from "./paths.js";
import type { MemoryEntry, MemoryIndex, MemoryIndexEntry, MemoryTombstone } from "./types.js";
import { buildMemoryRoutingIndex } from "./routing.js";

export const EMPTY_MEMORY_INDEX: MemoryIndex = { schemaVersion: 1, generatedAt: "", entries: [], byScope: {}, routing: {} };

const LOCK_STALE_MS = 30_000;
// Generous retry budget: the lock is a local file and real contention is rare,
// but a saturated host (or many concurrent records) can briefly serialize behind
// it. ~3s worst case beats spuriously failing a write under load.
const LOCK_MAX_ATTEMPTS = 80;
const LOCK_RETRY_MS = 40;

async function walkFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const child = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...await walkFiles(child));
		else out.push(child);
	}
	return out;
}

export async function withMemoryLock<T>(cwd: string | undefined, fn: () => Promise<T>): Promise<T> {
	const root = resolveMemoryPath(cwd);
	const lockPath = path.join(root, ".lock");
	await mkdir(root, { recursive: true });
	let lastError: unknown;
	for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
		let handle;
		try {
			handle = await open(lockPath, "wx");
		} catch (error) {
			lastError = error;
			const info = await stat(lockPath).catch(() => undefined);
			if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
				await rm(lockPath, { force: true }).catch(() => {});
				continue;
			}
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS + (attempt % 5) * 10));
			continue;
		}
		try {
			await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
			return await fn();
		} finally {
			await handle.close().catch(() => {});
			await rm(lockPath, { force: true }).catch(() => {});
		}
	}
	throw createCodedError({ name: "MemoryLockError", code: "MEMORY_SCHEMA_INVALID", message: "browser_memory lock acquisition timed out", details: { lockPath, lastError: lastError instanceof Error ? lastError.message : String(lastError || "") } });
}

export async function loadMemoryEntries(cwd: string | undefined): Promise<MemoryEntry[]> {
	const root = resolveMemoryPath(cwd);
	const files = [
		...await walkFiles(path.join(root, memoryEntryDir("sop"))),
		...await walkFiles(path.join(root, memoryEntryDir("fact"))),
	].filter((file) => file.endsWith(".md"));
	const entries: MemoryEntry[] = [];
	for (const file of files) {
		const relPath = path.relative(root, file).replace(/\\/g, "/");
		const text = await readFile(file, "utf8");
		const parsed = parseMemoryEntry(text, relPath);
		parsed.etag = computeEtag(file);
		entries.push(parsed);
	}
	return entries.sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadTombstones(cwd: string | undefined): Promise<MemoryTombstone[]> {
	const root = resolveMemoryPath(cwd);
	const files = (await walkFiles(path.join(root, "tombstones"))).filter((file) => file.endsWith(".json"));
	const out: MemoryTombstone[] = [];
	for (const file of files) {
		const value = parseJsonOrThrow<MemoryTombstone>(await readFile(file, "utf8"), `memory tombstone ${file}`);
		out.push(value);
	}
	return out;
}

export function browserMemoryUriForEntry(entry: Pick<MemoryEntry, "kind" | "id"> & { etag?: string }): string {
	const base = `browser-memory://${entry.kind}/${entry.id}`;
	return entry.etag ? `${base}?etag=${encodeURIComponent(entry.etag)}` : base;
}

function indexEntry(entry: MemoryEntry, deprecatedIds: Set<string>): MemoryIndexEntry {
	return {
		id: entry.id,
		kind: entry.kind,
		title: entry.title,
		triggers: entry.triggers,
		scopeKind: entry.scopeKind,
		scopeKey: entry.scopeKey,
		status: deprecatedIds.has(entry.id) ? "deprecated" : entry.status,
		confidence: entry.confidence,
		updatedAt: entry.updatedAt,
		handles: [browserMemoryUriForEntry(entry)],
	};
}

export async function deriveMemoryIndex(cwd: string | undefined): Promise<MemoryIndex> {
	const entries = await loadMemoryEntries(cwd);
	const tombstones = await loadTombstones(cwd);
	const deprecatedIds = new Set(tombstones.map((item) => item.id));
	const indexed = entries.map((entry) => indexEntry(entry, deprecatedIds));
	const byScope: Record<string, string[]> = {};
	for (const entry of indexed) {
		// byScope is a live-scope lookup: deprecated entries stay visible in
		// entries[] (with status) but must not pollute a scope's active set.
		if (entry.status !== "active") continue;
		const key = `${entry.scopeKind}:${entry.scopeKey}`;
		(byScope[key] ||= []).push(entry.id);
	}
	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		entries: indexed.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)),
		byScope,
		routing: buildMemoryRoutingIndex(indexed),
	};
}

export async function writeDerivedMemoryIndex(cwd: string | undefined): Promise<MemoryIndex> {
	const index = await deriveMemoryIndex(cwd);
	await atomicWriteText(resolveMemoryPath(cwd, "index.json"), `${stableJson(index)}\n`);
	return index;
}

export async function readMemoryIndex(cwd: string | undefined): Promise<MemoryIndex> {
	const filePath = resolveMemoryPath(cwd, "index.json");
	try {
		return parseJsonOrThrow<MemoryIndex>(await readFile(filePath, "utf8"), filePath);
	} catch {
		return await writeDerivedMemoryIndex(cwd);
	}
}

export async function readMemoryIndexNoRepair(cwd: string | undefined): Promise<{ index: MemoryIndex; warning?: string }> {
	const filePath = resolveMemoryPath(cwd, "index.json");
	try {
		return { index: parseJsonOrThrow<MemoryIndex>(await readFile(filePath, "utf8"), filePath) };
	} catch (error) {
		const code = (error as { code?: string } | undefined)?.code;
		if (code === "ENOENT") return { index: EMPTY_MEMORY_INDEX };
		return { index: EMPTY_MEMORY_INDEX, warning: "memory_index_unreadable" };
	}
}

export async function writeMemoryAudit(cwd: string | undefined, name: string, value: unknown): Promise<string> {
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const rel = path.join("audit", `${ts}-${name}.json`);
	const abs = resolveMemoryPath(cwd, rel);
	await atomicWriteText(abs, `${stableJson(value)}\n`);
	return abs;
}
