#!/usr/bin/env node
/**
 * Tear down a blind-eval stage created by launch-blind.mjs.
 * Reads .pi/browser-artifacts/eval-blind/stage.json and:
 *   - `pi-browser daemon stop` on the ISOLATED state dir,
 *   - hard-kills the isolated browser + the launch/fixture host by pid (no signal trapping needed),
 *   - removes the temp profile/extension/state dirs (unless --keep-temp).
 * Idempotent and best-effort: missing pids/files are ignored.
 */
import { spawnSync } from "node:child_process";
import { rm, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const stagePath = path.join(root, ".pi", "browser-artifacts", "eval-blind", "stage.json");
const cliBin = path.join(root, "dist", "cli", "bin.js");
const keepTemp = process.argv.includes("--keep-temp");

function killPid(pid) {
	if (!pid) return;
	if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
	else { try { process.kill(pid, "SIGTERM"); } catch {} }
}

async function main() {
	let stage;
	try { stage = JSON.parse(await readFile(stagePath, "utf8")); }
	catch { console.log(JSON.stringify({ ok: true, note: "no stage.json; nothing to tear down" })); return; }

	// Stop the isolated daemon gracefully first (releases the bridge), then hard-kill the rest.
	if (stage.stateDir) {
		spawnSync(process.execPath, [cliBin, "daemon", "stop"], { env: { ...process.env, PI_BROWSER_DAEMON_STATE_DIR: stage.stateDir }, stdio: "ignore" });
	}
	killPid(stage.browserPid);
	killPid(stage.daemonPid);
	killPid(stage.launchPid);

	const removed = [];
	if (!keepTemp) {
		for (const dir of [stage.profileDir, stage.extensionDir, stage.stateDir]) {
			if (!dir) continue;
			await rm(dir, { recursive: true, force: true }).catch(() => {});
			removed.push(path.relative(root, dir));
		}
	}
	await unlink(stagePath).catch(() => {});
	console.log(JSON.stringify({ ok: true, stoppedDaemonStateDir: stage.stateDir, killedPids: [stage.browserPid, stage.daemonPid, stage.launchPid].filter(Boolean), removed: keepTemp ? "kept" : removed }, null, 2));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
