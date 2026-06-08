import test from "node:test";
import assert from "node:assert/strict";
import { summarizePickData } from "../../../src/tools/summaries/pick.ts";
import { summarizeTransferData } from "../../../src/tools/summaries/transfer.ts";
import { summarizeMemoryResult } from "../../../src/tools/summaries/memory.ts";

// ── summarizePickData ─────────────────────────────────────────────────────────

test("summarizePickData returns type for non-record input", () => {
	const result = summarizePickData(null);
	assert.ok("type" in result);
});

test("summarizePickData extracts url, title, message", () => {
	const result = summarizePickData({
		url: "https://example.com",
		title: "Example",
		message: "Pick an element",
		selections: [],
	});
	assert.equal(result.url, "https://example.com");
	assert.equal(result.title, "Example");
	assert.equal(result.message, "Pick an element");
});

test("summarizePickData computes selectedCount from selections array", () => {
	const result = summarizePickData({
		selections: [
			{ selector: "#btn1", tag: "button", text: "Click me" },
			{ selector: "#btn2", tag: "button", text: "Or me" },
		],
	});
	assert.equal(result.selectedCount, 2);
});

test("summarizePickData includes selections table", () => {
	const result = summarizePickData({
		selections: [{ selector: "#btn", tag: "button", text: "Submit", id: "submitBtn", role: "button" }],
	});
	const table = result.selections as { rows: unknown[][]; count: number };
	assert.equal(table.count, 1);
	assert.ok(table.rows[0].includes("#btn"));
	assert.ok(table.rows[0].includes("button"));
});

test("summarizePickData truncates long selection text", () => {
	const longText = "x".repeat(200);
	const result = summarizePickData({ selections: [{ selector: "#el", tag: "span", text: longText }] });
	const table = result.selections as { rows: string[][] };
	const textCell = table.rows[0][4]; // text column
	assert.ok(typeof textCell === "string" && textCell.length < longText.length);
});

test("summarizePickData sets cancelled field", () => {
	const result = summarizePickData({ cancelled: true, reason: "timeout", selections: [] });
	assert.equal(result.cancelled, true);
	assert.equal(result.reason, "timeout");
});

// ── summarizeTransferData ─────────────────────────────────────────────────────

test("summarizeTransferData builds summary for download result", () => {
	const value = {
		data: {
			downloadId: 42,
			download: { state: "complete", path: "/downloads/file.pdf", mime: "application/pdf", bytesReceived: 1024, totalBytes: 1024 },
		},
	};
	const result = summarizeTransferData(value);
	assert.ok(Array.isArray(result.lines));
	assert.ok((result.lines as string[]).some((line) => line.includes("download")));
});

test("summarizeTransferData builds summary for upload result", () => {
	const value = {
		data: {
			uploaded: true,
			files_count: 2,
			selector: "#file-input",
		},
	};
	const result = summarizeTransferData(value);
	assert.ok((result.lines as string[]).some((line) => line.includes("uploaded")));
	assert.ok((result.lines as string[]).some((line) => line.includes("2 file(s)")));
});

test("summarizeTransferData notes mime mismatch when present", () => {
	const value = {
		data: {
			downloadId: 1,
			download: { state: "complete" },
			mimeMismatch: { expected: "application/pdf", actual: "text/html" },
		},
	};
	const result = summarizeTransferData(value);
	assert.ok((result.lines as string[]).some((line) => line.includes("mime mismatch")));
	assert.ok(result.mimeMismatch !== undefined);
});

// ── summarizeMemoryResult ─────────────────────────────────────────────────────

test("summarizeMemoryResult returns unknown action for non-record", () => {
	const result = summarizeMemoryResult(null);
	assert.equal(result.action, "unknown");
});

test("summarizeMemoryResult detects recall action from cards", () => {
	const result = summarizeMemoryResult({ cards: [{ id: "c1" }, { id: "c2" }] });
	assert.equal(result.action, "recall");
	assert.equal(result.count, 2);
});

test("summarizeMemoryResult detects record action from entry", () => {
	const result = summarizeMemoryResult({ entry: { id: "entry-1", scopeKind: "tab", scopeKey: "tab:5" } });
	assert.equal(result.action, "record");
	assert.equal(result.id, "entry-1");
	assert.equal(result.scopeKind, "tab");
});

test("summarizeMemoryResult extracts query, ok, mode", () => {
	const result = summarizeMemoryResult({ action: "recall", query: "login form", ok: true, mode: "fuzzy" });
	assert.equal(result.action, "recall");
	assert.equal(result.query, "login form");
	assert.equal(result.ok, true);
	assert.equal(result.mode, "fuzzy");
});

test("summarizeMemoryResult extracts index entryCount", () => {
	const result = summarizeMemoryResult({ action: "read", index: { entryCount: 12 } });
	assert.equal(result.entryCount, 12);
});

test("summarizeMemoryResult passes through error field", () => {
	const result = summarizeMemoryResult({ action: "record", ok: false, error: "scope not found" });
	assert.equal(result.error, "scope not found");
});

test("summarizeMemoryResult preserves structured error recovery fields", () => {
	const result = summarizeMemoryResult({
		action: "error",
		ok: false,
		error_code: "MEMORY_ENTRY_NOT_FOUND",
		message: "missing memory",
		error: "missing memory",
		recovery: { nextActions: ["browser_memory action=recall"] },
	});
	assert.equal(result.ok, false);
	assert.equal(result.error_code, "MEMORY_ENTRY_NOT_FOUND");
	assert.equal(result.message, "missing memory");
	assert.deepEqual(result.recovery, { nextActions: ["browser_memory action=recall"] });
});
