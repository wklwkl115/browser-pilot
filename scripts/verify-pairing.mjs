/**
 * Smoke test for the connection-authorization layer (pairing, leasing, revocation).
 *
 * Spawns a SEPARATE daemon with temp state dirs, connects a mock extension WS client,
 * and exercises the full auth flow. Always cleans up in a finally block.
 *
 * Run:  node scripts/verify-pairing.mjs
 * Or:   npm run verify:pairing
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_BIN = process.execPath;
const DAEMON_BIN = path.resolve(__dirname, "..", "dist", "cli", "bin.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function controlHttp(controlPort, daemonToken, method, pathname, body, pairingToken) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = {
      "x-pi-daemon-token": daemonToken,
      ...(pairingToken ? { "x-pi-pairing-token": pairingToken } : {}),
      ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
    };
    const req = http.request(
      { host: "127.0.0.1", port: controlPort, method, path: pathname, headers },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json;
          try { json = buf ? JSON.parse(buf) : undefined; } catch { /* ignore */ }
          resolve({ status: res.statusCode, json });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(20_000, () => { req.destroy(new Error("controlHttp timeout")); });
    if (data) req.write(data);
    req.end();
  });
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) {
    return e.code === "EPERM";
  }
}

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

const results = [];
let passed = 0;
let failed = 0;

function assert(name, condition, detail = "") {
  if (condition) {
    passed++;
    results.push({ name, ok: true });
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    results.push({ name, ok: false, detail });
    console.log(`  [FAIL] ${name}${detail ? ": " + detail : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Mock extension WebSocket client
// ---------------------------------------------------------------------------

class MockExtension {
  constructor(bridgePort) {
    this.bridgePort = bridgePort;
    this.ws = null;
    this.decision = "approve"; // controllable per test
  }

  connect() {
    return new Promise((resolve, reject) => {
      // Close any previous connection
      if (this.ws && this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
        this.ws.terminate();
      }
      this.ws = new WebSocket(`ws://127.0.0.1:${this.bridgePort}`, {
        headers: { origin: "null" }, // "null" is an allowed bridge origin per isAllowedBridgeOrigin()
      });
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      };
      this.ws.on("open", () => {
        // Send ext_ready envelope
        this.ws.send(JSON.stringify({
          type: "ext_ready",
          bridge: {
            extensionId: "mock-ext-smoke-test-" + Date.now(),
            name: "Mock Extension (smoke)",
            version: "0.0.1",
          },
          tabs: [],
          consentCapable: true,
        }));
        // Give daemon a full event loop cycle to process ext_ready before resolving
        setTimeout(() => done(null), 150);
      });
      this.ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        console.log(`    [dbg] MockExt(port=${this.bridgePort}) received msg.type=${msg.type}`);
        if (msg.type === "consent-request") {
          const decision = this.decision;
          console.log(`    [dbg] MockExt replying consent-response decision=${decision} pairingId=${msg.pairingId}`);
          this.ws.send(JSON.stringify({
            type: "consent-response",
            pairingId: msg.pairingId,
            decision,
          }));
        }
      });
      this.ws.on("error", (e) => done(e));
      this.ws.on("close", () => {
        // May fire before open on connection refused
        if (!settled) done(new Error("WS closed before open on port " + this.bridgePort));
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      this.ws.once("close", () => resolve());
      if (this.ws.readyState === WebSocket.CLOSING) return;
      this.ws.close();
    });
  }

  terminate() {
    if (this.ws) this.ws.terminate();
  }
}

// ---------------------------------------------------------------------------
// Daemon helpers
// ---------------------------------------------------------------------------

async function spawnDaemon(tempStateDir, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [DAEMON_BIN, "daemon", "start"], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    let resolved = false;
    const childPid = child.pid;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; reject(new Error("daemon spawn timeout — lockfile never appeared")); }
    }, 25_000);

    const poll = setInterval(() => {
      const lf = path.join(tempStateDir, "browser-daemon.json");
      if (existsSync(lf)) {
        try {
          const info = JSON.parse(readFileSync(lf, "utf8"));
          // Verify the lockfile belongs to OUR spawned child (not a leftover from a previous run)
          if (info.controlPort && info.token && info.pid === childPid) {
            clearInterval(poll);
            clearTimeout(timer);
            if (!resolved) { resolved = true; resolve({ child, info }); }
          }
        } catch { /* not yet */ }
      }
    }, 150);

    child.on("error", (e) => {
      clearInterval(poll);
      clearTimeout(timer);
      if (!resolved) { resolved = true; reject(e); }
    });
    child.on("exit", (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      if (!resolved) { resolved = true; reject(new Error(`daemon exited with code ${code} before lockfile appeared`)); }
    });
    child.stderr.on("data", (d) => { process.stderr.write("[daemon-err] " + d.toString()); });
    child.stdout.on("data", () => { /* consume stdout */ });
  });
}

async function triggerBridgeStart(controlPort, daemonToken) {
  // POST /connect to lazily start the bridge server
  try {
    await controlHttp(controlPort, daemonToken, "POST", "/connect", { wait: false, timeoutMs: 0 });
  } catch { /* ignore */ }
}

async function getBridgePort(controlPort, daemonToken, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await triggerBridgeStart(controlPort, daemonToken);
      const { status, json } = await controlHttp(controlPort, daemonToken, "GET", "/status");
      if (status === 200 && json && json.bridgePort && json.running) {
        return json.bridgePort;
      }
    } catch { /* retry */ }
    await sleep(300);
  }
  return null;
}

async function waitDaemonReady(controlPort, daemonToken, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { status, json } = await controlHttp(controlPort, daemonToken, "GET", "/status");
      if (status === 200 && json?.ok === true) return true;
    } catch { /* retry */ }
    await sleep(200);
  }
  return false;
}

async function stopDaemonGracefully(controlPort, daemonToken, child, pid, stateDir) {
  // 1. Try graceful /shutdown
  try {
    await controlHttp(controlPort, daemonToken, "POST", "/shutdown", {});
  } catch { /* ignore */ }

  // 2. Wait for pid to die AND lockfile to be removed (daemon removes lockfile on clean shutdown)
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const lfGone = stateDir ? !existsSync(path.join(stateDir, "browser-daemon.json")) : true;
    if (!isPidAlive(pid) && lfGone) return;
    await sleep(150);
  }

  // 3. SIGTERM
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
  await sleep(1_200);

  // 4. SIGKILL
  if (isPidAlive(pid)) {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    await sleep(600);
  }
}

// ---------------------------------------------------------------------------
// Pairing helpers
// ---------------------------------------------------------------------------

async function doPairStart(controlPort, daemonToken, label) {
  console.log(`    [dbg] doPairStart("${label}")...`);
  const r = await controlHttp(controlPort, daemonToken, "POST", "/pair/start", { label });
  console.log(`    [dbg] doPairStart("${label}") → ${r.status} ${JSON.stringify(r.json)}`);
  return r;
}

async function doPairWait(controlPort, daemonToken, pairingId, timeoutMs = 15_000) {
  console.log(`    [dbg] doPairWait(${pairingId}, ${timeoutMs})...`);
  const r = await controlHttp(controlPort, daemonToken, "POST", "/pair/wait", { pairingId, timeoutMs });
  console.log(`    [dbg] doPairWait(${pairingId}) → ${r.status} ${JSON.stringify(r.json)}`);
  return r;
}

async function doPairFull(controlPort, daemonToken, label) {
  const startR = await doPairStart(controlPort, daemonToken, label);
  if (startR.status !== 200 || !startR.json?.ok) {
    return { ok: false, error: `pair/start failed: ${startR.status} ${JSON.stringify(startR.json)}` };
  }
  const { pairingId } = startR.json;
  const waitR = await doPairWait(controlPort, daemonToken, pairingId, 15_000);
  const ok = waitR.status === 200 && waitR.json?.ok === true;
  return { ok, pairingId, waitR, token: waitR.json?.token, error: ok ? undefined : `pair/wait: ${waitR.status} ${JSON.stringify(waitR.json)}` };
}

// Poll /pairings until condition is met or timeout
async function pollPairings(controlPort, daemonToken, condition, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await controlHttp(controlPort, daemonToken, "GET", "/pairings");
    if (r.status === 200 && r.json?.ok) {
      const agents = r.json.agents ?? [];
      if (condition(agents)) return { ok: true, agents };
    }
    await sleep(200);
  }
  const r = await controlHttp(controlPort, daemonToken, "GET", "/pairings");
  return { ok: false, agents: r.json?.agents ?? [] };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n=== verify-pairing smoke ===\n");

  const tempBase = mkdtempSync(path.join(os.tmpdir(), "bp-smoke-"));
  const tempStateDir = path.join(tempBase, "state");
  const tempAuthDir = path.join(tempBase, "auth");
  mkdirSync(tempStateDir, { recursive: true });
  mkdirSync(tempAuthDir, { recursive: true });

  const daemonEnv = {
    PI_BROWSER_DAEMON_STATE_DIR: tempStateDir,
    PI_BROWSER_AUTH_STATE_DIR: tempAuthDir,
    PI_BROWSER_PAIRING_TOKEN: "", // don't inherit caller's token
    PI_BROWSER_NO_SYSTEM_CA: "1",
  };

  let daemonChild = null;
  let daemonPid = null;
  let controlPort = null;
  let daemonToken = null;
  let bridgePort = null;
  let mockExt = null;

  try {
    // -----------------------------------------------------------------------
    // Step 1: Spawn temp daemon
    // -----------------------------------------------------------------------
    console.log("Starting temp daemon...");
    const spawn1 = await spawnDaemon(tempStateDir, daemonEnv);
    daemonChild = spawn1.child;
    daemonPid = spawn1.info.pid;
    controlPort = spawn1.info.controlPort;
    daemonToken = spawn1.info.token;
    console.log(`  pid=${daemonPid} controlPort=${controlPort}`);

    assert("daemon started and lockfile readable", controlPort > 0 && !!daemonToken);

    // Trigger bridge start and read its port
    console.log("Starting bridge server...");
    bridgePort = await getBridgePort(controlPort, daemonToken, 12_000);
    assert("bridge server started", !!bridgePort, `bridgePort=${bridgePort}`);
    if (!bridgePort) throw new Error("Bridge did not start — cannot continue");
    console.log(`  bridgePort=${bridgePort}`);

    // -----------------------------------------------------------------------
    // Step 2: Connect mock extension
    // -----------------------------------------------------------------------
    console.log("\nConnecting mock extension (decision=approve)...");
    mockExt = new MockExtension(bridgePort);
    mockExt.decision = "approve";
    await mockExt.connect();
    // Give daemon event loop time to process ext_ready and update browserSessions
    await sleep(400);

    // Verify daemon sees the extension via /status
    {
      const { json } = await controlHttp(controlPort, daemonToken, "GET", "/status");
      assert("mock extension seen by daemon", json?.extensionConnected === true, `extensionConnected=${json?.extensionConnected}`);
    }

    // -----------------------------------------------------------------------
    // A: GET /pairings → empty agents (grace mode)
    // -----------------------------------------------------------------------
    console.log("\n[A] GET /pairings → empty agents");
    const pairingsA = await controlHttp(controlPort, daemonToken, "GET", "/pairings");
    assert("A: /pairings returns ok", pairingsA.status === 200 && pairingsA.json?.ok === true);
    assert("A: agents array is empty", Array.isArray(pairingsA.json?.agents) && pairingsA.json.agents.length === 0,
      `agents=${JSON.stringify(pairingsA.json?.agents)}`);

    // -----------------------------------------------------------------------
    // B: Happy-path pair (smoke-a)
    // -----------------------------------------------------------------------
    console.log("\n[B] Happy-path pair flow (smoke-a)");
    const pairA = await doPairFull(controlPort, daemonToken, "smoke-a");
    assert("B: pair/start+wait succeeds", pairA.ok === true, pairA.error ?? "");
    const tokenA = pairA.token;
    const pairingIdA = pairA.pairingId;
    assert("B: token A returned", typeof tokenA === "string" && tokenA.startsWith("bp_pat_"),
      `token=${tokenA?.slice(0, 12)}...`);

    // /pairings shows one ACTIVE agent
    await sleep(200);
    const pbResult = await pollPairings(controlPort, daemonToken,
      (agents) => agents.some((a) => a.pairingId === pairingIdA && a.status === "active"), 5_000);
    assert("B: /pairings shows one active agent", pbResult.ok, `agents=${JSON.stringify(pbResult.agents)}`);

    // -----------------------------------------------------------------------
    // C: Enforcement on /lease
    // -----------------------------------------------------------------------
    console.log("\n[C] Enforcement: /lease without token → 401, with token A → 200");
    const leaseNoToken = await controlHttp(controlPort, daemonToken, "POST", "/lease", { action: "acquire" });
    assert("C: /lease without pairing token → 401", leaseNoToken.status === 401,
      `status=${leaseNoToken.status}`);
    assert("C: error code PAIRING_INVALID", leaseNoToken.json?.code === "PAIRING_INVALID",
      `code=${leaseNoToken.json?.code}`);

    const leaseWithA = await controlHttp(controlPort, daemonToken, "POST", "/lease", { action: "acquire" }, tokenA);
    assert("C: /lease with token A → 200", leaseWithA.status === 200 && leaseWithA.json?.ok === true,
      `status=${leaseWithA.status} json=${JSON.stringify(leaseWithA.json)}`);
    assert("C: lease.pairingId matches A", leaseWithA.json?.lease?.pairingId === pairingIdA,
      `lease=${JSON.stringify(leaseWithA.json?.lease)}`);

    // -----------------------------------------------------------------------
    // D: Contention — smoke-b tries to acquire while A holds
    // -----------------------------------------------------------------------
    console.log("\n[D] Contention: pair smoke-b, try lease → 409 LEASE_BUSY");
    const pairB = await doPairFull(controlPort, daemonToken, "smoke-b");
    assert("D: smoke-b pair succeeds", pairB.ok === true, pairB.error ?? "");
    const tokenB = pairB.token;
    const pairingIdB = pairB.pairingId;

    const leaseConflict = await controlHttp(controlPort, daemonToken, "POST", "/lease", { action: "acquire" }, tokenB);
    assert("D: /lease with token B → 409 LEASE_BUSY", leaseConflict.status === 409,
      `status=${leaseConflict.status}`);
    assert("D: code is LEASE_BUSY", leaseConflict.json?.code === "LEASE_BUSY",
      `code=${leaseConflict.json?.code}`);
    assert("D: heldBy.label is smoke-a", leaseConflict.json?.heldBy?.label === "smoke-a",
      `heldBy=${JSON.stringify(leaseConflict.json?.heldBy)}`);

    // -----------------------------------------------------------------------
    // E: PAIR_NO_EXTENSION (close mock ext, then pair/start → 409)
    // -----------------------------------------------------------------------
    console.log("\n[E] PAIR_NO_EXTENSION: close mock ext, then pair/start → 409");
    await mockExt.close();
    mockExt = null;

    // Poll until daemon no longer sees extension as connected
    const extGone = await (async () => {
      const deadline = Date.now() + 6_000;
      while (Date.now() < deadline) {
        try {
          const { json } = await controlHttp(controlPort, daemonToken, "GET", "/status");
          if (!json?.extensionConnected) return true;
        } catch { /* ignore */ }
        await sleep(300);
      }
      return false;
    })();
    assert("E: daemon sees extension as disconnected", extGone, "extension still shows connected after 6s");

    const pairNoExt = await doPairStart(controlPort, daemonToken, "smoke-noext");
    assert("E: pair/start without extension → 409", pairNoExt.status === 409,
      `status=${pairNoExt.status}`);
    assert("E: code is PAIR_NO_EXTENSION", pairNoExt.json?.code === "PAIR_NO_EXTENSION",
      `code=${pairNoExt.json?.code}`);

    // -----------------------------------------------------------------------
    // F: PAIR_DENIED (reconnect with deny, pair → 403)
    // -----------------------------------------------------------------------
    console.log("\n[F] PAIR_DENIED: reconnect ext (decision=deny), pair → 403");
    const extDeny = new MockExtension(bridgePort);
    extDeny.decision = "deny";
    await extDeny.connect();
    await sleep(400);

    // Verify extension is connected again
    {
      const { json } = await controlHttp(controlPort, daemonToken, "GET", "/status");
      assert("F: ext reconnected (deny mode)", json?.extensionConnected === true,
        `extensionConnected=${json?.extensionConnected}`);
    }

    const startF = await doPairStart(controlPort, daemonToken, "smoke-deny");
    if (startF.status === 200 && startF.json?.ok) {
      const waitF = await doPairWait(controlPort, daemonToken, startF.json.pairingId, 10_000);
      assert("F: pair/wait → 403 PAIR_DENIED", waitF.status === 403,
        `status=${waitF.status} json=${JSON.stringify(waitF.json)}`);
      assert("F: code is PAIR_DENIED", waitF.json?.code === "PAIR_DENIED",
        `code=${waitF.json?.code}`);
    } else {
      assert("F: pair/start succeeded (pre-deny)", false,
        `status=${startF.status} json=${JSON.stringify(startF.json)}`);
      // Still count as 2 assertions to keep numbering consistent
      assert("F: pair/wait → 403 PAIR_DENIED", false, "skipped (pair/start failed)");
    }

    await extDeny.close();

    // -----------------------------------------------------------------------
    // G: REVOKE → PAIRING_REVOKED on subsequent /lease
    // -----------------------------------------------------------------------
    console.log("\n[G] Revoke pairingId A, then /lease → 403 PAIRING_REVOKED");
    const revokeA = await controlHttp(controlPort, daemonToken, "POST", "/revoke", { pairingId: pairingIdA });
    assert("G: /revoke → 200", revokeA.status === 200 && revokeA.json?.ok === true,
      `status=${revokeA.status} json=${JSON.stringify(revokeA.json)}`);

    await sleep(100);
    const leaseRevokedA = await controlHttp(controlPort, daemonToken, "POST", "/lease", { action: "acquire" }, tokenA);
    assert("G: /lease with revoked token → 403", leaseRevokedA.status === 403,
      `status=${leaseRevokedA.status}`);
    assert("G: code is PAIRING_REVOKED", leaseRevokedA.json?.code === "PAIRING_REVOKED",
      `code=${leaseRevokedA.json?.code}`);

    // -----------------------------------------------------------------------
    // H: Persistence — stop daemon, restart, /pairings still lists agents
    // -----------------------------------------------------------------------
    console.log("\n[H] Persistence: stop daemon, restart with same state dirs");
    await stopDaemonGracefully(controlPort, daemonToken, daemonChild, daemonPid, tempStateDir);
    daemonChild = null;
    daemonPid = null;

    // Extra safety: wait for old lockfile to be gone and old pid to be dead
    await (async () => {
      const deadline = Date.now() + 5_000;
      const lf = path.join(tempStateDir, "browser-daemon.json");
      while (Date.now() < deadline) {
        const lfGone = !existsSync(lf);
        // If lockfile exists, check if it's stale (pid dead)
        if (!lfGone) {
          try {
            const info = JSON.parse(readFileSync(lf, "utf8"));
            if (info.pid && !isPidAlive(info.pid)) {
              // Force-remove stale lockfile
              try { rmSync(lf, { force: true }); } catch { /* ignore */ }
              break;
            }
          } catch { /* ignore */ }
          await sleep(200);
        } else {
          break;
        }
      }
    })();

    console.log("  Restarting with same state dirs...");
    const spawn2 = await spawnDaemon(tempStateDir, daemonEnv);
    daemonChild = spawn2.child;
    daemonPid = spawn2.info.pid;
    controlPort = spawn2.info.controlPort;
    daemonToken = spawn2.info.token;
    console.log(`  pid=${daemonPid} controlPort=${controlPort}`);

    await waitDaemonReady(controlPort, daemonToken, 8_000);

    const pairingsH = await controlHttp(controlPort, daemonToken, "GET", "/pairings");
    assert("H: /pairings after restart → ok", pairingsH.status === 200 && pairingsH.json?.ok === true,
      `status=${pairingsH.status}`);

    const agentsH = pairingsH.json?.agents ?? [];
    const agentAH = agentsH.find((a) => a.pairingId === pairingIdA);
    const agentBH = agentsH.find((a) => a.pairingId === pairingIdB);

    assert("H: agents list is non-empty", agentsH.length >= 2,
      `agents=${JSON.stringify(agentsH.map((a) => ({ label: a.label, status: a.status })))}`);
    assert("H: smoke-a is still revoked", agentAH?.status === "revoked",
      `agentA=${JSON.stringify(agentAH)}`);
    assert("H: smoke-b is still active", agentBH?.status === "active",
      `agentB=${JSON.stringify(agentBH)}`);

  } finally {
    console.log("\nCleaning up...");
    try { mockExt?.terminate(); } catch { /* ignore */ }
    if (daemonChild && controlPort && daemonToken) {
      await stopDaemonGracefully(controlPort, daemonToken, daemonChild, daemonPid, tempStateDir);
    } else if (daemonChild) {
      try { daemonChild.kill("SIGTERM"); } catch { /* ignore */ }
      await sleep(500);
      try { daemonChild.kill("SIGKILL"); } catch { /* ignore */ }
    }
    try { rmSync(tempBase, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log("  Done.");
  }

  // Summary
  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(`  ${r.ok ? "[PASS]" : "[FAIL]"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
  console.log(`\nTotal: ${passed} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n[FATAL]", err.stack ?? err);
  process.exit(1);
});
