import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const summariesDir = path.join(root, "src", "tools", "summaries");

// Accepted summary truncation boundary: per-tool distillers intentionally keep summary output compact.
// This is not a pending fact-level relevance debt while the allocator remains shadow-only; it is a
// shrink-only ratchet. New local caps/truncation sites must route through distill-core/granularity or
// explicitly shrink this reviewed allowlist.
const ACCEPTED_TRUNCATION_BOUNDARY_MAX = 31;
const GRANDFATHERED_TRUNCATION_FILES = new Set([
	"src/tools/summaries/common.ts",
	"src/tools/summaries/content.ts",
	"src/tools/summaries/evidence.ts",
	"src/tools/summaries/generic.ts",
	"src/tools/summaries/hook.ts",
	"src/tools/summaries/html.ts",
	"src/tools/summaries/index.ts",
	"src/tools/summaries/memory.ts",
	"src/tools/summaries/network.ts",
	"src/tools/summaries/outputSchemas.ts",
	"src/tools/summaries/pick.ts",
	"src/tools/summaries/registerBuiltinDistillers.ts",
	"src/tools/summaries/scan.ts",
	"src/tools/summaries/transfer.ts",
	"src/tools/summaries/webSecurity.ts",
	"src/tools/summaries/webSecurity/bridges.ts",
	"src/tools/summaries/webSecurity/cookie.ts",
	"src/tools/summaries/webSecurity/crawl.ts",
	"src/tools/summaries/webSecurity/domFlow.ts",
	"src/tools/summaries/webSecurity/fuzz.ts",
	"src/tools/summaries/webSecurity/index.ts",
	"src/tools/summaries/webSecurity/jsAst.ts",
	"src/tools/summaries/webSecurity/oast.ts",
	"src/tools/summaries/webSecurity/recon.ts",
	"src/tools/summaries/webSecurity/replay.ts",
	"src/tools/summaries/webSecurity/shared.ts",
	"src/tools/summaries/webSecurity/sqli.ts",
	"src/tools/summaries/webSecurity/template.ts",
	"src/tools/summaries/webSecurity/wasm.ts",
	"src/tools/summaries/webSecurity/wasmBridge.ts",
	"src/tools/summaries/webSecurity/ws.ts",
]);

const TRUNCATION_SCATTER_RE = /\.slice\(0,|slice\(0,|truncateText\(|textPreview\(|summaryTable\(|\.length\s*>\s*\d+|MAX_[A-Z0-9_]+|LIMIT\b|_LIMIT\b/;

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

const files = walk(summariesDir);
assert(
	GRANDFATHERED_TRUNCATION_FILES.size <= ACCEPTED_TRUNCATION_BOUNDARY_MAX,
	`summary truncation accepted boundary may shrink only: ${GRANDFATHERED_TRUNCATION_FILES.size} > ${ACCEPTED_TRUNCATION_BOUNDARY_MAX}`,
);
for (const file of files) {
	const rel = path.relative(root, file).replace(/\\/g, "/");
	const text = readFileSync(file, "utf8");
	assert(!text.includes("registerRefDescriptor"), `${rel} must not mint pi-ref registry entries`);
	assert(!/from\s+["'][^"']*resources\//.test(text), `${rel} must not import resource-store writers`);
	if (TRUNCATION_SCATTER_RE.test(text) && !text.includes("distill-core/granularity") && !GRANDFATHERED_TRUNCATION_FILES.has(rel)) {
		assert.fail(`${rel} adds local truncation/capping outside the accepted shrink-only boundary; route through src/distill-core/granularity.ts or explicitly shrink/review the boundary`);
	}
}

const missingGrandfathered = [...GRANDFATHERED_TRUNCATION_FILES].filter((rel) => !files.some((file) => path.relative(root, file).replace(/\\/g, "/") === rel));
assert.deepEqual(missingGrandfathered, [], "summary truncation grandfather list contains deleted/moved files");

console.log(`summary boundary ok — distillers do not write ref/resource registries; accepted shrink-only truncation boundary ${GRANDFATHERED_TRUNCATION_FILES.size}/${ACCEPTED_TRUNCATION_BOUNDARY_MAX} file(s)`);
