import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
function resolveReadPath(relOrAbs) {
	if (path.isAbsolute(relOrAbs)) return relOrAbs;
	const drivePath = /^([A-Za-z]):[\\/](.*)$/.exec(relOrAbs);
	if (drivePath) return process.platform === "win32" ? relOrAbs : path.join("/mnt", drivePath[1].toLowerCase(), drivePath[2].replace(/\\/g, "/"));
	return path.join(root, relOrAbs);
}
const read = (relOrAbs) => readFileSync(resolveReadPath(relOrAbs), "utf8");
const toolDir = path.join(root, "src", "tools");
function readTypeScriptSources(rel) {
	const dir = path.join(root, rel);
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) => {
			const child = path.join(rel, entry.name);
			if (entry.isDirectory()) return [readTypeScriptSources(child)];
			return entry.name.endsWith(".ts") ? [read(child)] : [];
		})
		.join("\n");
}
const toolSource = readTypeScriptSources("src/tools");
const registered = Array.from(new Set(Array.from(toolSource.matchAll(/name:\s*"(browser_[^"]+)"/g)).map((match) => match[1]))).sort();
assert(registered.length >= 15, "tool drift: expected registered browser tools");

const readme = read("README.md");
const sop = read("docs/browser-usage.md");
const boundaries = read("docs/tool-boundaries.md");
const generatedContract = read("docs/generated/browser-tool-contract.generated.md");
const skillPath = "skills/browser-pilot/SKILL.md";
assert(existsSync(resolveReadPath(skillPath)), "tool drift: browser-pilot skill must exist in repo");
const skill = read(skillPath);
const cliSkillPath = "skills/browser-pilot-cli/SKILL.md";
assert(existsSync(resolveReadPath(cliSkillPath)), "tool drift: browser-pilot-cli skill must exist in repo");
const cliSkill = read(cliSkillPath);

function cliSubcommand(toolName) {
	return toolName.replace(/^browser_/, "").replace(/_/g, "-");
}

function markdownTableFirstColumn(markdown, heading) {
	const start = markdown.indexOf(heading);
	assert(start >= 0, `skill table missing heading: ${heading}`);
	const rest = markdown.slice(start + heading.length);
	const nextHeading = rest.search(/\n##\s+/);
	const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
	return section.split(/\r?\n/)
		.filter((line) => line.trim().startsWith("|"))
		.filter((line) => !/^\|\s*-+/.test(line.trim()))
		.slice(1)
		.map((line) => line.split("|")[1]?.trim())
		.filter(Boolean);
}

assert(readme.includes("docs/browser-usage.md"), "README must link install and usage guide");
assert(readme.includes("skills/browser-pilot/SKILL.md"), "README must link in-repo Pi skill");
assert(readme.includes("docs/tool-boundaries.md"), "README must link tool boundary matrix");
assert(skill.includes("docs/tool-boundaries.md"), "skill must link tool boundary matrix");
assert(boundaries.includes("## Primary workflow") && boundaries.includes("## Runtime browser tools") && boundaries.includes("## Scoped Web follow-up tools"), "tool boundaries doc must define workflow and tool groups");
for (const token of ["Semantic", "Use when", "Do not use when", "Primary inputs", "Primary output/evidence", "Follow-up", "browser_http_replay as the primitive"]) {
	assert(boundaries.includes(token), `tool boundaries doc missing boundary token: ${token}`);
}
function boundaryRowsForTool(tool) {
	const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return boundaries.match(new RegExp(`^\\|\\s*\\\`${escaped}\\\`\\s*\\|.*$`, "gm")) || [];
}
for (const tool of registered) {
	assert(readme.includes(tool), `tool drift: README missing ${tool}`);
	assert(skill.includes(tool), `tool drift: skill missing ${tool}`);
	assert(cliSkill.includes(cliSubcommand(tool)), `tool drift: CLI skill missing ${cliSubcommand(tool)} for ${tool}`);
	assert.equal(boundaryRowsForTool(tool).length, 1, `tool drift: docs/tool-boundaries.md must contain exactly one table row for ${tool}`);
}

for (const token of ["PI_BROWSER_BRIDGE_PORT", "bridge/pi_browser_bridge", "/browser-install", "/browser-status", "/browser-reload", "npm run check", "npm run smoke:browser"]) {
	assert(sop.includes(token), `SOP missing install/env token: ${token}`);
}
for (const forbidden of ["npm run check", "npm run smoke:browser", "npm install", "chrome://extensions", "edge://extensions"]) {
	assert(!skill.includes(forbidden), `skill must not contain project install/test content: ${forbidden}`);
}
for (const removed of ["browser_query", "browser_click", "browser_type", "browser_dom_snapshot", "browser_dom_click", "browser_dom_type", "browser_orchestrate"]) {
	assert(!boundaries.includes(removed), `tool boundaries must not document removed tool: ${removed}`);
	assert(!skill.includes(removed), `Pi skill must not document removed tool: ${removed}`);
	assert(!cliSkill.includes(removed), `CLI skill must not document removed tool: ${removed}`);
}
for (const removed of ["browser_recon_probe", "browser_fuzz_paths", "browser_fuzz_vhosts", "browser_fuzz_params", "browser_sqli_probe", "browser_sqlmap_bridge", "browser_nuclei_bridge", "browser_template_check"]) {
	assert(!skill.includes(removed), `Pi skill must not document removed/merged WebSecurity tool: ${removed}`);
	assert(!cliSkill.includes(removed), `CLI skill must not document removed/merged WebSecurity tool: ${removed}`);
}
assert.deepEqual(markdownTableFirstColumn(cliSkill, "## Routes (intent → subcommand)"), markdownTableFirstColumn(skill, "## Routes (intent → tool)"), "Pi and CLI skills must keep the same Routes intent rows");
assert.deepEqual(markdownTableFirstColumn(cliSkill, "## Observe products (scan envelope)"), markdownTableFirstColumn(skill, "## Observe products (scan envelope)"), "Pi and CLI skills must keep the same Observe-products rows");
assert(generatedContract.includes("| `REF_STALE` | abml | abml.ref | yes | schema |"), "generated contract must classify ABML ref errors as abml, not unknown");
assert(generatedContract.includes("| `WEBSOCKET_WAIT_TIMEOUT` | websocket | bridge.ws | yes | schema |"), "generated contract must classify WebSocket errors as websocket, not unknown");
assert(!generatedContract.includes("`content.fingerprint`"), "generated contract must not publish internal native commands");
const migration = read("docs/browser-usage.md");
assert(migration.includes("## Install") && migration.includes("## Load The Extension") && migration.includes("## Troubleshooting"), "docs/browser-usage.md must own public install and troubleshooting guidance");
console.log("tool doc drift contract ok");
