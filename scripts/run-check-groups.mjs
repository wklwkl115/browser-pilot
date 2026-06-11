import { spawnSync } from "node:child_process";
import {
	CHECK_GROUPS,
	CHECK_GROUPS_SUMMARY_PATH,
	DEFAULT_GROUP_SEQUENCE,
	packageScripts,
	recordMissIfApplicable,
	writeJsonFile,
} from "./check-graph.mjs";

const root = process.cwd();
const summaryPath = CHECK_GROUPS_SUMMARY_PATH;
const jsonMode = process.argv.includes("--json");
const groups = CHECK_GROUPS;
const defaultSequence = DEFAULT_GROUP_SEQUENCE;
const requested = process.argv.slice(2).filter((arg) => arg !== "--json");
const sequence = requested.length ? requested : defaultSequence;
const startedAt = new Date().toISOString();
const runId = startedAt.replace(/[:.]/g, "-");
const packageScriptMap = packageScripts(root);
const summary = { schemaVersion: 1, ok: false, runId, startedAt, finishedAt: undefined, sequence, results: [], summaryPath };

function flushSummary() {
	writeJsonFile(summaryPath, summary);
}

for (const name of sequence) {
	const groupScripts = groups[name];
	if (!groupScripts) {
		console.error(`Unknown check group: ${name}`);
		summary.finishedAt = new Date().toISOString();
		summary.error = `Unknown check group: ${name}`;
		flushSummary();
		process.exit(1);
	}
	for (const script of groupScripts) {
		console.log(`\n[check-all] npm run ${script}`);
		const scriptStartedAt = new Date().toISOString();
		const start = performance.now();
		const result = spawnSync("npm", ["run", script], { encoding: "utf8", stdio: jsonMode ? "pipe" : "inherit", shell: process.platform === "win32" });
		const item = {
			script,
			command: packageScriptMap[script],
			ok: (result.status ?? 1) === 0,
			status: result.status ?? 1,
			signal: result.signal ?? null,
			startedAt: scriptStartedAt,
			finishedAt: new Date().toISOString(),
			durationMs: Math.round(performance.now() - start),
			stdoutTail: String(result.stdout || "").slice(-4000),
			stderrTail: String(result.stderr || "").slice(-4000),
		};
		summary.results.push(item);
		if (jsonMode) {
			if (result.stdout) process.stdout.write(result.stdout);
			if (result.stderr) process.stderr.write(result.stderr);
		}
		if ((result.status ?? 1) !== 0) {
			summary.finishedAt = new Date().toISOString();
			summary.ok = false;
			flushSummary();
			const miss = recordMissIfApplicable({ root, fullRunId: runId, failingScript: script, fullSummaryPath: summaryPath });
			if (miss) console.error(`[check-all] smart/full miss recorded: ${miss.path}`);
			process.exit(result.status ?? 1);
		}
	}
}

summary.finishedAt = new Date().toISOString();
summary.ok = true;
flushSummary();
if (jsonMode) process.stdout.write(`${JSON.stringify({ ok: true, summaryPath, sequence })}\n`);
console.log("\n[check-all] ok");
