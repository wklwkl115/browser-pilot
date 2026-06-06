#!/usr/bin/env node
/**
 * Shell-agnostic wrapper that pins a blind agent to the isolated blind-eval stage.
 * Forwards ALL argv to dist/cli/bin.js with PI_BROWSER_DAEMON_STATE_DIR taken from stage.json, so a
 * blind subagent calls `node evals/browser-workflows/pb-blind.mjs <cmd> --flags` with no env juggling
 * and physically cannot reach the operator's real browser/daemon. `--help` forwards through unchanged,
 * so CLI ergonomics under test stay intact.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let stage;
try {
	stage = JSON.parse(readFileSync(path.join(root, ".pi", "browser-artifacts", "eval-blind", "stage.json"), "utf8"));
} catch {
	console.error("no blind-eval stage.json — start it with: node evals/browser-workflows/launch-blind.mjs --confirm");
	process.exit(3);
}
const r = spawnSync(process.execPath, [path.join(root, "dist", "cli", "bin.js"), ...process.argv.slice(2)], {
	env: { ...process.env, PI_BROWSER_DAEMON_STATE_DIR: stage.stateDir },
	stdio: "inherit",
});
process.exit(r.status ?? 1);
