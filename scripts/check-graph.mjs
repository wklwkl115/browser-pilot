import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inputMatchesChangedFile, normalizeRel } from "./lib/repo-introspection.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ARTIFACT_DIR = path.join(ROOT, ".pi", "browser-artifacts");
export const CHECK_CACHE_DIR = path.join(ROOT, ".pi", "check-cache");
export const CHECK_GROUPS_SUMMARY_PATH = path.join(ARTIFACT_DIR, "check-groups-summary.json");
export const CHECK_DAG_SUMMARY_PATH = path.join(ARTIFACT_DIR, "check-dag-summary.json");
export const CHECK_DAG_RUN_DIR = path.join(ARTIFACT_DIR, "check-dag");
export const CHECK_IMPACT_SUMMARY_PATH = path.join(ARTIFACT_DIR, "check-impact-summary.json");
export const CHECK_IMPACT_MAP_PATH = path.join(ROOT, "tests", "contracts", "drift", "check-impact-map.json");
export const CHECK_MISS_DIR = path.join(ARTIFACT_DIR, "check-misses");
export const CHECK_CACHE_INDEX_PATH = path.join(CHECK_CACHE_DIR, "index.json");
export const CHECK_CACHE_SCHEMA_VERSION = 2;

export const CHECK_GROUPS = Object.freeze({
	src: ["check:src:types", "check:registry-drift"],
	bridge: ["check:bridge"],
	unit: ["test:unit:abml", "test:unit:cli:commands", "test:unit:cli:daemon", "test:unit:distill", "test:unit:driver", "test:unit:memory", "test:unit:tools", "test:unit:web-security", "test:unit:misc"],
	package: ["check:package", "check:deps", "check:pi-browser-bridge"],
	docs: ["check:tool-docs", "check:doc-structure", "check:audit-inbox", "check:doc-paths", "check:code-map", "check:boundaries", "check:distill-core-boundary", "check:recovery-boundary", "check:abml-core-boundary", "check:memory-core-boundary", "check:docs-sync"],
	contracts: ["check:capture", "check:scan", "check:content-pick", "check:transfer", "check:web-security", "check:page-scripts", "check:fake-ws", "check:lifecycle", "check:runtime-fixtures", "check:smoke-diagnostics", "check:paths", "check:token", "check:summaries", "check:artifact", "check:errors", "check:eval-workflows", "check:browser-workflow-results", "check:browser-commands", "check:distiller-coverage", "check:output-schema-conformance", "check:tool-parameter-contract", "check:tool-parameter-framework-validation", "check:summary-boundary", "check:compaction-ledger", "check:governance", "check:input-surface", "check:file-ceilings", "check:check-graph", "check:impact-map", "check:abml-contracts", "check:cli-parity", "check:param-surface", "check:cli-json-envelopes", "check:memory-autosurface", "check:memory-plane", "check:memory-lifecycle", "check:token-economy", "bench:distill", "check:session-delta-long-conversation", "check:task-conditioned-salience"],
});

export const DEFAULT_GROUP_SEQUENCE = Object.freeze(["src", "bridge", "unit", "package", "docs", "contracts"]);
export const DAG_EXTRA_NODE_IDS = Object.freeze(["lint:eslint"]);

export const CI_GROUP_LABELS = Object.freeze({
	src: "contracts-and-unit",
	bridge: "contracts-and-unit",
	unit: "contracts-and-unit",
	package: "package-acceptance",
	docs: "package-acceptance",
	contracts: "contracts-and-unit",
	"lint:eslint": "lint-static",
});

export const GRAPH_SCRIPT_EXCLUSIONS = Object.freeze({
	check: "top-level alias for check:all",
	"check:abml-ax-runtime": "covered by check:abml-contracts umbrella",
	"check:abml-ax-smoke": "covered by check:abml-contracts umbrella",
	"check:abml-causal": "covered by check:abml-contracts umbrella",
	"check:abml-diff": "covered by check:abml-contracts umbrella",
	"check:abml-inference": "covered by check:abml-contracts umbrella",
	"check:abml-internal-integration": "covered by check:abml-contracts umbrella",
	"check:abml-p6p7-runtime": "covered by check:abml-contracts umbrella",
	"check:abml-ref-registry": "covered by check:abml-contracts umbrella",
	"check:abml-relation-graph": "covered by check:abml-contracts umbrella",
	"check:abml-scan-entities": "covered by check:abml-contracts umbrella",
	"check:abml-scan-envelope": "covered by check:abml-contracts umbrella",
	"check:abml-semantic-ref-anchor": "covered by check:abml-contracts umbrella",
	"check:abml-snapshot-projection": "covered by check:abml-contracts umbrella",
	"check:abml-stream-plane": "covered by check:abml-contracts umbrella",
	"check:abml-templating": "covered by check:abml-contracts umbrella",
	"check:abml-tree-diff": "covered by check:abml-contracts umbrella",
	"check:abml-verb-runtime": "covered by check:abml-contracts umbrella",
	"check:all": "DAG full-graph alias; graph source is CHECK_GROUPS",
	"check:all:bridge": "DAG group alias for bridge+unit",
	"check:all:contracts": "DAG group alias for contracts",
	"check:all:package": "DAG group alias for package+docs",
	"check:all:src": "DAG group alias for src",
	"check:cli-migration-drift": "completed migration guard; retained as standalone script but removed from default check graph",
	"check:compute-once": "covered by check:governance umbrella",
	"check:dag": "graph executor frontend, not a proof obligation node",
	"check:env-flags": "covered by check:governance umbrella",
	"check:jshookmcp-closure": "completed migration guard; retained as standalone script but removed from default check graph",
	"check:kernel-test-map": "covered by check:governance umbrella",
	"check:purity-vocabulary": "covered by check:governance umbrella",
	"check:serial": "serial grouped-runner escape hatch",
	"check:serial:bridge": "serial grouped-runner escape hatch for bridge+unit",
	"check:serial:contracts": "serial grouped-runner escape hatch for contracts",
	"check:serial:package": "serial grouped-runner escape hatch for package+docs",
	"check:smart": "impact executor frontend, not a proof obligation node",
	"check:spec-truth": "covered by check:governance umbrella",
	"check:surface-liveness": "covered by check:governance umbrella",
	"check:trace": "trace frontend over the graph-backed grouped runner",
	"docs:generate": "child tool-doc generator; guarded by check:docs-sync and check:tool-docs",
	"docs:sync": "doc generator umbrella; guarded by check:docs-sync",
	"docs:sync-indexes": "child doc index generator; guarded by check:docs-sync",
	"eval:blind:launch": "operator-driven blind eval stage",
	"eval:blind:teardown": "operator-driven blind eval cleanup",
	"eval:browser-workflows": "eval runner, not a default local check obligation",
	"eval:redundancy-allocator": "eval runner, not a default local check obligation",
	"new:check": "developer scaffolder; graph gate verifies generated wiring",
	"query:markers": "developer query tool; not a proof obligation node",
	"release:local": "release acceptance gate, not part of default local check graph",
	"release:local:smoke": "release acceptance smoke, opt-in runtime gate",
	"scope:begin": "developer workstream-scope baseline helper; DAG summary consumes its artifact",
	"smoke:abml:internal-routing": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:abml-causal": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:abml-frame-compare": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:abml-monitor-comparison": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:abml-relations": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:abml-templating": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:abml-vision-compare": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:ax-merge": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:correlation-chain": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:debugger-evidence": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:intercept-lease-conflict": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:intercept-replace-script": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:intercept-request-mutate": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:intercept-response": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:intercept-tab-close-cleanup": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:intercept-uninstall-fail-closed": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:isolated": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:memory": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:observe-navigation": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:scan-summary": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:transfer": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:websocket-session": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:cli": "runtime CLI smoke, explicitly opt-in outside default local checks",
	"smoke:cli:full": "runtime CLI smoke, explicitly opt-in outside default local checks",
	"sync:code-map": "child code-map doc generator; guarded by check:code-map and check:docs-sync",
	"test:coverage": "optional coverage mode, not part of local acceptance",
	"test:observe-abml-integration": "covered by test:unit glob in the graph",
	"test:unit": "umbrella; covered by test:unit:* shards",
	"test:unit:cli": "umbrella; covered by test:unit:cli:commands and test:unit:cli:daemon shards",
});

const COMMAND_OVERRIDES = Object.freeze({
	"lint:eslint": "eslint .",
	"check:src:types": "tsc -p tsconfig.json --incremental --tsBuildInfoFile .pi/tsbuildinfo/tsconfig.tsbuildinfo",
	"check:bridge:types": "tsc -p tsconfig.bridge-src.json --incremental --tsBuildInfoFile .pi/tsbuildinfo/tsconfig.bridge-src.tsbuildinfo",
});

const NON_PARALLEL_NODE_IDS = new Set([
	"check:deps",
	"check:runtime-fixtures",
	"check:token-economy",
	"bench:distill",
	// Memory tests exercise shared local profile/resource state; keep the shard exclusive.
	"test:unit:memory",
	// WebSecurity unit fixtures open local HTTP/WS servers and artifact paths; keep the shard exclusive.
	"test:unit:web-security",
]);

export const FINGERPRINT_ROOTS = Object.freeze([
	"src",
	"cli",
	"bridge_src",
	"capture-src",
	"tests",
	"scripts",
	"evals",
	"skills",
	"docs",
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	"tsconfig.base.json",
	"tsconfig.build.json",
	"tsconfig.bridge-src.json",
	"eslint.config.js",
	".github/workflows/check.yml",
]);

export const CACHE_GLOBAL_INPUTS = Object.freeze([
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	"tsconfig.base.json",
	"tsconfig.build.json",
	"tsconfig.bridge-src.json",
	"eslint.config.js",
	"scripts/check-graph.mjs",
	"scripts/check-dag.mjs",
]);

export function readPackageJson(root = ROOT) {
	return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
}

export function packageScripts(root = ROOT) {
	return readPackageJson(root).scripts || {};
}

export function ensureArtifactDir() {
	mkdirSync(ARTIFACT_DIR, { recursive: true });
}

export function writeJsonFile(file, value) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readImpactMap(root = ROOT) {
	const mapPath = path.join(root, "tests", "contracts", "drift", "check-impact-map.json");
	return JSON.parse(readFileSync(mapPath, "utf8"));
}

function likelyImpactRepairTarget({ root = ROOT, failingScript, changedFiles = [] }) {
	let map;
	try {
		map = readImpactMap(root);
	} catch {
		return "impact map unavailable; run npm run sync:impact-map";
	}
	const node = map.nodes?.[failingScript];
	const changed = changedFiles.map(normalizeRel);
	if (!node) return `${failingScript} is absent from tests/contracts/drift/check-impact-map.json; run npm run sync:impact-map`;
	if (node.scope === "global") return `${failingScript} has global impact scope but was not selected; inspect selectSmartScripts and run npm run sync:impact-map`;
	const unmatched = changed.filter((file) => !(node.inputs || []).some((input) => inputMatchesChangedFile(input, file)));
	const sample = unmatched.slice(0, 3).join(", ") || changed.slice(0, 3).join(", ") || "no changed files recorded";
	return `${sample} matched no impact-map scope for ${failingScript}; run npm run sync:impact-map and inspect npm run query:markers -- --file <path>`;
}

export function parseCommandLine(text) {
	const tokens = [];
	let current = "";
	let quote = "";
	let escaping = false;
	for (const ch of String(text)) {
		if (escaping) {
			current += ch;
			escaping = false;
			continue;
		}
		if (ch === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = "";
			else current += ch;
			continue;
		}
		if (ch === "\"" || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (escaping) current += "\\";
	if (quote) throw new Error(`Unclosed quote in command: ${text}`);
	if (current) tokens.push(current);
	if (!tokens.length) throw new Error("Empty command");
	return { command: tokens[0], args: tokens.slice(1) };
}

export function splitCommandSteps(command) {
	return String(command).split(/\s+&&\s+/).map((step) => step.trim()).filter(Boolean);
}

export function scriptCommand(scriptName, scripts = packageScripts()) {
	return COMMAND_OVERRIDES[scriptName] || scripts[scriptName];
}

export function resolveScriptSteps(scriptName, options = {}) {
	const scripts = options.scripts || packageScripts(options.root || ROOT);
	const seen = options.seen || new Set();
	const command = scriptCommand(scriptName, scripts);
	if (!command) throw new Error(`No package or graph command for ${scriptName}`);
	if (seen.has(scriptName)) throw new Error(`Recursive check graph command: ${[...seen, scriptName].join(" -> ")}`);
	const nextSeen = new Set(seen);
	nextSeen.add(scriptName);
	const steps = [];
	const rawSteps = splitCommandSteps(command);
	for (let index = 0; index < rawSteps.length; index += 1) {
		const raw = rawSteps[index];
		const parsed = parseCommandLine(raw);
		if (parsed.command === "npm" && parsed.args[0] === "run" && parsed.args[1]) {
			steps.push(...resolveScriptSteps(parsed.args[1], { scripts, root: options.root, seen: nextSeen }));
			continue;
		}
		const id = rawSteps.length === 1 ? scriptName : `${scriptName}#${index + 1}`;
		steps.push({
			id,
			script: scriptName,
			command: parsed.command,
			args: parsed.args,
			commandLine: raw,
			parallelSafe: !NON_PARALLEL_NODE_IDS.has(scriptName),
			cacheable: true,
		});
	}
	return steps;
}

export function groupScriptSequence(groups = DEFAULT_GROUP_SEQUENCE) {
	const out = [];
	for (const group of groups) {
		const scripts = CHECK_GROUPS[group];
		if (!scripts) throw new Error(`Unknown check group: ${group}`);
		out.push(...scripts);
	}
	return out;
}

export function graphCoveredPackageScripts(groups = DEFAULT_GROUP_SEQUENCE) {
	const covered = new Set();
	const scripts = packageScripts();
	const collect = (scriptName, seen = new Set()) => {
		if (seen.has(scriptName)) return;
		seen.add(scriptName);
		covered.add(scriptName);
		const command = scriptCommand(scriptName, scripts);
		if (!command) return;
		for (const raw of splitCommandSteps(command)) {
			const parsed = parseCommandLine(raw);
			if (parsed.command === "npm" && parsed.args[0] === "run" && parsed.args[1]) collect(parsed.args[1], seen);
		}
	};
	for (const script of groupScriptSequence(groups)) {
		collect(script);
		for (const step of resolveScriptSteps(script, { scripts })) covered.add(step.script);
	}
	return covered;
}

function gitLines(args, root = ROOT) {
	const out = execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	return out.split("\0").filter(Boolean).map((item) => item.replace(/\\/g, "/"));
}

function addSelection(selected, script, reason) {
	if (!selected.has(script)) selected.set(script, []);
	selected.get(script).push(reason);
}

function contractScriptFor(file, scripts = packageScripts()) {
	const base = path.basename(file);
	if (!base.startsWith("check-") || !base.endsWith(".mjs")) return undefined;
	const scriptName = `check:${base.slice("check-".length, -".mjs".length)}`;
	return scripts[scriptName] ? scriptName : undefined;
}

function selectFullGraph(selected, reason) {
	for (const script of groupScriptSequence(DEFAULT_GROUP_SEQUENCE)) addSelection(selected, script, reason);
}

export function selectSmartScripts(files, options = {}) {
	const selected = new Map();
	const scripts = options.scripts || packageScripts(options.root || ROOT);
	addSelection(selected, "check:src:types", "base type proof");
	addSelection(selected, "check:registry-drift", "base registry drift proof");
	addSelection(selected, "lint:eslint", "base lint proof");
	addSelection(selected, "check:boundaries", "base repository boundary proof");

	if (!files.length) {
		addSelection(selected, "check:check-graph", "clean-tree graph integrity proof");
		return selected;
	}

	const impactMap = options.impactMap || readImpactMap(options.root || ROOT);
	const entries = Object.values(impactMap.nodes || {});
	for (const file of files) {
		const rel = normalizeRel(file);
		if (/^(package\.json|package-lock\.json|tsconfig.*\.json|eslint\.config\.js|\.github\/)/.test(rel)) {
			selectFullGraph(selected, `${rel}: package/config/toolchain change expands to full graph`);
			continue;
		}
		if (rel.startsWith("scripts/")) {
			addSelection(selected, "check:check-graph", `${rel}: graph/runner script change`);
			addSelection(selected, "check:boundaries", `${rel}: script boundary check`);
			selectFullGraph(selected, `${rel}: script change expands to full graph`);
			continue;
		}

		let matched = false;
		for (const entry of entries) {
			if (!entry?.script || !scripts[entry.script]) continue;
			if (entry.scope === "global") {
				addSelection(selected, entry.script, `${rel}: ${entry.script} has global impact scope`);
				matched = true;
				continue;
			}
			if ((entry.inputs || []).some((input) => inputMatchesChangedFile(input, rel))) {
				addSelection(selected, entry.script, `${rel}: matched derived impact scope`);
				matched = true;
			}
		}

		if (rel.startsWith("tests/contracts/")) {
			const script = contractScriptFor(rel, scripts);
			if (script) {
				addSelection(selected, script, `${rel}: changed contract script`);
				matched = true;
			}
			addSelection(selected, "check:check-graph", `${rel}: graph drift coverage`);
			matched = true;
		}
		if (rel.startsWith("docs/") || rel.startsWith("README") || rel === "AGENTS.md" || rel === "CLAUDE.md" || rel === "TODO.md" || rel === "CURRENT.md" || rel === "CHANGELOG.md") {
			addSelection(selected, "check:doc-structure", `${rel}: document structure`);
			addSelection(selected, "check:tool-docs", `${rel}: generated doc drift if affected`);
			matched = true;
		}
		if (!matched) selectFullGraph(selected, `${rel}: unknown impact expands to full graph`);
	}
	return selected;
}

export function collectFingerprintFiles(root = ROOT, pathspecs) {
	const suffix = Array.isArray(pathspecs) && pathspecs.length ? ["--", ...pathspecs] : [];
	const tracked = gitLines(["ls-files", "-z", ...suffix], root);
	const untracked = gitLines(["ls-files", "--others", "--exclude-standard", "-z", ...suffix], root);
	const files = new Map();
	for (const file of tracked) files.set(file, "tracked");
	for (const file of untracked) files.set(file, "untracked");
	return [...files.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

function hashFingerprintFiles(files, options) {
	const hash = createHash("sha256");
	let untrackedCount = 0;
	hash.update(`${options.seed}\n`);
	hash.update(`${process.version}\n`);
	for (const line of options.extraLines || []) hash.update(`${line}\n`);
	for (const [file, kind] of files) {
		const abs = path.join(options.root, file);
		if (!existsSync(abs)) continue;
		const content = readFileSync(abs);
		const itemHash = createHash("sha256").update(content).digest("hex");
		if (kind === "untracked") untrackedCount += 1;
		hash.update(`${kind}\0${file}\0${itemHash}\0${content.length}\n`);
	}
	return {
		ok: true,
		scope: options.scope,
		fingerprint: `sha256:${hash.digest("hex")}`,
		fileCount: files.length,
		untrackedCount,
	};
}

export function computeCoarseFingerprint(root = ROOT, options = {}) {
	const files = options.fileEntries || collectFingerprintFiles(root, FINGERPRINT_ROOTS);
	return {
		...hashFingerprintFiles(files, {
			root,
			seed: "pi-browser-check-fingerprint-v1",
			scope: "repo-coarse-v1",
		}),
		roots: [...FINGERPRINT_ROOTS],
	};
}

function nodeImpactEntry(node, impactMap) {
	const impactScript = node.impactScript || node.script;
	return {
		impactScript,
		entry: impactMap?.nodes?.[impactScript] || impactMap?.nodes?.[node.script],
	};
}

export function cacheScopeForNode(node, options = {}) {
	const root = options.root || ROOT;
	const impactMap = options.impactMap || readImpactMap(root);
	const { impactScript, entry } = nodeImpactEntry(node, impactMap);
	if (!entry) {
		return {
			scope: "global",
			cacheScope: "repo-coarse-v1",
			impactScript,
			reason: "missing impact-map entry; using whole-repo cache key",
			inputs: [...FINGERPRINT_ROOTS],
			globalConfigInputs: [...CACHE_GLOBAL_INPUTS],
		};
	}
	if (entry.scope === "global") {
		return {
			scope: "global",
			cacheScope: "repo-coarse-v1",
			impactScript,
			reason: "impact-map entry is global",
			inputs: [...FINGERPRINT_ROOTS],
			unresolvedInputs: entry.unresolvedInputs || [],
			globalConfigInputs: [...CACHE_GLOBAL_INPUTS],
		};
	}
	const inputs = [...new Set([...(entry.inputs || []), ...CACHE_GLOBAL_INPUTS])].sort();
	return {
		scope: "paths",
		cacheScope: "node-paths-v2",
		impactScript,
		reason: "impact-map path scope plus global cache config",
		inputs,
		unresolvedInputs: entry.unresolvedInputs || [],
		globalConfigInputs: [...CACHE_GLOBAL_INPUTS],
	};
}

export function computeNodeCacheFingerprint(node, options = {}) {
	const root = options.root || ROOT;
	const impactMap = options.impactMap || readImpactMap(root);
	const scope = cacheScopeForNode(node, { root, impactMap });
	if (scope.scope === "global") {
		const coarse = options.coarseFingerprint || computeCoarseFingerprint(root, { fileEntries: options.coarseFileEntries });
		return {
			schemaVersion: CHECK_CACHE_SCHEMA_VERSION,
			...coarse,
			scope: scope.cacheScope,
			cacheScope: scope.cacheScope,
			impactScript: scope.impactScript,
			reason: scope.reason,
			inputs: scope.inputs,
			inputCount: scope.inputs.length,
			globalConfigInputs: scope.globalConfigInputs,
		};
	}
	const allFiles = options.allFileEntries || collectFingerprintFiles(root);
	const scopedFiles = allFiles.filter(([file]) => scope.inputs.some((input) => inputMatchesChangedFile(input, file)));
	const nodeEntry = impactMap.nodes?.[scope.impactScript] || {};
	const impactDigest = createHash("sha256").update(JSON.stringify({ script: scope.impactScript, scope: nodeEntry.scope, inputs: nodeEntry.inputs || [] })).digest("hex");
	const fingerprint = hashFingerprintFiles(scopedFiles, {
		root,
		seed: "pi-browser-check-node-fingerprint-v2",
		scope: scope.cacheScope,
		extraLines: [
			`impactScript:${scope.impactScript}`,
			`impactDigest:${impactDigest}`,
			...scope.inputs.map((input) => `input:${input}`),
		],
	});
	return {
		schemaVersion: CHECK_CACHE_SCHEMA_VERSION,
		...fingerprint,
		cacheScope: scope.cacheScope,
		impactScript: scope.impactScript,
		reason: scope.reason,
		inputs: scope.inputs,
		inputCount: scope.inputs.length,
		globalConfigInputs: scope.globalConfigInputs,
	};
}

export function recordMissIfApplicable({ root = ROOT, fullRunId, failingScript, fullSummaryPath, now = new Date() }) {
	if (!existsSync(CHECK_IMPACT_SUMMARY_PATH)) return undefined;
	const impact = JSON.parse(readFileSync(CHECK_IMPACT_SUMMARY_PATH, "utf8"));
	if (impact.mode !== "smart" || impact.ok !== true) return undefined;
	if (impact.dryRun === true) return undefined;
	const current = computeCoarseFingerprint(root);
	if (!current.ok || current.fingerprint !== impact.worktreeFingerprint) return undefined;
	const selected = new Set(impact.selectedScripts || []);
	if (selected.has(failingScript)) return undefined;
	const runId = `${now.toISOString().replace(/[:.]/g, "-")}-${String(failingScript || "unknown").replace(/[^A-Za-z0-9_.-]+/g, "_")}`;
	const miss = {
		schemaVersion: 1,
		runId,
		smartRunId: impact.runId,
		fullRunId,
		worktreeFingerprint: current.fingerprint,
		changedFiles: impact.changedFiles || [],
		selectedScripts: impact.selectedScripts || [],
		selectedNodes: impact.selectedNodes || [],
		skippedScripts: impact.skippedScripts || [],
		cacheHits: impact.cacheHits || [],
		failingFullCheckNode: failingScript,
		likelyRepairTarget: likelyImpactRepairTarget({ root, failingScript, changedFiles: impact.changedFiles || [] }),
		fullSummaryPath,
	};
	const outPath = path.join(CHECK_MISS_DIR, `${runId}.json`);
	writeJsonFile(outPath, miss);
	return { path: outPath, miss };
}
