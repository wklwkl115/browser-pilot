import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	asUploadFiles,
	requireDownloadTarget,
	normalizeTransferDownloadMode,
	requireUploadConfirmation,
	rejectUnsafeExecuteCommand,
	checkedUploadFiles,
} from "../../../src/tools/transferValidation.ts";

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
	const dir = mkdtempSync(path.join(tmpdir(), "transfer-test-"));
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

// ── asUploadFiles ────────────────────────────────────────────────────────────

test("asUploadFiles handles string input", () => {
	assert.deepEqual(asUploadFiles("/path/to/file.txt"), ["/path/to/file.txt"]);
});

test("asUploadFiles handles array input", () => {
	assert.deepEqual(asUploadFiles(["/a.txt", "/b.txt"]), ["/a.txt", "/b.txt"]);
});

test("asUploadFiles filters empty/whitespace values", () => {
	assert.deepEqual(asUploadFiles(["  ", "", "/valid.txt"]), ["/valid.txt"]);
});

test("asUploadFiles trims whitespace from paths", () => {
	assert.deepEqual(asUploadFiles(["  /trimmed.txt  "]), ["/trimmed.txt"]);
});

test("asUploadFiles handles non-string non-array as empty", () => {
	assert.deepEqual(asUploadFiles(null), []);
	assert.deepEqual(asUploadFiles(undefined), []);
	assert.deepEqual(asUploadFiles(42), []);
});

// ── requireDownloadTarget ────────────────────────────────────────────────────

test("requireDownloadTarget passes when url is provided", () => {
	assert.doesNotThrow(() => requireDownloadTarget({ url: "https://example.com/file.pdf" }));
});

test("requireDownloadTarget passes when selector is provided", () => {
	assert.doesNotThrow(() => requireDownloadTarget({ selector: "#download-btn" }));
});

test("requireDownloadTarget throws when neither url nor selector", () => {
	assert.throws(() => requireDownloadTarget({}), /requires selector or url/);
});

test("requireDownloadTarget throws for empty url and selector", () => {
	assert.throws(() => requireDownloadTarget({ url: "", selector: "  " }), /requires selector or url/);
});

// ── normalizeTransferDownloadMode ────────────────────────────────────────────

test("normalizeTransferDownloadMode defaults to url when url is provided and no mode", () => {
	assert.equal(normalizeTransferDownloadMode({ url: "https://example.com/f.pdf" }), "url");
});

test("normalizeTransferDownloadMode defaults to click when selector is provided and no mode", () => {
	assert.equal(normalizeTransferDownloadMode({ selector: "#btn" }), "click");
});

test("normalizeTransferDownloadMode accepts explicit mode click for selector", () => {
	assert.equal(normalizeTransferDownloadMode({ selector: "#btn", mode: "click" }), "click");
});

test("normalizeTransferDownloadMode accepts explicit mode media for selector", () => {
	assert.equal(normalizeTransferDownloadMode({ selector: "#video", mode: "media" }), "media");
});

test("normalizeTransferDownloadMode accepts explicit mode url for url target", () => {
	assert.equal(normalizeTransferDownloadMode({ url: "https://example.com/f.pdf", mode: "url" }), "url");
});

test("normalizeTransferDownloadMode throws for invalid mode string", () => {
	assert.throws(() => normalizeTransferDownloadMode({ selector: "#btn", mode: "invalid" }), /must be one of/);
});

test("normalizeTransferDownloadMode throws when mode=url but no url", () => {
	assert.throws(() => normalizeTransferDownloadMode({ selector: "#btn", mode: "url" }), /selector target/);
});

test("normalizeTransferDownloadMode throws when mode=click but url is provided", () => {
	assert.throws(() => normalizeTransferDownloadMode({ url: "https://example.com/f.pdf", mode: "click" }), /url target/);
});

// ── requireUploadConfirmation ────────────────────────────────────────────────

test("requireUploadConfirmation passes when confirm is true", () => {
	assert.doesNotThrow(() => requireUploadConfirmation(true, "#input"));
});

test("requireUploadConfirmation throws when confirm is not true", () => {
	assert.throws(() => requireUploadConfirmation(false, "#input"), /confirm:true/);
	assert.throws(() => requireUploadConfirmation(undefined, "#input"), /confirm:true/);
	assert.throws(() => requireUploadConfirmation("yes", "#input"), /confirm:true/);
});

// ── rejectUnsafeExecuteCommand ───────────────────────────────────────────────

test("rejectUnsafeExecuteCommand throws for upload command (transfer.upload)", () => {
	assert.throws(() => rejectUnsafeExecuteCommand({ cmd: "transfer.upload" }), /UPLOAD_REQUIRES_BROWSER_UPLOAD|through browser_upload/);
});

test("rejectUnsafeExecuteCommand allows non-upload commands", () => {
	assert.doesNotThrow(() => rejectUnsafeExecuteCommand({ cmd: "pi.browser.screenshot" }));
	assert.doesNotThrow(() => rejectUnsafeExecuteCommand({}));
});

// ── checkedUploadFiles (async, needs real filesystem) ───────────────────────

test("checkedUploadFiles throws for empty files list", async () => {
	await assert.rejects(() => checkedUploadFiles([]), /at least one file/);
});

test("checkedUploadFiles throws for non-absolute paths", async () => {
	await assert.rejects(() => checkedUploadFiles(["relative/path.txt"]), /absolute file paths/);
});

test("checkedUploadFiles throws for file count exceeding limit", async () => {
	const files = Array.from({ length: 51 }, (_, i) => path.join(tmpdir(), `file${i}.txt`));
	await assert.rejects(() => checkedUploadFiles(files), /at most 50/);
});

test("checkedUploadFiles throws for nonexistent file", async () => {
	await assert.rejects(
		() => checkedUploadFiles([path.join(tmpdir(), "nonexistent-file-xyz-999.txt")]),
		/does not exist/
	);
});

test("checkedUploadFiles resolves valid absolute file paths", async () => {
	await withTempDir(async (dir) => {
		const file = path.join(dir, "upload-me.txt");
		writeFileSync(file, "content");
		const resolved = await checkedUploadFiles([file]);
		assert.equal(resolved.length, 1);
		assert.ok(path.isAbsolute(resolved[0]));
	});
});
