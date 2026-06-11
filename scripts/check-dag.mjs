import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	ARTIFACT_DIR,
	CHECK_CACHE_INDEX_PATH,
	CHECK_DAG_SUMMARY_PATH,
	CHECK_GROUPS,
	CHECK_IMPACT_SUMMARY_PATH,
	DAG_EXTRA_NODE_IDS,
	DEFAULT_GROUP_SEQUENCE,
	ROOT,
	computeCoarseFingerprint,
	ensureArtifactDir,
	groupScriptSequence,
	packageScripts,
	recordMissIfApplicable,
	resolveScriptSteps,
	writeJsonFile,
} from "./check-graph.mjs";

const args = process.argv.slice(2);
const cacheEnabled = args.includes("--cache");
const smartMode = args.includes("--smart");
const jsonMode = args.includes("--json");
const dryRun = args.includes("--dry-run");
const selfTestMissRecorder = args.includes("--self-test-miss-recorder");
const maxConcurrencyArg = args.find((arg) => arg.startsWith("--max-concurrency="));
const maxConcurrency = Math.max(1, Number(maxConcurrencyArg?.split("=")[1] || Math.max(2, Math.floor((os.cpus()?.length || 4) / 2))) || 2);
const requestedGroups = args.filter((arg) => !arg.startsWith("--") && CHECK_GROUPS[arg]);
const changedFileOverrides = args.filter((arg) => arg.startsWith("--changed-file=")).map((arg) => arg.slice("--changed-file=".length)).filter(Boolean);

const localBin = path.join(ROOT, "node_modules", ".bin");
const pathEnv = `${localBin}${path.delimiter}${process.env.PATH || ""}`;

if (selfTestMissRecorder) {
	const fingerprint = computeCoarseFingerprint(ROOT);
	const previousImpact = existsSync(CHECK_IMPACT_SUMMARY_PATH) ? readFileSync(CHECK_IMPACT_SUMMARY_PATH, "utf8") : undefined;
	try {
		writeJsonFile(CHECK_IMPACT_SUMMARY_PATH, {
			schemaVersion: 1,
			mode: "smart",
			ok: true,
			runId: "synthetic-smart",
			worktreeFingerprint: fingerprint.fingerprint,
			changedFiles: ["synthetic.js"],
			selectedScripts: ["check:src:types"],
			selectedNodes: ["check:src:types"],
			skippedScripts: ["synthetic:miss"],
			cacheHits: [],
		});
		const recorded = recordMissIfApplicable({ root: ROOT, fullRunId: "synthetic-full", failingScript: "synthetic:miss", fullSummaryPath: CHECK_DAG_SUMMARY_PATH });
		if (!recorded || !existsSync(recorded.path)) throw new Error("synthetic miss recorder did not write an artifact");
		console.log(`synthetic miss recorder ok: ${recorded.path}`);
	} finally {
		if (previousImpact !== undefined) writeFileSync(CHECK_IMPACT_SUMMARY_PATH, previousImpact, "utf8");
		else rmSync(CHECK_IMPACT_SUMMARY_PATH, { force: true });
	}
	process.exit(0);
}

function readCacheIndex() {
	if (!existsSync(CHECK_CACHE_INDEX_PATH)) return { schemaVersion: 1, records: {} };
	try {
		const parsed = JSON.parse(readFileSync(CHECK_CACHE_INDEX_PATH, "utf8"));
		return parsed && typeof parsed === "object" && parsed.records ? parsed : { schemaVersion: 1, records: {} };
	} catch {
		return { schemaVersion: 1, records: {} };
	}
}

function writeCacheIndex(index) {
	mkdirSync(path.dirname(CHECK_CACHE_INDEX_PATH), { recursive: true });
	writeFileSync(CHECK_CACHE_INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function changedFiles() {
	const tracked = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: ROOT, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
	const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
	return Array.from(new Set([...tracked, ...untracked])).sort();
}

function selectSmartScripts(files) {
	const selected = new Map();
	const add = (script, reason) => {
		if (!selected.has(script)) selected.set(script, []);
		selected.get(script).push(reason);
	};
	add("check:src:types", "base type proof");
	add("check:registry-drift", "base registry drift proof");
	add("lint:eslint", "base lint proof");
	add("check:boundaries", "base repository boundary proof");

	if (!files.length) {
		add("check:check-graph", "clean-tree graph integrity proof");
		return selected;
	}

	for (const file of files) {
		const rel = file.replace(/\\/g, "/");
		if (/^(package\.json|package-lock\.json|tsconfig.*\.json|eslint\.config\.js|\.github\/)/.test(rel)) {
			for (const script of groupScriptSequence(DEFAULT_GROUP_SEQUENCE)) add(script, `${rel}: package/config/toolchain change expands to full graph`);
			continue;
		}
		if (rel.startsWith("scripts/")) {
			add("check:check-graph", `${rel}: graph/runner script change`);
			add("check:boundaries", `${rel}: script boundary check`);
			for (const script of groupScriptSequence(DEFAULT_GROUP_SEQUENCE)) add(script, `${rel}: script change expands to full graph`);
			continue;
		}
		if (rel.startsWith("bridge_src/")) {
			add("check:bridge:types", `${rel}: bridge source typecheck`);
			add("check:bridge:build", `${rel}: bridge generated dist contract`);
			add("check:bridge:files", `${rel}: bridge file contract`);
			add("check:protocol", `${rel}: bridge protocol drift`);
			continue;
		}
		if (rel.startsWith("capture-src/")) {
			add("check:capture", `${rel}: capture source drift`);
			add("check:scan", `${rel}: scan runtime contract`);
			add("check:content-pick", `${rel}: content/pick runtime contract`);
			continue;
		}
		if (rel.startsWith("src/tools/") || rel.startsWith("src/frontend/") || rel.startsWith("src/resources/")) {
			add("check:tools", `${rel}: tool registration/runtime surface`);
			add("check:tool-docs", `${rel}: generated tool docs`);
			add("check:tool-parameter-contract", `${rel}: tool parameter contract`);
			add("check:summaries", `${rel}: tool summary contract`);
			add("check:errors", `${rel}: tool error contract`);
			add("test:unit", `${rel}: source unit coverage`);
			continue;
		}
		if (rel.startsWith("src/abml-core/") || rel.startsWith("src/abml/")) {
			add("check:abml-core-boundary", `${rel}: ABML boundary`);
			add("check:abml-internal-integration", `${rel}: ABML integration`);
			add("test:unit", `${rel}: ABML unit coverage`);
			continue;
		}
		if (rel.startsWith("src/distill-core/")) {
			add("check:distill-core-boundary", `${rel}: distill-core boundary`);
			add("check:token-economy", `${rel}: token economy`);
			add("bench:distill", `${rel}: distill bench`);
			add("test:unit", `${rel}: distill unit coverage`);
			continue;
		}
		if (rel.startsWith("src/memory-core/") || rel.startsWith("src/memory/")) {
			add("check:memory-core-boundary", `${rel}: memory-core boundary`);
			add("check:memory-plane", `${rel}: memory plane contract`);
			add("check:memory-lifecycle", `${rel}: memory lifecycle contract`);
			add("test:unit", `${rel}: memory unit coverage`);
			continue;
		}
		if (rel.startsWith("src/") || rel.startsWith("cli/")) {
			add("test:unit", `${rel}: source unit coverage`);
			add("check:cli-parity", `${rel}: CLI parity if affected`);
			continue;
		}
		if (rel.startsWith("tests/unit/")) {
			add("test:unit", `${rel}: changed unit test`);
			continue;
		}
		if (rel.startsWith("tests/contracts/")) {
			const script = contractScriptFor(rel);
			if (script) add(script, `${rel}: changed contract script`);
			add("check:check-graph", `${rel}: graph drift coverage`);
			continue;
		}
		if (rel.startsWith("docs/") || rel.startsWith("README") || rel === "AGENTS.md" || rel === "CLAUDE.md" || rel === "TODO.md" || rel === "CURRENT.md" || rel === "CHANGELOG.md") {
			add("check:doc-structure", `${rel}: document structure`);
			add("check:tool-docs", `${rel}: generated doc drift if affected`);
			continue;
		}
		for (const script of groupScriptSequence(DEFAULT_GROUP_SEQUENCE)) add(script, `${rel}: unknown impact expands to full graph`);
	}
	return selected;
}

function contractScriptFor(file) {
	const base = path.basename(file);
	if (!base.startsWith("check-") || !base.endsWith(".mjs")) return undefined;
	const scriptName = `check:${base.slice("check-".length, -".mjs".length)}`;
	return packageScripts()[scriptName] ? scriptName : undefined;
}

function buildNodes(scriptIds) {
	const scripts = packageScripts();
	const out = [];
	const seen = new Set();
	for (const scriptId of scriptIds) {
		for (const step of resolveScriptSteps(scriptId, { scripts })) {
			if (seen.has(step.id)) continue;
			seen.add(step.id);
			out.push({ ...step });
		}
	}
	return out;
}

function runNode(node) {
	return new Promise((resolve) => {
		const startedAt = new Date().toISOString();
		const start = performance.now();
		let stdout = "";
		let stderr = "";
		const executable = resolveExecutable(node.command, node.args);
		const child = spawn(executable.command, executable.args, {
			cwd: ROOT,
			env: { ...process.env, PATH: pathEnv },
			shell: false,
			stdio: jsonMode ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stdout.on("data", (chunk) => {
			const text = String(chunk);
			stdout += text;
			if (!jsonMode) process.stdout.write(text);
		});
		child.stderr.on("data", (chunk) => {
			const text = String(chunk);
			stderr += text;
			if (!jsonMode) process.stderr.write(text);
		});
		child.on("error", (error) => {
			stderr += `${error.stack || error.message}\n`;
		});
		child.on("close", (code, signal) => {
			const finishedAt = new Date().toISOString();
			resolve({
				nodeId: node.id,
				script: node.script,
				command: node.command,
				args: node.args,
				commandLine: node.commandLine,
				ok: code === 0,
				status: code ?? 1,
				signal: signal ?? null,
				startedAt,
				finishedAt,
				durationMs: Math.round(performance.now() - start),
				stdoutTail: stdout.slice(-4000),
				stderrTail: stderr.slice(-4000),
			});
		});
	});
}

function resolveExecutable(command, args) {
	if (command === "tsx") return { command: process.execPath, args: [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), ...args] };
	if (command === "tsc") return { command: process.execPath, args: [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), ...args] };
	if (command === "eslint") return { command: process.execPath, args: [path.join(ROOT, "node_modules", "eslint", "bin", "eslint.js"), ...args] };
	return { command, args };
}

async function runNodes(nodes, options) {
	const pending = [...nodes];
	const results = [];
	let running = 0;
	let exclusiveRunning = false;
	let failed = false;
	return await new Promise((resolve) => {
		const pump = () => {
			if ((!pending.length && running === 0) || failed) {
				if (running === 0) resolve(results);
				return;
			}
			while (pending.length && running < options.maxConcurrency && !exclusiveRunning) {
				const nextIndex = pending.findIndex((node) => node.parallelSafe !== false || running === 0);
				if (nextIndex < 0) break;
				const node = pending.splice(nextIndex, 1)[0];
				if (node.parallelSafe === false && running > 0) {
					pending.unshift(node);
					break;
				}
				running += 1;
				if (node.parallelSafe === false) exclusiveRunning = true;
				console.log(`\n[check-dag] ${node.id}: ${node.commandLine}`);
				runNode(node).then((result) => {
					results.push(result);
					running -= 1;
					if (node.parallelSafe === false) exclusiveRunning = false;
					if (!result.ok) failed = true;
					pump();
				});
				if (node.parallelSafe === false) break;
			}
		};
		pump();
	});
}

function cacheKey(node, fingerprint) {
	return `${fingerprint}\0${node.id}\0${node.commandLine}`;
}

function applyCache(nodes, fingerprint, cacheIndex) {
	const executable = [];
	const hits = [];
	for (const node of nodes) {
		const record = cacheIndex.records[cacheKey(node, fingerprint)];
		if (cacheEnabled && node.cacheable !== false && record?.status === "passed") {
			hits.push({ nodeId: node.id, script: node.script, durationMs: 0, hitReason: "same coarse repo fingerprint and same node command" });
		} else {
			executable.push(node);
		}
	}
	return { executable, hits };
}

function updateCache(results, nodesById, fingerprint, cacheIndex) {
	for (const result of results) {
		const node = nodesById.get(result.nodeId);
		if (!node || !result.ok || node.cacheable === false) continue;
		cacheIndex.records[cacheKey(node, fingerprint)] = {
			schemaVersion: 1,
			nodeId: node.id,
			fingerprint,
			scope: "repo-coarse-v1",
			command: node.commandLine,
			status: "passed",
			durationMs: result.durationMs,
			recordedAt: new Date().toISOString(),
			hitReason: "same coarse repo fingerprint and same node command",
		};
	}
	return cacheIndex;
}

const startedAt = new Date().toISOString();
const runId = startedAt.replace(/[:.]/g, "-");
const fingerprint = computeCoarseFingerprint(ROOT);
const changed = smartMode ? (changedFileOverrides.length ? changedFileOverrides : changedFiles()) : [];
const selectedMap = smartMode ? selectSmartScripts(changed) : undefined;
const selectedScripts = smartMode ? [...selectedMap.keys()] : [...DAG_EXTRA_NODE_IDS, ...groupScriptSequence(requestedGroups.length ? requestedGroups : DEFAULT_GROUP_SEQUENCE)];
const selectedReasons = smartMode ? Object.fromEntries([...selectedMap.entries()]) : {};
const nodes = buildNodes(selectedScripts);
const nodesById = new Map(nodes.map((node) => [node.id, node]));
const cacheIndex = readCacheIndex();
const { executable, hits } = applyCache(nodes, fingerprint.fingerprint, cacheIndex);
const skippedScripts = smartMode ? groupScriptSequence(DEFAULT_GROUP_SEQUENCE).filter((script) => !selectedScripts.includes(script)) : [];
const summary = {
	schemaVersion: 1,
	mode: smartMode ? "smart" : "dag",
	ok: false,
	runId,
	startedAt,
	finishedAt: undefined,
	maxConcurrency,
	cacheEnabled,
	dryRun,
	worktreeFingerprint: fingerprint.fingerprint,
	fingerprint,
	changedFiles: changed,
	changedFilesSource: changedFileOverrides.length ? "override" : smartMode ? "git" : "none",
	selectedScripts,
	selectedReasons,
	selectedNodes: nodes.map((node) => node.id),
	skippedScripts,
	cacheHits: hits,
	results: hits.map((hit) => ({ ...hit, ok: true, status: 0, cacheHit: true })),
	summaryPath: smartMode ? CHECK_IMPACT_SUMMARY_PATH : CHECK_DAG_SUMMARY_PATH,
};

ensureArtifactDir();
if (dryRun) {
	summary.ok = true;
	summary.finishedAt = new Date().toISOString();
	writeJsonFile(summary.summaryPath, summary);
	process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, summaryPath: summary.summaryPath, selectedNodes: summary.selectedNodes }, null, jsonMode ? 2 : 0)}\n`);
	process.exit(0);
}

const runResults = await runNodes(executable, { maxConcurrency });
summary.results.push(...runResults);
summary.ok = summary.results.every((result) => result.ok);
summary.finishedAt = new Date().toISOString();
writeJsonFile(summary.summaryPath, summary);

if (!summary.ok) {
	const firstFailure = summary.results.find((result) => !result.ok);
	const recorded = smartMode ? undefined : recordMissIfApplicable({ root: ROOT, fullRunId: runId, failingScript: firstFailure?.script || firstFailure?.nodeId, fullSummaryPath: summary.summaryPath });
	if (recorded) console.error(`[check-dag] miss recorded: ${recorded.path}`);
	process.exit(firstFailure?.status || 1);
}

writeCacheIndex(updateCache(runResults, nodesById, fingerprint.fingerprint, cacheIndex));
if (jsonMode) process.stdout.write(`${JSON.stringify({ ok: true, summaryPath: summary.summaryPath, selectedNodes: summary.selectedNodes, cacheHits: hits.length }, null, 2)}\n`);
console.log(`\n[check-dag] ok (${summary.results.length} node result(s), cache hits=${hits.length}, artifact=${summary.summaryPath})`);
