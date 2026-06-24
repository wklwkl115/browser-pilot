import test from "node:test";
import assert from "node:assert/strict";
import { buildCliCommands, collectCommandDefs } from "../../src/apps/cli/registry.ts";
import { WEB_SECURITY_TOOL_NAMES } from "../../src/commands/commandCatalog.ts";
import { validateCommandArgs } from "../../src/validation/commandArgs.ts";
import { dispatchProgramElement, validateProgram } from "../../src/browser-command-runtime/programDispatcher.ts";
import { PROGRAM_OP_DISCRIMINATORS } from "../../src/browser-command-runtime/programOps.ts";

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
	assert.deepEqual([...WEB_SECURITY_TOOL_NAMES].sort(), [
		"browser_callback_oast",
		"browser_cookie_analyze",
		"browser_crawl",
		"browser_fuzz",
		"browser_http_replay",
		"browser_sqli",
		"browser_template",
	].sort());
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
