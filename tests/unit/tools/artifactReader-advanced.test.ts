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

test("artifactReader promotes a bare query (no mode) to search mode", async () => {
	// R-G mirror of H2: query alone must not be silently ignored and return the file head.
	await withArtifactRoot(async (cwd) => {
		const file = path.join(cwd, ".pi", "browser-artifacts", "doc.txt");
		await writeFile(file, "alpha\nbeta needle gamma\ndelta\n", "utf8");
		const result = await readBrowserArtifact({ path: file, query: "needle" }, { cwd });
		assert.equal(result.mode, "search");
		assert.ok(result.matches >= 1);
	});
});

test("artifactReader rejects query combined with a json/jsonPath read instead of silently ignoring it", async () => {
	// R-G Friction 6: agent passed mode=json jsonPath + query expecting it to locate text; query was a no-op.
	await withArtifactRoot(async (cwd) => {
		const file = path.join(cwd, ".pi", "browser-artifacts", "data.json");
		await writeFile(file, JSON.stringify({ markdown: "Linux kernel source tree" }), "utf8");
		await assert.rejects(
			() => readBrowserArtifact({ path: file, jsonPath: "markdown", query: "Linux kernel" }, { cwd }),
			(error: unknown) => error instanceof ArtifactReaderError && error.code === "ARTIFACT_QUERY_REQUIRES_SEARCH_MODE",
		);
	});
});

test("artifactReader plain-text search windows a single very long line (no regex)", async () => {
	// G5 capability proof: a plain (non-regex) query locates + windows a match inside one huge line,
	// unlike regex which is skipped past MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS.
	await withArtifactRoot(async (cwd) => {
		const file = path.join(cwd, ".pi", "browser-artifacts", "oneline.txt");
		const longLine = "x".repeat(300_000) + "NEEDLE_TOKEN" + "y".repeat(300_000);
		await writeFile(file, longLine, "utf8");
		const result = await readBrowserArtifact({ path: file, mode: "search", query: "NEEDLE_TOKEN", contextChars: 200 }, { cwd });
		assert.equal(result.mode, "search");
		assert.equal(result.matches, 1);
		assert.ok(String(result.snippets[0].text).includes("NEEDLE_TOKEN"));
		assert.ok(result.snippets[0].truncated === true, "a 600KB line match must be returned as a bounded window, not the whole line");
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

test("artifactReader streaming text modes preserve char and sample semantics", async () => {
	await withArtifactRoot(async (cwd) => {
		const file = path.join(cwd, ".pi", "browser-artifacts", "crlf.txt");
		const text = "alpha\r\nbeta needle\r\ngamma\r\ndelta\r\nepsilon";
		await writeFile(file, text, "utf8");
		const textResult = await readBrowserArtifact({ path: file, mode: "text", offset: 2, limit: 2 }, { cwd });
		const searchResult = await readBrowserArtifact({ path: file, mode: "search", query: "needle", contextLines: 1 }, { cwd });
		const sampleResult = await readBrowserArtifact({ path: file, mode: "sample", limit: 1, maxChars: 1_000 }, { cwd });
		assert.equal(textResult.summary.chars, text.length);
		assert.equal(searchResult.summary.chars, text.length);
		assert.equal(sampleResult.summary.chars, text.length);
		assert.equal(textResult.summary.lineCount, 5);
		assert.equal(searchResult.matches, 1);
		for (let i = 1; i < sampleResult.snippets.length; i += 1) {
			assert.ok(sampleResult.snippets[i].lineStart > sampleResult.snippets[i - 1].lineEnd, "sample snippets must remain non-overlapping after one-pass collection");
		}
	});
});
