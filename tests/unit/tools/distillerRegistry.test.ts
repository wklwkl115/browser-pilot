import test from "node:test";
import assert from "node:assert/strict";
import {
	registerDistiller,
	registerCommandDistiller,
	registerDistillerDefinition,
	distillValue,
	hasRegisteredDistiller,
	getDistillerDefinition,
	getDistillerRegistrySnapshot,
	unwrapDistillData,
} from "../../../src/tools/distillerRegistry.ts";
import { Type } from "typebox";

// ── unwrapDistillData ────────────────────────────────────────────────────────

test("unwrapDistillData returns data field when present", () => {
	assert.deepEqual(unwrapDistillData({ data: { key: "val" } }), { key: "val" });
});

test("unwrapDistillData returns value unchanged when no data field", () => {
	assert.deepEqual(unwrapDistillData({ other: 1 }), { other: 1 });
});

test("unwrapDistillData returns non-object values unchanged", () => {
	assert.equal(unwrapDistillData("hello"), "hello");
	assert.equal(unwrapDistillData(42), 42);
	assert.equal(unwrapDistillData(null), null);
});

// ── registerDistiller and distillValue ───────────────────────────────────────

test("registerDistiller allows distillValue to use custom distiller", () => {
	const toolName = `__test_tool_${Date.now()}`;
	registerDistiller(toolName, (value) => ({ custom: true, input: value }));
	const result = distillValue(toolName, undefined, { raw: 1 });
	assert.equal(result.custom, true);
	assert.deepEqual(result.input, { raw: 1 });
});

test("distillValue falls back to summarizeGenericValue for unknown tool", () => {
	const result = distillValue("__tool_never_registered__", undefined, { a: 1 });
	assert.ok(typeof result === "object");
});

test("hasRegisteredDistiller returns true after registration", () => {
	const toolName = `__test_has_${Date.now()}`;
	registerDistiller(toolName, () => ({}));
	assert.equal(hasRegisteredDistiller(toolName), true);
});

test("hasRegisteredDistiller returns false for unknown tool", () => {
	assert.equal(hasRegisteredDistiller("__nonexistent_tool_xyz__"), false);
});

// ── registerCommandDistiller ─────────────────────────────────────────────────

test("registerCommandDistiller routes by command match", () => {
	const label = `__cmd_distiller_${Date.now()}`;
	registerCommandDistiller(label, (cmd) => cmd === "my-special-command", () => ({ matched: true }));
	const result = distillValue("__any_unknown_tool__", "my-special-command", {});
	assert.equal(result.matched, true);
});

test("registerCommandDistiller replaces existing rule with same label", () => {
	const label = `__cmd_replace_${Date.now()}`;
	registerCommandDistiller(label, (cmd) => cmd === "cmd-x", () => ({ version: 1 }));
	registerCommandDistiller(label, (cmd) => cmd === "cmd-x", () => ({ version: 2 }));
	const result = distillValue("__any_tool__", "cmd-x", {});
	assert.equal(result.version, 2);
});

// ── registerDistillerDefinition ──────────────────────────────────────────────

test("registerDistillerDefinition registers and retrieves definition", () => {
	const toolName = `__def_tool_${Date.now()}`;
	const schema = Type.Object({ ok: Type.Boolean() });
	registerDistillerDefinition({ toolName, summarySchema: schema, distill: () => ({ ok: true }) });
	const def = getDistillerDefinition(toolName);
	assert.ok(def !== undefined);
	assert.equal(def!.toolName, toolName);
	assert.deepEqual(def!.distill({}, undefined), { ok: true });
});

test("registerDistillerDefinition also makes distillValue work", () => {
	const toolName = `__def_distill_${Date.now()}`;
	registerDistillerDefinition({ toolName, summarySchema: Type.Object({}), distill: () => ({ fromDef: 1 }) });
	const result = distillValue(toolName, undefined, {});
	assert.equal(result.fromDef, 1);
});

test("getDistillerDefinition returns undefined for non-definition tool", () => {
	const toolName = `__legacy_only_${Date.now()}`;
	registerDistiller(toolName, () => ({}));
	assert.equal(getDistillerDefinition(toolName), undefined);
});

// ── getDistillerRegistrySnapshot ─────────────────────────────────────────────

test("getDistillerRegistrySnapshot returns sorted toolNames", () => {
	const snapshot = getDistillerRegistrySnapshot();
	assert.ok(Array.isArray(snapshot.toolNames));
	const sorted = [...snapshot.toolNames].sort();
	assert.deepEqual(snapshot.toolNames, sorted);
});

test("getDistillerRegistrySnapshot includes registered tool names", () => {
	const toolName = `__snapshot_tool_${Date.now()}`;
	registerDistiller(toolName, () => ({}));
	const snapshot = getDistillerRegistrySnapshot();
	assert.ok(snapshot.toolNames.includes(toolName));
});
