import assert from "node:assert/strict";
import { BrowserBridgeError, errorToPlain } from "../../src/driver/errors.ts";
import { validateBridgeCommand } from "../../src/protocol/nativeProtocol.ts";
import { assertBridgeCommandSucceeded } from "../../src/tools/bridgeResultValidation.ts";
import { ArtifactReaderError } from "../../src/tools/artifactReader.ts";
import { codedTransferError } from "../../src/tools/transferValidation.ts";
import { webSecurityToolError } from "../../src/tools/webSecurity/shared/diagnostics.ts";
import { compactError, normalizeError, suppressErrorStack } from "../../src/utils/errors.ts";
import { jsonPreview, stableJson } from "../../src/utils/json.ts";
import { asPositiveInt } from "../../src/utils/params.ts";
import { errorResult } from "../../src/utils/toolResult.ts";

function assertNormalized(value, label) {
	assert.equal(typeof value.code, "string", `${label}: code must be string`);
	assert.ok(value.code.length > 0, `${label}: code must be non-empty`);
	assert.equal(typeof value.message, "string", `${label}: message must be string`);
	assert.ok(value.message.length > 0, `${label}: message must be non-empty`);
	assert.equal(value.details && typeof value.details === "object" && !Array.isArray(value.details), true, `${label}: details must be object`);
	assert.equal(value.taxonomy && typeof value.taxonomy === "object" && !Array.isArray(value.taxonomy), true, `${label}: taxonomy must be object`);
	assert.equal(typeof value.taxonomy.domain, "string", `${label}: taxonomy.domain must be string`);
	assert.equal(typeof value.taxonomy.category, "string", `${label}: taxonomy.category must be string`);
	assert.equal(typeof value.taxonomy.retryable, "boolean", `${label}: taxonomy.retryable must be boolean`);
	assert.equal(value.diagnostics && typeof value.diagnostics === "object" && !Array.isArray(value.diagnostics), true, `${label}: diagnostics must be object`);
	assert.equal(Array.isArray(value.diagnostics.scopes), true, `${label}: diagnostics.scopes must be array`);
}

const bridgeError = new BrowserBridgeError("BRIDGE_TIMEOUT", "timed out", { id: "1", pendingCount: 1 });
const bridgePlain = errorToPlain(bridgeError);
assertNormalized(bridgePlain, "BrowserBridgeError");
assert.equal(bridgePlain.code, "BRIDGE_TIMEOUT");
assert.equal(bridgePlain.details.pendingCount, 1);
assert.equal(bridgePlain.taxonomy.domain, "driver");
assert.equal(bridgePlain.taxonomy.retryable, true);
assert.ok(bridgePlain.diagnostics.scopes.includes("pending"), "driver timeout diagnostics must expose pending scope");
const targetPlain = normalizeError(new BrowserBridgeError("TAB_NOT_FOUND", "missing tab", { target: { tabId: 7, browserId: "browser-1", source: "explicit" } }));
assert.equal(targetPlain.taxonomy.domain, "driver");
assert.equal(targetPlain.diagnostics.target.tabId, 7, "driver target diagnostics must preserve tabId");
assert.equal(targetPlain.diagnostics.target.browserId, "browser-1", "driver target diagnostics must preserve browserId");
assert.equal(targetPlain.diagnostics.nextActions?.includes("browser_tabs action=list"), true, "driver target errors must expose factual nextActions");

const artifactError = new ArtifactReaderError("ARTIFACT_TOO_LARGE", "too large", { bytes: 10, maxBytes: 5 });
const artifactPlain = normalizeError(artifactError);
assertNormalized(artifactPlain, "ArtifactReaderError");
assert.equal(artifactPlain.code, "ARTIFACT_TOO_LARGE");
assert.equal(artifactPlain.details.maxBytes, 5);
assert.equal(artifactPlain.taxonomy.domain, "artifact");
assert.equal(artifactPlain.taxonomy.source, "heuristic");
assert.ok(artifactPlain.diagnostics.scopes.includes("artifact"), "artifact errors must expose artifact diagnostics scope");
assert.equal(Array.isArray(artifactPlain.recovery?.nextActions), true, "artifact errors must expose bounded browser_artifact recovery guidance");

const protocol = validateBridgeCommand({ cmd: "wait.selector", tabId: 1 }, { allowMissingTabId: false });
assert.equal(protocol.ok, false, "protocol command must fail for missing selector");
const protocolError = normalizeError({ code: "INVALID_BROWSER_COMMAND", message: protocol.error, details: protocol.details });
assertNormalized(protocolError, "protocol validation error");
assert.equal(protocolError.code, "INVALID_BROWSER_COMMAND");
assert.deepEqual(protocolError.details.missing, ["selector"]);
assert.equal(protocolError.taxonomy.domain, "protocol");
assert.equal(protocolError.taxonomy.category, "driver.command");
assert.equal(protocolError.recovery?.nextActions?.includes("use browser_command with a validated command object"), true, "protocol validation errors must suggest browser_command recovery");

const plainError = normalizeError(new Error("plain boom"));
assertNormalized(plainError, "plain Error");
assert.equal(plainError.code, "INTERNAL_ERROR");
assert.equal(plainError.taxonomy.domain, "native");
const toolError = normalizeError({ code: "CONTENT_EXTRACTION_FAILED", message: "content failed", details: { selector: "main" } });
assert.equal(toolError.taxonomy.domain, "tool", "tool errors must keep tool taxonomy domain");
const cdpError = normalizeError({ error: { code: "SEND_FAILED", message: "CDP send failed", details: { method: "Runtime.evaluate", tabId: 4 } } });
assert.equal(cdpError.taxonomy.domain, "cdp", "persistent CDP errors must classify as cdp");
assert.equal(cdpError.diagnostics.target.tabId, 4, "CDP errors must expose target diagnostics when available");

const result = errorResult(artifactError);
const text = result.content[0].text;
assert.ok(text.includes('"code": "ARTIFACT_TOO_LARGE"'), "errorResult content must include code");
assert.ok(text.includes('"taxonomy"'), "errorResult content must include taxonomy");
assert.equal(text.includes("stack"), false, "errorResult content must not include stack traces by default");
assert.equal(result.details.error.code, "ARTIFACT_TOO_LARGE", "errorResult details must include code");
assert.equal(result.details.error.taxonomy.domain, "artifact", "errorResult details must include taxonomy");
assert.equal(result.details.error.details.maxBytes, 5, "errorResult details must include error details");
assert.equal(Object.hasOwn(result.details.error, "stack"), false, "errorResult details must not include stack traces by default");

const nestedStack = normalizeError(new BrowserBridgeError("BROWSER_EXECUTION_ERROR", "script failed", { error: { code: "DOM_NODE_NOT_FOUND", message: "stale", stack: "nested stack", details: { stack: "details stack", selector: "#go" } } }));
assert.equal(JSON.stringify(nestedStack).includes("stack"), false, "normalizeError must strip nested stack traces from details");
assert.equal(nestedStack.details.error.details.selector, "#go", "normalizeError must preserve non-stack nested details");
const nestedResult = errorResult(new BrowserBridgeError("BROWSER_EXECUTION_ERROR", "script failed", { error: { code: "DOM_NODE_NOT_FOUND", message: "stale", stack: "nested stack" } }));
assert.equal(nestedResult.content[0].text.includes("stack"), false, "errorResult content must strip nested stack traces");
assert.equal(JSON.stringify(nestedResult.details).includes("stack"), false, "errorResult details must strip nested stack traces");
assert.equal(nestedResult.details.error.taxonomy.domain, "driver", "wrapper BrowserBridgeError must keep public driver code taxonomy");

const nativeNetworkError = normalizeError({ error_code: "BODY_UNAVAILABLE", error: "body unavailable", details: { requestId: "r1", bodyUnavailableReason: "evicted", postData: "token=native-secret" } });
assertNormalized(nativeNetworkError, "native network response");
assert.equal(nativeNetworkError.code, "BODY_UNAVAILABLE");
assert.equal(nativeNetworkError.taxonomy.domain, "network");
assert.equal(nativeNetworkError.taxonomy.retryable, false);
assert.ok(nativeNetworkError.diagnostics.scopes.includes("network"), "native network response must expose network diagnostics");
assert.equal(nativeNetworkError.diagnostics.session.requestId, "r1", "native network response must expose request/session diagnostics");
const compactNativeNetwork = compactError({ error_code: "BODY_UNAVAILABLE", error: "body unavailable", details: { requestId: "r1", postData: "token=native-secret" } });
assert.equal(JSON.stringify(compactNativeNetwork).includes("native-secret"), false, "compactError must redact native response secrets");

const bridgeNested = normalizeError({ error: { code: "BODY_UNAVAILABLE", message: "body missing", details: { requestId: "req-1", postData: "nested-secret" } } });
assert.equal(bridgeNested.code, "BODY_UNAVAILABLE", "bridge nested response must preserve nested native error code");
assert.equal(bridgeNested.taxonomy.domain, "network", "bridge nested response must classify nested native error");
assert.equal(JSON.stringify(compactError({ error: { code: "BODY_UNAVAILABLE", message: "body missing", details: { requestId: "req-1", postData: "nested-secret" } } })).includes("nested-secret"), false, "bridge nested response must redact nested body/postData secrets");

assert.throws(() => assertBridgeCommandSucceeded({ data: { ok: false, error_code: "INVALID_SELECTOR", error: "bad selector", details: { selector: "#go", stack: "native stack" } } }, "html.get"), (error) => {
	const normalized = normalizeError(error);
	assert.equal(normalized.code, "INVALID_SELECTOR", "native response assertion must preserve error_code");
	assert.equal(normalized.taxonomy.domain, "page", "native page/selector errors must classify as page");
	assert.equal(JSON.stringify(normalized).includes("stack"), false, "native response assertion must strip stack");
	return true;
});

const transferError = codedTransferError("UPLOAD_CONFIRMATION_REQUIRED", "browser_upload requires confirm:true", { selector: "#file" });
const transferPlain = normalizeError(transferError);
assertNormalized(transferPlain, "transfer error");
assert.equal(transferPlain.taxonomy.domain, "transfer");
assert.equal(transferPlain.taxonomy.retryable, false);
assert.ok(transferPlain.diagnostics.scopes.includes("transfer"), "transfer errors must expose transfer diagnostics scope");

const webCause = new Error("Authorization: Bearer web-secret");
webCause.details = { headers: { Cookie: "sid=web-cookie" }, token: "web-token" };
const webSecurityError = webSecurityToolError(webCause, { toolName: "browser_recon_probe", command: "recon.probe" });
const webSecurityPlain = normalizeError(webSecurityError);
assertNormalized(webSecurityPlain, "webSecurity error");
assert.equal(webSecurityPlain.taxonomy.domain, "security");
assert.ok(webSecurityPlain.diagnostics.scopes.includes("security"), "webSecurity errors must expose security diagnostics scope");
const webSecurityResult = errorResult(webSecurityError);
for (const secret of ["web-secret", "web-cookie", "web-token"]) assert.equal(JSON.stringify(webSecurityResult).includes(secret), false, `webSecurity error must redact ${secret}`);
assert.equal(JSON.stringify(webSecurityResult).includes("stack"), false, "webSecurity error result must not include stack");

const stacklessError = suppressErrorStack(new Error("stackless"));
assert.equal(Object.hasOwn(stacklessError, "stack"), false, "suppressErrorStack must remove configurable own stack fields");
const nonConfigurableStackError = new Error("non-configurable stack");
Object.defineProperty(nonConfigurableStackError, "stack", { get() { return "locked stack"; }, configurable: false });
assert.doesNotThrow(() => suppressErrorStack(nonConfigurableStackError), "suppressErrorStack must not throw on non-configurable stack accessors");
assert.equal(nonConfigurableStackError.stack, "locked stack", "locked stack accessors remain readable when they cannot be suppressed safely");

assert.equal(asPositiveInt(15.1, 100), 16, "asPositiveInt must not floor fractional user budgets below the requested value");
assert.equal(asPositiveInt(0.1, 100), 1, "asPositiveInt must keep positive fractional input positive after integer normalization");
assert.equal(asPositiveInt(15, 100), 15, "asPositiveInt must preserve integer values");
assert.equal(asPositiveInt(0, 100), 100, "asPositiveInt must reject zero values to fallback");

const circular = { name: "root" };
circular.self = circular;
const circularJson = stableJson(circular);
assert.ok(circularJson.includes('"self": "[Circular]"'), "stableJson must serialize circular references without throwing");
assert.ok(jsonPreview(circular, 120).text.includes("[Circular]"), "jsonPreview must tolerate circular references");
const shared = { value: 1 };
const sharedJson = stableJson({ left: shared, right: shared, big: 1n });
assert.equal((sharedJson.match(/"value": 1/g) || []).length, 2, "stableJson must not label non-cyclic shared references as circular");
assert.ok(sharedJson.includes('"big": "1"'), "stableJson must keep bigint stringification");
assert.equal(sharedJson.includes("[Circular]"), false, "stableJson must only mark actual ancestor cycles");
const circularDetails = { selector: "#go" };
circularDetails.self = circularDetails;
const circularErrorResult = errorResult(new BrowserBridgeError("BROWSER_EXECUTION_ERROR", "loop", circularDetails));
assert.ok(circularErrorResult.content[0].text.includes("[Circular]"), "errorResult content must tolerate circular error details");
assert.ok(JSON.stringify(circularErrorResult.details).includes("[Circular]"), "errorResult details must tolerate circular error details");

console.log("error contract ok");
