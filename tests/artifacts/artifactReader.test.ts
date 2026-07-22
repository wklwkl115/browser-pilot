import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactReaderError, readBrowserArtifact } from "../../src/artifacts/artifactReader.ts";
import type { BrowserArtifactReadResult } from "../../src/artifacts/artifactReaderShared.ts";

function expectMode<M extends BrowserArtifactReadResult["mode"]>(result: BrowserArtifactReadResult, mode: M): Extract<BrowserArtifactReadResult, { mode: M }> {
	assert.equal(result.mode, mode);
	return result as Extract<BrowserArtifactReadResult, { mode: M }>;
}

function makeArtifactRoot() {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-artifacts-"));
	const root = path.join(cwd, ".browser-pilot", "artifacts");
	mkdirSync(root, { recursive: true });
	return { cwd, root };
}

test("jsonPath without mode promotes browser_artifact reads to json mode", async () => {
	const { cwd, root } = makeArtifactRoot();
	writeFileSync(path.join(root, "sample.json"), JSON.stringify({ data: { token: "secret-value", nested: { ok: true } } }), "utf8");
	const result = expectMode(await readBrowserArtifact({ path: ".browser-pilot/artifacts/sample.json", jsonPath: "data.nested" }, { cwd }), "json");
	assert.deepEqual(result.value, { ok: true });
	assert.equal((result.summary.privacy as Record<string, unknown>).redaction, "targeted_raw");
});

test("query without mode promotes browser_artifact reads to search mode", async () => {
	const { cwd, root } = makeArtifactRoot();
	writeFileSync(path.join(root, "sample.txt"), "alpha\nneedle here\nomega\n", "utf8");
	const result = expectMode(await readBrowserArtifact({ path: ".browser-pilot/artifacts/sample.txt", query: "needle" }, { cwd }), "search");
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
	const result = expectMode(await readBrowserArtifact({ path: ".browser-pilot/artifacts/headers.txt" }, { cwd }), "text");
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
	const result = expectMode(await readBrowserArtifact({ path: ".browser-pilot/artifacts/sample.json", pick: ["data.ok", "data.missing"] }, { cwd }), "json");
	const value = result.value as Record<string, { exists: boolean; notFound?: boolean }>;
	assert.equal(value["data.ok"].exists, true);
	assert.equal(value["data.missing"].exists, false);
	assert.equal(value["data.missing"].notFound, true);
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
	const result = expectMode(await readBrowserArtifact({ path: ".browser-pilot/artifacts/sample.json", jsonPath: "a.missing" }, { cwd }), "json");
	const value = result.value as { notFound: boolean; nearestPath: string; nearestKeys: string[] };
	assert.equal(value.notFound, true);
	assert.equal(value.nearestPath, "a");
	assert.deepEqual(value.nearestKeys, ["b"]);
});

test("single-line search windows preserve truncation metadata", async () => {
	const { cwd, root } = makeArtifactRoot();
	writeFileSync(path.join(root, "long.txt"), `${"x".repeat(500)}needle${"y".repeat(9_000)}\n`, "utf8");
	const result = expectMode(await readBrowserArtifact({ path: ".browser-pilot/artifacts/long.txt", mode: "search", query: "needle", contextChars: 80 }, { cwd }), "search");
	assert.equal(result.snippets[0]?.truncated, true);
	assert.equal(result.snippets[0]?.truncatedBefore, true);
	assert.equal(result.snippets[0]?.truncatedAfter, true);
	assert.match(result.snippets[0]?.text ?? "", /1: .*needle/);
});

test("missing artifact reads keep coded not-found recovery metadata", async () => {
	const { cwd } = makeArtifactRoot();
	await assert.rejects(
		readBrowserArtifact({ path: ".browser-pilot/artifacts/missing.json", mode: "json" }, { cwd }),
		(error: unknown) => {
			const nextActions = error instanceof ArtifactReaderError ? (error.details as { recovery?: { nextActions?: unknown[] } }).recovery?.nextActions : undefined;
				return error instanceof ArtifactReaderError && error.code === "ARTIFACT_NOT_FOUND" && Array.isArray(nextActions) && nextActions.includes("browser_observe") && nextActions.includes("call browser_artifact with mode=inspect and path=<saved.path>");
		},
	);
});

test("invalid json artifacts keep coded metadata without leaking content", async () => {
	const { cwd, root } = makeArtifactRoot();
	writeFileSync(path.join(root, "broken.json"), "{ not valid json", "utf8");
	await assert.rejects(
		readBrowserArtifact({ path: ".browser-pilot/artifacts/broken.json", mode: "json" }, { cwd }),
		(error: unknown) => error instanceof ArtifactReaderError && error.code === "ARTIFACT_JSON_INVALID" && (error.details as { bytes?: number }).bytes === 16 && !JSON.stringify(error.details).includes("not valid json"),
	);
});

test("absolute and relative artifact reads stay scoped to cwd", async () => {
	const first = makeArtifactRoot();
	const second = makeArtifactRoot();
	const outsidePath = path.join(first.root, "shared.txt");
	const insidePath = path.join(second.root, "shared.txt");
	writeFileSync(outsidePath, "first cwd artifact\n", "utf8");
	writeFileSync(insidePath, "second cwd artifact\n", "utf8");
	const relative = expectMode(await readBrowserArtifact({ path: ".browser-pilot/artifacts/shared.txt" }, { cwd: second.cwd }), "text");
	assert.match(relative.snippets[0]?.text ?? "", /second cwd/);
	const absolute = expectMode(await readBrowserArtifact({ path: insidePath }, { cwd: second.cwd }), "text");
	assert.match(absolute.snippets[0]?.text ?? "", /second cwd/);
	await assert.rejects(readBrowserArtifact({ path: outsidePath }, { cwd: second.cwd }), (error: unknown) => error instanceof ArtifactReaderError && error.code === "ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT");
});
