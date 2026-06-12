import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const runsDir = path.join(root, "agent-audits", "runs");
const indexPath = path.join(runsDir, "index.json");
const pkg = JSON.parse(read("package.json"));
const scripts = pkg.scripts || {};
const STATUS = new Set(["unverified", "accepted", "rejected", "duplicate", "fixed", "graduated"]);

function read(rel) {
	return readFileSync(path.join(root, rel), "utf8");
}

function reportFiles() {
	return readdirSync(runsDir)
		.filter((file) => file.endsWith(".md"))
		.map((file) => `agent-audits/runs/${file}`)
		.sort();
}

function loadIndex() {
	assert(existsSync(indexPath), "audit inbox index missing: create agent-audits/runs/index.json");
	const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
	assert.equal(parsed.schemaVersion, 1, "audit inbox index schemaVersion must be 1");
	assert(Array.isArray(parsed.reports), "audit inbox index must contain reports[]");
	return parsed;
}

function findingIdsFromReport(rel) {
	const text = read(rel);
	const ids = new Set();
	for (const match of text.matchAll(/^###\s+(AUDIT-[0-9]{3,})\b/gm)) ids.add(match[1]);
	for (const match of text.matchAll(/^\|\s*(AUDIT-[0-9]{3,})\s*\|/gm)) ids.add(match[1]);
	return [...ids].sort();
}

function isShallowRepository() {
	try {
		return execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() === "true";
	} catch {
		return false;
	}
}

function assertCommitExists(commit, context, options = {}) {
	try {
		execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root, stdio: "ignore" });
	} catch (error) {
		if (options.shallow ?? isShallowRepository()) {
			throw new Error(`${context}: evidenceCommit ${commit} is unavailable in shallow history; set actions/checkout fetch-depth: 0 for every CI job that runs the docs group/check:audit-inbox`);
		}
		throw new Error(`${context}: evidenceCommit ${commit} is not a local commit object`);
	}
}

function validateFinding(reportPath, finding, knownKeys) {
	const context = `${reportPath}#${finding.id || "missing-id"}`;
	assert(/^AUDIT-[0-9]{3,}$/.test(String(finding.id || "")), `${context}: finding id must use AUDIT-###`);
	assert(STATUS.has(finding.status), `${context}: invalid status ${finding.status}`);
	if (finding.verifiedByGate !== undefined) {
		assert(scripts[finding.verifiedByGate], `${context}: verifiedByGate must name an existing package script`);
	}
	if (finding.status === "fixed") {
		assert(finding.evidenceCommit, `${context}: fixed finding requires evidenceCommit`);
		assertCommitExists(finding.evidenceCommit, context);
	}
	if (finding.status === "graduated") {
		assert(finding.graduatedGate && scripts[finding.graduatedGate], `${context}: graduated finding requires graduatedGate naming an existing package script`);
	}
	if (finding.status === "rejected") {
		assert(typeof finding.reason === "string" && finding.reason.trim(), `${context}: rejected finding requires non-empty reason`);
	}
	if (finding.status === "duplicate") {
		assert(finding.duplicateOf && knownKeys.has(finding.duplicateOf), `${context}: duplicate finding requires duplicateOf pointing at a known finding key`);
	}
	if (finding.recurrenceOf !== undefined) {
		assert(knownKeys.has(finding.recurrenceOf), `${context}: recurrenceOf must point at a known finding key`);
		assert(["graduated", "rejected"].includes(finding.status), `${context}: recurrenceOf findings must be graduated or rejected`);
	}
}

function runSelfTestShallowDiagnostic() {
	let message = "";
	try {
		assertCommitExists("0000000000000000000000000000000000000000", "self-test", { shallow: true });
	} catch (error) {
		message = error.message;
	}
	assert(message.includes("fetch-depth: 0") && message.includes("check:audit-inbox"), "shallow-history diagnostic must name the CI checkout fix and audit gate");
	console.log("audit inbox shallow diagnostic self-test ok");
}

if (process.argv.includes("--self-test-shallow")) {
	runSelfTestShallowDiagnostic();
	process.exit(0);
}

const index = loadIndex();
const files = reportFiles();
const indexedPaths = index.reports.map((report) => report.path).sort();
assert.deepEqual(indexedPaths, files, `audit inbox index must register every run report:\nexpected ${files.join("\n")}\nactual ${indexedPaths.join("\n")}`);

const knownKeys = new Set();
for (const report of index.reports) {
	assert(files.includes(report.path), `audit inbox index references missing report: ${report.path}`);
	assert(Array.isArray(report.findings), `${report.path}: findings must be an array`);
	for (const finding of report.findings) knownKeys.add(`${report.path}#${finding.id}`);
}

for (const report of index.reports) {
	const idsInReport = findingIdsFromReport(report.path);
	const idsInIndex = report.findings.map((finding) => finding.id).sort();
	assert.deepEqual(idsInIndex, idsInReport, `${report.path}: index findings must match report finding IDs`);
	for (const finding of report.findings) validateFinding(report.path, finding, knownKeys);
}

const workflow = read(".github/workflows/check.yml");
assert(workflow.includes("npm run check:all:package") && workflow.includes("fetch-depth: 0"), "CI job that runs the docs/package group must checkout full history for audit evidence commits");
assert(read("agent-audits/templates/run-report.md").includes("Finding ID rule"), "audit run template must document stable finding ID rules");
assert(read("agent-audits/templates/finding.md").includes("Finding ID rule"), "single finding template must document stable finding ID rules");

console.log(`audit inbox contract ok — ${index.reports.length} report(s), ${knownKeys.size} finding(s)`);
