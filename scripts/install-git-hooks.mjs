import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function skip(reason) {
	if (process.env.PI_BROWSER_PREPARE_VERBOSE === "1") console.error(`prepare: skip lefthook install (${reason})`);
	process.exit(0);
}

if (process.env.npm_config_ignore_scripts === "true") skip("npm_config_ignore_scripts=true");
if (process.env.CI === "true") skip("CI=true");
if (!existsSync(path.join(root, ".git"))) skip("no .git directory");
if (!existsSync(path.join(root, "lefthook.yml"))) skip("no lefthook.yml");

const lefthookBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "lefthook.cmd" : "lefthook");
if (!existsSync(lefthookBin)) skip("lefthook binary not installed");

const result = spawnSync(lefthookBin, ["install"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

if (result.error) {
	console.error(`prepare: lefthook install failed: ${result.error.message}`);
	process.exit(1);
}
process.exit(result.status ?? 1);
