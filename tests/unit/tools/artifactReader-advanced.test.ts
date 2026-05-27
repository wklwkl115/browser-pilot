import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactReaderError, readBrowserArtifact } from "../../../src/tools/artifactReader.ts";

async function withArtifactRoot(run: (root: string) => Promise<void>) {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-artifact-reader-unit-"));
	try {
		await mkdir(path.join(tmp, ".pi", "browser-artifacts"), { recursive: true });
		await run(tmp);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

test("artifactReader returns explicit notFound JSON path values", async () => {
	await withArtifactRoot(async (cwd) => {
		const file = path.join(cwd, ".pi", "browser-artifacts", "data.json");
		await writeFile(file, JSON.stringify({ items: [{ id: 1 }] }), "utf8");
		const result = await readBrowserArtifact({ path: file, mode: "json", jsonPath: "items[9].id" }, { cwd });
		assert.deepEqual(result.value, { exists: false, notFound: true, jsonPath: "items[9].id", value: null });
	});
});

test("artifactReader keeps pick outputs aligned", async () => {
	await withArtifactRoot(async (cwd) => {
		const file = path.join(cwd, ".pi", "browser-artifacts", "data.json");
		await writeFile(file, JSON.stringify({ items: [{ id: 1 }] }), "utf8");
		const result = await readBrowserArtifact({ path: file, mode: "json", pick: ["items[0].id", "items[9].id"] }, { cwd });
		assert.equal(result.value["items[0].id"].exists, true);
		assert.equal(result.value["items[9].id"].notFound, true);
	});
});

test("artifactReader rejects multi-search options outside search mode", async () => {
	await withArtifactRoot(async (cwd) => {
		const file = path.join(cwd, ".pi", "browser-artifacts", "data.txt");
		await writeFile(file, "hello", "utf8");
		await assert.rejects(
			() => readBrowserArtifact({ path: file, mode: "text", root: ".pi/browser-artifacts" }, { cwd }),
			(error: unknown) => error instanceof ArtifactReaderError && error.code === "ARTIFACT_MULTI_SEARCH_MODE_INVALID",
		);
	});
});

test("artifactReader multi-search respects bounded result collection", async () => {
	await withArtifactRoot(async (cwd) => {
		const root = path.join(cwd, ".pi", "browser-artifacts", "multi");
		await mkdir(root, { recursive: true });
		await writeFile(path.join(root, "a.txt"), "needle\n", "utf8");
		await writeFile(path.join(root, "b.txt"), "needle\n", "utf8");
		const result = await readBrowserArtifact({ mode: "search", root: ".pi/browser-artifacts/multi", glob: "*.txt", query: "needle", maxFiles: 10, maxTotalMatches: 10, maxMatchesPerFile: 1 }, { cwd });
		assert.equal(result.mode, "search");
		assert.equal(result.matches, 2);
		assert.equal(result.snippets.length, 2);
		assert.ok(result.snippets.some((item) => String(item.path).includes("a.txt")));
		assert.ok(result.snippets.some((item) => String(item.path).includes("b.txt")));
	});
});
