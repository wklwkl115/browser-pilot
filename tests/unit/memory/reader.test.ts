import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { recallMemory, recordMemoryEntry } from "../../../src/tools/memory/store.ts";
import { readBrowserMemory, readBrowserMemoryResource } from "../../../src/tools/memory/reader.ts";

async function seed() {
	const cwd = mkdtempSync(path.join(tmpdir(), "memory-reader-"));
	const artifactPath = path.join(cwd, ".pi", "browser-artifacts", "e.json");
	mkdirSync(path.dirname(artifactPath), { recursive: true });
	writeFileSync(artifactPath, "{}");
	const rec = await recordMemoryEntry({
		cwd,
		payload: { kind: "sop", url: "https://www.site.com/x", title: "reader entry", triggers: ["alpha", "beta"], body: "line one\nline two\nline three\nline four\n", evidenceRefs: [artifactPath] },
	});
	return { cwd, id: rec.entry.id };
}

test("text read honors offset/limit and reports nextOffset", async () => {
	const { cwd, id } = await seed();
	const r = await readBrowserMemory({ cwd, id, mode: "text", offset: 2, limit: 2 });
	assert.equal(r.mode, "text");
	if (r.mode !== "text") return;
	assert.equal(r.snippets[0].text, "line two\nline three");
	assert.equal(r.snippets[0].lineStart, 2);
	assert.equal(r.snippets[0].lineEnd, 3);
	assert.equal(r.nextOffset, 4, "nextOffset must point past the returned slice when more lines remain");
});

test("text read past the end returns no snippets and a null nextOffset", async () => {
	const { cwd, id } = await seed();
	const r = await readBrowserMemory({ cwd, id, mode: "text", offset: 99, limit: 5 });
	assert.equal(r.mode, "text");
	if (r.mode !== "text") return;
	assert.equal(r.snippets.length, 0);
	assert.equal(r.nextOffset, null);
});

test("json read resolves object and array jsonPaths", async () => {
	const { cwd, id } = await seed();
	const title = await readBrowserMemory({ cwd, id, mode: "json", jsonPath: "frontmatter.title" });
	assert.equal(title.mode, "json");
	if (title.mode !== "json") return;
	assert.equal(title.value, "reader entry");
	const trigger = await readBrowserMemory({ cwd, id, mode: "json", jsonPath: "frontmatter.triggers[1]" });
	if (trigger.mode !== "json") return;
	assert.equal(trigger.value, "beta");
});

test("jsonPath without explicit mode promotes memory entry reads to json", async () => {
	const { cwd, id } = await seed();
	const title = await readBrowserMemory({ cwd, id, jsonPath: "frontmatter.title" });
	assert.equal(title.mode, "json");
	if (title.mode !== "json") return;
	assert.equal(title.value, "reader entry");
});

test("browser-memory resource jsonPath without explicit mode reads json slice", async () => {
	const { cwd, id } = await seed();
	const result = await readBrowserMemoryResource(`browser-memory://sop/${id}?jsonPath=frontmatter.triggers[0]`, cwd);
	assert.equal(result.ok, true);
	assert.equal(result.ok ? JSON.parse(result.content.text) : undefined, "alpha");
});

test("browser-memory resource mode query is case-insensitive", async () => {
	const { cwd, id } = await seed();
	const result = await readBrowserMemoryResource(`browser-memory://sop/${id}?mode=JSON&jsonPath=frontmatter.title`, cwd);
	assert.equal(result.ok, true);
	assert.equal(result.ok ? JSON.parse(result.content.text) : undefined, "reader entry");
});

test("browser-memory resource kind must match the backing entry directory", async () => {
	const { cwd, id } = await seed();
	const direct = await readBrowserMemory({ cwd, id, mode: "text" });
	assert.equal(direct.mode, "text");
	const mismatched = await readBrowserMemoryResource(`browser-memory://fact/${id}`, cwd);
	assert.equal(mismatched.ok, false);
	assert.equal(mismatched.ok ? undefined : mismatched.code, "MEMORY_ENTRY_NOT_FOUND");
});

test("json read of a missing path returns a not-found marker, not a throw", async () => {
	const { cwd, id } = await seed();
	const missing = await readBrowserMemory({ cwd, id, mode: "json", jsonPath: "frontmatter.nope" });
	if (missing.mode !== "json") return;
	assert.deepEqual(missing.value, { exists: false, notFound: true, jsonPath: "frontmatter.nope", value: null });
});

test("read of an unknown id throws MEMORY_ENTRY_NOT_FOUND", async () => {
	const { cwd } = await seed();
	await assert.rejects(() => readBrowserMemory({ cwd, id: "sop_does_not_exist", mode: "text" }), (err: { code?: string }) => err.code === "MEMORY_ENTRY_NOT_FOUND");
});

test("direct read rejects ids that could become path traversal segments", async () => {
	const { cwd } = await seed();
	await assert.rejects(() => readBrowserMemory({ cwd, id: "..\\..\\..\\outside", mode: "text" }), (err: { code?: string }) => err.code === "MEMORY_SCHEMA_INVALID");
});

test("browser-memory resource rejects traversal ids before filesystem reads", async () => {
	const { cwd } = await seed();
	const outside = path.join(cwd, "outside.md");
	writeFileSync(outside, "---\nid: outside\ntitle: leaked\nkind: sop\ntriggers: []\n---\nSECRET BODY\n");
	const result = await readBrowserMemoryResource("browser-memory://sop/..\\..\\..\\outside", cwd);
	assert.equal(result.ok, false);
	assert.equal(result.ok ? undefined : result.code, "MEMORY_SCHEMA_INVALID");
	assert.equal(JSON.stringify(result).includes("SECRET BODY"), false);
	assert.equal(JSON.stringify(result).includes(outside), false);
});

test("recall rejects stored entries with traversal frontmatter ids", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "memory-recall-traversal-"));
	mkdirSync(path.join(cwd, ".pi", "browser-memory", "sop"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "browser-memory", "sop", "evil.md"), "---\nid: \"..\\\\..\\\\..\\\\outside\"\ntitle: needle leak\nkind: sop\ntriggers: [needle]\nscopeKind: origin\nscopeKey: example.com\nstatus: active\nconfidence: verified\nupdatedAt: 2026-06-08T00:00:00.000Z\nverifiedAt: 2026-06-08T00:00:00.000Z\nevidenceRefs: []\n---\nbenign\n");
	writeFileSync(path.join(cwd, "outside.md"), "---\nid: outside\ntitle: outside\nkind: sop\ntriggers: []\n---\nSECRET BODY\n");
	await assert.rejects(() => recallMemory({ cwd, query: "needle" }), (err: { code?: string }) => err.code === "MEMORY_SCHEMA_INVALID");
});
