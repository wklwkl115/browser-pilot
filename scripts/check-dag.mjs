import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	ARTIFACT_DIR,
	CHECK_CACHE_INDEX_PATH,
	CHECK_CACHE_SCHEMA_VERSION,
	CHECK_DAG_SUMMARY_PATH,
	CHECK_DAG_RUN_DIR,
	CHECK_GROUPS,
	CHECK_IMPACT_SUMMARY_PATH,
	DAG_EXTRA_NODE_IDS,
	DEFAULT_GROUP_SEQUENCE,
	ROOT,
	collectFingerprintFiles,
	computeCoarseFingerprint,
	computeNodeCacheFingerprint,
	ensureArtifactDir,
	groupScriptSequence,
	packageScripts,
	recordMissIfApplicable,
	readImpactMap,
	resolveScriptSteps,
	selectSmartScripts,
	writeJsonFile,
} from "./check-graph.mjs";

const args = process.argv.slice(2);
const cacheEnabled = args.includes("--cache");
const smartMode = args.includes("--smart");
const jsonMode = args.includes("--json");
const dryRun = args.includes("--dry-run");
const selfTestMissRecorder = args.includes("--self-test-miss-recorder");
const selfTestBadNodeExit = args.includes("--self-test-bad-node-exit");
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
	if (!existsSync(CHECK_CACHE_INDEX_PATH)) return { schemaVersion: CHECK_CACHE_SCHEMA_VERSION, records: {} };
	try {
		const parsed = JSON.parse(readFileSync(CHECK_CACHE_INDEX_PATH, "utf8"));
		return parsed && typeof parsed === "object" && parsed.schemaVersion === CHECK_CACHE_SCHEMA_VERSION && parsed.records ? parsed : { schemaVersion: CHECK_CACHE_SCHEMA_VERSION, records: {} };
	} catch {
		return { schemaVersion: CHECK_CACHE_SCHEMA_VERSION, records: {} };
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

function buildNodes(scriptIds) {
	const scripts = packageScripts();
	const out = [];
	const seen = new Set();
	for (const scriptId of scriptIds) {
		for (const step of resolveScriptSteps(scriptId, { scripts })) {
			if (seen.has(step.id)) continue;
			seen.add(step.id);
			out.push({ ...step, impactScript: scriptId });
		}
	}
	return out;
}

function pruneDagRunArtifacts(activePath) {
	if (!existsSync(CHECK_DAG_RUN_DIR)) return;
	const files = readdirSync(CHECK_DAG_RUN_DIR, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => path.join(CHECK_DAG_RUN_DIR, entry.name))
		.sort();
	const keep = new Set(files.slice(-20));
	if (activePath) keep.add(activePath);
	for (const file of files) {
		if (!keep.has(file)) unlinkSync(file);
	}
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
	return `${CHECK_CACHE_SCHEMA_VERSION}\0${fingerprint.fingerprint}\0${node.id}\0${node.commandLine}`;
}

function applyCache(nodes, fingerprints, cacheIndex) {
	const executable = [];
	const hits = [];
	for (const node of nodes) {
		const fingerprint = fingerprints.get(node.id);
		const record = fingerprint ? cacheIndex.records[cacheKey(node, fingerprint)] : undefined;
		if (cacheEnabled && node.cacheable !== false && record?.status === "passed") {
			hits.push({
				nodeId: node.id,
				script: node.script,
				durationMs: 0,
				hitReason: record.hitReason || fingerprint?.reason || "same scoped cache fingerprint and same node command",
				cacheScope: record.scope || fingerprint?.cacheScope,
				impactScript: record.impactScript || fingerprint?.impactScript,
				fingerprint: fingerprint?.fingerprint,
			});
		} else {
			executable.push(node);
		}
	}
	return { executable, hits };
}

function updateCache(results, nodesById, fingerprints, cacheIndex) {
	cacheIndex.schemaVersion = CHECK_CACHE_SCHEMA_VERSION;
	for (const result of results) {
		const node = nodesById.get(result.nodeId);
		const fingerprint = fingerprints.get(result.nodeId);
		if (!node || !result.ok || node.cacheable === false) continue;
		if (!fingerprint) continue;
		cacheIndex.records[cacheKey(node, fingerprint)] = {
			schemaVersion: CHECK_CACHE_SCHEMA_VERSION,
			nodeId: node.id,
			fingerprint: fingerprint.fingerprint,
			scope: fingerprint.cacheScope,
			impactScript: fingerprint.impactScript,
			inputCount: fingerprint.inputCount,
			fileCount: fingerprint.fileCount,
			untrackedCount: fingerprint.untrackedCount,
			command: node.commandLine,
			status: "passed",
			durationMs: result.durationMs,
			recordedAt: new Date().toISOString(),
			hitReason: `${fingerprint.reason}; same node command`,
		};
	}
	return cacheIndex;
}

if (selfTestBadNodeExit) {
	const [result] = await runNodes([{
		id: "synthetic:bad-node",
		script: "synthetic:bad-node",
		command: process.execPath,
		args: ["-e", "process.exit(7)"],
		commandLine: "node -e process.exit(7)",
		parallelSafe: true,
		cacheable: false,
	}], { maxConcurrency: 1 });
	if (!result || result.status !== 7) {
		console.error(`[check-dag] synthetic bad-node self-test failed: ${JSON.stringify(result)}`);
		process.exit(1);
	}
	if (jsonMode) process.stdout.write(`${JSON.stringify({ ok: false, nodeId: result.nodeId, status: result.status }, null, 2)}\n`);
	process.exit(result.status);
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
const impactMapForCache = readImpactMap(ROOT);
const allCacheFileEntries = collectFingerprintFiles(ROOT);
const nodeFingerprints = new Map(nodes.map((node) => [node.id, computeNodeCacheFingerprint(node, {
	root: ROOT,
	impactMap: impactMapForCache,
	allFileEntries: allCacheFileEntries,
	coarseFingerprint: fingerprint,
})]));
const { executable, hits } = applyCache(nodes, nodeFingerprints, cacheIndex);
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
	requestedGroups: smartMode ? [] : (requestedGroups.length ? requestedGroups : [...DEFAULT_GROUP_SEQUENCE]),
	selectedScripts,
	selectedReasons,
	selectedNodes: nodes.map((node) => node.id),
	skippedScripts,
	cacheHits: hits,
	cacheScopes: Object.fromEntries(nodes.map((node) => {
		const item = nodeFingerprints.get(node.id);
		return [node.id, item ? {
			schemaVersion: item.schemaVersion,
			cacheScope: item.cacheScope,
			impactScript: item.impactScript,
			reason: item.reason,
			fingerprint: item.fingerprint,
			inputCount: item.inputCount,
			fileCount: item.fileCount,
			untrackedCount: item.untrackedCount,
		} : undefined];
	})),
	results: hits.map((hit) => ({ ...hit, ok: true, status: 0, cacheHit: true })),
	summaryPath: smartMode ? CHECK_IMPACT_SUMMARY_PATH : CHECK_DAG_SUMMARY_PATH,
	perRunSummaryPath: smartMode ? undefined : path.join(CHECK_DAG_RUN_DIR, `${runId}.json`),
	scope: { active: false, declared: [], declaredRoot: "public release tree" },
};

function writeSummary() {
	writeJsonFile(summary.summaryPath, summary);
	if (summary.perRunSummaryPath) {
		writeJsonFile(summary.perRunSummaryPath, summary);
		pruneDagRunArtifacts(summary.perRunSummaryPath);
	}
}

ensureArtifactDir();
if (dryRun) {
	summary.ok = true;
	summary.finishedAt = new Date().toISOString();
	writeSummary();
	process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, summaryPath: summary.summaryPath, selectedNodes: summary.selectedNodes }, null, jsonMode ? 2 : 0)}\n`);
	process.exit(0);
}

const runResults = await runNodes(executable, { maxConcurrency });
summary.results.push(...runResults);
summary.ok = summary.results.every((result) => result.ok);
summary.finishedAt = new Date().toISOString();
writeSummary();

if (!summary.ok) {
	const firstFailure = summary.results.find((result) => !result.ok);
	const recorded = smartMode ? undefined : recordMissIfApplicable({ root: ROOT, fullRunId: runId, failingScript: firstFailure?.script || firstFailure?.nodeId, fullSummaryPath: summary.summaryPath });
	if (recorded) console.error(`[check-dag] miss recorded: ${recorded.path}`);
	process.exit(firstFailure?.status || 1);
}

writeCacheIndex(updateCache(runResults, nodesById, nodeFingerprints, cacheIndex));
if (jsonMode) process.stdout.write(`${JSON.stringify({ ok: true, summaryPath: summary.summaryPath, selectedNodes: summary.selectedNodes, cacheHits: hits.length }, null, 2)}\n`);
console.log(`\n[check-dag] ok (${summary.results.length} node result(s), cache hits=${hits.length}, artifact=${summary.summaryPath})`);
