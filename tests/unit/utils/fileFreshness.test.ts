import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeEtag, computeContentHash, isFreshEtag } from "../../../src/utils/fileFreshness.ts";

function withTempDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(path.join(tmpdir(), "fileFreshness-test-"));
	try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("computeEtag returns size-mtime string for existing file", () => {
	withTempDir((dir) => {
		const file = path.join(dir, "test.txt");
		writeFileSync(file, "hello");
		const etag = computeEtag(file);
		assert.ok(typeof etag === "string");
		assert.ok(etag!.includes("-"));
		const [size] = etag!.split("-");
		assert.equal(Number(size), 5);
	});
});

test("computeEtag returns undefined for missing file", () => {
	const etag = computeEtag("/nonexistent/path/file.txt");
	assert.equal(etag, undefined);
});

test("computeEtag changes when file content changes", () => {
	withTempDir((dir) => {
		const file = path.join(dir, "test.txt");
		writeFileSync(file, "original");
		const etag1 = computeEtag(file);
		writeFileSync(file, "changed content here");
		const etag2 = computeEtag(file);
		assert.notEqual(etag1, etag2);
	});
});

test("computeContentHash returns sha256 hex for existing file", () => {
	withTempDir((dir) => {
		const file = path.join(dir, "test.txt");
		writeFileSync(file, "hello");
		const hash = computeContentHash(file);
		assert.ok(typeof hash === "string");
		assert.ok(/^[0-9a-f]{64}$/.test(hash!));
	});
});

test("computeContentHash is deterministic", () => {
	withTempDir((dir) => {
		const file = path.join(dir, "test.txt");
		writeFileSync(file, "hello world");
		const hash1 = computeContentHash(file);
		const hash2 = computeContentHash(file);
		assert.equal(hash1, hash2);
	});
});

test("computeContentHash returns undefined for missing file", () => {
	const hash = computeContentHash("/nonexistent/path.txt");
	assert.equal(hash, undefined);
});

test("computeContentHash with jsonPath scopes to nested value", () => {
	withTempDir((dir) => {
		const file = path.join(dir, "data.json");
		writeFileSync(file, JSON.stringify({ a: { b: 42 }, c: "noise" }));
		const hashFull = computeContentHash(file);
		const hashScoped = computeContentHash(file, "$.a.b");
		const hashOther = computeContentHash(file, "$.c");
		assert.notEqual(hashFull, hashScoped);
		assert.notEqual(hashScoped, hashOther);
	});
});

test("computeContentHash with jsonPath returns undefined for missing path", () => {
	withTempDir((dir) => {
		const file = path.join(dir, "data.json");
		writeFileSync(file, JSON.stringify({ a: 1 }));
		const hash = computeContentHash(file, "$.nonexistent");
		assert.equal(hash, undefined);
	});
});

test("isFreshEtag returns true when etag matches", () => {
	withTempDir((dir) => {
		const file = path.join(dir, "test.txt");
		writeFileSync(file, "stable");
		const etag = computeEtag(file);
		assert.equal(isFreshEtag(file, etag), true);
	});
});

test("isFreshEtag returns false after file changes", () => {
	withTempDir((dir) => {
		const file = path.join(dir, "test.txt");
		writeFileSync(file, "original");
		const etag = computeEtag(file);
		writeFileSync(file, "modified file content that is longer");
		assert.equal(isFreshEtag(file, etag), false);
	});
});

test("isFreshEtag returns true when etag is undefined (no baseline)", () => {
	withTempDir((dir) => {
		const file = path.join(dir, "test.txt");
		writeFileSync(file, "hello");
		assert.equal(isFreshEtag(file, undefined), true);
	});
});
