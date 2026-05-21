import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function resolveReadPath(relOrAbs) {
	if (path.isAbsolute(relOrAbs)) return relOrAbs;
	const drivePath = /^([A-Za-z]):[\\/](.*)$/.exec(relOrAbs);
	if (drivePath) return process.platform === "win32" ? relOrAbs : path.join("/mnt", drivePath[1].toLowerCase(), drivePath[2].replace(/\\/g, "/"));
	return path.join(root, relOrAbs);
}
const read = (relOrAbs) => readFileSync(resolveReadPath(relOrAbs), "utf8");
const toolDir = path.join(root, "src", "tools");
const toolSource = readdirSync(toolDir).filter((file) => file.endsWith(".ts")).map((file) => read(path.join(toolDir, file))).join("\n");
const registered = Array.from(new Set(Array.from(toolSource.matchAll(/name:\s*"(browser_[^"]+)"/g)).map((match) => match[1]))).sort();
assert(registered.length >= 15, "tool drift: expected registered browser tools");

const readme = read("README.md");
const sop = read("AI_INSTALL.md");
const skillPath = "D:/Pi/agent/skills/pi-browser-tools/SKILL.md";
assert(existsSync(resolveReadPath(skillPath)), "tool drift: global pi-browser-tools skill must exist");
const skill = read(skillPath);

assert(readme.includes("AI_INSTALL.md"), "README must link install SOP");
assert(readme.includes("D:/Pi/agent/skills/pi-browser-tools/SKILL.md"), "README must link global Pi skill");
for (const tool of registered) {
	assert(readme.includes(tool), `tool drift: README missing ${tool}`);
	assert(skill.includes(tool), `tool drift: skill missing ${tool}`);
}

for (const token of ["PI_BROWSER_BRIDGE_PORT", "bridge/pi_browser_bridge", "/browser-install", "/browser-status", "/browser-reload", "npm run check", "npm run smoke:browser"]) {
	assert(sop.includes(token), `SOP missing install/env token: ${token}`);
}
for (const forbidden of ["npm run check", "npm run smoke:browser", "npm install", "chrome://extensions", "edge://extensions"]) {
	assert(!skill.includes(forbidden), `skill must not contain project install/test content: ${forbidden}`);
}
const migration = read("docs/browser-usage.md");
assert(migration.includes("迁移指引") && migration.includes("AI_INSTALL.md") && migration.includes("SKILL.md"), "docs/browser-usage.md must only be a migration pointer");
console.log("tool doc drift contract ok");
