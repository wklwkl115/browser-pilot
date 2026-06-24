import yaml from "js-yaml";
import { createCodedError } from "../utils/codedError.js";
import { isRecord } from "../utils/records.js";
import { normalizeMemoryEntryId } from "./ids.js";
import type { MemoryAnchors, MemoryEntry, MemoryFrontmatter } from "./types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

export function serializeMemoryEntry(entry: Omit<MemoryEntry, "relPath" | "etag">): string {
	const frontmatter: MemoryFrontmatter = {
		schemaVersion: 1,
		id: entry.id,
		title: entry.title,
		kind: entry.kind,
		triggers: entry.triggers,
		scopeKind: entry.scopeKind,
		scopeKey: entry.scopeKey,
		sensitivity: entry.sensitivity,
		status: entry.status,
		confidence: entry.confidence,
		verifiedAt: entry.verifiedAt,
		updatedAt: entry.updatedAt,
		evidenceRefs: entry.evidenceRefs,
		...(entry.anchors ? { anchors: entry.anchors } : {}),
	};
	return `---\n${yaml.dump(frontmatter, { lineWidth: 120, noRefs: true }).trimEnd()}\n---\n${entry.body.endsWith("\n") ? entry.body : `${entry.body}\n`}`;
}

function parseAnchors(value: unknown): MemoryAnchors | undefined {
	const record = asRecord(value);
	const canonicalUrl = typeof record.canonicalUrl === "string" ? record.canonicalUrl : undefined;
	const stampSetId = typeof record.stampSetId === "string" ? record.stampSetId : undefined;
	const fingerprintSummary = isRecord(record.fingerprintSummary) ? record.fingerprintSummary : undefined;
	return canonicalUrl || stampSetId || fingerprintSummary ? { canonicalUrl, stampSetId, fingerprintSummary } : undefined;
}

export function parseMemoryEntry(text: string, relPath: string): MemoryEntry {
	const match = FRONTMATTER_RE.exec(text);
	if (!match) throw createCodedError({ name: "MemoryFrontmatterError", code: "MEMORY_SCHEMA_INVALID", message: "memory entry missing YAML frontmatter", details: { relPath } });
	const frontmatter = asRecord(yaml.load(match[1]) ?? {});
	if (frontmatter.kind !== "fact") throw createCodedError({ name: "MemoryFrontmatterError", code: "MEMORY_SCHEMA_INVALID", message: "memory entry kind must be fact", details: { relPath } });
	const triggers = Array.isArray(frontmatter.triggers) ? frontmatter.triggers.filter((v): v is string => typeof v === "string") : [];
	const evidenceRefs = Array.isArray(frontmatter.evidenceRefs) ? frontmatter.evidenceRefs as MemoryEntry["evidenceRefs"] : [];
	return {
		schemaVersion: 1,
		id: normalizeMemoryEntryId(frontmatter.id),
		title: String(frontmatter.title || "").trim(),
		kind: "fact",
		triggers,
		scopeKind: frontmatter.scopeKind === "task" || frontmatter.scopeKind === "project" ? frontmatter.scopeKind : "origin",
		scopeKey: String(frontmatter.scopeKey || "").trim(),
		sensitivity: "local",
		status: frontmatter.status === "deprecated" ? "deprecated" : "active",
		confidence: frontmatter.confidence === "verified" || frontmatter.confidence === "high" || frontmatter.confidence === "medium" || frontmatter.confidence === "low" ? frontmatter.confidence : "verified",
		verifiedAt: String(frontmatter.verifiedAt || "").trim(),
		updatedAt: String(frontmatter.updatedAt || "").trim(),
		evidenceRefs,
		anchors: parseAnchors(frontmatter.anchors),
		body: match[2] || "",
		relPath,
	};
}
