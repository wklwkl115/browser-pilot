import path from "node:path";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { recordValue } from "../utils/records.js";
import { parseJsonOrThrow, stableJson } from "../utils/json.js";
import { atomicWriteText } from "../utils/fsAtomic.js";
import { emptyMemoryOriginProfile, mergeProfiles } from "../kernels/memory/profile.js";
import type { MemoryOriginProfile } from "../kernels/memory/types.js";
import { memoryKernelEnabled } from "./secret.js";

const MEMORY_ROOT = ".browser-pilot/memory";
const PROFILE_DIR = "profiles";
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_PROFILE_ORIGINS = 64;

export type MemoryProfileReadResult = {
	profile?: MemoryOriginProfile;
	warning?: "memory_profile_unreadable" | "memory_profile_oversized";
};

function memoryRoot(cwd?: string): string {
	return path.resolve(cwd || process.cwd(), MEMORY_ROOT);
}

function safeOriginSlug(value: string): string {
	const normalized = String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return normalized || "origin";
}

export function fnv64Hex(value: string): string {
	let hash = 0xcbf29ce484222325n;
	const prime = 0x100000001b3n;
	for (const byte of Buffer.from(value, "utf8")) {
		hash ^= BigInt(byte);
		hash = BigInt.asUintN(64, hash * prime);
	}
	return hash.toString(16).padStart(16, "0");
}

export function memoryProfileFilePath(cwd: string | undefined, origin: string): string {
	return path.join(memoryRoot(cwd), PROFILE_DIR, `${safeOriginSlug(origin)}-${fnv64Hex(origin)}.json`);
}

function normalizeProfile(value: unknown, expectedOrigin: string): MemoryOriginProfile | undefined {
	const record = recordValue(value);
	if (!record || record.schemaVersion !== 1 || record.origin !== expectedOrigin) return undefined;
	const sessions = Array.isArray(record.sessions) ? record.sessions : [];
	const urls = Array.isArray(record.urls) ? record.urls : [];
	const termStats = recordValue(record.termStats) ?? {};
	const strikes = recordValue(record.strikes) ?? {};
	if (!sessions.every((item) => {
		const session = recordValue(item);
		return !!session && typeof session.sessionId === "string" && typeof session.capturedAt === "number" && Array.isArray(session.termKeys);
	})) return undefined;
	if (!urls.every((item) => {
		const url = recordValue(item);
		return !!url && typeof url.canonicalUrl === "string" && typeof url.capturedAt === "number";
	})) return undefined;
	return {
		schemaVersion: 1,
		origin: expectedOrigin,
		sessions: sessions as MemoryOriginProfile["sessions"],
		termStats: termStats as MemoryOriginProfile["termStats"],
		urls: urls as MemoryOriginProfile["urls"],
		strikes: Object.fromEntries(Object.entries(strikes).filter(([, item]) => typeof item === "number")) as Record<string, number>,
	};
}

function shrinkProfileToLimit(profile: MemoryOriginProfile): MemoryOriginProfile {
	let current = mergeProfiles(emptyMemoryOriginProfile(profile.origin), profile) ?? emptyMemoryOriginProfile(profile.origin);
	let rendered = stableJson(current);
	if (Buffer.byteLength(rendered, "utf8") <= MAX_PROFILE_BYTES) return current;
	for (const key of Object.keys(current.termStats).sort((a, b) => {
		const left = current.termStats[a]!;
		const right = current.termStats[b]!;
		return left.sessionCount - right.sessionCount || left.lastSeenAt - right.lastSeenAt || b.localeCompare(a);
	})) {
		delete current.termStats[key];
		rendered = stableJson(current);
		if (Buffer.byteLength(rendered, "utf8") <= MAX_PROFILE_BYTES) return current;
	}
	current = { ...current, urls: current.urls.slice(0, 2), sessions: current.sessions.slice(0, 2) };
	rendered = stableJson(current);
	if (Buffer.byteLength(rendered, "utf8") <= MAX_PROFILE_BYTES) return current;
	return emptyMemoryOriginProfile(profile.origin);
}

async function pruneProfileFiles(cwd: string | undefined, keepPath: string): Promise<void> {
	const dir = path.join(memoryRoot(cwd), PROFILE_DIR);
	const files = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json")).map((name) => path.join(dir, name));
	if (files.length <= MAX_PROFILE_ORIGINS) return;
	const withStats = await Promise.all(files.map(async (file) => ({ file, mtimeMs: (await stat(file).catch(() => undefined))?.mtimeMs ?? 0 })));
	for (const item of withStats.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file)).slice(0, Math.max(0, files.length - MAX_PROFILE_ORIGINS))) {
		if (path.resolve(item.file) === path.resolve(keepPath)) continue;
		await rm(item.file, { force: true }).catch(() => {});
	}
}

export async function readMemoryProfile(cwd: string | undefined, origin: string): Promise<MemoryProfileReadResult> {
	if (!memoryKernelEnabled()) return {};
	const filePath = memoryProfileFilePath(cwd, origin);
	const info = await stat(filePath).catch(() => undefined);
	if (!info) return {};
	if (info.size > MAX_PROFILE_BYTES) return { warning: "memory_profile_oversized" };
	try {
		const parsed = parseJsonOrThrow<unknown>(await readFile(filePath, "utf8"), filePath);
		const profile = normalizeProfile(parsed, origin);
		return profile ? { profile } : { warning: "memory_profile_unreadable" };
	} catch {
		return { warning: "memory_profile_unreadable" };
	}
}

export async function writeMemoryProfile(cwd: string | undefined, profile: MemoryOriginProfile): Promise<string | undefined> {
	if (!memoryKernelEnabled()) return undefined;
	const filePath = memoryProfileFilePath(cwd, profile.origin);
	const capped = shrinkProfileToLimit(profile);
	await atomicWriteText(filePath, `${stableJson(capped)}\n`);
	await pruneProfileFiles(cwd, filePath);
	return filePath;
}
