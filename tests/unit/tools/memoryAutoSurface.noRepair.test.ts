import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendMemoryAutoSurface, __resetMemoryAutoSurfaceState } from "../../../src/tools/memory/autoSurface.ts";

function observeEnvelope(url: string) {
	return { tool: "browser_observe", detailLevel: "summary", summary: { url } };
}

test("automatic memory surface treats a corrupt index as empty and never repairs it", async () => {
	__resetMemoryAutoSurfaceState();
	const cwd = await mkdtemp(path.join(os.tmpdir(), "memory-autosurface-norepair-"));
	const indexPath = path.join(cwd, ".pi", "browser-memory", "index.json");
	mkdirSync(path.dirname(indexPath), { recursive: true });
	writeFileSync(indexPath, "{ definitely not json", "utf8");

	const out = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://example.test/") });
	assert.deepEqual(out.nextActions ?? [], [], "corrupt index is treated as an empty automatic memory index");
	assert.deepEqual(out.diagnostics?.warnings, ["memory_index_unreadable"], "the first corrupt automatic read emits one low-noise diagnostic");
	assert.equal(readFileSync(indexPath, "utf8"), "{ definitely not json", "automatic path must not repair or rewrite index.json");

	const second = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://example.test/") });
	assert.equal(second.diagnostics?.warnings, undefined, "the same corrupt index is not reported repeatedly in one process");
	assert.equal(readFileSync(indexPath, "utf8"), "{ definitely not json", "suppressed diagnostic still must not rewrite index.json");
});

test("automatic memory surface does not materialize the memory root for missing index", async () => {
	__resetMemoryAutoSurfaceState();
	const cwd = await mkdtemp(path.join(os.tmpdir(), "memory-autosurface-empty-"));
	const out = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://example.test/") });
	assert.deepEqual(out, observeEnvelope("https://example.test/"));
	assert.equal(existsSync(path.join(cwd, ".pi", "browser-memory")), false, "missing automatic memory must not materialize .pi/browser-memory");
});
