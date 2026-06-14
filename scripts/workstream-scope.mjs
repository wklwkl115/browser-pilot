import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_DIR, ROOT, writeJsonFile } from "./check-graph.mjs";
import { normalizeRel } from "./lib/repo-introspection.mjs";

export const WORKSTREAM_SCOPE_BASELINE_PATH = path.join(ARTIFACT_DIR, "workstream-scope-baseline.json");

function gitLines(args, root = ROOT) {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map(normalizeRel);
	} catch {
		return [];
	}
}

export function changedFiles(root = ROOT) {
	const tracked = gitLines(["diff", "--name-only", "HEAD"], root);
	const untracked = gitLines(["ls-files", "--others", "--exclude-standard"], root);
	return Array.from(new Set([...tracked, ...untracked]))
		.filter((file) => file && !file.startsWith(".pi/") && !file.includes("/node_modules/"))
		.sort();
}

export function parseCurrentActivation(text) {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const activeIndex = lines.findIndex((line) => line.trim() === "## 当前激活项");
	if (activeIndex < 0) return {};
	const firstEntry = lines.findIndex((line, index) => index > activeIndex && line.startsWith("### "));
	if (firstEntry < 0) return {};
	const end = lines.findIndex((line, index) => index > firstEntry && (line.startsWith("### ") || line.startsWith("## ")));
	const entryLines = lines.slice(firstEntry, end < 0 ? undefined : end);
	const scopeIndex = entryLines.findIndex((line) => /^Scope:\s*/i.test(line.trim()));
	if (scopeIndex < 0) return { title: entryLines[0]?.replace(/^###\s*/, "").trim(), declared: [] };
	const scopeParts = [entryLines[scopeIndex].trim().replace(/^Scope:\s*/i, "")];
	for (const line of entryLines.slice(scopeIndex + 1)) {
		const trimmed = line.trim();
		if (!trimmed) break;
		if (/^[A-Za-z][A-Za-z -]*:\s*/.test(trimmed)) break;
		scopeParts.push(trimmed);
	}
	const declared = scopeParts.join(" ")
		.split(",")
		.map((item) => normalizeRel(item.trim()
			.replace(/^and\s+/i, "")
			.replace(/[.;]$/, "")
			.trim()
			.replace(/^`|`$/g, "")))
		.filter(Boolean);
	return { title: entryLines[0]?.replace(/^###\s*/, "").trim(), declared };
}

export function matchesScope(file, pattern) {
	const rel = normalizeRel(file);
	const normalized = normalizeRel(pattern);
	if (normalized === rel) return true;
	if (normalized.endsWith("/**")) return rel.startsWith(normalized.slice(0, -3));
	if (normalized.endsWith("/")) return rel.startsWith(normalized);
	return false;
}

function readBaseline(pathname = WORKSTREAM_SCOPE_BASELINE_PATH) {
	if (!existsSync(pathname)) return undefined;
	try {
		return JSON.parse(readFileSync(pathname, "utf8"));
	} catch {
		return undefined;
	}
}

export function summarizeWorkstreamScope(root = ROOT, options = {}) {
	const currentPath = path.join(root, "CURRENT.md");
	if (!existsSync(currentPath)) return { declared: [], active: false, declaredRoot: "missing CURRENT.md" };
	const activation = parseCurrentActivation(readFileSync(currentPath, "utf8"));
	const declared = activation.declared || [];
	if (!declared.length) return { declared: [], active: false };
	const baseline = readBaseline(options.baselinePath);
	const currentChanged = changedFiles(root);
	const baselineDirtyFiles = Array.isArray(baseline?.baselineDirtyFiles) ? baseline.baselineDirtyFiles.map(normalizeRel).sort() : [];
	const baselineDirtySet = new Set(baselineDirtyFiles);
	const scopedChanged = currentChanged.filter((file) => !baselineDirtySet.has(file));
	const outOfScope = scopedChanged.filter((file) => !declared.some((pattern) => matchesScope(file, pattern)));
	return {
		active: true,
		title: activation.title,
		declared,
		outOfScope,
		changedFilesSource: "git",
		changedFiles: currentChanged,
		baselineStatus: baseline ? "artifact" : "implicit-head",
		baselineCommit: baseline?.baselineCommit,
		baselineDirtyFiles,
		declaredRoot: "CURRENT.md 当前激活项 Scope",
	};
}

export function writeScopeBaseline(root = ROOT, pathname = WORKSTREAM_SCOPE_BASELINE_PATH) {
	mkdirSync(path.dirname(pathname), { recursive: true });
	const payload = {
		schemaVersion: 1,
		baselineCommit: gitLines(["rev-parse", "HEAD"], root)[0],
		baselineDirtyFiles: changedFiles(root),
		recordedAt: new Date().toISOString(),
	};
	writeJsonFile(pathname, payload);
	return payload;
}

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--begin")) {
		const payload = writeScopeBaseline(ROOT);
		console.log(`workstream scope baseline written: ${WORKSTREAM_SCOPE_BASELINE_PATH} (${payload.baselineDirtyFiles.length} dirty file(s))`);
		return;
	}
	const summary = summarizeWorkstreamScope(ROOT);
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.stack || error.message);
		process.exit(1);
	});
}
