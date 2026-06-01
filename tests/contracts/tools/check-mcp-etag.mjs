/**
 * MCP etag / staleness contract (Residual B).
 *
 * Verifies change-detection on browser-result resources:
 * - etag (stat-based) is populated at registration for all kinds
 * - sha256 hash is populated only for http-request kind
 * - resolveResourceUri + isResourceFresh detect a rewritten artifact (RESOURCE_STALE on read)
 * - ingress handle resolution detects a swapped http-request artifact (HANDLE_ETAG_MISMATCH)
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// ── Source-level contracts ────────────────────────────────────────────────────

const storeSrc = read("mcp/resourceStore.ts");
assert(storeSrc.includes("computeEtag"), "resourceStore.ts must compute an etag");
assert(storeSrc.includes("statSync"), "etag must be stat-based (no content read on the hot path)");
assert(storeSrc.includes("isResourceFresh"), "resourceStore.ts must export isResourceFresh");
assert(storeSrc.includes('kind === "http-request"'), "content hash must be gated to http-request kind only");

const resolverSrc = read("mcp/handleResolver.ts");
assert(resolverSrc.includes("HANDLE_ETAG_MISMATCH"), "handleResolver must return HANDLE_ETAG_MISMATCH on stale handles");

const readerSrc = read("mcp/resourceReader.ts");
assert(readerSrc.includes("RESOURCE_STALE"), "resourceReader must return RESOURCE_STALE on stale resources");

// ── Runtime behavior ──────────────────────────────────────────────────────────

const { registerBrowserResultResource, resolveResourceUri, isResourceFresh, clearResourceStore } =
	await import(new URL("../../../mcp/resourceStore.ts", import.meta.url).href);
const { readBrowserResultResource } = await import(new URL("../../../mcp/resourceReader.ts", import.meta.url).href);
const { resolveIngressHandles } = await import(new URL("../../../mcp/handleResolver.ts", import.meta.url).href);

const dir = mkdtempSync(path.join(tmpdir(), "mcp-etag-"));

// 1. etag populated for raw-result; no content hash for raw-result.
const rawPath = path.join(dir, "raw.json");
writeFileSync(rawPath, JSON.stringify({ summary: { ok: true }, big: "a".repeat(500) }), "utf8");
const rawUri = registerBrowserResultResource({ kind: "raw-result", artifactPath: rawPath, name: "raw" });
const rawRes = resolveResourceUri(rawUri);
assert(rawRes?.etag, "raw-result must have an etag");
assert(!rawRes.hash, "raw-result must NOT carry a content hash (cheap path)");
assert(isResourceFresh(rawRes), "freshly registered resource must be fresh");

// 2. Read succeeds while fresh.
const okRead = await readBrowserResultResource(rawUri);
assert(okRead.ok, `fresh read must succeed: ${okRead.ok ? "" : okRead.error}`);

// 3. Rewrite the artifact → stale → RESOURCE_STALE on read.
//    Bump mtime deterministically by writing different-length content.
writeFileSync(rawPath, JSON.stringify({ summary: { ok: true }, big: "b".repeat(900) }), "utf8");
assert(!isResourceFresh(rawRes), "resource must be detected stale after the artifact is rewritten");
const staleRead = await readBrowserResultResource(rawUri);
assert(!staleRead.ok, "stale read must fail");
assert.equal(staleRead.code, "RESOURCE_STALE", "stale read must return RESOURCE_STALE");

// 4. http-request handle gets a content hash; swapping content → HANDLE_ETAG_MISMATCH.
const reqPath = path.join(dir, "req.json");
writeFileSync(reqPath, JSON.stringify({ data: { url: "https://t.example/login", method: "POST", body: "a=1" } }), "utf8");
const reqUri = registerBrowserResultResource({ kind: "http-request", artifactPath: reqPath, name: "req" });
const reqRes = resolveResourceUri(reqUri);
assert(reqRes?.hash, "http-request resource MUST carry a content sha256");

// Fresh resolve works.
const okResolve = await resolveIngressHandles("browser_sqli", { request: reqUri, engine: "builtin" });
assert(okResolve.ok, `fresh handle resolve must succeed: ${okResolve.ok ? "" : okResolve.error}`);
assert.equal(typeof okResolve.args.request, "object", "resolved request must be the expanded object");

// Swap content → hash mismatch.
writeFileSync(reqPath, JSON.stringify({ data: { url: "https://attacker.example/x", method: "GET" } }), "utf8");
const tampered = await resolveIngressHandles("browser_sqli", { request: reqUri, engine: "builtin" });
assert(!tampered.ok, "tampered handle must fail resolution");
assert.equal(tampered.code, "HANDLE_ETAG_MISMATCH", "tampered handle must return HANDLE_ETAG_MISMATCH");

clearResourceStore();
console.log("mcp etag ok");
