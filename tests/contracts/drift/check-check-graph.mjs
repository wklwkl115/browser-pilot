import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CHECK_GROUPS,
	CHECK_GROUPS_SUMMARY_PATH,
	DEFAULT_GROUP_SEQUENCE,
	DAG_EXTRA_NODE_IDS,
	GRAPH_SCRIPT_EXCLUSIONS,
	graphCoveredPackageScripts,
	packageScripts,
	recordMissIfApplicable,
	computeCoarseFingerprint,
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
assert.equal(pkg.scripts["check:trace"], "node scripts/run-check-groups.mjs --json", "package must expose check:trace over the grouped runner");
assert.equal(pkg.scripts["check:dag"], "node scripts/check-dag.mjs", "package must expose check:dag");
assert.equal(pkg.scripts["check:smart"], "node scripts/check-dag.mjs --smart", "package must expose check:smart");
assert.equal(pkg.scripts["check:check-graph"], "node tests/contracts/drift/check-check-graph.mjs", "package must expose the check graph drift gate");

const runner = read("scripts/run-check-groups.mjs");
const dag = read("scripts/check-dag.mjs");
assert(runner.includes("CHECK_GROUPS") && runner.includes("CHECK_GROUPS_SUMMARY_PATH") && runner.includes("durationMs"), "grouped runner must read graph groups and write duration trace");
assert(dag.includes("CHECK_GROUPS") && dag.includes("CHECK_DAG_SUMMARY_PATH") && dag.includes("CHECK_IMPACT_SUMMARY_PATH") && dag.includes("--changed-file=") && read("scripts/check-graph.mjs").includes("CHECK_MISS_DIR"), "DAG runner must read graph groups and write DAG/impact/miss artifacts");

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

const fingerprint = computeCoarseFingerprint(root);
assert.equal(fingerprint.ok, true, "coarse fingerprint must be available");
assert(fingerprint.fingerprint.startsWith("sha256:"), "coarse fingerprint must be sha256 tagged");
assert(fingerprint.fileCount > 100, "coarse fingerprint must cover the repo source/test/doc scope");

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
	assert(missText.includes("contract:miss") && missText.includes("likelyRepairTarget"), "synthetic miss artifact must identify the failed node and repair target");
} finally {
	if (priorImpact !== undefined) writeJsonFile(CHECK_IMPACT_SUMMARY_PATH, JSON.parse(priorImpact));
	else rmSync(CHECK_IMPACT_SUMMARY_PATH, { force: true });
}

assert(CHECK_GROUPS_SUMMARY_PATH.endsWith(".pi\\browser-artifacts\\check-groups-summary.json") || CHECK_GROUPS_SUMMARY_PATH.endsWith(".pi/browser-artifacts/check-groups-summary.json"), "group trace artifact path must stay under .pi/browser-artifacts");

console.log("check graph contract ok");
