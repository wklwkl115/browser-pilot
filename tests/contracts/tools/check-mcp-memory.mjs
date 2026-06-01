import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const { recordMemoryEntry } = await import(new URL("../../../src/tools/memory/store.ts", import.meta.url).href);
const { listMemoryResources, resolveMemoryResourceUri, memoryResourceTemplates } = await import(new URL("../../../mcp/memoryResourceStore.ts", import.meta.url).href);
const { readMemoryResource } = await import(new URL("../../../mcp/memoryResourceReader.ts", import.meta.url).href);
const { resolveBrowserResultEvidence } = await import(new URL("../../../mcp/memoryResourceStore.ts", import.meta.url).href);
const { registerBrowserResultResource, clearResourceStore } = await import(new URL("../../../mcp/resourceStore.ts", import.meta.url).href);

const cwd = mkdtempSync(path.join(tmpdir(), "browser-memory-"));
const artifactPath = path.join(cwd, ".pi", "browser-artifacts", "evidence.json");
mkdirSync(path.dirname(artifactPath), { recursive: true });
writeFileSync(artifactPath, JSON.stringify({ ok: true, note: "artifact evidence" }), "utf8");

const recorded = await recordMemoryEntry({
	cwd,
	payload: {
		kind: "sop",
		url: "https://www.xiaohongshu.com/explore",
		title: "xhs like first result",
		triggers: ["xiaohongshu", "like"],
		body: "1. 搜索 AI\n2. 打开第一个结果\n3. 点赞\n",
		evidenceRefs: [artifactPath],
	},
});

const resources = await listMemoryResources(cwd);
assert(resources.some((item) => item.uri.startsWith("browser-memory://index")), "browser-memory://index must be listed");
const entryResource = resources.find((item) => item.uri.startsWith(`browser-memory://sop/${recorded.entry.id}`));
assert(entryResource, "recorded SOP resource must be listed");
assert(!entryResource.uri.includes(".pi") && !entryResource.uri.includes("browser-artifacts"), "browser-memory URI must not leak local paths");

const templates = memoryResourceTemplates();
assert(templates.some((item) => item.uriTemplate === "browser-memory://index"), "memory resource templates must include index");
assert(templates.some((item) => item.uriTemplate === "browser-memory://sop/{id}"), "memory resource templates must include sop/{id}");

const resolved = await resolveMemoryResourceUri(entryResource.uri, cwd);
assert(resolved?.filePath.endsWith(`${recorded.entry.id}.md`), "memory resource resolution must stay server-side on filePath");

const readIndex = await readMemoryResource("browser-memory://index?mode=json&jsonPath=entries[0].id", cwd);
assert(readIndex.ok, `memory index read must succeed: ${readIndex.ok ? "" : readIndex.error}`);
assert.equal(JSON.parse(readIndex.content.text), recorded.entry.id, "memory index jsonPath read must return the first entry id");

const readEntry = await readMemoryResource(`browser-memory://sop/${recorded.entry.id}?mode=text&offset=1&limit=2`, cwd);
assert(readEntry.ok, `memory entry read must succeed: ${readEntry.ok ? "" : readEntry.error}`);
assert(readEntry.content.text.includes("搜索 AI"), "memory entry text read must return bounded body text");

const unknown = await readMemoryResource("browser-memory://sop/does-not-exist", cwd);
assert(!unknown.ok && unknown.code === "RESOURCE_NOT_FOUND", "unknown memory resource must fail with RESOURCE_NOT_FOUND");

const stale = await readMemoryResource(`browser-memory://sop/${recorded.entry.id}?etag=stale-etag`, cwd);
assert(!stale.ok && stale.code === "MEMORY_RESOURCE_STALE", `etag-mismatched memory read must fail with MEMORY_RESOURCE_STALE: ${JSON.stringify(stale)}`);

const browserResultUri = registerBrowserResultResource({ kind: "raw-result", artifactPath, name: "test artifact" });
const resolvedEvidence = await resolveBrowserResultEvidence(browserResultUri);
assert(resolvedEvidence.ok, `browser-result evidence resolver must succeed: ${resolvedEvidence.ok ? "" : resolvedEvidence.error}`);
assert.equal(path.normalize(resolvedEvidence.path), path.normalize(artifactPath), "resolved browser-result evidence must return server-side artifact path");

clearResourceStore();
console.log("mcp memory ok");
