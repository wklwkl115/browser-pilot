import test from "node:test";
import assert from "node:assert/strict";
import { createCodedError } from "../../../src/utils/codedError.ts";

test("createCodedError sets code and message", () => {
	const err = createCodedError({ name: "TestError", code: "MY_CODE", message: "something failed" });
	assert.equal(err.code, "MY_CODE");
	assert.equal(err.message, "something failed");
	assert.equal(err.name, "TestError");
	assert.ok(err instanceof Error);
});

test("createCodedError sets details to empty object by default", () => {
	const err = createCodedError({ name: "TestError", code: "X", message: "msg" });
	assert.deepEqual(err.details, {});
});

test("createCodedError stores provided details", () => {
	const err = createCodedError({ name: "TestError", code: "X", message: "msg", details: { foo: 1, bar: "baz" } });
	assert.deepEqual(err.details, { foo: 1, bar: "baz" });
});

test("createCodedError suppresses stack by default", () => {
	const err = createCodedError({ name: "TestError", code: "X", message: "msg" });
	assert.ok(!err.stack, `expected stack to be suppressed, got: ${err.stack}`);
});

test("createCodedError preserves stack when suppressStack is false", () => {
	const err = createCodedError({ name: "TestError", code: "X", message: "msg", suppressStack: false });
	assert.ok(err.stack && err.stack.length > 0);
});

test("createCodedError is instanceof Error", () => {
	const err = createCodedError({ name: "TestError", code: "X", message: "msg" });
	assert.ok(err instanceof Error);
});
