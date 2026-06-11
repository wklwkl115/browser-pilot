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
const DEFAULT_CLI_TIMEOUT_MS = 5 * 60 * 1000;
const TIMEOUT_EXIT_CODE = 124;

function cliTimeoutMs() {
	const raw = process.env.PI_BROWSER_BLIND_CLI_TIMEOUT_MS;
	if (!raw) return DEFAULT_CLI_TIMEOUT_MS;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		console.error(`invalid PI_BROWSER_BLIND_CLI_TIMEOUT_MS=${JSON.stringify(raw)}; expected a positive integer milliseconds value`);
		process.exit(2);
	}
	return value;
}

let stage;
try {
	stage = JSON.parse(readFileSync(path.join(root, ".pi", "browser-artifacts", "eval-blind", "stage.json"), "utf8"));
} catch {
	console.error("no blind-eval stage.json — start it with: node evals/browser-workflows/launch-blind.mjs --confirm");
	process.exit(3);
}
const timeoutMs = cliTimeoutMs();
const r = spawnSync(process.execPath, [path.join(root, "dist", "cli", "bin.js"), ...process.argv.slice(2)], {
	env: { ...process.env, PI_BROWSER_DAEMON_STATE_DIR: stage.stateDir },
	stdio: "inherit",
	timeout: timeoutMs,
	killSignal: "SIGTERM",
});
if (r.error) {
	if (r.error.code === "ETIMEDOUT") {
		console.error(`[pb-blind] forwarded CLI command timed out after ${timeoutMs}ms; killed child with ${r.signal || "SIGTERM"}`);
		process.exit(TIMEOUT_EXIT_CODE);
	}
	console.error(`[pb-blind] forwarded CLI command failed: ${r.error.message}`);
	process.exit(1);
}
if (r.signal) {
	console.error(`[pb-blind] forwarded CLI command exited by signal ${r.signal}`);
	process.exit(1);
}
process.exit(r.status ?? 1);
