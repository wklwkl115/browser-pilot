# Agent CLI Connection Control Plan

## Status

Implemented queue. Items are marked complete where current code, docs, tests, or runtime smoke prove
the behavior. This plan turns browser connection readiness into an explicit agent-facing CLI
protocol while preserving the existing daemon-backed execution model.

## Problem

The current CLI execution path is correct for compatibility but too implicit for agents:

```text
pi-browser <command>
  -> short-lived CLI process
  -> ensureDaemon()
  -> maybe start detached singleton daemon
  -> tool invocation lazily starts BrowserBridgeServer
  -> browser extension connects to daemon bridge port
```

An agent can inspect `doctor --json` or `daemon status --json`, but it cannot explicitly say
"prepare the browser connection and tell me if it is ready" without invoking a real browser tool.
That makes connection state passive, and it incorrectly nudges SOPs toward manual cleanup such as
`daemon stop`, which is not a good default agent workflow.

## Decision

Add an explicit connection readiness protocol:

```bash
pi-browser connect --json
pi-browser connect --wait --timeout-ms 15000 --json
pi-browser status --json
```

`connect` is the agent readiness gate. It is idempotent, may start the singleton daemon, starts the
bridge, optionally waits for the extension, and returns a compact machine-readable connection
envelope. `status` is read-only and never starts daemon or bridge.

Keep `pi-browser daemon start|stop|status` as an advanced lifecycle/debug surface. Do not teach
agents to stop the daemon after ordinary tasks.

## Boundaries

- Do not add public `browser_*` tools.
- Do not restore MCP.
- Do not change native Pi tool registration or in-process behavior.
- Do not make `connect` solve tasks or pick tabs strategically.
- Do not leak daemon tokens or raw extension internals.
- Do not implement one-shot/direct transport in this phase. Direct transport remains a follow-up
  candidate after the explicit singleton connection protocol is measured.

## Protocol Shape

### `pi-browser connect`

Semantics:

- Find or start the user-local singleton daemon.
- If daemon version is stale, use the existing replacement path.
- Ask the daemon to start `BrowserBridgeServer` without invoking a browser tool.
- Wait for extension connection when `--wait` is set.
- Return the same JSON envelope class used by other CLI commands.

Draft flags:

- `--wait` waits until `extensionConnected:true`; recommended for agents.
- `--timeout-ms <number>` bounds daemon/bridge/extension wait. Default should match or slightly
  exceed `PI_BROWSER_EXTENSION_WAIT_MS`.
- `--json` / `--text` follows global output rules.

Draft success fields:

```json
{
  "ok": true,
  "command": "connect",
  "ready": true,
  "startedDaemon": false,
  "startedBridge": true,
  "waitedMs": 842,
  "daemon": {
    "pid": 1234,
    "controlPort": 50001,
    "version": "0.3.0+daemon.4",
    "expectedVersion": "0.3.0+daemon.4",
    "versionStale": false
  },
  "bridge": {
    "running": true,
    "port": 18765
  },
  "extension": {
    "connected": true
  },
  "tabCount": 0,
  "activeTab": null,
  "health": {},
  "recovery": {
    "commands": []
  }
}
```

Draft timeout/error fields:

```json
{
  "ok": false,
  "exitCode": 3,
  "code": "CLI_EXTENSION_NOT_CONNECTED",
  "command": "connect",
  "ready": false,
  "message": "Browser extension did not connect before timeout",
  "daemon": {},
  "bridge": {},
  "extension": { "connected": false },
  "recovery": {
    "commands": [
      {
        "command": "pi-browser status --json",
        "argv": ["pi-browser", "status", "--json"],
        "purpose": "inspect current connection state without starting anything"
      },
      {
        "command": "pi-browser doctor --json",
        "argv": ["pi-browser", "doctor", "--json"],
        "purpose": "inspect daemon, bridge, extension, and active tab diagnostics"
      }
    ]
  }
}
```

### `pi-browser status`

Semantics:

- Read-only.
- Does not call `ensureDaemon()`.
- Does not start bridge.
- Returns `ready:true` only when daemon is reachable, bridge is running, extension is connected,
  and at least daemon/bridge versions are current.

Draft fields:

- `command:"status"`
- `ready`
- `daemon.running`
- `daemon.reachable`
- `daemon.lockfile`
- `daemon.versionStale`
- `bridge.running`
- `bridge.port`
- `extension.connected`
- `tabs`
- `activeTab`
- `staleLockfile`
- `recovery.commands`

## Implementation Queue

### P0 - Contract Lock

- [x] Add this plan to `CURRENT.md` / `TODO.md` as the active execution line.
- [x] Decide final names: `connect` and `status`.
- [x] Decide default wait behavior: `connect --json` starts bridge and returns immediate state;
  `connect --wait --json` is the recommended agent gate.
- [x] Decide whether strict manual mode is needed now: deferred until blind eval proves hidden
  auto-start still hurts agent control.

### P1 - Daemon Control Endpoint

- [x] Add daemon control endpoint `POST /connect`.
- [x] Endpoint starts `BrowserBridgeServer` through the existing `ensureStarted` path without invoking a public browser tool.
- [x] Endpoint supports `wait`, `timeoutMs`, and returns compact snapshot fields.
- [x] Endpoint must never expose daemon token.
- [x] Endpoint distinguishes:
  - [x] daemon reachable
  - [x] bridge started
  - [x] extension connected
  - [x] extension timeout
  - [x] bridge startup failure

### P2 - CLI Commands

- [x] Add top-level `pi-browser connect`.
- [x] Add top-level `pi-browser status`.
- [x] Keep `doctor` read-only and broader than `status`.
- [x] Keep `daemon status` for low-level daemon details.
- [x] Ensure `connect/status --json` each write exactly one JSON object to stdout.
- [x] Human output is compact and places failed connect diagnostics on stderr.

### P3 - Agent-Facing Recovery

- [x] Add recovery commands to `connect` timeout/error envelopes:
  - [x] `pi-browser status --json`
  - [x] `pi-browser doctor --json`
  - [x] `pi-browser connect --wait --timeout-ms <ms> --json`
  - [x] extension install/reload guidance only as text, not hidden automation.
- [x] Update ordinary daemon unavailable errors to suggest `connect --wait` before `doctor` when the failure is readiness-related.
- [x] Keep stale lockfile diagnostics non-sensitive.

### P4 - Tests

- [x] Unit test: `status --json` is local/read-only and does not create a lockfile.
- [x] Unit test: no-daemon `status --json` returns `ready:false`, exit `0`, parseable JSON.
- [x] Unit test: stale lockfile status does not leak token.
- [x] Fake daemon test: `connect --wait` success envelope when extension is connected.
- [x] Fake daemon test: `connect --wait` timeout/error envelope when extension is not connected.
- [x] Contract test: top-level help includes `connect` and `status`; `connect/status` are lifecycle commands, not counted in the 22 public `browser_*` command surface.

### P5 - Runtime Smoke

- [x] Add isolated runtime smoke:

```bash
pi-browser connect --wait --timeout-ms 15000 --json
pi-browser status --json
pi-browser tabs list --json
```

- [x] Verify no manual `daemon stop` is required in the agent path; test cleanup may still stop isolated daemon.
- [x] Assert command count / public `browser_*` surface does not drift.
- [x] Record artifact path for smoke result.

### P6 - Docs, Skill, and SOP

- [x] Update `docs/cli.md` model:
  - [x] `connect` is the recommended task-start readiness gate.
  - [x] `status` is read-only state.
  - [x] `doctor` is broad diagnostics.
  - [x] `daemon stop` is advanced cleanup, not normal agent SOP.
- [x] Update `skills/pi-browser-tools/SKILL.md` to start complex workflows with:

```bash
pi-browser connect --wait --timeout-ms 15000 --json
```

- [x] Keep simple one-command examples valid without mandatory connect.
- [x] Update `CHANGELOG.md`.
- [x] Run skill quick validation.

### P7 - Verification Gates

- [x] `npm run check:cli-parity`
- [x] CLI unit tests for connect/status.
- [x] JSON envelope contract tests for connect/status success and timeout.
- [x] Runtime smoke for connect/status/tabs.
- [x] `npm run check`

## Acceptance Criteria

- An external shell-capable agent can explicitly prepare browser readiness with one command:
  `pi-browser connect --wait --timeout-ms 15000 --json`.
- The agent can inspect current state without side effects using `pi-browser status --json`.
- Agents are no longer instructed to run `daemon stop` as normal task cleanup.
- Existing ordinary CLI commands remain backward compatible.
- No daemon token or sensitive bridge credential appears in JSON output, errors, logs, or docs.
- Parseable JSON behavior and exit-code taxonomy remain stable.
