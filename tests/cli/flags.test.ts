import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { buildFlagSpecs, coerceParams, parseArgs, resolveParamValueReferences, wantsJson, type FlagKind, type FlagSpec } from "../../src/apps/cli/flags.ts";

function flag(name: string, kind: FlagKind, extra: Partial<FlagSpec> = {}): FlagSpec {
	return { name, flag: `--${name}`, kind, required: false, ...extra };
}

test("CLI flags characterize schema generation, render mode ordering, and strict typed validation", () => {
	const schema = {
		type: "object",
		properties: {
			name: { type: "string", description: "Name" },
			count: { type: "integer" },
			enabled: { type: "boolean" },
			tags: { type: "array" },
			params: { type: "object" },
			mode: { anyOf: [{ const: "fast" }, { const: "safe" }] },
			mixed: { anyOf: [{ type: "number" }, { type: "string" }] },
		},
		required: ["name"],
	};
	assert.deepEqual(buildFlagSpecs(schema).map(({ name, flag: cliFlag, kind, choices, required }) => ({ name, flag: cliFlag, kind, choices, required })), [
		{ name: "name", flag: "--name", kind: "string", choices: undefined, required: true },
		{ name: "count", flag: "--count", kind: "number", choices: undefined, required: false },
		{ name: "enabled", flag: "--enabled", kind: "boolean", choices: undefined, required: false },
		{ name: "tags", flag: "--tags", kind: "array", choices: undefined, required: false },
		{ name: "params", flag: "--params", kind: "json", choices: undefined, required: false },
		{ name: "mode", flag: "--mode", kind: "enum", choices: ["fast", "safe"], required: false },
		{ name: "mixed", flag: "--mixed", kind: "string", choices: undefined, required: false },
	]);
	assert.equal(wantsJson(["--json", "--text", "--json"]), true);
	assert.equal(wantsJson(["--json", "--text"]), false);
	const typedSchema = Type.Object({ name: Type.String(), count: Type.Integer(), enabled: Type.Boolean() });
	assert.equal(coerceParams(typedSchema, { name: "pilot", count: "3", enabled: "true" }).ok, false);
	assert.deepEqual(coerceParams(typedSchema, { name: "pilot", count: 3, enabled: true }), { ok: true, args: { name: "pilot", count: 3, enabled: true } });
});

test("CLI flags characterize globals, inline values, booleans, enums, arrays, and JSON", () => {
	const specs = [
		flag("name", "string"),
		flag("count", "number"),
		flag("enabled", "boolean"),
		flag("mode", "enum", { choices: ["fast", "safe"] }),
		flag("tags", "array", { split: "comma" }),
		flag("inputs", "array"),
		flag("ports", "array", { split: "comma", itemKind: "number" }),
		flag("params", "json"),
	];
	const parsed = parseArgs(specs, ["--text", "--json", "--name=pilot", "--count", "-1", "--enabled=false", "--mode", "fast", "--tags", "a, b", "--tags=c", "--inputs", "one", "--inputs=two", "--ports", "80,443", "--params", "{\"x\":1}", "--no-enabled", "--help"]);
	assert.deepEqual(parsed, {
		ok: true,
		value: {
			globals: { json: true, text: false, help: true },
			params: { name: "pilot", count: -1, enabled: false, mode: "fast", tags: ["a", "b", "c"], inputs: ["one", "two"], ports: [80, 443], params: { x: 1 } },
		},
	});
});

test("CLI flags characterize file references and post-JSON reference resolution", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-pilot-flags-"));
	await Promise.all([
		writeFile(path.join(cwd, "params.json"), "{\"limit\":5}"),
		writeFile(path.join(cwd, "items.json"), "[\"a\",\"b\"]"),
		writeFile(path.join(cwd, "lines.txt"), "c\n\nd\n"),
		writeFile(path.join(cwd, "content.txt"), "script body"),
	]);
	const specs = [flag("params", "json"), flag("items", "array"), flag("content", "string")];
	assert.deepEqual(parseArgs(specs, ["--params", "@params.json", "--items", "@items.json", "--items", "@lines.txt", "--content", "@content.txt"], cwd), {
		ok: true,
		value: { globals: { json: false, text: false, help: false }, params: { params: { limit: 5 }, items: ["a", "b", "c", "d"], content: "script body" } },
	});
	assert.deepEqual(resolveParamValueReferences(specs, { params: "@params.json", content: "literal", untouched: "@missing.txt" }, cwd), { ok: true, params: { params: { limit: 5 }, content: "literal", untouched: "@missing.txt" } });
	assert.deepEqual(resolveParamValueReferences([flag("content", "string", { valueReferences: false })], { content: "@missing.txt" }, cwd), { ok: true, params: { content: "@missing.txt" } });
});

test("CLI flags characterize parse errors, typo suggestions, and retired-flag guidance", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-pilot-flags-errors-"));
	await writeFile(path.join(cwd, "invalid-array.json"), "[invalid");
	const specs = [flag("name", "string"), flag("enabled", "boolean"), flag("mode", "enum", { choices: ["fast", "safe"] }), flag("items", "array"), flag("params", "json"), flag("command", "json", { valueReferences: false })];
	const cases: Array<{ argv: string[]; pattern: RegExp }> = [
		{ argv: ["positional"], pattern: /unexpected argument/ },
		{ argv: ["--nmae", "pilot"], pattern: /did you mean "--name"/ },
		{ argv: ["--timeout-ms", "5"], pattern: /timeoutMs is internal now/ },
		{ argv: ["--name"], pattern: /needs a value/ },
		{ argv: ["--enabled=maybe"], pattern: /expects true or false/ },
		{ argv: ["--mode", "turbo"], pattern: /must be one of: fast, safe/ },
		{ argv: ["--params", "{"], pattern: /expects JSON/ },
		{ argv: ["--command", "@command.json"], pattern: /file references are not supported/ },
		{ argv: ["--items", "@invalid-array.json"], pattern: /expects a JSON array or newline list/ },
		{ argv: ["--items", "@missing.json"], pattern: /cannot read/ },
	];
	for (const { argv, pattern } of cases) {
		const parsed = parseArgs(specs, argv, cwd);
		assert.equal(parsed.ok, false, argv.join(" "));
		if (!parsed.ok) assert.match(parsed.error, pattern);
	}
	const noFlags = parseArgs([], ["--unknown"]);
	assert.equal(noFlags.ok, false);
	if (!noFlags.ok) assert.match(noFlags.error, /accepted: \(none\)/);
});
