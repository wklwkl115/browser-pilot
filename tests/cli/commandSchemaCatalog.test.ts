import test from "node:test";
import assert from "node:assert/strict";
import { buildCliCommands, collectCommandDefs } from "../../src/apps/cli/registry.ts";
import { validateCommandArgs } from "../../src/validation/commandArgs.ts";
import { dispatchProgramElement, validateProgram } from "../../src/browser-command-runtime/programDispatcher.ts";
import { PROGRAM_OP_DISCRIMINATORS } from "../../src/browser-command-runtime/programOps.ts";
import { normalizeObserveMode, selectDiffBaselineSnapshot, validateObserveParams } from "../../src/commands/observeCommand.ts";
import { legacyProjectionDetails, legacyProjectionSummary } from "../../src/commands/observe/renderCache.ts";

function command(name: string) {
	const def = collectCommandDefs().find((item) => item.name === name);
	assert.ok(def, `${name} should be registered`);
	return def;
}

function schemaProperties(schema: unknown): Record<string, unknown> {
	assert.equal(typeof schema, "object");
	assert.notEqual(schema, null);
	const properties = (schema as { properties?: unknown }).properties;
	assert.equal(typeof properties, "object");
	assert.notEqual(properties, null);
	return properties as Record<string, unknown>;
}

function assertValidationError(schema: unknown, args: Record<string, unknown>, pattern: RegExp) {
	const result = validateCommandArgs(schema, args);
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, pattern);
}

test("command catalog characterization: public browser tool names are stable, unique, and CLI-safe", () => {
	const defs = collectCommandDefs();
	const names = defs.map((def) => def.name);
	assert.equal(names.length, 21);
	assert.deepEqual(names, [
		"browser_tabs",
		"browser_command",
		"browser_execute",
		"browser_observe",
		"browser_download",
		"browser_upload",
		"browser_wait",
		"browser_network",
		"browser_hook",
		"browser_evidence",
		"browser_frame",
		"browser_screenshot",
		"browser_artifact",
		"browser_memory",
		"browser_crawl",
		"browser_fuzz",
		"browser_sqli",
		"browser_template",
		"browser_callback_oast",
		"browser_cookie_analyze",
		"browser_http_replay",
	]);
	assert.equal(new Set(names).size, names.length);
	for (const name of names) assert.match(name, /^browser_[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*$/);
});

test("command catalog characterization: CLI subcommands are derived one-to-one from browser tool names", () => {
	const cliCommands = buildCliCommands();
	assert.equal(cliCommands.length, collectCommandDefs().length);
	assert.deepEqual(cliCommands.map((cmd) => cmd.subcommand), [...cliCommands.map((cmd) => cmd.subcommand)].sort((a, b) => a.localeCompare(b)));
	assert.equal(new Set(cliCommands.map((cmd) => cmd.subcommand)).size, cliCommands.length);
	for (const cmd of cliCommands) {
		assert.equal(cmd.subcommand, cmd.name.replace(/^browser_/, "").replace(/_/g, "-"));
		assert.match(cmd.subcommand, /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$/);
		assert.equal(cmd.def.name, cmd.name);
	}
});

test("command schema characterization: every public command has strict object parameters and executable metadata", () => {
	for (const def of collectCommandDefs()) {
		assert.equal(typeof def.execute, "function", `${def.name} execute`);
		assert.equal(typeof def.label, "string", `${def.name} label`);
		assert.equal(typeof def.description, "string", `${def.name} description`);
		assert.equal(typeof def.promptSnippet, "string", `${def.name} promptSnippet`);
		assert.ok(Array.isArray(def.promptGuidelines), `${def.name} promptGuidelines`);
		assert.equal(typeof def.parameters, "object", `${def.name} parameters`);
		assert.notEqual(def.parameters, null, `${def.name} parameters`);
		assert.equal((def.parameters as { type?: unknown }).type, "object", `${def.name} parameter type`);
		assert.equal((def.parameters as { additionalProperties?: unknown }).additionalProperties, false, `${def.name} strict parameters`);
	}
});

test("command schema characterization: required fields and unknown parameters fail before execution", () => {
	const tabs = command("browser_tabs");
	assert.deepEqual((tabs.parameters as { required?: unknown }).required, ["action"]);
	assertValidationError(tabs.parameters, {}, /missing required parameter "action"/);
	assertValidationError(tabs.parameters, { action: "list", typo: true }, /unknown parameter "typo"/);

	const native = command("browser_command");
	assert.deepEqual((native.parameters as { required?: unknown }).required, ["command"]);
	assertValidationError(native.parameters, {}, /missing required parameter "command"/);
	assertValidationError(native.parameters, { command: { cmd: "tabs" }, typo: true }, /unknown parameter "typo"/);

	const artifact = command("browser_artifact");
	assert.deepEqual((artifact.parameters as { required?: unknown }).required, undefined);
	assertValidationError(artifact.parameters, { path: "artifact.json", stray: "x" }, /unknown parameter "stray"/);

	const execute = command("browser_execute");
	const executeResult = validateCommandArgs(execute.parameters, { script: "return 1", monitor: "true" });
	assert.equal(executeResult.ok, true);
	if (executeResult.ok) assert.deepEqual({ monitor: executeResult.args.monitor }, { monitor: true });
});

test("command schema characterization: key commands expose expected top-level parameter surfaces", () => {
	assert.deepEqual(Object.keys(schemaProperties(command("browser_tabs").parameters)).sort(), [
		"action",
		"active",
		"allowExpired",
		"browserId",
		"browserSessionId",
		"includeBridgePerTab",
		"incognito",
		"name",
		"snapshotId",
		"tabId",
		"targetRef",
		"url",
	].sort());
	assert.deepEqual(Object.keys(schemaProperties(command("browser_execute").parameters)).sort(), ["monitor", "program", "script", "tabId", "targetRef"].sort());
	assert.deepEqual(Object.keys(schemaProperties(command("browser_memory").parameters)).sort(), ["action", "body", "evidenceRefs", "freshOnly", "id", "jsonPath", "kind", "limit", "mode", "offset", "query", "scopeKey", "scopeKind", "title", "triggers", "uri", "url"].sort());
});

test("command schema characterization: browser_observe metadata presents canonical no-mode ABML observation", () => {
	const observe = command("browser_observe");
	assert.match(observe.description, /canonical ABML page observation model/i);
	assert.match(observe.description, /Any explicit mode value is a legacy\/debug\/projection override/i);
	assert.match(observe.description, /including explicit mode=scan/i);
	assert.match(observe.promptSnippet, /canonical ABML page model/i);
	const guidance = observe.promptGuidelines.join("\n");
	assert.match(guidance, /without choosing a mode/i);
	assert.match(guidance, /Any explicit mode value, including mode=scan, is marked legacy\/debug\/projection and rejects canonical-only diff\/baseline\/actionRef parameters/i);
	assert.match(guidance, /explicit content\/html\/text\/tabs remain only for compatibility projections/i);
	assert.doesNotMatch(guidance, /choose (?:scan|content|html|text|tabs)|select (?:a )?mode/i);

	const properties = schemaProperties(observe.parameters);
	assert.match(JSON.stringify(properties.mode), /Legacy\/debug\/projection override/);
	assert.match(JSON.stringify(properties.mode), /Omit for the canonical ABML PageObservation/);
	assert.match(JSON.stringify(properties.mode), /including scan/);
	assert.match(JSON.stringify(properties.mode), /cannot use canonical-only diff\/baseline\/actionRef/);
	assert.match(JSON.stringify(properties.baseline), /Canonical no-mode ABML diff baseline/);
	assert.match(JSON.stringify(properties.actionRef), /Rejected when any mode is explicit, including mode=scan/);
	assert.match(JSON.stringify(properties.diff), /Canonical no-mode ABML observation only/);
	assert.match(JSON.stringify(properties.selector), /Legacy content\/html projection only/);
	assert.match(JSON.stringify(properties.url), /canonical no-mode ABML page model/);
	assert.match(JSON.stringify(properties.includeLinks), /Legacy content projection only/);
});

test("command schema characterization: browser_observe absent mode stays canonical despite legacy-shaped parameters", () => {
	const legacyShapedInputs = [
		{ selector: "main" },
		{ includeLinks: false },
		{ htmlMode: "raw" },
		{ params: { selector: "main" } },
		{ intent: "summarize checkout" },
		{ url: "https://example.test/" },
	];
	for (const params of legacyShapedInputs) {
		assert.deepEqual(normalizeObserveMode(undefined, params), { mode: "scan", inferred: null, explicit: false });
	}
	assert.deepEqual(normalizeObserveMode("content", { selector: "main" }), { mode: "content", inferred: null, explicit: true });
	assert.deepEqual(normalizeObserveMode("HTML", { htmlMode: "raw" }), { mode: "html", inferred: null, explicit: true });
	assert.deepEqual(normalizeObserveMode("scan", {}), { mode: "scan", inferred: null, explicit: true });
});

test("command schema characterization: all explicit browser_observe modes are marked legacy debug projections", () => {
	for (const mode of ["scan", "content", "html", "text", "tabs"] as const) {
		const params = { modeExplicit: true };
		const expected = { projection: "legacy", canonical: false, modeExplicit: true, semantics: ["legacy", "debug", "projection"] };
		assert.deepEqual(legacyProjectionSummary(params, mode), expected);
		assert.deepEqual(legacyProjectionDetails(params, mode), expected);
	}
	assert.deepEqual(legacyProjectionSummary({ modeExplicit: false }, "scan"), {});
	assert.deepEqual(legacyProjectionDetails({}, "content"), {});
});

test("command schema characterization: browser_observe validation separates canonical boundaries from legacy projections", () => {
	assert.doesNotThrow(() => validateObserveParams("scan", { url: "https://example.test/", diff: true, maxNodes: 50, includeIframes: true, intent: "find checkout", tabId: 7 }));
	assert.doesNotThrow(() => validateObserveParams("scan", { baselineSnapshotId: "snap-1", baselinePath: "prior.json", actionRef: "bp-ref://button/checkout" }));
	assert.doesNotThrow(() => validateObserveParams("scan", { content: "readability", params: { readability: true, readabilityMaxInlineChars: 500 } }));
	assert.doesNotThrow(() => validateObserveParams("content", { mode: "content", modeExplicit: true, selector: "article", includeLinks: false, url: "https://example.test/" }));
	assert.doesNotThrow(() => validateObserveParams("html", { mode: "html", modeExplicit: true, selector: "main", htmlMode: "outer", params: { selector: "main" } }));
	assert.doesNotThrow(() => validateObserveParams("text", { mode: "text", modeExplicit: true, fresh: true, maxNodes: 25, includeIframes: false }));
	assert.doesNotThrow(() => validateObserveParams("tabs", { mode: "tabs", modeExplicit: true }));

	assert.throws(() => validateObserveParams("scan", { modeExplicit: true, diff: true }), /mode=scan does not accept diff/);
	assert.throws(() => validateObserveParams("scan", { modeExplicit: true, baseline: [] }), /mode=scan does not accept baseline/);
	assert.throws(() => validateObserveParams("scan", { modeExplicit: true, baselineSnapshotId: "snap-1" }), /mode=scan does not accept baselineSnapshotId/);
	assert.throws(() => validateObserveParams("scan", { modeExplicit: true, baselinePath: "prior.json" }), /mode=scan does not accept baselinePath/);
	assert.throws(() => validateObserveParams("scan", { modeExplicit: true, actionRef: "bp-ref://button/checkout" }), /mode=scan does not accept actionRef/);
	assert.throws(() => validateObserveParams("scan", { selector: "main" }), /mode=scan does not accept selector/);
	assert.throws(() => validateObserveParams("scan", { includeLinks: true }), /mode=scan does not accept includeLinks/);
	assert.throws(() => validateObserveParams("scan", { htmlMode: "raw" }), /mode=scan does not accept htmlMode/);
	assert.throws(() => validateObserveParams("scan", { modeExplicit: true, params: { readability: true } }), /mode=scan does not accept params/);
	assert.throws(() => validateObserveParams("scan", { modeExplicit: true, content: "readability" }), /mode=scan does not accept readability/);
	assert.throws(() => validateObserveParams("tabs", { url: "https:\/\/example.test\/" }), /mode=tabs does not accept url/);
	assert.throws(() => validateObserveParams("content", { diff: true }), /mode=content does not accept diff/);
});

test("command schema characterization: diff auto-baseline is isolated by browser session and effective tab", () => {
	const snapshots = [
		{ snapshotId: "other-session", browserSessionId: "session-2", tabId: 7, sourceMode: "scan", capturedAt: 3, ttlMs: 1_000, saved: { path: "other.json" } },
		{ snapshotId: "same-session-other-tab", browserSessionId: "session-1", tabId: 8, sourceMode: "scan", capturedAt: 2, ttlMs: 1_000, saved: { path: "other-tab.json" } },
		{ snapshotId: "same-session-same-tab", browserSessionId: "session-1", tabId: 7, sourceMode: "scan", capturedAt: 1, ttlMs: 1_000, saved: { path: "same.json" } },
	];
	const server = {
		snapshot: () => ({ browserSessionId: "session-1", defaultTabId: 7 }),
		resolveTargetTabId: (value: unknown, _browserSessionId?: string) => typeof value === "number" ? value : undefined,
		listObservationSnapshots: () => snapshots,
	};
	assert.equal(selectDiffBaselineSnapshot(server as never, { browserSessionId: "session-1", diff: true }), "same-session-same-tab");
});

test("command schema characterization: diff auto-baseline selects the most recent matching snapshot for same session+tab", () => {
	const snapshots = [
		{ snapshotId: "same-session-same-tab-older", browserSessionId: "session-A", tabId: 5, sourceMode: "scan", capturedAt: 50, ttlMs: 300_000, saved: { path: "older.json" } },
		{ snapshotId: "same-session-same-tab-oldest", browserSessionId: "session-A", tabId: 5, sourceMode: "scan", capturedAt: 10, ttlMs: 300_000, saved: { path: "oldest.json" } },
		{ snapshotId: "same-session-same-tab-newest", browserSessionId: "session-A", tabId: 5, sourceMode: "scan", capturedAt: 100, ttlMs: 300_000, saved: { path: "newest.json" } },
	];
	const server = {
		snapshot: () => ({ browserSessionId: "session-A", defaultTabId: 5 }),
		resolveTargetTabId: (value: unknown, _browserSessionId?: string) => typeof value === "number" ? value : undefined,
		listObservationSnapshots: () => snapshots,
	};
	assert.equal(selectDiffBaselineSnapshot(server as never, { browserSessionId: "session-A", diff: true }), "same-session-same-tab-newest");
});

test("command schema characterization: diff auto-baseline does not cross session boundary even with same tabId", () => {
	const snapshots = [
		{ snapshotId: "wrong-session-newer", browserSessionId: "session-X", tabId: 3, sourceMode: "scan", capturedAt: 200, ttlMs: 300_000, saved: { path: "wrong.json" } },
		{ snapshotId: "correct-session", browserSessionId: "session-Y", tabId: 3, sourceMode: "scan", capturedAt: 100, ttlMs: 300_000, saved: { path: "correct.json" } },
	];
	const server = {
		snapshot: () => ({ browserSessionId: "session-Y", defaultTabId: 3 }),
		resolveTargetTabId: (value: unknown, _browserSessionId?: string) => typeof value === "number" ? value : undefined,
		listObservationSnapshots: () => snapshots,
	};
	assert.equal(selectDiffBaselineSnapshot(server as never, { browserSessionId: "session-Y", diff: true }), "correct-session");
});

test("command schema characterization: diff auto-baseline skips expired snapshots and snapshots without saved.path", () => {
	const snapshots = [
		{ snapshotId: "no-saved-path", browserSessionId: "session-Z", tabId: 1, sourceMode: "scan", capturedAt: 150, ttlMs: 300_000, saved: undefined },
		{ snapshotId: "valid-same-session-tab", browserSessionId: "session-Z", tabId: 1, sourceMode: "scan", capturedAt: 100, ttlMs: 300_000, saved: { path: "valid.json" } },
		{ snapshotId: "expired-same-session-tab", browserSessionId: "session-Z", tabId: 1, sourceMode: "scan", capturedAt: 200, ttlMs: 1_000, expired: true, saved: { path: "expired.json" } },
	];
	const server = {
		snapshot: () => ({ browserSessionId: "session-Z", defaultTabId: 1 }),
		resolveTargetTabId: (value: unknown, _browserSessionId?: string) => typeof value === "number" ? value : undefined,
		listObservationSnapshots: () => snapshots,
	};
	assert.equal(selectDiffBaselineSnapshot(server as never, { browserSessionId: "session-Z", diff: true }), "valid-same-session-tab");
});

test("command schema characterization: diff auto-baseline returns undefined when no matching snapshot exists", () => {
	const snapshots = [
		{ snapshotId: "other-session-only", browserSessionId: "session-other", tabId: 7, sourceMode: "scan", capturedAt: 100, ttlMs: 300_000, saved: { path: "other.json" } },
	];
	const server = {
		snapshot: () => ({ browserSessionId: "session-new", defaultTabId: 7 }),
		resolveTargetTabId: (value: unknown, _browserSessionId?: string) => typeof value === "number" ? value : undefined,
		listObservationSnapshots: () => snapshots,
	};
	assert.equal(selectDiffBaselineSnapshot(server as never, { browserSessionId: "session-new", diff: true }), undefined);
});

test("program dispatch characterization: discriminator boundary rejects ambiguous and malformed frames", () => {
	assert.deepEqual([...PROGRAM_OP_DISCRIMINATORS], ["eval", "mouse", "key", "text", "wait"]);
	assert.equal(validateProgram([{ eval: "document.title" }, { wait: 50, delay: 5 }]).ok, true);

	const ambiguous = dispatchProgramElement({ eval: "1", mouse: "click" }, 3);
	assert.equal(ambiguous.ok, false);
	if (!ambiguous.ok) assert.match(ambiguous.error, /exactly one required/);

	const unknownField = dispatchProgramElement({ key: "press", value: "Enter", typo: true }, 4);
	assert.equal(unknownField.ok, false);
	if (!unknownField.ok) assert.match(unknownField.error, /unknown parameters "value", "typo"/);

	const missingCoordinates = dispatchProgramElement({ mouse: "click" }, 5);
	assert.equal(missingCoordinates.ok, false);
	if (!missingCoordinates.ok) assert.match(missingCoordinates.error, /must be equal to constant/);
});
