/**
 * MCP Layer-1 section sub-resources contract (Residual C).
 *
 * Proves the end-to-end section pipeline WITHOUT a live browser:
 * - The 3 spike distillers emit summary.artifact_hints.preferredReads.
 * - Each emitted jsonPath RESOLVES against the actual saved raw artifact
 *   (the Plan agent's required guard against summary-vs-raw path drift).
 * - A registered section resource reads back its jsonPath slice via resources/read.
 * - The MCP adapter (index.ts) registers section sub-resources + envelope.sections.
 */
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// ── Source-level contracts ────────────────────────────────────────────────────

assert(read("src/tools/summaries/common.ts").includes("export function artifactHints"), "common.ts must export the shared artifactHints helper");
assert(read("src/tools/summaries/evidence.ts").includes("artifactHints("), "evidence summarizer must emit artifact_hints");
assert(read("src/tools/summaries/network.ts").includes("entriesContainerPath"), "network summarizer must emit the actual entries container path");
assert(read("src/tools/summaries/network.ts").includes("requestEntryHints"), "network summarizer must emit bounded per-entry http-request hints");
assert(read("src/tools/summaries/webSecurity/domFlow.ts").includes("artifactHints("), "domFlow summarizer must emit artifact_hints");

const indexSrc = read("mcp/index.ts");
assert(indexSrc.includes("preferredReads"), "mcp/index.ts must read summary.artifact_hints.preferredReads");
assert(indexSrc.includes("sections"), "mcp/index.ts must populate envelope.sections");
assert(indexSrc.includes("jsonPath: pr.jsonPath"), "mcp/index.ts must register section resources with the hint jsonPath");
assert(indexSrc.includes("pi-ref://data-slice"), "mcp/index.ts must advertise section handles as pi-ref data-slice handles for P8");

// ── jsonPath-resolves-against-raw-artifact (the critical guard) ───────────────

const { distilledJsonResult } = await import(new URL("../../../src/tools/resultMiddleware.ts", import.meta.url).href);

const dir = mkdtempSync(path.join(tmpdir(), "mcp-sections-"));

/** Minimal dot-path getter (supports "a.b"); mirrors artifactReader addressing for our flat keys. */
function getByPath(obj, p) {
	let cur = obj;
	const normalized = p.startsWith("$.") ? p.slice(2) : p.startsWith("$") ? p.slice(1) : p;
	for (const part of normalized.split(".")) {
		if (!part) continue;
		const re = /([^[]+)|\[(\d+)\]/g;
		let match;
		while ((match = re.exec(part))) {
			const key = match[1] !== undefined ? match[1] : Number(match[2]);
			if (cur == null || typeof cur !== "object") return undefined;
			cur = cur[key];
		}
	}
	return cur;
}

async function distillAndCheck(value, toolName, command, expectPaths) {
	const out = path.join(dir, `${toolName}.json`);
	const r = await distilledJsonResult(value, {
		toolName, command, maxChars: 8000, fallbackName: `${toolName}.json`,
		detailLevel: "summary", outputPath: out, ctx: { cwd: dir },
	});
	const envelope = JSON.parse(r.content[0].text);
	const hints = envelope.summary?.artifact_hints;
	assert(hints && Array.isArray(hints.preferredReads) && hints.preferredReads.length, `${toolName}: summary.artifact_hints.preferredReads must be present`);

	// The saved raw artifact must exist and every emitted jsonPath must resolve in it.
	const savedPath = envelope.saved?.path;
	assert(savedPath, `${toolName}: a raw artifact must be saved`);
	const raw = JSON.parse(readFileSync(savedPath, "utf8"));
	for (const pr of hints.preferredReads) {
		const resolved = getByPath(raw, pr.jsonPath);
		assert(resolved !== undefined, `${toolName}: emitted jsonPath '${pr.jsonPath}' must resolve in the saved raw artifact`);
	}
	for (const ep of expectPaths) {
		assert(hints.preferredReads.some((pr) => pr.jsonPath === ep), `${toolName}: expected a section hint for jsonPath '${ep}'`);
	}
	return { envelope, savedPath };
}

// Evidence — flat, sources at top.
await distillAndCheck(
	{ tabId: 1, collected_at: "2026-06-01", sources: { dom: { ok: true, data: { events: [{ type: "click" }] } }, net: { ok: true, data: { count: 2 } } } },
	"browser_evidence", "evidence.collect", ["sources"],
);

// Network — entries container key emitted is the one actually used, and each
// request-capable entry gets a bounded http-request section hint.
const { envelope: netEnvelope, savedPath: netArtifact } = await distillAndCheck(
	{ tabId: 7, total: 3, entries: [
		{ requestId: "r1", url: "https://ex.com/a", method: "GET", status: 200 },
		{ requestId: "r2", request: { url: "https://ex.com/b", method: "POST", headers: { accept: "application/json" }, body: "x=1" }, response: { status: 404 }, errorText: "NF" },
		{ requestId: "r3", url: "https://ex.com/c", method: "GET", status: 500 },
	] },
	"browser_network", "network.list", ["entries", "entries[1].request"],
);
const requestHint = netEnvelope.summary.artifact_hints.preferredReads.find((pr) => pr.kind === "http-request" && pr.jsonPath === "entries[1].request");
assert(requestHint, "network summary must advertise entries[1].request as an http-request section");

// Hook (DOM flow) — listeners under the (flat) root.
await distillAndCheck(
	{ selector: "#pay", node: { tagName: "BUTTON" }, count: 2, listeners: [{ type: "click" }, { type: "submit" }] },
	"browser_hook", "hook.getNodeListeners", ["listeners"],
);

// ── Section resource reads its jsonPath slice via resources/read ──────────────

const { registerBrowserResultResource, resolveResourceUri, clearResourceStore } = await import(new URL("../../../mcp/resourceStore.ts", import.meta.url).href);
const { readBrowserResultResource } = await import(new URL("../../../mcp/resourceReader.ts", import.meta.url).href);
const { resolveIngressHandles } = await import(new URL("../../../mcp/handleResolver.ts", import.meta.url).href);

const sectionUri = registerBrowserResultResource({
	kind: "network-entry", artifactPath: netArtifact, jsonPath: "entries", section: "all network entries", name: "browser_network: entries", mime: "application/json",
});
const slice = await readBrowserResultResource(sectionUri);
assert(slice.ok, `section resource read must succeed: ${slice.ok ? "" : slice.error}`);
const sliceJson = JSON.parse(slice.content.text);
// json-mode read returns the jsonPath slice as a pagination envelope { type, count, items }.
assert(sliceJson && typeof sliceJson === "object", "section read must return the jsonPath slice");
const arr = Array.isArray(sliceJson) ? sliceJson : (sliceJson.items ?? sliceJson.value);
assert(Array.isArray(arr) && arr.length === 3, `section read must return exactly the 3-entry array slice (got ${Array.isArray(arr) ? arr.length : typeof arr})`);
assert(sliceJson.count === undefined || sliceJson.count === 3, "section slice count must reflect the full array (untruncated Layer-1 read)");

const piSection = `pi-ref://data-slice/${sectionUri.split("://")[1]}`;
const piSlice = await readBrowserResultResource(piSection);
assert(piSlice.ok, `pi-ref data-slice section read must succeed: ${piSlice.ok ? "" : piSlice.error}`);

const requestUri = registerBrowserResultResource({
	kind: "http-request", artifactPath: netArtifact, jsonPath: "entries[1].request", section: "request r2", name: "browser_network: request r2", mime: "application/json",
});
const requestResource = resolveResourceUri(requestUri);
assert(requestResource?.hash, "http-request section resources must carry a content hash");
const requestSlice = await readBrowserResultResource(requestUri);
assert(requestSlice.ok, `http-request section read must succeed: ${requestSlice.ok ? "" : requestSlice.error}`);
const requestJson = JSON.parse(requestSlice.content.text);
assert.equal(requestJson.url, "https://ex.com/b", "http-request section must read back the selected request object");
const expanded = await resolveIngressHandles("browser_sqli", { request: requestUri, engine: "builtin" });
assert(expanded.ok, `http-request section must resolve as browser_sqli.request: ${expanded.ok ? "" : expanded.error}`);
assert.equal(expanded.args.request.url, "https://ex.com/b", "resolved browser_sqli.request must be the selected request object");

clearResourceStore();
console.log("mcp sections ok");
