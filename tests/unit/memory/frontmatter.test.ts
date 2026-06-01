import test from "node:test";
import assert from "node:assert/strict";
import { serializeMemoryEntry, parseMemoryEntry } from "../../../src/tools/memory/frontmatter.ts";
import type { MemoryEntry } from "../../../src/tools/memory/types.ts";

function sampleEntry(over: Partial<Omit<MemoryEntry, "relPath" | "etag">> = {}): Omit<MemoryEntry, "relPath" | "etag"> {
	return {
		schemaVersion: 1,
		id: "sop_20260601000000_deadbeef",
		title: "xhs like first result",
		kind: "sop",
		triggers: ["xiaohongshu", "like"],
		scopeKind: "origin",
		scopeKey: "xiaohongshu.com",
		sensitivity: "local",
		status: "active",
		confidence: "verified",
		verifiedAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-01T00:00:00.000Z",
		evidenceRefs: [{ kind: "artifact", path: ".pi/browser-artifacts/scan.json", etag: "1-2" }],
		body: "1. search\n2. open first\n3. like\n",
		...over,
	};
}

test("serialize -> parse round-trips all frontmatter fields", () => {
	const entry = sampleEntry();
	const parsed = parseMemoryEntry(serializeMemoryEntry(entry), "sop/x.md");
	for (const key of ["id", "title", "kind", "scopeKind", "scopeKey", "status", "confidence", "verifiedAt", "updatedAt"] as const) {
		assert.equal(parsed[key], entry[key], `field ${key} must round-trip`);
	}
	assert.deepEqual(parsed.triggers, entry.triggers);
	assert.deepEqual(parsed.evidenceRefs, entry.evidenceRefs);
	assert.equal(parsed.body.trim(), entry.body.trim());
	assert.equal(parsed.relPath, "sop/x.md");
});

test("parse preserves a body containing a --- line (non-greedy frontmatter)", () => {
	const entry = sampleEntry({ body: "intro\n---\nsection after a horizontal rule\n" });
	const parsed = parseMemoryEntry(serializeMemoryEntry(entry), "sop/x.md");
	assert(parsed.body.includes("section after a horizontal rule"), "body past a --- line must survive parsing");
});

test("parse throws on missing YAML frontmatter", () => {
	assert.throws(() => parseMemoryEntry("no frontmatter here", "sop/x.md"), (err: { code?: string }) => err.code === "MEMORY_SCHEMA_INVALID");
});

test("parse coerces unknown enum values to safe defaults", () => {
	const entry = sampleEntry();
	const tampered = serializeMemoryEntry(entry).replace("kind: sop", "kind: bogus").replace("status: active", "status: weird").replace("confidence: verified", "confidence: nonsense");
	const parsed = parseMemoryEntry(tampered, "sop/x.md");
	assert.equal(parsed.kind, "sop", "unknown kind defaults to sop");
	assert.equal(parsed.status, "active", "unknown status defaults to active");
	assert.equal(parsed.confidence, "verified", "unknown confidence defaults to verified");
});
