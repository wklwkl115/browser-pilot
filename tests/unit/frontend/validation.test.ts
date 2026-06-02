import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { validateToolArgs } from "../../../src/frontend/validation.ts";

const schema = Type.Object(
	{ script: Type.String(), tabId: Type.Optional(Type.Number()), redact: Type.Optional(Type.Boolean()) },
	{ additionalProperties: false },
);

test("validateToolArgs names unknown params and lists the accepted ones", () => {
	const res = validateToolArgs(schema, { script: "x", bogusField: 1 });
	assert.equal(res.ok, false);
	if (res.ok) return;
	assert.match(res.error, /unknown parameter "bogusField"/);
	assert.match(res.error, /accepted: script, tabId, redact/);
});

test("validateToolArgs lists every unknown param when several are passed", () => {
	const res = validateToolArgs(schema, { script: "x", foo: 1, bar: 2 });
	assert.equal(res.ok, false);
	if (res.ok) return;
	assert.match(res.error, /unknown parameters "foo", "bar"/);
});

test("validateToolArgs coerces scalars and accepts valid args", () => {
	const res = validateToolArgs(schema, { script: "x", tabId: "5", redact: "false" });
	assert.equal(res.ok, true);
	if (!res.ok) return;
	assert.equal(res.args.tabId, 5);
	assert.equal(res.args.redact, false);
});

test("validateToolArgs passes through when there is no schema", () => {
	const res = validateToolArgs(undefined, { anything: true });
	assert.equal(res.ok, true);
	if (!res.ok) return;
	assert.deepEqual(res.args, { anything: true });
});
