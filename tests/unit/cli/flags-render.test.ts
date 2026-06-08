// CLI flag parsing + result rendering. parseArgs collects argv into raw params +
// globals; coercion is delegated to the shared validator (tested there). render
// maps a tool result to an exit code per mode.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFlagSpecs, coerceParams, parseArgs } from "../../../cli/flags.ts";
import { normalizeJsonEnvelope, renderResult, EXIT } from "../../../cli/render.ts";
import { applyCliOnlyParams, buildCommandFlagSpecs, invocationFlagSpecs, nativeActionParamsHelp, selftestToolError, translateNaturalActionArgv } from "../../../cli/index.ts";
import { buildCliCommands } from "../../../cli/registry.ts";
import { nativeToolMetadata } from "../../../src/protocol/nativeActionMetadata.ts";

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

function captureStderr(fn: () => number): { code: number; output: string } {
	const originalWrite = process.stderr.write;
	let output = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		return { code: fn(), output };
	} finally {
		process.stderr.write = originalWrite;
	}
}

function parseAndCoerceCommand(subcommand: string, argv: string[]): Record<string, unknown> {
	const cmd = buildCliCommands().find((c) => c.subcommand === subcommand);
	assert.ok(cmd, `${subcommand} command must exist`);
	const translated = translateNaturalActionArgv(cmd, argv);
	assert.ok(translated.ok);
	const parsed = parseArgs(invocationFlagSpecs(cmd, translated.natural?.action), translated.argv);
	assert.ok(parsed.ok);
	const coerced = coerceParams(cmd.parameters, parsed.value.params);
	assert.ok(coerced.ok);
	return coerced.args;
}

type NaturalActionToolName = "browser_wait" | "browser_network" | "browser_frame" | "browser_hook";

function canonicalNativeActionArgs(toolName: NaturalActionToolName, args: Record<string, unknown>): Record<string, unknown> {
	const actions = (nativeToolMetadata.nativeActionTools as Record<string, { actions?: Array<{ required?: readonly string[]; requiredAny?: readonly (readonly string[])[] }> }>)[toolName]?.actions ?? [];
	const passthroughKeys = new Set<string>();
	for (const action of actions) {
		for (const key of action.required ?? []) passthroughKeys.add(key);
		for (const group of action.requiredAny ?? []) for (const key of group) passthroughKeys.add(key);
	}
	const params = { ...((args.params && typeof args.params === "object" && !Array.isArray(args.params)) ? args.params as Record<string, unknown> : {}) };
	const out: Record<string, unknown> = { ...args, params };
	for (const key of passthroughKeys) {
		if (out[key] !== undefined && params[key] === undefined) params[key] = out[key];
		delete out[key];
	}
	return out;
}

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

test("buildCliCommands memoizes the registered command graph", () => {
	const first = buildCliCommands();
	const second = buildCliCommands();
	assert.equal(first, second);
	assert.ok(first.length >= 20);
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
	writeFileSync(path.join(dir, "requests.json"), JSON.stringify([{ url: "https://example.test/", method: "POST" }]), "utf8");
	const fileSpecs = buildFlagSpecs({
		type: "object",
		properties: {
			params: { type: "object" },
			tag: { type: "array", items: { type: "string" } },
			requests: { type: "array", items: { type: "object" } },
			script: { type: "string" },
		},
	});
	const out = parseArgs(fileSpecs, ["--params", "@params.json", "--tag", "@items.txt", "--requests", "@requests.json", "--script", "@items.txt"], dir);
	assert.ok(out.ok);
	assert.deepEqual(out.value.params.params, { action: "list" });
	assert.deepEqual(out.value.params.tag, ["a", "b"]);
	assert.deepEqual(out.value.params.requests, [{ url: "https://example.test/", method: "POST" }]);
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

test("parseArgs error results preserve only schema-aware globals", () => {
	const explicitJson = parseArgs(specs, ["--json", "--mode", "fly"]);
	assert.equal(explicitJson.ok, false);
	assert.equal(explicitJson.globals.json, true, "real global --json is preserved on parse errors");
	const valueLooksGlobal = parseArgs(specs, ["--mode", "--text"]);
	assert.equal(valueLooksGlobal.ok, false);
	assert.deepEqual(valueLooksGlobal.globals, { json: false, text: false, help: false }, "a consumed flag value must not be reclassified as a global output flag");
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

test("natural action routing translates action subcommands to legacy action params", () => {
	const wait = buildCliCommands().find((c) => c.subcommand === "wait");
	const network = buildCliCommands().find((c) => c.subcommand === "network");
	const frame = buildCliCommands().find((c) => c.subcommand === "frame");
	const hook = buildCliCommands().find((c) => c.subcommand === "hook");
	assert.ok(wait, "wait command must exist");
	assert.ok(network, "network command must exist");
	assert.ok(frame, "frame command must exist");
	assert.ok(hook, "hook command must exist");

	const selector = translateNaturalActionArgv(wait, ["selector", "--selector", "#login", "--json"]);
	assert.ok(selector.ok);
	assert.deepEqual(selector.argv, ["--action", "selector", "--selector", "#login", "--json"]);
	assert.deepEqual(selector.natural, { action: "selector", token: "selector" });

	const networkIdle = translateNaturalActionArgv(wait, ["--json", "network-idle"]);
	assert.ok(networkIdle.ok);
	assert.deepEqual(networkIdle.argv, ["--json", "--action", "networkIdle"]);

	const exportHar = translateNaturalActionArgv(network, ["export", "--session-id", "net-1"]);
	assert.ok(exportHar.ok);
	assert.deepEqual(exportHar.argv, ["--action", "exportHar", "--session-id", "net-1"]);

	const frameEval = translateNaturalActionArgv(frame, ["evaluate", "--frame-id", "frame-1", "--expression", "document.title"]);
	assert.ok(frameEval.ok);
	assert.deepEqual(frameEval.argv, ["--action", "evaluate", "--frame-id", "frame-1", "--expression", "document.title"]);

	const hookInstallTargets = translateNaturalActionArgv(hook, ["install-targets", "--targets", "console,error"]);
	assert.ok(hookInstallTargets.ok);
	assert.deepEqual(hookInstallTargets.argv, ["--action", "installTargets", "--targets", "console,error"]);

	const hookListeners = translateNaturalActionArgv(hook, ["get-node-listeners", "--selector", "button"]);
	assert.ok(hookListeners.ok);
	assert.deepEqual(hookListeners.argv, ["get-node-listeners", "--selector", "button"], "non-allowlisted hook actions remain advanced compatibility only");
});

test("natural action routes are semantically equivalent to legacy action params", () => {
	const cases: Array<{
		subcommand: "wait" | "network" | "frame" | "hook";
		toolName: NaturalActionToolName;
		natural: string[];
		legacy: string[];
	}> = [
		{
			subcommand: "wait",
			toolName: "browser_wait",
			natural: ["selector", "--selector", "#login", "--tab-id", "7"],
			legacy: ["--action", "selector", "--params", "{\"selector\":\"#login\"}", "--tab-id", "7"],
		},
		{
			subcommand: "wait",
			toolName: "browser_wait",
			natural: ["network-idle", "--tab-id", "7"],
			legacy: ["--action", "networkIdle", "--tab-id", "7"],
		},
		{
			subcommand: "network",
			toolName: "browser_network",
			natural: ["start", "--tab-id", "7"],
			legacy: ["--action", "start", "--tab-id", "7"],
		},
		{
			subcommand: "network",
			toolName: "browser_network",
			natural: ["export", "--session-id", "net-1"],
			legacy: ["--action", "exportHar", "--session-id", "net-1"],
		},
		{
			subcommand: "frame",
			toolName: "browser_frame",
			natural: ["list", "--tab-id", "7"],
			legacy: ["--action", "list", "--tab-id", "7"],
		},
		{
			subcommand: "frame",
			toolName: "browser_frame",
			natural: ["evaluate", "--frame-id", "frame-1", "--expression", "document.title", "--tab-id", "7"],
			legacy: ["--action", "evaluate", "--params", "{\"frameId\":\"frame-1\",\"expression\":\"document.title\"}", "--tab-id", "7"],
		},
		{
			subcommand: "hook",
			toolName: "browser_hook",
			natural: ["install-targets", "--targets", "console,error", "--tab-id", "7"],
			legacy: ["--action", "installTargets", "--params", "{\"targets\":[\"console\",\"error\"]}", "--tab-id", "7"],
		},
		{
			subcommand: "hook",
			toolName: "browser_hook",
			natural: ["install-targets", "--targets", "console", "--targets", "error", "--tab-id", "7"],
			legacy: ["--action", "installTargets", "--params", "{\"targets\":[\"console\",\"error\"]}", "--tab-id", "7"],
		},
		{
			subcommand: "hook",
			toolName: "browser_hook",
			natural: ["collect", "--session-id", "hook-1"],
			legacy: ["--action", "collect", "--session-id", "hook-1"],
		},
	];

	for (const item of cases) {
		const natural = canonicalNativeActionArgs(item.toolName, parseAndCoerceCommand(item.subcommand, item.natural));
		const legacy = canonicalNativeActionArgs(item.toolName, parseAndCoerceCommand(item.subcommand, item.legacy));
		assert.deepEqual(natural, legacy, `${item.subcommand} ${item.natural[0]} must match legacy --action form`);
	}
});

test("natural action routing rejects mixing subcommand action with legacy --action", () => {
	const wait = buildCliCommands().find((c) => c.subcommand === "wait");
	assert.ok(wait, "wait command must exist");
	const mixed = translateNaturalActionArgv(wait, ["selector", "--action", "navigation"]);
	assert.equal(mixed.ok, false);
	if (!mixed.ok) assert.match(mixed.error, /cannot be combined with --action/);
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

test("selftestToolError preserves structured daemon/tool failure messages", () => {
	const daemonError = {
		content: [{ type: "text", text: JSON.stringify({ ok: false, code: "CLI_DAEMON_INVOKE_ERROR", message: "Validation failed: missing script" }) }],
		terminate: true,
	};
	assert.equal(selftestToolError(daemonError), "Validation failed: missing script");

	const codedError = {
		content: [{ type: "text", text: JSON.stringify({ code: "NO_TAB", message: "No target tab", name: "BrowserBridgeError", taxonomy: { domain: "driver" } }) }],
	};
	assert.equal(selftestToolError(codedError), "No target tab");

	const plainError = { content: [{ type: "text", text: "browser bridge offline" }], terminate: true };
	assert.equal(selftestToolError(plainError), "browser bridge offline");

	const ok = { content: [{ type: "text", text: JSON.stringify({ tool: "browser_tabs", data: { tabId: 1 } }) }] };
	assert.equal(selftestToolError(ok), undefined);
});

test("renderResult human errors show structured recovery nextActions", () => {
	const err = {
		content: [{
			type: "text",
			text: JSON.stringify({
				code: "REF_STALE",
				message: "stale ref",
				taxonomy: { domain: "abml" },
				recovery: { nextActions: ["browser_observe mode=scan"] },
				diagnostics: { nextActions: ["retry with a fresh ABML ref"] },
			}),
		}],
	};
	const captured = captureStderr(() => renderResult(err, "human"));
	assert.equal(captured.code, EXIT.toolError);
	assert.match(captured.output, /REF_STALE/);
	assert.match(captured.output, /next: browser_observe mode=scan \| retry with a fresh ABML ref/);
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
		nextActions: ["read_saved_artifact mode=json jsonPath=data.content", "read_saved_artifact offset=20"],
	}), EXIT.ok, "OK");
	assert.ok(Array.isArray(env.artifacts));
	assert.ok(Array.isArray(env.cliNextActions));
	const commonPaths = ["data.content", "data.actionables", "data.list_hints"];
	const artifact = (env.artifacts as Array<Record<string, unknown>>)[0];
	const readCommands = artifact.readCommands as string[];
	assert.equal("readArgv" in artifact, false, "artifact descriptors keep one canonical executable command shape");
	assert.ok(readCommands.some((command) => command.includes("--json-path data")), "artifact readCommands include generic data read");
	for (const jsonPath of commonPaths) {
		assert.ok(readCommands.some((command) => command.includes(`--json-path "${jsonPath}"`)), `artifact readCommands include ${jsonPath}`);
	}
	assert.equal(readCommands.some((command) => command.includes("operation.operationId") || command.includes("snapshot.snapshotId")), false, "artifact readCommands skip low-probability generic paths");
	assert.equal((env.cliNextActions as Array<Record<string, unknown>>).some((action) => String(action.command).includes("--json-path \"data.content\"")), false, "cliNextActions do not duplicate artifact readCommands");
	assert.ok((env.cliNextActions as Array<Record<string, unknown>>).some((action) => String(action.command).includes("--path \"D:\\tmp\\observe.json\"") && String(action.command).includes("--offset 20")));
	assert.ok((env.cliNextActions as Array<Record<string, unknown>>).some((action) => String(action.command).includes("--baseline-snapshot-id")));
	assert.ok((env.cliNextActions as Array<Record<string, unknown>>).some((action) => Array.isArray(action.argv) && action.argv.includes("D:\\tmp\\observe.json") && action.argv.includes("20")));
});
