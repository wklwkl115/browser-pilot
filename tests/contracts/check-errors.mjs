import assert from "node:assert/strict";
import { BrowserBridgeError, errorToPlain } from "../../src/driver/errors.ts";
import { validateBridgeCommand } from "../../src/protocol/nativeProtocol.ts";
import { ArtifactReaderError } from "../../src/tools/artifactReader.ts";
import { normalizeError } from "../../src/utils/errors.ts";
import { errorResult } from "../../src/utils/toolResult.ts";

function assertNormalized(value, label) {
	assert.equal(typeof value.code, "string", `${label}: code must be string`);
	assert.ok(value.code.length > 0, `${label}: code must be non-empty`);
	assert.equal(typeof value.message, "string", `${label}: message must be string`);
	assert.ok(value.message.length > 0, `${label}: message must be non-empty`);
	assert.equal(value.details && typeof value.details === "object" && !Array.isArray(value.details), true, `${label}: details must be object`);
}

const bridgeError = new BrowserBridgeError("BRIDGE_TIMEOUT", "timed out", { id: "1", pendingCount: 1 });
const bridgePlain = errorToPlain(bridgeError);
assertNormalized(bridgePlain, "BrowserBridgeError");
assert.equal(bridgePlain.code, "BRIDGE_TIMEOUT");
assert.equal(bridgePlain.details.pendingCount, 1);

const artifactError = new ArtifactReaderError("ARTIFACT_TOO_LARGE", "too large", { bytes: 10, maxBytes: 5 });
const artifactPlain = normalizeError(artifactError);
assertNormalized(artifactPlain, "ArtifactReaderError");
assert.equal(artifactPlain.code, "ARTIFACT_TOO_LARGE");
assert.equal(artifactPlain.details.maxBytes, 5);

const protocol = validateBridgeCommand({ cmd: "wait.selector", tabId: 1 }, { allowMissingTabId: false });
assert.equal(protocol.ok, false, "protocol command must fail for missing selector");
const protocolError = normalizeError({ code: "INVALID_BROWSER_COMMAND", message: protocol.error, details: protocol.details });
assertNormalized(protocolError, "protocol validation error");
assert.equal(protocolError.code, "INVALID_BROWSER_COMMAND");
assert.deepEqual(protocolError.details.missing, ["selector"]);

const plainError = normalizeError(new Error("plain boom"));
assertNormalized(plainError, "plain Error");
assert.equal(plainError.code, "INTERNAL_ERROR");

const result = errorResult(artifactError);
const text = result.content[0].text;
assert.ok(text.includes('"code": "ARTIFACT_TOO_LARGE"'), "errorResult content must include code");
assert.equal(text.includes("stack"), false, "errorResult content must not include stack traces by default");
assert.equal(result.details.error.code, "ARTIFACT_TOO_LARGE", "errorResult details must include code");
assert.equal(result.details.error.details.maxBytes, 5, "errorResult details must include error details");
assert.equal(Object.hasOwn(result.details.error, "stack"), false, "errorResult details must not include stack traces by default");

const nestedStack = normalizeError(new BrowserBridgeError("BROWSER_EXECUTION_ERROR", "script failed", { error: { code: "DOM_NODE_NOT_FOUND", message: "stale", stack: "nested stack", details: { stack: "details stack", selector: "#go" } } }));
assert.equal(JSON.stringify(nestedStack).includes("stack"), false, "normalizeError must strip nested stack traces from details");
assert.equal(nestedStack.details.error.details.selector, "#go", "normalizeError must preserve non-stack nested details");
const nestedResult = errorResult(new BrowserBridgeError("BROWSER_EXECUTION_ERROR", "script failed", { error: { code: "DOM_NODE_NOT_FOUND", message: "stale", stack: "nested stack" } }));
assert.equal(nestedResult.content[0].text.includes("stack"), false, "errorResult content must strip nested stack traces");
assert.equal(JSON.stringify(nestedResult.details).includes("stack"), false, "errorResult details must strip nested stack traces");

console.log("error contract ok");
