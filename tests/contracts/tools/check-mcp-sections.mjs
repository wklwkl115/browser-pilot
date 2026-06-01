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
assert(read("src/tools/summaries/webSecurity/domFlow.ts").includes("artifactHints("), "domFlow summarizer must emit artifact_hints");

const indexSrc = read("mcp/index.ts");
assert(indexSrc.includes("preferredReads"), "mcp/index.ts must read summary.artifact_hints.preferredReads");
assert(indexSrc.includes("sections"), "mcp/index.ts must populate envelope.sections");
assert(indexSrc.includes("jsonPath: pr.jsonPath"), "mcp/index.ts must register section resources with the hint jsonPath");

// ── jsonPath-resolves-against-raw-artifact (the critical guard) ───────────────

const { distilledJsonResult } = await import(new URL("../../../src/tools/resultMiddleware.ts", import.meta.url).href);

const dir = mkdtempSync(path.join(tmpdir(), "mcp-sections-"));

/** Minimal dot-path getter (supports "a.b"); mirrors artifactReader addressing for our flat keys. */
function getByPath(obj, p) {
	let cur = obj;
	for (const key of p.split(".")) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = cur[key];
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

// Network — entries container key emitted is the one actually used.
const { savedPath: netArtifact } = await distillAndCheck(
	{ tabId: 7, total: 3, entries: [
		{ requestId: "r1", url: "https://ex.com/a", method: "GET", status: 200 },
		{ requestId: "r2", url: "https://ex.com/b", method: "POST", status: 404, errorText: "NF" },
		{ requestId: "r3", url: "https://ex.com/c", method: "GET", status: 500 },
	] },
	"browser_network", "network.list", ["entries"],
);

// Hook (DOM flow) — listeners under the (flat) root.
await distillAndCheck(
	{ selector: "#pay", node: { tagName: "BUTTON" }, count: 2, listeners: [{ type: "click" }, { type: "submit" }] },
	"browser_hook", "hook.getNodeListeners", ["listeners"],
);

// ── Section resource reads its jsonPath slice via resources/read ──────────────

const { registerBrowserResultResource, clearResourceStore } = await import(new URL("../../../mcp/resourceStore.ts", import.meta.url).href);
const { readBrowserResultResource } = await import(new URL("../../../mcp/resourceReader.ts", import.meta.url).href);

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

clearResourceStore();
console.log("mcp sections ok");
