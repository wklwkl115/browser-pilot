import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedGroups = new Set(["src", "bridge", "unit", "package", "docs", "contracts"]);

function usage() {
	console.error("Usage: npm run new:check -- --name <x> --group <src|bridge|unit|package|docs|contracts> [--dir tests/contracts/drift] [--dry-run] [--force]");
	process.exit(2);
}

function argValue(name) {
	const prefix = `${name}=`;
	const inline = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
	if (inline) return inline.slice(prefix.length);
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalizeName(raw) {
	const name = String(raw || "").trim().replace(/^check:/, "").replace(/^check-/, "");
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid check name: ${raw}`);
	return name;
}

function gitDirty(paths) {
	const output = execFileSync("git", ["status", "--short", "--", ...paths], { cwd: root, encoding: "utf8" });
	return output.split(/\r?\n/).filter(Boolean);
}

function insertIntoCheckGroup(source, group, scriptName) {
	const pattern = new RegExp(`(${group}: \\[)([^\\]]*)(\\])`);
	const match = source.match(pattern);
	if (!match) throw new Error(`CHECK_GROUPS.${group} not found in scripts/check-graph.mjs`);
	const current = match[2].trim();
	if (current.includes(`"${scriptName}"`)) return source;
	const replacement = `${match[1]}${current ? `${current}, ` : ""}"${scriptName}"${match[3]}`;
	return source.replace(pattern, replacement);
}

function checkTemplate(scriptName, targetRel) {
	return `import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// red-first: verify this contract fails against unmodified code before landing.
// Remediation messages must name the file or command that fixes the failure.
assert(existsSync(path.join(root, "${targetRel.replace(/\\/g, "/")}")), "${scriptName} scaffold must point at its committed contract file");

console.log("${scriptName} scaffold ok");
`;
}

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const name = normalizeName(argValue("--name"));
const group = argValue("--group");
if (!allowedGroups.has(group)) usage();
const scriptName = `check:${name}`;
const dir = argValue("--dir") || "tests/contracts/drift";
const targetRel = path.posix.join(dir.replace(/\\/g, "/"), `check-${name}.mjs`);
const packagePath = path.join(root, "package.json");
const graphPath = path.join(root, "scripts", "check-graph.mjs");
const targetPath = path.join(root, targetRel);

const planned = [
	{ file: "package.json", action: `add ${scriptName}` },
	{ file: "scripts/check-graph.mjs", action: `add ${scriptName} to CHECK_GROUPS.${group}` },
	{ file: targetRel, action: "create contract scaffold" },
];

if (dryRun) {
	process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, planned }, null, 2)}\n`);
	process.exit(0);
}

if (!force) {
	const dirty = gitDirty(["package.json", "scripts/check-graph.mjs", targetRel]);
	if (dirty.length) {
		console.error(`new:check refused because target files are dirty. Re-run with --force after reviewing:\n${dirty.join("\n")}`);
		process.exit(1);
	}
}
if (existsSync(targetPath)) throw new Error(`target contract already exists: ${targetRel}`);

const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
if (pkg.scripts?.[scriptName]) throw new Error(`package script already exists: ${scriptName}`);
pkg.scripts[scriptName] = `node ${targetRel}`;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

const graph = readFileSync(graphPath, "utf8");
writeFileSync(graphPath, insertIntoCheckGroup(graph, group, scriptName), "utf8");

mkdirSync(path.dirname(targetPath), { recursive: true });
writeFileSync(targetPath, checkTemplate(scriptName, targetRel), "utf8");

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
execFileSync(npmCommand, ["run", "check:check-graph"], { cwd: root, stdio: "inherit" });
console.log(`new check scaffolded: ${scriptName} -> ${targetRel}`);
