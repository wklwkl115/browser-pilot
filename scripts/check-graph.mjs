import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ARTIFACT_DIR = path.join(ROOT, ".pi", "browser-artifacts");
export const CHECK_CACHE_DIR = path.join(ROOT, ".pi", "check-cache");
export const CHECK_GROUPS_SUMMARY_PATH = path.join(ARTIFACT_DIR, "check-groups-summary.json");
export const CHECK_DAG_SUMMARY_PATH = path.join(ARTIFACT_DIR, "check-dag-summary.json");
export const CHECK_IMPACT_SUMMARY_PATH = path.join(ARTIFACT_DIR, "check-impact-summary.json");
export const CHECK_MISS_DIR = path.join(ARTIFACT_DIR, "check-misses");
export const CHECK_CACHE_INDEX_PATH = path.join(CHECK_CACHE_DIR, "index.json");

export const CHECK_GROUPS = Object.freeze({
	src: ["check:src:types", "check:registry-drift"],
	bridge: ["check:bridge"],
	unit: ["test:unit"],
	package: ["check:package", "check:deps", "check:pi-browser-bridge"],
	docs: ["check:tool-docs", "check:doc-structure", "check:boundaries", "check:distill-core-boundary", "check:recovery-boundary", "check:abml-core-boundary", "check:memory-core-boundary", "check:cli-migration-drift"],
	contracts: ["check:jshookmcp-closure", "check:capture", "check:scan", "check:content-pick", "check:transfer", "check:web-security", "check:page-scripts", "check:fake-ws", "check:lifecycle", "check:runtime-fixtures", "check:abml-ax-smoke", "check:smoke-diagnostics", "check:paths", "check:token", "check:summaries", "check:artifact", "check:errors", "check:eval-workflows", "check:browser-workflow-results", "check:browser-commands", "check:distiller-coverage", "check:output-schema-conformance", "check:tool-parameter-contract", "check:tool-parameter-framework-validation", "check:summary-boundary", "check:compaction-ledger", "check:spec-truth", "check:surface-liveness", "check:compute-once", "check:purity-vocabulary", "check:kernel-test-map", "check:env-flags", "check:input-surface", "check:file-ceilings", "check:check-graph", "check:abml-ref-registry", "check:abml-scan-entities", "check:abml-scan-envelope", "check:abml-verb-runtime", "check:abml-ax-runtime", "check:abml-relation-graph", "check:abml-inference", "check:abml-diff", "check:abml-causal", "check:abml-templating", "check:abml-tree-diff", "check:abml-semantic-ref-anchor", "check:abml-snapshot-projection", "check:abml-stream-plane", "check:abml-p6p7-runtime", "check:abml-internal-integration", "check:cli-parity", "check:param-surface", "check:cli-json-envelopes", "check:memory-autosurface", "check:memory-plane", "check:memory-lifecycle", "check:token-economy", "bench:distill", "check:session-delta-long-conversation", "check:task-conditioned-salience"],
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
	"check:all": "grouped runner alias; graph source is CHECK_GROUPS",
	"check:all:bridge": "grouped runner alias for bridge+unit",
	"check:all:package": "grouped runner alias for package+docs",
	"check:all:contracts": "grouped runner alias for contracts",
	"check:trace": "trace frontend over the graph-backed grouped runner",
	"check:dag": "graph executor frontend, not a proof obligation node",
	"check:smart": "impact executor frontend, not a proof obligation node",
	"check:lint": "legacy aggregate; covered by check:boundaries, check:bridge:files, and check:page-scripts nodes",
	"test:coverage": "optional coverage mode, not part of local acceptance",
	"test:observe-abml-integration": "covered by test:unit glob in the graph",
	"smoke:browser": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:transfer": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:isolated": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:observe-navigation": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:scan-summary": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:debugger-evidence": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:correlation-chain": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:abml-monitor-comparison": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:abml-frame-compare": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:abml-vision-compare": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:intercept-response": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:intercept-replace-script": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:intercept-uninstall-fail-closed": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:intercept-request-mutate": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:intercept-tab-close-cleanup": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:intercept-lease-conflict": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:websocket-session": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:ax-merge": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:abml-relations": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:abml-causal": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:abml-templating": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:browser:memory": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:abml:internal-routing": "runtime smoke, explicitly opt-in outside default local checks",
	"smoke:cli": "runtime CLI smoke, explicitly opt-in outside default local checks",
	"smoke:cli:full": "runtime CLI smoke, explicitly opt-in outside default local checks",
	"eval:browser-workflows": "eval runner, not a default local check obligation",
	"eval:redundancy-allocator": "eval runner, not a default local check obligation",
	"eval:blind:launch": "operator-driven blind eval stage",
	"eval:blind:teardown": "operator-driven blind eval cleanup",
	"release:local": "release acceptance gate, not part of default local check graph",
	"release:local:smoke": "release acceptance smoke, opt-in runtime gate",
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

function relevantFiles(root = ROOT) {
	const tracked = gitLines(["ls-files", "-z", "--", ...FINGERPRINT_ROOTS], root);
	const untracked = gitLines(["ls-files", "--others", "--exclude-standard", "-z", "--", ...FINGERPRINT_ROOTS], root);
	const files = new Map();
	for (const file of tracked) files.set(file, "tracked");
	for (const file of untracked) files.set(file, "untracked");
	return [...files.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

export function computeCoarseFingerprint(root = ROOT) {
	const hash = createHash("sha256");
	const files = relevantFiles(root);
	let untrackedCount = 0;
	hash.update("pi-browser-check-fingerprint-v1\n");
	hash.update(`${process.version}\n`);
	for (const [file, kind] of files) {
		const abs = path.join(root, file);
		if (!existsSync(abs)) continue;
		const content = readFileSync(abs);
		const itemHash = createHash("sha256").update(content).digest("hex");
		if (kind === "untracked") untrackedCount += 1;
		hash.update(`${kind}\0${file}\0${itemHash}\0${content.length}\n`);
	}
	return {
		ok: true,
		scope: "repo-coarse-v1",
		fingerprint: `sha256:${hash.digest("hex")}`,
		fileCount: files.length,
		untrackedCount,
		roots: [...FINGERPRINT_ROOTS],
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
		likelyRepairTarget: "graph edge, fingerprint scope, ABI source, or cache eligibility",
		fullSummaryPath,
	};
	const outPath = path.join(CHECK_MISS_DIR, `${runId}.json`);
	writeJsonFile(outPath, miss);
	return { path: outPath, miss };
}
