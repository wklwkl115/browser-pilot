import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const archiveDir = path.join(root, "docs", "archive");
const playbooksDir = path.join(root, "docs", "playbooks");
const referenceDir = path.join(root, "docs", "reference");

const current = read("CURRENT.md");
const roadmap = read("ROADMAP.md");
const todo = read("TODO.md");
const archive = read("ARCHIVE.md");
const structure = read("docs/document-structure.md");

assert(structure.includes("## Canonical layers") && structure.includes("CURRENT.md") && structure.includes("ARCHIVE.md"), "document-structure.md must define canonical layers");
assert(structure.includes("docs/playbooks/*.md") && structure.includes("docs/reference/*.md"), "document-structure.md must define playbook/reference layers");
assert(current.includes("docs/document-structure.md"), "CURRENT.md must link document structure rules");
assert(todo.includes("docs/document-structure.md"), "TODO.md must link document structure rules");
assert(archive.includes("docs/archive/bridge-esm-history.md") && archive.includes("docs/archive/bridge-esm-history.full.md"), "ARCHIVE.md must link both summary and full archive entries");
assert(roadmap.includes("*.full.md") || roadmap.includes("bridge-esm-history.full.md"), "ROADMAP.md must mention detailed archive files");

const archiveFiles = readdirSync(archiveDir).filter((file) => file.endsWith(".md")).sort();
const summaryFiles = archiveFiles.filter((file) => !file.endsWith(".full.md"));
const fullFiles = archiveFiles.filter((file) => file.endsWith(".full.md"));
assert(summaryFiles.length >= 3, "docs/archive must contain summary archive docs");
assert(fullFiles.length >= 3, "docs/archive must contain full archive docs");
for (const summary of summaryFiles) {
	const base = summary.replace(/\.md$/, "");
	const full = `${base}.full.md`;
	assert(fullFiles.includes(full), `archive summary/full pair missing: ${summary} -> ${full}`);
	assert(archive.includes(`docs/archive/${summary}`), `ARCHIVE.md must link summary archive: ${summary}`);
	assert(archive.includes(`docs/archive/${full}`), `ARCHIVE.md must link detailed archive: ${full}`);
}

assert(existsSync(path.join(root, "docs/archive-history-compression-plan.md")), "missing archive doc: docs/archive-history-compression-plan.md");

const requiredPlaybooks = [
	"README.md",
	"first-pass-browser-triage.md",
	"recon-and-discovery.md",
	"request-capture-and-replay.md",
	"sqli-verification.md",
	"auth-session-jwt.md",
	"ssrf-oast.md",
	"evidence-and-reporting.md",
];
for (const file of requiredPlaybooks) {
	assert(existsSync(path.join(playbooksDir, file)), `missing browser security playbook: docs/playbooks/${file}`);
}
assert(existsSync(path.join(referenceDir, "web-security-methodology-map.md")), "missing methodology reference: docs/reference/web-security-methodology-map.md");
const playbookIndex = read("docs/playbooks/README.md");
for (const file of requiredPlaybooks.filter((file) => file !== "README.md")) {
	assert(playbookIndex.includes(`docs/playbooks/${file}`), `playbook index must link docs/playbooks/${file}`);
}

assert(!current.includes("## 180.") && !current.includes("## 216.") && !current.includes("## 203."), "CURRENT.md must not expand into detailed historical TODO logs again");
assert(!archive.includes("## 180.") && !archive.includes("## 216.") && !archive.includes("## 203."), "ARCHIVE.md must not keep detailed 180-240 execution logs after migration to full archive docs");
assert(archive.split(/\r?\n/).length <= 120, "ARCHIVE.md must stay summary-first and compact");
assert(todo.split(/\r?\n/).length <= 30, "TODO.md must remain a navigation page");
assert(roadmap.split(/\r?\n/).length <= 80, "ROADMAP.md must stay compact and future-facing");

console.log("doc structure contract ok");
