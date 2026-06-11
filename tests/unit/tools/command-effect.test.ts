import test from "node:test";
import assert from "node:assert/strict";
import { commandCollectsExecutionEffect } from "../../../src/tools/executionEffect.ts";

test("browser_command effect collection is limited to tab-scoped writes", () => {
	assert.equal(commandCollectsExecutionEffect({ cmd: "input.pointer", tabId: 1, gesture: "press", x: 10, y: 12 }), true);
	assert.equal(commandCollectsExecutionEffect({ cmd: "input.keys", tabId: 1, text: "redacted" }), true);
	assert.equal(commandCollectsExecutionEffect({ cmd: "wait.navigateAndWait", tabId: 1, url: "https://example.test" }), true);
	assert.equal(commandCollectsExecutionEffect({ cmd: "content.fingerprint", tabId: 1 }), false);
	assert.equal(commandCollectsExecutionEffect({ cmd: "network.status", tabId: 1 }), false);
	assert.equal(commandCollectsExecutionEffect({ cmd: "tabs", method: "create", url: "https://example.test" }), false);
});
