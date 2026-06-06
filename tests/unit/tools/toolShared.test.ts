import test from "node:test";
import assert from "node:assert/strict";
import {
	parseMaybeCommand,
	objectParam,
	DEFAULT_TOOL_TIMEOUT_MS,
	DEFAULT_OBSERVATION_TIMEOUT_MS,
	TAB_SCOPED_TOOL_GUIDELINE,
} from "../../../src/tools/toolShared.ts";

// ── parseMaybeCommand ─────────────────────────────────────────────────────────

test("parseMaybeCommand parses valid JSON command object", () => {
	const result = parseMaybeCommand('{"cmd":"screenshot","tabId":5}');
	assert.ok(result !== undefined);
	assert.equal(result!.cmd, "screenshot");
});

test("parseMaybeCommand returns undefined for non-JSON-object strings", () => {
	assert.equal(parseMaybeCommand("screenshot"), undefined);
	assert.equal(parseMaybeCommand(""), undefined);
	assert.equal(parseMaybeCommand('["array"]'), undefined);
});

test("parseMaybeCommand returns undefined when cmd is not a string", () => {
	assert.equal(parseMaybeCommand('{"notCmd": 1}'), undefined);
	assert.equal(parseMaybeCommand('{"cmd": 42}'), undefined);
});

test("parseMaybeCommand handles whitespace-prefixed scripts", () => {
	assert.equal(parseMaybeCommand("  document.title"), undefined);
	// whitespace is trimmed before checking for "{", so a leading-space JSON command IS treated as command
	const withLeadingSpace = parseMaybeCommand('  {"cmd":"wait"}');
	assert.ok(withLeadingSpace !== undefined);
	assert.equal(withLeadingSpace!.cmd, "wait");
});

// ── objectParam ───────────────────────────────────────────────────────────────

test("objectParam returns copy of record input", () => {
	const input = { a: 1, b: "hello" };
	const result = objectParam(input);
	assert.deepEqual(result, input);
	assert.notEqual(result, input); // should be a copy
});

test("objectParam returns empty object for non-record input", () => {
	assert.deepEqual(objectParam(null), {});
	assert.deepEqual(objectParam("string"), {});
	assert.deepEqual(objectParam([1, 2, 3]), {});
	assert.deepEqual(objectParam(42), {});
});

// ── constants ─────────────────────────────────────────────────────────────────

test("DEFAULT_TOOL_TIMEOUT_MS is a positive number", () => {
	assert.ok(typeof DEFAULT_TOOL_TIMEOUT_MS === "number" && DEFAULT_TOOL_TIMEOUT_MS > 0);
});

test("DEFAULT_OBSERVATION_TIMEOUT_MS is a positive number", () => {
	assert.ok(typeof DEFAULT_OBSERVATION_TIMEOUT_MS === "number" && DEFAULT_OBSERVATION_TIMEOUT_MS > 0);
});

test("TAB_SCOPED_TOOL_GUIDELINE mentions tabId and browser_tabs", () => {
	assert.ok(TAB_SCOPED_TOOL_GUIDELINE.includes("tabId"));
	assert.ok(TAB_SCOPED_TOOL_GUIDELINE.includes("browser_tabs"));
});
