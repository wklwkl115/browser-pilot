import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

function runNode(args) {
	execFileSync(process.execPath, args, { cwd: root, stdio: "inherit" });
}

const tasks = checkOnly
	? [
		["scripts/sync-doc-indexes.mjs", "--check"],
		["scripts/generate-tool-docs.mjs", "--check"],
		["node_modules/tsx/dist/cli.mjs", "scripts/sync-code-map.mjs", "--check"],
		["node_modules/tsx/dist/cli.mjs", "scripts/sync-concept-ownership.mjs", "--check"],
		["scripts/sync-managed-blocks.mjs", "--check"],
	]
	: [
		["scripts/sync-doc-indexes.mjs"],
		["scripts/generate-tool-docs.mjs"],
		["node_modules/tsx/dist/cli.mjs", "scripts/sync-code-map.mjs"],
		["node_modules/tsx/dist/cli.mjs", "scripts/sync-concept-ownership.mjs"],
		["scripts/sync-managed-blocks.mjs"],
	];

for (const task of tasks) runNode(task);
console.log(checkOnly ? "docs sync check ok" : "docs synced");
