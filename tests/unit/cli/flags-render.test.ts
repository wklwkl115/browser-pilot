// CLI flag parsing + result rendering. parseArgs collects argv into raw params +
// globals; coercion is delegated to the shared validator (tested there). render
// maps a tool result to an exit code per mode.
import test from "node:test";
import assert from "node:assert/strict";
import { buildFlagSpecs, parseArgs } from "../../../cli/flags.ts";
import { renderResult, EXIT } from "../../../cli/render.ts";

const specs = buildFlagSpecs({
	type: "object",
	properties: {
		mode: { anyOf: [{ const: "scan" }, { const: "read" }] },
		count: { type: "number" },
		redact: { type: "boolean" },
		tag: { type: "array", items: { type: "string" } },
	},
	required: ["mode"],
});

test("buildFlagSpecs maps schema constructs to flag kinds", () => {
	const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
	assert.equal(byName.mode.kind, "enum");
	assert.deepEqual(byName.mode.choices, ["scan", "read"]);
	assert.equal(byName.mode.required, true);
	assert.equal(byName.count.kind, "number");
	assert.equal(byName.redact.kind, "boolean");
	assert.equal(byName.tag.kind, "array");
	assert.equal(byName.redact.flag, "--redact");
});

test("parseArgs collects values, booleans, --no-, repeatable arrays, and globals", () => {
	const out = parseArgs(specs, ["--mode", "scan", "--count", "5", "--no-redact", "--tag", "a", "--tag", "b", "--json"]);
	assert.ok(out.ok);
	assert.equal(out.value.params.mode, "scan");
	assert.equal(out.value.params.count, "5", "raw string — coercion happens in validateToolArgs");
	assert.equal(out.value.params.redact, false);
	assert.deepEqual(out.value.params.tag, ["a", "b"]);
	assert.equal(out.value.globals.json, true);
	assert.equal(out.value.globals.text, false);
});

test("--text and --json are mutually exclusive (last wins, both reset the other)", () => {
	assert.deepEqual(parseArgs(specs, ["--json", "--text"]).ok && parseArgs(specs, ["--json", "--text"]).value.globals, { json: false, text: true, help: false });
	assert.deepEqual(parseArgs(specs, ["--text", "--json"]).ok && parseArgs(specs, ["--text", "--json"]).value.globals, { json: true, text: false, help: false });
});

test("parseArgs rejects unknown flags and bad enum values", () => {
	assert.equal(parseArgs(specs, ["--nope"]).ok, false);
	assert.equal(parseArgs(specs, ["--mode", "fly"]).ok, false);
	assert.equal(parseArgs(specs, ["positional"]).ok, false);
});

test("renderResult maps mode + terminate to exit codes", () => {
	const ok = { content: [{ type: "text", text: JSON.stringify({ tool: "browser_tabs", summary: { tabs: 1 } }) }] };
	const err = { content: [{ type: "text", text: JSON.stringify({ error: { code: "NO_BROWSER", message: "no extension" } }) }], terminate: true };
	assert.equal(renderResult(ok, "json"), EXIT.ok);
	assert.equal(renderResult(ok, "human"), EXIT.ok);
	assert.equal(renderResult(err, "json"), EXIT.toolError);
	assert.equal(renderResult(err, "human"), EXIT.toolError);
});

test("renderResult maps envelope-signalled tool errors to a non-zero exit even without terminate", () => {
	// Real cases that previously slipped through as exit 0: NO_TAB and memory read-miss
	// return error-shaped envelopes WITHOUT terminate:true.
	const noTab = { content: [{ type: "text", text: JSON.stringify({ code: "NO_TAB", message: "No target tab", name: "BrowserBridgeError", taxonomy: { domain: "driver" } }) }] };
	const memMiss = { content: [{ type: "text", text: JSON.stringify({ action: "read", ok: false, error: "not found" }) }] };
	const summaryNotOk = { content: [{ type: "text", text: JSON.stringify({ tool: "browser_x", summary: { ok: false } }) }] };
	assert.equal(renderResult(noTab, "json"), EXIT.toolError, "NO_TAB envelope → tool error exit");
	assert.equal(renderResult(memMiss, "json"), EXIT.toolError, "ok:false envelope → tool error exit");
	assert.equal(renderResult(summaryNotOk, "json"), EXIT.toolError, "summary.ok:false → tool error exit");
	// A clean success envelope must NOT be misread as an error.
	const success = { content: [{ type: "text", text: JSON.stringify({ tool: "browser_tabs", summary: { tabs: 1, ok: true }, nextActions: [] }) }] };
	assert.equal(renderResult(success, "json"), EXIT.ok, "success envelope stays exit 0");
});
