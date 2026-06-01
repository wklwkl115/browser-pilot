import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { recordMemoryEntry } from "../../../src/tools/memory/store.ts";
import { readBrowserMemory } from "../../../src/tools/memory/reader.ts";

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

test("json read of a missing path returns a not-found marker, not a throw", async () => {
	const { cwd, id } = await seed();
	const missing = await readBrowserMemory({ cwd, id, mode: "json", jsonPath: "frontmatter.nope" });
	if (missing.mode !== "json") return;
	assert.deepEqual(missing.value, { exists: false, notFound: true, value: null });
});

test("read of an unknown id throws MEMORY_ENTRY_NOT_FOUND", async () => {
	const { cwd } = await seed();
	await assert.rejects(() => readBrowserMemory({ cwd, id: "sop_does_not_exist", mode: "text" }), (err: { code?: string }) => err.code === "MEMORY_ENTRY_NOT_FOUND");
});
