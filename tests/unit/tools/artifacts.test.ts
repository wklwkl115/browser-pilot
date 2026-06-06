import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveArtifactPath, saveTextArtifact, saveDataUrl } from "../../../src/tools/artifacts.ts";

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
	const dir = mkdtempSync(path.join(tmpdir(), "artifacts-test-"));
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	try {
		const result = fn(dir);
		if (result && typeof (result as Promise<void>).then === "function") {
			return (result as Promise<void>).finally(cleanup);
		}
		cleanup();
		return Promise.resolve();
	} catch (e) {
		cleanup();
		return Promise.reject(e);
	}
}

// ── resolveArtifactPath ──────────────────────────────────────────────────────

test("resolveArtifactPath uses requested absolute path as-is", () => {
	withTempDir((dir) => {
		const absTarget = path.join(dir, "output.txt");
		const result = resolveArtifactPath({ cwd: dir }, absTarget, "fallback.txt");
		assert.equal(result, absTarget);
	});
});

test("resolveArtifactPath resolves relative requested path from cwd", () => {
	withTempDir((dir) => {
		const result = resolveArtifactPath({ cwd: dir }, "relative/out.txt", "fallback.txt");
		assert.equal(result, path.join(dir, "relative", "out.txt"));
	});
});

test("resolveArtifactPath uses fallback when requested is undefined", () => {
	withTempDir((dir) => {
		const result = resolveArtifactPath({ cwd: dir }, undefined, "fallback.txt");
		assert.ok(result.includes("fallback.txt"));
		assert.ok(result.includes("browser-artifacts"));
	});
});

test("resolveArtifactPath uses process.cwd() when ctx is undefined", () => {
	const result = resolveArtifactPath(undefined, undefined, "fallback.txt");
	assert.ok(path.isAbsolute(result));
	assert.ok(result.includes("fallback.txt"));
});

test("resolveArtifactPath ignores whitespace-only requested", () => {
	withTempDir((dir) => {
		const result = resolveArtifactPath({ cwd: dir }, "   ", "fallback.txt");
		assert.ok(result.includes("fallback.txt"));
	});
});

// ── saveTextArtifact ─────────────────────────────────────────────────────────

test("saveTextArtifact writes text to disk and returns metadata", async () => {
	await withTempDir(async (dir) => {
		const result = await saveTextArtifact({ cwd: dir }, "output.txt", "fallback.txt", "hello world");
		assert.ok(existsSync(result.path));
		assert.equal(result.chars, 11);
		assert.ok(result.bytes > 0);
		assert.ok(result.privacy !== undefined);
	});
});

test("saveTextArtifact creates nested directories", async () => {
	await withTempDir(async (dir) => {
		const result = await saveTextArtifact({ cwd: dir }, "nested/deep/out.txt", "fallback.txt", "content");
		assert.ok(existsSync(result.path));
	});
});

test("saveTextArtifact uses fallback path when no requested path", async () => {
	await withTempDir(async (dir) => {
		const result = await saveTextArtifact({ cwd: dir }, undefined, "auto-name.txt", "data");
		assert.ok(result.path.includes("auto-name.txt"));
		assert.ok(existsSync(result.path));
	});
});

// ── saveDataUrl ──────────────────────────────────────────────────────────────

test("saveDataUrl writes a valid PNG data URL to disk", async () => {
	await withTempDir(async (dir) => {
		// Minimal valid 1x1 transparent PNG in base64
		const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		const dataUrl = `data:image/png;base64,${png1x1}`;
		const outPath = path.join(dir, "screenshot.png");
		const result = await saveDataUrl(dataUrl, outPath);
		assert.ok(existsSync(result.path));
		assert.equal(result.mime, "image/png");
		assert.ok(result.bytes > 0);
	});
});

test("saveDataUrl throws for non-base64-data-URL input", async () => {
	await withTempDir(async (dir) => {
		await assert.rejects(
			() => saveDataUrl("https://example.com/image.png", path.join(dir, "out.png")),
			/not a base64 data URL/
		);
	});
});

test("saveDataUrl throws for invalid base64 payload", async () => {
	await withTempDir(async (dir) => {
		await assert.rejects(
			() => saveDataUrl("data:image/png;base64,!!!invalid!!!", path.join(dir, "out.png")),
			/invalid base64/
		);
	});
});
