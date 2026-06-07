// CLI flag parsing + result rendering. parseArgs collects argv into raw params +
// globals; coercion is delegated to the shared validator (tested there). render
// maps a tool result to an exit code per mode.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFlagSpecs, parseArgs } from "../../../cli/flags.ts";
import { normalizeJsonEnvelope, renderResult, EXIT } from "../../../cli/render.ts";
import { applyCliOnlyParams, buildCommandFlagSpecs, nativeActionParamsHelp } from "../../../cli/index.ts";
import { buildCliCommands } from "../../../cli/registry.ts";

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

test("parseArgs reads @file and stdin-style file references for structured inputs", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-flag-file-"));
	writeFileSync(path.join(dir, "params.json"), JSON.stringify({ action: "list" }), "utf8");
	writeFileSync(path.join(dir, "items.txt"), "a\nb\n", "utf8");
	const fileSpecs = buildFlagSpecs({
		type: "object",
		properties: {
			params: { type: "object" },
			tag: { type: "array", items: { type: "string" } },
			script: { type: "string" },
		},
	});
	const out = parseArgs(fileSpecs, ["--params", "@params.json", "--tag", "@items.txt", "--script", "@items.txt"], dir);
	assert.ok(out.ok);
	assert.deepEqual(out.value.params.params, { action: "list" });
	assert.deepEqual(out.value.params.tag, ["a", "b"]);
	assert.equal(out.value.params.script, "a\nb\n");
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

test("B10: unknown flag suggests the closest valid flag (camelCase↔kebab) + absent-flag hints", () => {
	const jsonSpecs = buildFlagSpecs({ type: "object", properties: { jsonPath: { type: "string" }, maxChars: { type: "number" } } });
	// camelCase typo of a kebab flag → exact normalized match suggestion
	const camel = parseArgs(jsonSpecs, ["--jsonPath", "data.items"]);
	assert.equal(camel.ok, false);
	assert.match(camel.error, /did you mean "--json-path"/);
	// near typo → edit-distance suggestion
	const typo = parseArgs(jsonSpecs, ["--max-char", "5"]);
	assert.equal(typo.ok, false);
	assert.match(typo.error, /did you mean "--max-chars"/);
	// a common flag the command legitimately lacks → targeted hint, not just the accepted list
	const detail = parseArgs(jsonSpecs, ["--detail-level", "full"]);
	assert.equal(detail.ok, false);
	assert.match(detail.error, /--limit \/ --offset \/ --max-chars/);
	// G-round R-bilibili: agents reach for --selector on action tools; point them at the --params shape.
	const selector = parseArgs(jsonSpecs, ["--selector", "#id"]);
	assert.equal(selector.ok, false);
	assert.match(selector.error, /--params/);
});

test("F4: nativeActionParamsHelp surfaces per-action required --params keys from generated metadata", () => {
	// General + source-of-truth driven (bridge/native_command_schema.json → generated metadata), not
	// hand-listed: any action tool's per-action required/requiredAny keys must show in `<tool> --help`
	// so a blind agent doesn't have to guess the `--params` shape.
	const wait = nativeActionParamsHelp("browser_wait").join("\n");
	assert.match(wait, /selector\s+requires selector/, "wait.selector must surface its required selector key");
	assert.match(wait, /navigate\s+requires url/, "wait.navigate must surface its required url key");
	const hook = nativeActionParamsHelp("browser_hook").join("\n");
	assert.match(hook, /evaluate\s+requires expression/, "hook.evaluate must surface its required expression key");
	const frame = nativeActionParamsHelp("browser_frame").join("\n");
	assert.match(frame, /evaluate\s+requires frameId, expression/, "frame.evaluate must surface both required keys");
	// Honest + general: a non-action tool (no per-action --params) yields nothing; nothing fabricated.
	assert.deepEqual(nativeActionParamsHelp("browser_observe"), [], "non-action tools have no per-action params block");
});

test("M1: observe exposes by-reference baseline flags (CLI-discoverable, no huge inline envelope)", () => {
	const observe = buildCliCommands().find((c) => c.subcommand === "observe");
	assert.ok(observe, "observe command must exist");
	const flags = buildFlagSpecs(observe.parameters).map((s) => s.flag);
	assert.ok(flags.includes("--baseline-snapshot-id"), "observe must expose --baseline-snapshot-id (daemon-resolved by reference)");
	assert.ok(flags.includes("--baseline-path"), "observe must expose --baseline-path (saved-artifact by reference)");
});

test("B2: execute exposes and applies CLI-only --script-file", () => {
	const execute = buildCliCommands().find((c) => c.subcommand === "execute");
	assert.ok(execute, "execute command must exist");
	const specs = buildCommandFlagSpecs(execute);
	assert.ok(specs.some((s) => s.flag === "--script-file"), "execute help must expose --script-file");
	const parsed = parseArgs(specs, ["--script-file", "script.js", "--tab-id", "7"]);
	assert.ok(parsed.ok);
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-script-file-"));
	writeFileSync(path.join(dir, "script.js"), "(() => 42)()", "utf8");
	const applied = applyCliOnlyParams(execute, parsed.value.params, dir);
	assert.ok(applied.ok);
	assert.equal(applied.params.script, "(() => 42)()");
	assert.equal("scriptFile" in applied.params, false);
	assert.equal(applyCliOnlyParams(execute, { script: "1", scriptFile: "script.js" }, dir).ok, false, "--script-file and --script conflict");
});

test("B3: artifact help describes data-rooted jsonPath and repeated --pick", () => {
	const artifact = buildCliCommands().find((c) => c.subcommand === "artifact");
	assert.ok(artifact, "artifact command must exist");
	const specs = buildCommandFlagSpecs(artifact);
	const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
	assert.match(byName.jsonPath.description || "", /data\.items/);
	assert.match(byName.pick.description || "", /repeat --pick/);
	assert.match(byName.pick.description || "", /not a JSON array string/);
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

test("normalizeJsonEnvelope adds stable ok and exitCode fields", () => {
	assert.deepEqual(normalizeJsonEnvelope(JSON.stringify({ tool: "browser_tabs" }), EXIT.ok, "OK"), { tool: "browser_tabs", ok: true, exitCode: 0 });
	assert.deepEqual(normalizeJsonEnvelope(JSON.stringify({ code: "NO_TAB", message: "no tab" }), EXIT.toolError, "TOOL_ERROR"), { code: "NO_TAB", message: "no tab", ok: false, exitCode: 1 });
});

test("normalizeJsonEnvelope adds CLI artifact descriptors and executable next actions", () => {
	const env = normalizeJsonEnvelope(JSON.stringify({
		tool: "browser_observe",
		saved: { path: "D:\\tmp\\observe.json", bytes: 10, chars: 10 },
		snapshot: { snapshotId: "123e4567-e89b-12d3-a456-426614174000" },
		nextActions: ["read_saved_artifact mode=json jsonPath=data.content"],
	}), EXIT.ok, "OK");
	assert.ok(Array.isArray(env.artifacts));
	assert.ok(Array.isArray(env.cliNextActions));
	assert.ok((env.cliNextActions as Array<Record<string, unknown>>).some((action) => String(action.command).includes("pi-browser artifact")));
	assert.ok((env.cliNextActions as Array<Record<string, unknown>>).some((action) => String(action.command).includes("--baseline-snapshot-id")));
});
