import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPEC_CLAIMS } from "./spec-claims.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const archiveDir = path.join(root, "docs", "archive");
const playbooksDir = path.join(root, "docs", "playbooks");
const referenceDir = path.join(root, "docs", "reference");
const auditsDir = path.join(root, "agent-audits");

const current = read("CURRENT.md");
const roadmap = read("ROADMAP.md");
const todo = read("TODO.md");
const archive = read("ARCHIVE.md");
const structure = read("docs/document-structure.md");
const agentNativeArchitecture = read("docs/agent-native-architecture.md");
const agentNativeCliSpec = read("docs/agent-native-cli-spec.md");
const agentDevelopment = read("docs/agent-development.md");
const buildBridge = read("scripts/build-bridge.mjs");

assert(structure.includes("## Canonical layers") && structure.includes("CURRENT.md") && structure.includes("ARCHIVE.md"), "document-structure.md must define canonical layers");
assert(structure.includes("docs/playbooks/*.md") && structure.includes("docs/reference/*.md"), "document-structure.md must define playbook/reference layers");
assert(structure.includes("agent-audits/") && structure.includes("agent-audits/runs/YYYY-MM-DD-<scope>.md"), "document-structure.md must define the agent audit inbox layer");
assert(structure.includes("Doc-class: contract") && structure.includes("tests/contracts/drift/spec-claims.js"), "document-structure.md must define contract-doc registration");
for (const entry of SPEC_CLAIMS) {
	assert(read(entry.doc).includes("> Doc-class: contract"), `${entry.doc} must carry the contract-doc header`);
}
assert(current.includes("docs/document-structure.md"), "CURRENT.md must link document structure rules");
assert(current.includes("agent-audits/") && current.includes("审计 agent 只写报告") && current.includes("skills/browser-pilot-audit-fix/SKILL.md"), "CURRENT.md must describe the asynchronous audit/fix inbox workflow");
assert(todo.includes("docs/document-structure.md"), "TODO.md must link document structure rules");
assert(todo.includes("Agent 审计收件箱：`agent-audits/`"), "TODO.md must link the agent audit inbox");
assert(existsSync(path.join(root, "docs", "agent-development.md")), "missing dev-harness handbook: docs/agent-development.md");
for (const heading of ["## Dev Loop", "## Writing A Check", "## Contract Test Conventions", "## Ledgers And Ratchets", "## Closing A Workstream", "## Multi-Agent Parallel Work", "## Change-path Playbooks"]) {
	assert(agentDevelopment.includes(heading), `docs/agent-development.md missing required heading: ${heading}`);
}
for (const required of ["check:smart --", "query:markers", "npm run new:check", "NON_PARALLEL_NODE_IDS", "red-first", "docs:sync", "check:doc-paths", "Narrow gates are iteration evidence, not closure evidence", "Capture the gate exit code before piping"]) {
	assert(agentDevelopment.includes(required), `docs/agent-development.md missing required dev-harness guidance: ${required}`);
}
assert(buildBridge.includes("// contract: tests/contracts/drift/check-package-files.mjs"), "fragile source-text pins must have a source-site contract breadcrumb");
assert(archive.includes("docs/archive/bridge-esm-history.md") && archive.includes("docs/archive/bridge-esm-history.full.md"), "ARCHIVE.md must link both summary and full archive entries");
assert(roadmap.includes("*.full.md") || roadmap.includes("bridge-esm-history.full.md"), "ROADMAP.md must mention detailed archive files");
assert(existsSync(path.join(auditsDir, "README.md")), "missing audit inbox README: agent-audits/README.md");
assert(existsSync(path.join(auditsDir, "AGENTS.md")), "missing audit inbox local agent rules: agent-audits/AGENTS.md");
assert(existsSync(path.join(auditsDir, "templates", "run-report.md")), "missing audit run template");
assert(existsSync(path.join(auditsDir, "templates", "finding.md")), "missing audit finding template");
assert(existsSync(path.join(auditsDir, "runs")), "missing audit runs directory");
assert(existsSync(path.join(auditsDir, "runs", "index.json")), "missing audit findings lifecycle index: agent-audits/runs/index.json");
assert(existsSync(path.join(root, "skills", "browser-pilot-audit-fix", "SKILL.md")), "missing audit/fix skill");
const auditReadme = read("agent-audits/README.md");
const auditAgents = read("agent-audits/AGENTS.md");
const auditFixSkill = read("skills/browser-pilot-audit-fix/SKILL.md");
assert(auditReadme.includes("audit-only") && auditReadme.includes("must not edit project source"), "audit README must state audit-only/no-code-change rules");
assert(auditAgents.includes("Audit-Only Rule") && auditAgents.includes("You may write only audit reports under `agent-audits/runs/`"), "audit AGENTS.md must constrain audit agents to reports only");
assert(auditFixSkill.includes("Audit Agent Mode") && auditFixSkill.includes("Fix Agent Mode") && auditFixSkill.includes("Do not spawn or manage subagents"), "audit/fix skill must define async audit/fix roles and forbid subagent orchestration");

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
assert(current.split(/\r?\n/).length <= 180, "CURRENT.md must stay compact (<=180 lines); move completed workstream details to docs/archive/*.full.md");
assert(archive.split(/\r?\n/).length <= 120, "ARCHIVE.md must stay summary-first and compact");
assert(todo.split(/\r?\n/).length <= 30, "TODO.md must remain a navigation page");
assert(roadmap.split(/\r?\n/).length <= 80, "ROADMAP.md must stay compact and future-facing");

const closedAgentNativeForbidden = [
	"ACTIVE execution contract",
	"Workstream A — agent line (ACTIVATED)",
	"Durable fix — ACTIVE",
	"external-face task queue",
];
for (const phrase of closedAgentNativeForbidden) {
	assert(!agentNativeArchitecture.includes(phrase), `docs/agent-native-architecture.md is a completed/current-reference contract and must not advertise active execution: ${phrase}`);
}
assert(!agentNativeCliSpec.includes("Draft execution contract"), "docs/agent-native-cli-spec.md is the shipped CLI contract, not a draft execution contract");

// AGENTS.md is inlined into CLAUDE.md because Claude Code does not auto-read AGENTS.md.
// Guard the two copies against silent drift: every AGENTS.md `## section` must appear under
// CLAUDE.md's inlined block as a `### section` with verbatim body.
function parseSections(text, prefix) {
	const sections = {};
	let name = null;
	let buf = [];
	for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
		if (line.startsWith(prefix) && !line.startsWith(`${prefix}#`)) {
			if (name !== null) sections[name] = buf.join("\n").trim();
			name = line.slice(prefix.length).trim();
			buf = [];
		} else if (/^<!-- (BEGIN|END) GENERATED: /.test(line.trim())) {
			continue;
		} else if (name !== null) {
			buf.push(line);
		}
	}
	if (name !== null) sections[name] = buf.join("\n").trim();
	return sections;
}

const claudeMd = read("CLAUDE.md");
const agentsMd = read("AGENTS.md");
const inlineMarker = "## Design, Governance & Workflow Rules (inlined from AGENTS.md)";
assert(agentsMd.includes("`AGENTS.md` is the single editing surface") && agentsMd.includes("regenerate the `CLAUDE.md` inlined block"), "AGENTS.md must tell agents to edit AGENTS.md and regenerate CLAUDE.md via docs:sync");
assert(claudeMd.includes("edit `AGENTS.md` and run `npm run docs:sync`"), "CLAUDE.md must point back to AGENTS.md as the generated governance source");
const inlineIdx = claudeMd.indexOf(inlineMarker);
assert(inlineIdx !== -1, "CLAUDE.md must inline AGENTS.md under a 'Design, Governance & Workflow Rules (inlined from AGENTS.md)' section");
const agentsSections = parseSections(agentsMd, "## ");
const inlinedSections = parseSections(claudeMd.slice(inlineIdx), "### ");
assert(Object.keys(agentsSections).length >= 9, "AGENTS.md must define its governance sections (Scope..Sync & Verification)");
const KEPT_SECTIONS = ["Code Search", "Change Workflow", "Sync & Verification"];
assert(
	Object.keys(inlinedSections).length === KEPT_SECTIONS.length,
	`CLAUDE.md must inline exactly ${KEPT_SECTIONS.length} AGENTS.md sections (${KEPT_SECTIONS.join(", ")}), got ${Object.keys(inlinedSections).length} — re-sync via npm run docs:sync`,
);
for (const name of KEPT_SECTIONS) {
	assert(name in inlinedSections, `CLAUDE.md must inline AGENTS.md section "### ${name}"`);
	assert(name in agentsSections, `AGENTS.md must define section "## ${name}"`);
	assert(inlinedSections[name] === agentsSections[name], `CLAUDE.md inlined "${name}" drifted from AGENTS.md — re-sync via npm run docs:sync`);
}
assert(claudeMd.includes("Full design principles, tool constitution, and architecture rules: see `AGENTS.md`"), "CLAUDE.md must include a reference line pointing to AGENTS.md for full rules");

console.log("doc structure contract ok");
