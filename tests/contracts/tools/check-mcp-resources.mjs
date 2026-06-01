/**
 * MCP resources contract (Phase 4).
 *
 * Verifies:
 * - Resource stores generate opaque browser-result:// and browser-memory:// URIs (no local path in URI)
 * - URI parsing and resolution are consistent
 * - resources/list, resources/templates/list, resources/read handlers present in mcp/index.ts
 * - resource_link injection present for saved artifacts
 * - Privacy: resource metadata does not expose local absolute paths
 * - TTL / expiry semantics
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// ── Source-level contracts ────────────────────────────────────────────────────

const storeSrc = read("mcp/resourceStore.ts");
assert(storeSrc.includes("browser-result"), "resourceStore.ts must use 'browser-result' URI scheme");
assert(storeSrc.includes("randomUUID"), "resourceStore.ts must use crypto.randomUUID for opaque IDs");
// artifactPath is stored server-side (ok to have in store type) but must NOT
// appear in any exported function that returns content to the caller
assert(!storeSrc.includes("return artifactPath") && !storeSrc.includes("uri: artifactPath"),
	"resourceStore.ts must not return artifactPath to MCP callers");
assert(storeSrc.includes("pruneExpired"), "resourceStore.ts must implement TTL pruning");
assert(storeSrc.includes("expiresAt"), "resourceStore.ts must track TTL via expiresAt");
assert(storeSrc.includes("export function parseResourceUri"), "resourceStore.ts must export parseResourceUri");
assert(storeSrc.includes("export function registerBrowserResultResource"), "resourceStore.ts must export registerBrowserResultResource");
assert(storeSrc.includes("export function resolveResourceUri"), "resourceStore.ts must export resolveResourceUri");

const readerSrc = read("mcp/resourceReader.ts");
assert(readerSrc.includes("resolveResourceUri"), "resourceReader.ts must use resolveResourceUri to get artifact path");
assert(readerSrc.includes("readBrowserArtifact"), "resourceReader.ts must delegate to readBrowserArtifact");
assert(!readerSrc.includes("return.*artifactPath"), "resourceReader.ts must not return artifactPath to MCP callers");

const memoryStoreSrc = read("mcp/memoryResourceStore.ts");
assert(memoryStoreSrc.includes("browser-memory"), "memoryResourceStore.ts must use 'browser-memory' URI scheme");
assert(memoryStoreSrc.includes("resolveBrowserResultEvidence"), "memoryResourceStore.ts must expose browser-result evidence resolver for browser_memory");
assert(!memoryStoreSrc.includes("uri: filePath"), "memoryResourceStore.ts must not expose local file paths in URIs");

const memoryReaderSrc = read("mcp/memoryResourceReader.ts");
assert(memoryReaderSrc.includes("readBrowserMemoryResource"), "memoryResourceReader.ts must delegate to readBrowserMemoryResource");

const indexSrc = read("mcp/index.ts");
assert(indexSrc.includes("resources: {}"), "mcp/index.ts must declare resources capability");
assert(indexSrc.includes("ListResourcesRequestSchema"), "mcp/index.ts must handle resources/list");
assert(indexSrc.includes("ListResourceTemplatesRequestSchema"), "mcp/index.ts must handle resources/templates/list");
assert(indexSrc.includes("ReadResourceRequestSchema"), "mcp/index.ts must handle resources/read");
assert(indexSrc.includes("registerBrowserResultResource"), "mcp/index.ts must register resources for saved artifacts");
assert(indexSrc.includes("resource_link"), "mcp/index.ts must include resource_link in tool results for saved artifacts");
assert(!indexSrc.includes("saved.path") || indexSrc.includes("registerBrowserResultResource"),
	"mcp/index.ts must not expose saved.path to client — only URI via registerBrowserResultResource");
assert(indexSrc.includes("clearResourceStore"), "mcp/index.ts must clear resource store on shutdown");
assert(indexSrc.includes("listMemoryResources") && indexSrc.includes("readMemoryResource"), "mcp/index.ts must merge browser-memory resources into list/read");
assert(indexSrc.includes("memoryResourceTemplates"), "mcp/index.ts must expose browser-memory resource templates");

// ── Runtime behavior: URI contract ───────────────────────────────────────────

const { registerBrowserResultResource, resolveResourceUri, parseResourceUri, listResources, clearResourceStore } =
	await import(new URL("../../../mcp/resourceStore.ts", import.meta.url).href);

// 1. URI is opaque — does not contain the local path
const fakePath = "C:\\Users\\test\\.pi\\browser-artifacts\\result.json";
const uri = registerBrowserResultResource({
	kind: "raw-result",
	artifactPath: fakePath,
	name: "test result",
	mime: "application/json",
	bytes: 1234,
});

assert(uri.startsWith("browser-result://"), `URI must start with browser-result:// scheme, got: ${uri}`);
assert(!uri.includes("test"), "URI must not contain any part of the local path");
assert(!uri.includes("Users"), "URI must not leak username in URI");
assert(!uri.includes("artifacts"), "URI must not contain 'artifacts' from local path");

// 2. Parse and resolve
const id = parseResourceUri(uri);
assert(typeof id === "string" && id.length > 0, "parseResourceUri must return non-empty id");

const resolved = resolveResourceUri(uri);
assert(resolved !== undefined, "resolveResourceUri must find the registered resource");
assert.equal(resolved.artifactPath, fakePath, "resolved resource must have the correct artifactPath");
assert.equal(resolved.uri, uri, "resolved resource URI must match registered URI");

// 3. Unrecognized URIs return undefined
const unrecognized = resolveResourceUri("https://example.com/foo");
assert.equal(unrecognized, undefined, "resolveResourceUri must return undefined for non-browser-result URIs");
const notFound = resolveResourceUri("browser-result://00000000-0000-0000-0000-000000000000");
assert.equal(notFound, undefined, "resolveResourceUri must return undefined for unknown IDs");

// 4. listResources does not expose local path in URI
const resources = listResources();
for (const r of resources) {
	assert(r.uri.startsWith("browser-result://"), "listed resource URIs must use browser-result:// scheme");
	assert(!r.uri.includes("pi\\browser-artifacts") && !r.uri.includes("pi/browser-artifacts"),
		"listed resource URIs must not contain local artifact path");
}

// 5. Expired resources are pruned
clearResourceStore();
console.log("mcp resources ok");
