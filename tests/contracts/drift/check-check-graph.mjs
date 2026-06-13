import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CHECK_GROUPS,
	CHECK_GROUPS_SUMMARY_PATH,
	CACHE_GLOBAL_INPUTS,
	CHECK_CACHE_SCHEMA_VERSION,
	CHECK_IMPACT_MAP_PATH,
	DEFAULT_GROUP_SEQUENCE,
	DAG_EXTRA_NODE_IDS,
	GRAPH_SCRIPT_EXCLUSIONS,
	computeNodeCacheFingerprint,
	graphCoveredPackageScripts,
	packageScripts,
	recordMissIfApplicable,
	computeCoarseFingerprint,
	readImpactMap,
	selectSmartScripts,
	writeJsonFile,
	CHECK_IMPACT_SUMMARY_PATH,
	CHECK_DAG_SUMMARY_PATH,
} from "../../../scripts/check-graph.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const pkg = JSON.parse(read("package.json"));
const scripts = packageScripts(root);

assert.deepEqual(Object.keys(CHECK_GROUPS), DEFAULT_GROUP_SEQUENCE, "check graph groups must match the default grouped runner sequence");
assert(DAG_EXTRA_NODE_IDS.includes("lint:eslint"), "DAG graph must include ESLint as a first-class node");
assert.equal(CHECK_CACHE_SCHEMA_VERSION, 2, "DAG cache index schema must be v2 for per-node cache scopes");
assert(CACHE_GLOBAL_INPUTS.includes("scripts/check-graph.mjs") && CACHE_GLOBAL_INPUTS.includes("scripts/check-dag.mjs") && CACHE_GLOBAL_INPUTS.includes("package.json"), "per-node cache scopes must include graph/package global config inputs");
assert.equal(pkg.scripts["check:all"], "node scripts/check-dag.mjs", "package check:all must use the DAG runner as the closing gate");
assert.equal(pkg.scripts["check:serial"], "node scripts/run-check-groups.mjs", "package must retain the serial grouped runner escape hatch");
assert.equal(pkg.scripts["check:trace"], "node scripts/run-check-groups.mjs --json", "package must expose check:trace over the grouped runner");
assert.equal(pkg.scripts["check:dag"], "node scripts/check-dag.mjs", "package must expose check:dag");
assert.equal(pkg.scripts["check:smart"], "node scripts/check-dag.mjs --smart", "package must expose check:smart");
assert.equal(pkg.scripts["sync:impact-map"], "node scripts/sync-impact-map.mjs", "package must expose impact map synchronization");
assert.equal(pkg.scripts["check:impact-map"], "node scripts/sync-impact-map.mjs --check", "package must expose impact map drift check");
assert.equal(pkg.scripts["query:markers"], "node scripts/query-markers.mjs", "package must expose the marker query helper");
assert.equal(pkg.scripts["new:check"], "node scripts/new-check.mjs", "package must expose the check scaffolder");
assert.equal(pkg.scripts["scope:begin"], "node scripts/workstream-scope.mjs --begin", "package must expose the workstream scope baseline helper");
assert.equal(pkg.scripts["docs:sync"], "node scripts/sync-docs.mjs", "package must expose the doc sync umbrella");
assert.equal(pkg.scripts["check:docs-sync"], "node tests/contracts/drift/check-docs-sync.mjs", "package must expose the doc sync drift gate");
assert.equal(pkg.scripts["check:audit-inbox"], "node tests/contracts/drift/check-audit-inbox.mjs", "package must expose the audit inbox lifecycle gate");
assert.equal(pkg.scripts["check:doc-paths"], "node tests/contracts/drift/check-doc-paths.mjs", "package must expose the doc path liveness gate");
assert.equal(pkg.scripts["sync:code-map"], "tsx scripts/sync-code-map.mjs", "package must expose the generated code-map sync");
assert.equal(pkg.scripts["check:code-map"], "tsx scripts/sync-code-map.mjs --check", "package must expose the generated code-map drift gate");
assert.equal(pkg.scripts["check:check-graph"], "node tests/contracts/drift/check-check-graph.mjs", "package must expose the check graph drift gate");
assert.equal(GRAPH_SCRIPT_EXCLUSIONS["query:markers"], "developer query tool; not a proof obligation node", "query:markers must be explicitly excluded from graph obligations");
assert.equal(GRAPH_SCRIPT_EXCLUSIONS["new:check"], "developer scaffolder; graph gate verifies generated wiring", "new:check must be explicitly excluded from graph obligations");
assert.equal(GRAPH_SCRIPT_EXCLUSIONS["scope:begin"], "developer workstream-scope baseline helper; DAG summary consumes its artifact", "scope:begin must be explicitly excluded from graph obligations");
assert.equal(GRAPH_SCRIPT_EXCLUSIONS["docs:sync"], "doc generator umbrella; guarded by check:docs-sync", "docs:sync must be explicitly excluded from graph obligations");
assert.equal(GRAPH_SCRIPT_EXCLUSIONS["sync:code-map"], "child code-map doc generator; guarded by check:code-map and check:docs-sync", "sync:code-map must be explicitly excluded from graph obligations");
assert(CHECK_GROUPS.docs.includes("check:docs-sync"), "docs group must include check:docs-sync");
assert(CHECK_GROUPS.docs.includes("check:audit-inbox"), "docs group must include check:audit-inbox");
assert(CHECK_GROUPS.docs.includes("check:doc-paths"), "docs group must include check:doc-paths");
assert(CHECK_GROUPS.docs.includes("check:code-map"), "docs group must include check:code-map");

const runner = read("scripts/run-check-groups.mjs");
const dag = read("scripts/check-dag.mjs");
assert(runner.includes("CHECK_GROUPS") && runner.includes("CHECK_GROUPS_SUMMARY_PATH") && runner.includes("durationMs"), "grouped runner must read graph groups and write duration trace");
assert(dag.includes("CHECK_GROUPS") && dag.includes("CHECK_DAG_SUMMARY_PATH") && dag.includes("CHECK_DAG_RUN_DIR") && dag.includes("CHECK_IMPACT_SUMMARY_PATH") && dag.includes("--changed-file=") && dag.includes("computeNodeCacheFingerprint") && dag.includes("cacheScopes") && read("scripts/check-graph.mjs").includes("CHECK_MISS_DIR"), "DAG runner must read graph groups and write DAG/impact/miss/cache-scope artifacts");

const covered = graphCoveredPackageScripts(DEFAULT_GROUP_SEQUENCE);
covered.add("lint");
covered.add("lint:eslint");
const relevant = Object.keys(scripts).filter((name) => /^(check(?::|$)|test:|bench:|smoke:|eval:|release:)/.test(name));
const missing = relevant.filter((name) => !covered.has(name) && !GRAPH_SCRIPT_EXCLUSIONS[name]);
assert.deepEqual(missing.sort(), [], `check graph missing script coverage or exclusion:\n  - ${missing.join("\n  - ")}`);
for (const [name, reason] of Object.entries(GRAPH_SCRIPT_EXCLUSIONS)) {
	assert(reason && typeof reason === "string", `${name} graph exclusion must carry a reason`);
}

for (const group of DEFAULT_GROUP_SEQUENCE) {
	assert(CHECK_GROUPS[group].length > 0, `${group} check group must not be empty`);
}
assert(CHECK_GROUPS.contracts.includes("check:check-graph"), "contracts group must include check:check-graph");
assert(CHECK_GROUPS.contracts.includes("check:impact-map"), "contracts group must include check:impact-map");
assert(read("scripts/check-graph.mjs").includes("selectSmartScripts") && read("scripts/check-graph.mjs").includes("readImpactMap"), "smart selection must consume the generated impact map");
assert(CHECK_GROUPS.unit.every((script) => script.startsWith("test:unit:")), "unit group must use first-class shard nodes, not the umbrella test:unit script");
assert.equal(GRAPH_SCRIPT_EXCLUSIONS["test:unit"], "umbrella; covered by test:unit:* shards", "test:unit umbrella must be excluded with an explicit shard-coverage reason");

const unitFiles = walk("tests/unit", (file) => file.endsWith(".test.ts")).sort();
const unitCoverage = new Map(unitFiles.map((file) => [file, []]));
for (const script of CHECK_GROUPS.unit) {
	const command = String(scripts[script] || "").replace(/\\/g, "/");
	for (const match of command.matchAll(/tests\/unit\/[^\s"]+/g)) {
		const glob = match[0];
		const prefix = glob.includes("/**/") ? glob.slice(0, glob.indexOf("/**/") + 1) : glob;
		for (const file of unitFiles) {
			if (file.startsWith(prefix)) unitCoverage.get(file).push(script);
		}
	}
}
const uncoveredUnitFiles = [...unitCoverage.entries()].filter(([, owners]) => owners.length === 0).map(([file]) => file);
const overlappedUnitFiles = [...unitCoverage.entries()].filter(([, owners]) => owners.length > 1).map(([file, owners]) => `${file}: ${owners.join(", ")}`);
assert.deepEqual(uncoveredUnitFiles, [], `unit shard coverage missing files:\n  - ${uncoveredUnitFiles.join("\n  - ")}`);
assert.deepEqual(overlappedUnitFiles, [], `unit shard coverage overlaps:\n  - ${overlappedUnitFiles.join("\n  - ")}`);

const impactMap = readImpactMap(root);
assert.equal(impactMap.schemaVersion, 1, "impact map schema must be versioned");
assert(impactMap.nodes?.["check:abml-contracts"]?.inputs?.includes("src/abml-core/treeDiff.ts"), "impact map must connect abml-contracts umbrella to abml-core treeDiff source");
for (const [script, node] of Object.entries(impactMap.nodes || {})) {
	assert(node.scope === "global" || node.scope === "paths", `${script} impact scope must be explicit`);
	assert(node.scope === "global" || (node.unresolvedInputs || []).length === 0, `${script} unresolved inputs must force global scope`);
}
const abmlSelection = selectSmartScripts(["src/abml-core/treeDiff.ts"], { root, impactMap });
assert(abmlSelection.has("check:abml-contracts"), "smart selection for abml-core treeDiff must include check:abml-contracts");
const distillSelection = selectSmartScripts(["src/distill-core/relevance.ts"], { root, impactMap });
assert(distillSelection.has("check:task-conditioned-salience"), "smart selection for distill-core relevance must include check:task-conditioned-salience");

// Inert-docs fast lane: a plain prose doc under docs/ (not generated/, not spec-claim,
// not governance) must select ONLY the 3 doc-integrity gates.
const inertDocSelection = selectSmartScripts(["docs/document-structure.md"], { root, impactMap });
assert.deepEqual([...inertDocSelection.keys()].sort(), ["check:doc-paths", "check:doc-structure", "check:docs-sync"], "inert docs fast lane must select only the 3 doc-integrity gates");
assert(!inertDocSelection.has("check:src:types"), "inert docs fast lane must not include tsc base proof");
assert(!inertDocSelection.has("lint:eslint"), "inert docs fast lane must not include eslint base proof");
assert(!inertDocSelection.has("test:unit:abml"), "inert docs fast lane must not include unit shards");
// Mixed changeset (docs + code) must NOT take the fast lane
const mixedSelection = selectSmartScripts(["docs/document-structure.md", "src/abml-core/ax.ts"], { root, impactMap });
assert(mixedSelection.has("check:src:types"), "mixed docs+code changeset must not take the inert-docs fast lane");
assert(mixedSelection.has("test:unit:abml"), "mixed docs+code changeset must include unit shards");
// Governance docs must NOT take the fast lane
const readmeSelection = selectSmartScripts(["README.md"], { root, impactMap });
assert(readmeSelection.has("check:src:types"), "README.md must not take the inert-docs fast lane");
const claudeMdSelection = selectSmartScripts(["CLAUDE.md"], { root, impactMap });
assert(claudeMdSelection.has("check:src:types"), "CLAUDE.md must not take the inert-docs fast lane");
const agentsMdSelection = selectSmartScripts(["AGENTS.md"], { root, impactMap });
assert(agentsMdSelection.has("check:src:types"), "AGENTS.md must not take the inert-docs fast lane");
// Generated docs must NOT take the fast lane
const generatedDocSelection = selectSmartScripts(["docs/generated/browser-tool-contract.generated.md"], { root, impactMap });
assert(generatedDocSelection.has("check:src:types"), "docs/generated/ docs must not take the inert-docs fast lane");
// Spec-claim docs must NOT take the fast lane
const specClaimDocSelection = selectSmartScripts(["docs/abml-p1-spec.md"], { root, impactMap });
assert(specClaimDocSelection.has("check:src:types"), "spec-claim docs must not take the inert-docs fast lane");
// Unit shards must be paths-scoped (not global) after SCOPE_OVERRIDES were applied
assert.equal(impactMap.nodes?.["test:unit:abml"]?.scope, "paths", "test:unit:abml must be paths-scoped after SCOPE_OVERRIDES override");
assert(impactMap.nodes?.["test:unit:abml"]?.inputs?.includes("src/"), "test:unit:abml scope must include all of src/");
assert(impactMap.nodes?.["test:unit:abml"]?.inputs?.includes("tests/unit/abml/"), "test:unit:abml scope must include its own test directory");
assert.equal((impactMap.nodes?.["test:unit:abml"]?.unresolvedInputs || []).length, 0, "test:unit:abml must have zero unresolvedInputs after override");
// A docs-only change must NOT select any unit shard
const docOnlyUnitCheck = selectSmartScripts(["docs/document-structure.md"], { root, impactMap });
for (const shard of ["test:unit:abml", "test:unit:distill", "test:unit:tools", "test:unit:misc", "test:unit:memory", "test:unit:driver", "test:unit:temporal", "test:unit:web-security", "test:unit:cli:commands", "test:unit:cli:daemon"]) {
	assert(!docOnlyUnitCheck.has(shard), `docs-only change must not trigger ${shard}`);
}
// A src/ change must still select all unit shards
const srcUnitCheck = selectSmartScripts(["src/abml-core/ax.ts"], { root, impactMap });
for (const shard of ["test:unit:abml", "test:unit:distill", "test:unit:tools", "test:unit:misc", "test:unit:memory", "test:unit:driver", "test:unit:temporal", "test:unit:web-security", "test:unit:cli:commands", "test:unit:cli:daemon"]) {
	assert(srcUnitCheck.has(shard), `src/ change must trigger ${shard}`);
}

// ── Boundary-check narrowing (kernel subtree isolation) ───────────────────────────────────
// Each *-core-boundary check must be paths-scoped to its own kernel subtree.
// An abml-core change selects check:abml-core-boundary but NOT check:memory-core-boundary.
// A docs-only inert change selects neither.

// Structural assertions on the boundary nodes themselves
for (const [nodeId, subtree] of [
	["check:distill-core-boundary", "src/distill-core/"],
	["check:memory-core-boundary", "src/memory-core/"],
	["check:temporal-core-boundary", "src/temporal-core/"],
	["check:abml-core-boundary", "src/abml-core/"],
]) {
	assert.equal(impactMap.nodes?.[nodeId]?.scope, "paths", `${nodeId} must be paths-scoped after SCOPE_OVERRIDES override`);
	assert(impactMap.nodes?.[nodeId]?.inputs?.includes(subtree), `${nodeId} scope must include its kernel subtree ${subtree}`);
	assert.equal((impactMap.nodes?.[nodeId]?.unresolvedInputs || []).length, 0, `${nodeId} must have zero unresolvedInputs after override`);
}
assert(impactMap.nodes?.["check:abml-core-boundary"]?.inputs?.includes("src/abml/"), "check:abml-core-boundary scope must also include src/abml/ (runtime shims)");

// check:recovery-boundary walks all of src/ — scope must include src/
assert.equal(impactMap.nodes?.["check:recovery-boundary"]?.scope, "paths", "check:recovery-boundary must be paths-scoped after SCOPE_OVERRIDES override");
assert(impactMap.nodes?.["check:recovery-boundary"]?.inputs?.includes("src/"), "check:recovery-boundary scope must include all of src/ (scatter-walk covers entire tree)");

// check:summary-boundary walks src/tools/summaries/ only
assert.equal(impactMap.nodes?.["check:summary-boundary"]?.scope, "paths", "check:summary-boundary must be paths-scoped after SCOPE_OVERRIDES override");
assert(impactMap.nodes?.["check:summary-boundary"]?.inputs?.includes("src/tools/summaries/"), "check:summary-boundary scope must include src/tools/summaries/");

// check:compaction-ledger walks all of src/ — scope must include src/
assert.equal(impactMap.nodes?.["check:compaction-ledger"]?.scope, "paths", "check:compaction-ledger must be paths-scoped after SCOPE_OVERRIDES override");
assert(impactMap.nodes?.["check:compaction-ledger"]?.inputs?.includes("src/"), "check:compaction-ledger scope must include all of src/ (scatter-walk covers entire tree)");
assert(impactMap.nodes?.["check:compaction-ledger"]?.inputs?.includes("docs/compaction-ledger.json"), "check:compaction-ledger scope must include the committed compaction ledger");

// check:browser-workflow-results reads only evals/browser-workflows/ result JSON; no src/ imports.
// check:eval-workflows is intentionally LEFT GLOBAL — its spawnSync subprocess plus a top-level
// WORKSTREAMS_A_E_SUMMARY.md existence assert make its true footprint unsafe to bound.
assert.equal(impactMap.nodes?.["check:browser-workflow-results"]?.scope, "paths", "check:browser-workflow-results must be paths-scoped after SCOPE_OVERRIDES override");
assert(impactMap.nodes?.["check:browser-workflow-results"]?.inputs?.includes("evals/browser-workflows/"), "check:browser-workflow-results scope must include evals/browser-workflows/");
assert(!impactMap.nodes?.["check:browser-workflow-results"]?.inputs?.includes("src/"), "check:browser-workflow-results scope must NOT include src/ (no src imports in the check)");

// Selection probes
// 1. abml-core change → selects check:abml-core-boundary, NOT check:memory-core-boundary
assert(srcUnitCheck.has("check:abml-core-boundary"), "src/abml-core/ change must trigger check:abml-core-boundary");
assert(!srcUnitCheck.has("check:memory-core-boundary"), "src/abml-core/ change must NOT trigger check:memory-core-boundary (different kernel)");
// 2. memory-core change → selects check:memory-core-boundary, NOT check:abml-core-boundary
const memoryKernelCheck = selectSmartScripts(["src/memory-core/recall.ts"], { root, impactMap });
assert(memoryKernelCheck.has("check:memory-core-boundary"), "src/memory-core/ change must trigger check:memory-core-boundary");
assert(!memoryKernelCheck.has("check:abml-core-boundary"), "src/memory-core/ change must NOT trigger check:abml-core-boundary (different kernel)");
// 3. A docs-only inert change must not select any boundary check
for (const boundaryNode of ["check:distill-core-boundary", "check:memory-core-boundary", "check:temporal-core-boundary", "check:abml-core-boundary", "check:recovery-boundary", "check:summary-boundary", "check:compaction-ledger", "check:browser-workflow-results"]) {
	assert(!docOnlyUnitCheck.has(boundaryNode), `docs-only inert change must not trigger ${boundaryNode}`);
}
// 4. A src/ change still selects recovery-boundary and compaction-ledger (both walk all of src/)
assert(srcUnitCheck.has("check:recovery-boundary"), "src/ change must still trigger check:recovery-boundary");
assert(srcUnitCheck.has("check:compaction-ledger"), "src/ change must still trigger check:compaction-ledger");
// 5. An evals change selects browser-workflow-results but NOT unit shards
const evalsCheck = selectSmartScripts(["evals/browser-workflows/manifest.json"], { root, impactMap });
assert(evalsCheck.has("check:browser-workflow-results"), "evals/ change must trigger check:browser-workflow-results");
assert(!evalsCheck.has("test:unit:abml"), "evals/ change must NOT trigger test:unit:abml (no src/ in eval check scope)");

assert(existsSync(CHECK_IMPACT_MAP_PATH), "committed impact-map artifact must exist");
const markerOutput = execFileSync(process.execPath, ["scripts/query-markers.mjs", "--needle", "templateGroupDescriptorForEntity"], { cwd: root, encoding: "utf8" });
assert(markerOutput.includes("check-abml-tree-diff.mjs") && markerOutput.includes("check-abml-templating.mjs"), "query:markers control must find templateGroupDescriptorForEntity pins");
const fileOutput = execFileSync(process.execPath, ["scripts/query-markers.mjs", "--file", "src/abml-core/treeDiff.ts"], { cwd: root, encoding: "utf8" });
assert(fileOutput.includes("check:abml-contracts"), "query:markers --file must resolve to the abml-contracts umbrella via impact map");

const badNode = spawnSync(process.execPath, ["scripts/check-dag.mjs", "--self-test-bad-node-exit", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
assert.equal(badNode.status, 7, `DAG runner must propagate the first failing node exit code; stdout=${badNode.stdout} stderr=${badNode.stderr}`);
assert(`${badNode.stdout}\n${badNode.stderr}`.includes("synthetic:bad-node"), "DAG bad-node self-test must identify the failed synthetic node");

const fingerprint = computeCoarseFingerprint(root);
assert.equal(fingerprint.ok, true, "coarse fingerprint must be available");
assert(fingerprint.fingerprint.startsWith("sha256:"), "coarse fingerprint must be sha256 tagged");
assert(fingerprint.fileCount > 100, "coarse fingerprint must cover the repo source/test/doc scope");
const scopedCacheFingerprint = computeNodeCacheFingerprint({
	id: "check:task-conditioned-salience",
	script: "check:task-conditioned-salience",
	commandLine: scripts["check:task-conditioned-salience"],
}, { root, impactMap });
assert.equal(scopedCacheFingerprint.schemaVersion, 2, "per-node cache fingerprint must use schema v2");
assert.equal(scopedCacheFingerprint.cacheScope, "node-paths-v2", "path-scoped impact nodes must use node-paths-v2 cache scope");
assert(scopedCacheFingerprint.inputs.includes("src/distill-core/relevance.ts"), "per-node cache scope must include impact-map inputs");
assert(scopedCacheFingerprint.inputs.includes("scripts/check-graph.mjs") && scopedCacheFingerprint.inputs.includes("scripts/check-dag.mjs"), "per-node cache scope must include global graph config inputs");
const globalCacheFingerprint = computeNodeCacheFingerprint({
	id: "check:src:types",
	script: "check:src:types",
	commandLine: "tsc -p tsconfig.json --incremental --tsBuildInfoFile .pi/tsbuildinfo/tsconfig.tsbuildinfo",
}, { root, impactMap, coarseFingerprint: fingerprint });
assert.equal(globalCacheFingerprint.cacheScope, "repo-coarse-v1", "global impact nodes must retain whole-repo cache scope");
const nestedCacheFingerprint = computeNodeCacheFingerprint({
	id: "check:bridge:types",
	script: "check:bridge:types",
	impactScript: "check:bridge",
	commandLine: scripts["check:bridge:types"],
}, { root, impactMap, coarseFingerprint: fingerprint });
assert.equal(nestedCacheFingerprint.impactScript, "check:bridge", "nested DAG nodes must inherit their selected graph script for cache scope lookup");

const cacheFixtureRoot = mkdtempSync(path.join(os.tmpdir(), "pi-browser-cache-scope-"));
try {
	for (const dir of ["src", "docs", "scripts"]) mkdirSync(path.join(cacheFixtureRoot, dir), { recursive: true });
	writeFileSync(path.join(cacheFixtureRoot, "src", "foo.ts"), "export const value = 1;\n", "utf8");
	writeFileSync(path.join(cacheFixtureRoot, "docs", "note.md"), "docs v1\n", "utf8");
	writeFileSync(path.join(cacheFixtureRoot, "package.json"), "{}\n", "utf8");
	writeFileSync(path.join(cacheFixtureRoot, "scripts", "check-graph.mjs"), "graph v1\n", "utf8");
	writeFileSync(path.join(cacheFixtureRoot, "scripts", "check-dag.mjs"), "dag v1\n", "utf8");
	const fixtureImpact = {
		nodes: {
			"check:scoped": { script: "check:scoped", scope: "paths", inputs: ["src/foo.ts"], unresolvedInputs: [] },
		},
	};
	const fixtureNode = { id: "check:scoped", script: "check:scoped", commandLine: "node tests/contracts/drift/check-scoped.mjs" };
	const entries = [
		["src/foo.ts", "tracked"],
		["docs/note.md", "tracked"],
		["package.json", "tracked"],
		["scripts/check-graph.mjs", "tracked"],
		["scripts/check-dag.mjs", "tracked"],
	];
	const baseScoped = computeNodeCacheFingerprint(fixtureNode, { root: cacheFixtureRoot, impactMap: fixtureImpact, allFileEntries: entries });
	writeFileSync(path.join(cacheFixtureRoot, "docs", "note.md"), "docs v2\n", "utf8");
	const docsOnlyScoped = computeNodeCacheFingerprint(fixtureNode, { root: cacheFixtureRoot, impactMap: fixtureImpact, allFileEntries: entries });
	assert.equal(docsOnlyScoped.fingerprint, baseScoped.fingerprint, "docs-only edits outside the node impact scope must keep a non-doc scoped cache hit eligible");
	writeFileSync(path.join(cacheFixtureRoot, "src", "foo.ts"), "export const value = 2;\n", "utf8");
	const srcScoped = computeNodeCacheFingerprint(fixtureNode, { root: cacheFixtureRoot, impactMap: fixtureImpact, allFileEntries: entries });
	assert.notEqual(srcScoped.fingerprint, baseScoped.fingerprint, "source edits inside the node impact scope must invalidate that node cache key");
} finally {
	rmSync(cacheFixtureRoot, { recursive: true, force: true });
}

const priorImpact = existsSync(CHECK_IMPACT_SUMMARY_PATH) ? readFileSync(CHECK_IMPACT_SUMMARY_PATH, "utf8") : undefined;
try {
	writeJsonFile(CHECK_IMPACT_SUMMARY_PATH, {
		schemaVersion: 1,
		mode: "smart",
		ok: true,
		runId: "contract-synthetic-smart",
		worktreeFingerprint: fingerprint.fingerprint,
		changedFiles: ["synthetic.js"],
		selectedScripts: ["check:src:types"],
		selectedNodes: ["check:src:types"],
		skippedScripts: ["contract:miss"],
		cacheHits: [],
	});
	const miss = recordMissIfApplicable({ root, fullRunId: "contract-synthetic-full", failingScript: "contract:miss", fullSummaryPath: CHECK_DAG_SUMMARY_PATH });
	assert(miss && existsSync(miss.path), "synthetic smart/full miss must write an artifact");
	const missText = readFileSync(miss.path, "utf8");
	assert(missText.includes("contract:miss") && missText.includes("likelyRepairTarget") && missText.includes("npm run sync:impact-map"), "synthetic miss artifact must identify the failed node and impact-map repair command");
} finally {
	if (priorImpact !== undefined) writeJsonFile(CHECK_IMPACT_SUMMARY_PATH, JSON.parse(priorImpact));
	else rmSync(CHECK_IMPACT_SUMMARY_PATH, { force: true });
}

assert(CHECK_GROUPS_SUMMARY_PATH.endsWith(".pi\\browser-artifacts\\check-groups-summary.json") || CHECK_GROUPS_SUMMARY_PATH.endsWith(".pi/browser-artifacts/check-groups-summary.json"), "group trace artifact path must stay under .pi/browser-artifacts");

console.log("check graph contract ok");

function walk(rel, predicate = () => true) {
	const dir = path.join(root, rel);
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const child = `${rel}/${entry.name}`;
		if (entry.isDirectory()) out.push(...walk(child, predicate));
		else if (predicate(child)) out.push(child.replace(/\\/g, "/"));
	}
	return out;
}
