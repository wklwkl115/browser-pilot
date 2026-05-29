import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const artifactDir = path.join(root, ".pi", "browser-artifacts");
const summaryPath = path.join(artifactDir, "check-groups-summary.json");
const jsonMode = process.argv.includes("--json");

const groups = {
	src: ["check:src:types", "check:registry-drift"],
	bridge: ["check:bridge"],
	unit: ["test:unit"],
	package: ["check:package", "check:deps", "check:pi-browser-bridge"],
	docs: ["check:tool-docs", "check:doc-structure", "check:boundaries"],
	contracts: ["check:jshookmcp-closure", "check:scan", "check:content-pick", "check:transfer", "check:web-security", "check:page-scripts", "check:fake-ws", "check:lifecycle", "check:runtime-fixtures", "check:smoke-diagnostics", "check:paths", "check:token", "check:summaries", "check:artifact", "check:errors", "check:eval-workflows", "check:browser-workflow-results", "check:browser-commands"],
};

const defaultSequence = ["src", "bridge", "unit", "package", "docs", "contracts"];
const requested = process.argv.slice(2).filter((arg) => arg !== "--json");
const sequence = requested.length ? requested : defaultSequence;
const startedAt = new Date().toISOString();
const summary = { ok: false, startedAt, finishedAt: undefined, sequence, results: [] };

function flushSummary() {
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

for (const name of sequence) {
	const scripts = groups[name];
	if (!scripts) {
		console.error(`Unknown check group: ${name}`);
		summary.finishedAt = new Date().toISOString();
		summary.error = `Unknown check group: ${name}`;
		flushSummary();
		process.exit(1);
	}
	for (const script of scripts) {
		console.log(`\n[check-all] npm run ${script}`);
		const result = spawnSync("npm", ["run", script], { encoding: "utf8", stdio: jsonMode ? "pipe" : "inherit", shell: process.platform === "win32" });
		summary.results.push({ script, ok: (result.status ?? 1) === 0, status: result.status ?? 1, signal: result.signal ?? null, stdoutTail: String(result.stdout || "").slice(-4000), stderrTail: String(result.stderr || "").slice(-4000) });
		if (jsonMode) {
			if (result.stdout) process.stdout.write(result.stdout);
			if (result.stderr) process.stderr.write(result.stderr);
		}
		if ((result.status ?? 1) !== 0) {
			summary.finishedAt = new Date().toISOString();
			summary.ok = false;
			flushSummary();
			process.exit(result.status ?? 1);
		}
	}
}

summary.finishedAt = new Date().toISOString();
summary.ok = true;
flushSummary();
if (jsonMode) process.stdout.write(`${JSON.stringify({ ok: true, summaryPath, sequence })}\n`);
console.log("\n[check-all] ok");
