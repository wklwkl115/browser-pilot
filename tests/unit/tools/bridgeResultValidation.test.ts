import test from "node:test";
import assert from "node:assert/strict";
import { assertBridgeCommandSucceeded } from "../../../src/tools/bridgeResultValidation.ts";

test("assertBridgeCommandSucceeded does not throw when ok is not false", () => {
	assert.doesNotThrow(() => assertBridgeCommandSucceeded({ data: { ok: true } }, "test_command"));
});

test("assertBridgeCommandSucceeded does not throw when data is missing", () => {
	assert.doesNotThrow(() => assertBridgeCommandSucceeded({}, "test_command"));
});

test("assertBridgeCommandSucceeded does not throw when data is not a record", () => {
	assert.doesNotThrow(() => assertBridgeCommandSucceeded({ data: "string" }, "test_command"));
	assert.doesNotThrow(() => assertBridgeCommandSucceeded({ data: null }, "test_command"));
});

test("assertBridgeCommandSucceeded throws CodedError when ok is false", () => {
	assert.throws(
		() => assertBridgeCommandSucceeded({ data: { ok: false, error: "Something failed" } }, "my_command"),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.ok(err.message.includes("Something failed"));
			return true;
		}
	);
});

test("assertBridgeCommandSucceeded uses error_code when present", () => {
	assert.throws(
		() => assertBridgeCommandSucceeded({ data: { ok: false, error_code: "TAB_NOT_FOUND", error: "no tab" } }, "cmd"),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.ok((err as { code?: string }).code === "TAB_NOT_FOUND", `code was ${(err as { code?: string }).code}`);
			return true;
		}
	);
});

test("assertBridgeCommandSucceeded falls back to BROWSER_COMMAND_FAILED when no code", () => {
	assert.throws(
		() => assertBridgeCommandSucceeded({ data: { ok: false } }, "cmd"),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.equal((err as { code?: string }).code, "BROWSER_COMMAND_FAILED");
			return true;
		}
	);
});

test("assertBridgeCommandSucceeded uses nested error message from error object", () => {
	assert.throws(
		() => assertBridgeCommandSucceeded({
			data: {
				ok: false,
				error: { code: "NESTED_CODE", message: "nested error message", details: { extra: 1 } },
			}
		}, "cmd"),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.ok(err.message.includes("nested error message"), `message was: ${err.message}`);
			return true;
		}
	);
});

test("assertBridgeCommandSucceeded includes command in error details", () => {
	assert.throws(
		() => assertBridgeCommandSucceeded({ data: { ok: false, error: "fail" } }, "special_command"),
		(err: unknown) => {
			const details = (err as { details?: Record<string, unknown> }).details;
			assert.equal(details?.command, "special_command");
			return true;
		}
	);
});

test("assertBridgeCommandSucceeded strips stack from nested error details", () => {
	assert.throws(
		() => assertBridgeCommandSucceeded({
			data: {
				ok: false,
				error: { code: "ERR", message: "fail", details: { stack: "Error: fail\n at foo\n at bar" } },
			}
		}, "cmd"),
		(err: unknown) => {
			const details = (err as { details?: Record<string, unknown> }).details as Record<string, unknown>;
			assert.equal(details?.stack, undefined, "stack should be stripped from nested details");
			return true;
		}
	);
});
