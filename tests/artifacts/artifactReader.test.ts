import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactReaderError, readBrowserArtifact } from "../../src/artifacts/artifactReader.ts";

function makeArtifactRoot() {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-artifacts-"));
	const root = path.join(cwd, ".browser-pilot", "artifacts");
	mkdirSync(root, { recursive: true });
	return { cwd, root };
}

test("jsonPath without mode promotes browser_artifact reads to json mode", async () => {
	const { cwd, root } = makeArtifactRoot();
	writeFileSync(path.join(root, "sample.json"), JSON.stringify({ data: { token: "secret-value", nested: { ok: true } } }), "utf8");
	const result = await readBrowserArtifact({ path: ".browser-pilot/artifacts/sample.json", jsonPath: "data.nested" }, { cwd });
	assert.equal(result.mode, "json");
	assert.deepEqual(result.value, { ok: true });
	assert.equal(result.summary.privacy?.redaction, "targeted_raw");
});

test("query without mode promotes browser_artifact reads to search mode", async () => {
	const { cwd, root } = makeArtifactRoot();
	writeFileSync(path.join(root, "sample.txt"), "alpha\nneedle here\nomega\n", "utf8");
	const result = await readBrowserArtifact({ path: ".browser-pilot/artifacts/sample.txt", query: "needle" }, { cwd });
	assert.equal(result.mode, "search");
	assert.equal(result.matches, 1);
	assert.match(result.snippets[0]?.text ?? "", /needle here/);
});

test("relative paths outside .browser-pilot/artifacts are rejected", async () => {
	const { cwd } = makeArtifactRoot();
	await assert.rejects(
		readBrowserArtifact({ path: "../escape.txt" }, { cwd }),
		(error: unknown) => error instanceof ArtifactReaderError && error.code === "ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT",
	);
});

test("default text reads redact authorization-like lines", async () => {
	const { cwd, root } = makeArtifactRoot();
	writeFileSync(path.join(root, "headers.txt"), "Authorization: Bearer top-secret-token\nBody: ok\n", "utf8");
	const result = await readBrowserArtifact({ path: ".browser-pilot/artifacts/headers.txt" }, { cwd });
	assert.equal(result.mode, "text");
	assert.match(result.snippets[0]?.text ?? "", /Authorization: \[redacted\]/i);
	assert.doesNotMatch(result.snippets[0]?.text ?? "", /top-secret-token/);
});

test("query outside search mode raises an explicit coded error", async () => {
	const { cwd, root } = makeArtifactRoot();
	writeFileSync(path.join(root, "sample.json"), JSON.stringify({ data: { ok: true } }), "utf8");
	await assert.rejects(
		readBrowserArtifact({ path: ".browser-pilot/artifacts/sample.json", mode: "json", query: "ok" }, { cwd }),
		(error: unknown) => error instanceof ArtifactReaderError && error.code === "ARTIFACT_QUERY_REQUIRES_SEARCH_MODE",
	);
});

test("pick keeps one aligned entry per requested path", async () => {
	const { cwd, root } = makeArtifactRoot();
	writeFileSync(path.join(root, "sample.json"), JSON.stringify({ data: { ok: true } }), "utf8");
	const result = await readBrowserArtifact({ path: ".browser-pilot/artifacts/sample.json", pick: ["data.ok", "data.missing"] }, { cwd });
	assert.equal(result.mode, "json");
	assert.equal(result.value["data.ok"].exists, true);
	assert.equal(result.value["data.missing"].exists, false);
	assert.equal(result.value["data.missing"].notFound, true);
});

test("multi-artifact search keeps per-match file paths", async () => {
	const { cwd, root } = makeArtifactRoot();
	writeFileSync(path.join(root, "a.txt"), "needle-a\n", "utf8");
	writeFileSync(path.join(root, "b.txt"), "needle-b\n", "utf8");
	const result = await readBrowserArtifact({ mode: "search", root: ".browser-pilot/artifacts", glob: "*.txt", query: "needle" }, { cwd });
	assert.equal(result.mode, "search");
	assert.equal(result.matches, 2);
	assert.ok(result.snippets.every((snippet) => typeof snippet.path === "string" && snippet.path.endsWith(".txt")));
});

test("sample mode keeps the current head-only window when sections collapse", async () => {
	const { cwd, root } = makeArtifactRoot();
	writeFileSync(path.join(root, "sample.txt"), "zero\none\ntwo\nthree\n", "utf8");
	const result = await readBrowserArtifact({ path: ".browser-pilot/artifacts/sample.txt", mode: "sample", offset: 5, limit: 8 }, { cwd });
	assert.equal(result.mode, "sample");
	assert.equal(result.summary.sample.returnedSections, 1);
	assert.equal(result.snippets[0]?.section, "head");
	assert.match(result.snippets[0]?.text ?? "", /^1: zero/m);
});

test("non-search multi-artifact params keep their coded rejection", async () => {
	const { cwd, root } = makeArtifactRoot();
	writeFileSync(path.join(root, "sample.txt"), "alpha\n", "utf8");
	await assert.rejects(
		readBrowserArtifact({ path: ".browser-pilot/artifacts/sample.txt", mode: "text", glob: "*.txt" }, { cwd }),
		(error: unknown) => error instanceof ArtifactReaderError && error.code === "ARTIFACT_MULTI_SEARCH_MODE_INVALID",
	);
});

test("invalid regex search keeps the current coded error", async () => {
	const { cwd, root } = makeArtifactRoot();
	writeFileSync(path.join(root, "sample.txt"), "alpha\nneedle here\nomega\n", "utf8");
	await assert.rejects(
		readBrowserArtifact({ path: ".browser-pilot/artifacts/sample.txt", mode: "search", query: "[", regex: true }, { cwd }),
		(error: unknown) => error instanceof ArtifactReaderError && error.code === "ARTIFACT_SEARCH_REGEX_INVALID",
	);
});

test("missing jsonPath reports nearest-path metadata", async () => {
	const { cwd, root } = makeArtifactRoot();
	writeFileSync(path.join(root, "sample.json"), JSON.stringify({ a: { b: { c: 1 } } }), "utf8");
	const result = await readBrowserArtifact({ path: ".browser-pilot/artifacts/sample.json", jsonPath: "a.missing" }, { cwd });
	assert.equal(result.mode, "json");
	assert.equal(result.value.notFound, true);
	assert.equal(result.value.nearestPath, "a");
	assert.deepEqual(result.value.nearestKeys, ["b"]);
});

test("single-line search windows preserve truncation metadata", async () => {
	const { cwd, root } = makeArtifactRoot();
	writeFileSync(path.join(root, "long.txt"), `prefix ${"x".repeat(500)} suffix\n`, "utf8");
	const result = await readBrowserArtifact({ path: ".browser-pilot/artifacts/long.txt", mode: "search", query: "xxx", maxChars: 20 }, { cwd });
	assert.equal(result.mode, "search");
	assert.equal(result.snippets[0]?.truncated, true);
	assert.equal(result.snippets[0]?.truncatedBefore, true);
	assert.equal(result.snippets[0]?.truncatedAfter, true);
	assert.match(result.snippets[0]?.text ?? "", /1: xxx/);
});

test("artifactReader refactor target stays within the file-size budget", () => {
	const filePath = path.join(process.cwd(), "src/artifacts/artifactReader.ts");
	const lines = readFileSync(filePath, "utf8").split(/\r?\n/).length;
	assert.ok(lines <= 200, `expected src/artifacts/artifactReader.ts to stay within 200 lines, got ${lines}`);
});
