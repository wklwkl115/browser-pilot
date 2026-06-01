/**
 * MCP ingress handle resolution contract (Phase 6).
 *
 * Verifies:
 * - Handle-accepting fields side-table covers the 3 declared tools
 * - Handle detection (browser-result:// URI strings only)
 * - Positive: resolve → expand → args contain payload not URI
 * - Negative: kind mismatch, expired, unknown ID, not a handle
 * - Diagnostics echo handle meta, not payload
 * - No auto tool-chaining (no selectTarget, no auto next-tool)
 * - Handle resolution happens BEFORE TypeBox validation (ordering check)
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// ── Source-level contracts ────────────────────────────────────────────────────

const handlerSrc = read("mcp/handleResolver.ts");
assert(handlerSrc.includes("resolveIngressHandles"), "handleResolver.ts must export resolveIngressHandles");
assert(handlerSrc.includes("HANDLE_ACCEPTING_FIELDS"), "handleResolver.ts must use HANDLE_ACCEPTING_FIELDS side-table");
assert(handlerSrc.includes("HANDLE_KIND_MISMATCH"), "handleResolver.ts must return HANDLE_KIND_MISMATCH error code");
assert(handlerSrc.includes("HANDLE_NOT_FOUND"), "handleResolver.ts must return HANDLE_NOT_FOUND error code");
assert(!handlerSrc.includes("selectTarget") && !handlerSrc.includes("autoChain"),
	"handleResolver.ts must not implement auto tool chaining");

const fieldsSrc = read("mcp/handleFields.ts");
assert(fieldsSrc.includes("browser_sqli"), "handleFields.ts must declare browser_sqli handle fields");
assert(fieldsSrc.includes("browser_http_replay"), "handleFields.ts must declare browser_http_replay handle fields");
assert(fieldsSrc.includes("browser_fuzz"), "handleFields.ts must declare browser_fuzz handle fields");
assert(fieldsSrc.includes("http-request"), "handleFields.ts must declare http-request as expected kind");

const indexSrc = read("mcp/index.ts");
assert(indexSrc.includes("resolveIngressHandles"), "mcp/index.ts must call resolveIngressHandles before validateMcpToolArgs");
const resolvePos = indexSrc.indexOf("resolveIngressHandles");
const validatePos = indexSrc.indexOf("validateMcpToolArgs(def.parameters");
assert(resolvePos < validatePos, "resolveIngressHandles must run before validateMcpToolArgs");
assert(indexSrc.includes("Handle resolution error"), "mcp/index.ts must return error on handle resolution failure");

// ── Runtime behavior ──────────────────────────────────────────────────────────

const { resolveIngressHandles, hasIngressHandles, getExpectedHandleKind } = await import(
	new URL("../../../mcp/handleResolver.ts", import.meta.url).href
);
const { registerBrowserResultResource, clearResourceStore } = await import(
	new URL("../../../mcp/resourceStore.ts", import.meta.url).href
);

// Setup: create a temp artifact file with a request payload
const tmpDir = tmpdir();
const artifactPath = path.join(tmpDir, `mcp-handle-test-${process.pid}.json`);
const requestPayload = { url: "https://target.example.com/login", method: "POST", headers: {}, body: "user=x&pass=y" };
writeFileSync(artifactPath, JSON.stringify({ data: requestPayload }), "utf8");

// 1. No handles in args → pass through unchanged
const noHandleResult = await resolveIngressHandles("browser_sqli", { url: "https://example.com", engine: "builtin" });
assert(noHandleResult.ok, "resolveIngressHandles must succeed when no handles present");
assert.deepEqual(noHandleResult.args.url, "https://example.com", "args must be unchanged when no handles");

// 2. Handle string in non-handle field → not resolved (only declared fields)
const unknownFieldResult = await resolveIngressHandles("browser_sqli", { engine: "builtin", url: "browser-result://some-id" });
assert(unknownFieldResult.ok, "handle in non-declared field must pass through (not resolved)");
assert.equal(unknownFieldResult.args.url, "browser-result://some-id", "non-declared fields must not be resolved");

// 3. Register a resource and resolve it
const uri = registerBrowserResultResource({
	kind: "http-request",
	artifactPath,
	name: "captured request",
	mime: "application/json",
});
const resolvedResult = await resolveIngressHandles("browser_sqli", { request: uri, engine: "builtin" });
assert(resolvedResult.ok, `handle resolution must succeed: ${resolvedResult.ok ? "" : resolvedResult.error}`);
assert.notEqual(resolvedResult.args.request, uri, "resolved arg must not be the original URI string");
assert.equal(typeof resolvedResult.args.request, "object", "resolved arg must be the parsed JSON object");
assert(resolvedResult.diagnostics.length > 0, "diagnostics must include handle meta");
assert(resolvedResult.diagnostics[0].handle === uri, "diagnostic must echo the handle URI");
assert(!("url" in (resolvedResult.diagnostics[0] || {})) || resolvedResult.diagnostics[0].url !== "https://target.example.com/login",
	"diagnostics must NOT expose the payload URL");

// 4. Kind mismatch error
const wrongKindUri = registerBrowserResultResource({
	kind: "raw-result",  // wrong kind — sqli expects http-request
	artifactPath,
	name: "wrong kind",
	mime: "application/json",
});
const kindMismatchResult = await resolveIngressHandles("browser_sqli", { request: wrongKindUri });
assert(!kindMismatchResult.ok, "kind mismatch must return an error");
assert.equal(kindMismatchResult.code, "HANDLE_KIND_MISMATCH", "must return HANDLE_KIND_MISMATCH code");

// 5. Unknown/expired ID
const unknownIdResult = await resolveIngressHandles("browser_sqli", { request: "browser-result://00000000-0000-0000-0000-000000000000" });
assert(!unknownIdResult.ok, "unknown ID must return an error");
assert.equal(unknownIdResult.code, "HANDLE_NOT_FOUND", "must return HANDLE_NOT_FOUND code");

// 6. hasIngressHandles utility
assert(hasIngressHandles("browser_sqli", { request: uri }), "hasIngressHandles must return true for handle string");
assert(!hasIngressHandles("browser_sqli", { request: { url: "https://x.com" } }), "hasIngressHandles must return false for object");
assert(!hasIngressHandles("browser_tabs", { request: uri }), "hasIngressHandles must return false for non-declared tool");

// 7. getExpectedHandleKind
assert.equal(getExpectedHandleKind("browser_sqli", "request"), "http-request", "getExpectedHandleKind must return http-request for sqli.request");
assert.equal(getExpectedHandleKind("browser_sqli", "url"), undefined, "getExpectedHandleKind must return undefined for non-handle field");

// 8. Section http-request handle resolves only the selected jsonPath slice
const networkArtifactPath = path.join(tmpDir, `mcp-network-section-${process.pid}.json`);
writeFileSync(networkArtifactPath, JSON.stringify({ entries: [
	{ requestId: "r1", request: { url: "https://target.example.com/static.js", method: "GET" } },
	{ requestId: "r2", request: { url: "https://target.example.com/item?id=42", method: "GET", headers: { accept: "application/json" } } },
] }), "utf8");
const sectionUri = registerBrowserResultResource({
	kind: "http-request",
	artifactPath: networkArtifactPath,
	jsonPath: "entries[1].request",
	name: "captured request r2",
	mime: "application/json",
});
const sectionResolved = await resolveIngressHandles("browser_sqli", { request: sectionUri, engine: "builtin" });
assert(sectionResolved.ok, `section handle resolution must succeed: ${sectionResolved.ok ? "" : sectionResolved.error}`);
assert.equal(sectionResolved.args.request.url, "https://target.example.com/item?id=42", "section handle must expand the selected request slice");
assert.equal(sectionResolved.diagnostics[0].jsonPath, "entries[1].request", "diagnostic must include section jsonPath without payload");

// Cleanup
clearResourceStore();
console.log("mcp ingress handles ok");
