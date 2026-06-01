import yaml from "js-yaml";
import { createCodedError } from "../../utils/codedError.js";
import { isRecord } from "../../utils/records.js";
import type { MemoryEntry, MemoryFrontmatter } from "./types.js";

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
	};
	return `---\n${yaml.dump(frontmatter, { lineWidth: 120, noRefs: true }).trimEnd()}\n---\n${entry.body.endsWith("\n") ? entry.body : `${entry.body}\n`}`;
}

export function parseMemoryEntry(text: string, relPath: string): MemoryEntry {
	const match = FRONTMATTER_RE.exec(text);
	if (!match) throw createCodedError({ name: "MemoryFrontmatterError", code: "MEMORY_SCHEMA_INVALID", message: "memory entry missing YAML frontmatter", details: { relPath } });
	const frontmatter = asRecord(yaml.load(match[1]) ?? {});
	const triggers = Array.isArray(frontmatter.triggers) ? frontmatter.triggers.filter((v): v is string => typeof v === "string") : [];
	const evidenceRefs = Array.isArray(frontmatter.evidenceRefs) ? frontmatter.evidenceRefs as MemoryEntry["evidenceRefs"] : [];
	return {
		schemaVersion: 1,
		id: String(frontmatter.id || "").trim(),
		title: String(frontmatter.title || "").trim(),
		kind: frontmatter.kind === "fact" ? "fact" : "sop",
		triggers,
		scopeKind: frontmatter.scopeKind === "task" || frontmatter.scopeKind === "project" ? frontmatter.scopeKind : "origin",
		scopeKey: String(frontmatter.scopeKey || "").trim(),
		sensitivity: "local",
		status: frontmatter.status === "deprecated" ? "deprecated" : "active",
		confidence: frontmatter.confidence === "verified" || frontmatter.confidence === "high" || frontmatter.confidence === "medium" || frontmatter.confidence === "low" ? frontmatter.confidence : "verified",
		verifiedAt: String(frontmatter.verifiedAt || "").trim(),
		updatedAt: String(frontmatter.updatedAt || "").trim(),
		evidenceRefs,
		body: match[2] || "",
		relPath,
	};
}
