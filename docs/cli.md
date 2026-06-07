# `pi-browser` CLI

The `pi-browser` CLI is the external frontend for the browser tools — a strict superset
of what the old MCP server exposed, usable by any shell-capable agent, human, CI, or cron.
Inside Pi the same tools are still invoked natively as `browser_*` tool calls; the CLI is for
everything outside Pi. Both share one tool core (`registerBrowserTools`).

## Model

```
pi-browser <subcommand> [--flags]      (short-lived client)
  ├─ parse + --help: local, no browser startup
  └─ execute: POST /invoke ─► bridge daemon (long-lived, owns the browser)
```

Parsing and `--help` are local and cheap (no browser). Only tool **execution** is delegated to a
**user-local singleton daemon** that holds the live `BrowserBridgeServer`. The daemon auto-starts
on the first invocation; its lockfile lives in a user-local state root (`~/.pi/browser-daemon.json`,
override with `PI_BROWSER_DAEMON_STATE_DIR`), never under the caller project `.pi/`. Each call sends
the caller `cwd`, so artifacts/memory/evidence land under the caller's `.pi/`, not the daemon's.

## Commands

Every registered `browser_*` tool maps to a subcommand: drop the `browser_` prefix and turn `_`
into `-` (`browser_cookie_analyze` → `cookie-analyze`). Flags are the kebab-cased tool parameters.

```bash
pi-browser --help                       # list every command
pi-browser <cmd> --help                 # flags for one command
pi-browser tabs --action list
pi-browser observe --mode scan
pi-browser execute --script "document.title"
pi-browser execute --script-file ./extract.js   # avoids shell quoting for longer JS
pi-browser cookie-analyze --url https://target.example --bind-browser-session
```

Flag mapping from the tool's TypeBox schema: `string`/`number` → `--x <v>`; `boolean` → `--x` /
`--no-x`; enum (union of literals) → `--x <choice>`; array → repeatable `--x`; object → `--x <json>`.
Big values accept `--flag @file` or `--flag -` (stdin). `execute --script-file <path>` is a CLI-only
shortcut that reads a cwd-relative/absolute JavaScript file into the normal `script` parameter and
cannot be combined with `--script`. Coercion/validation reuses the shared frontend validator — there
is no separate CLI coercion.

## Output

- **TTY** → a compact human summary (+ `nextActions`, artifact path, diagnostics).
- **non-TTY** (pipes, agents, CI) → the distilled envelope as raw JSON.
- Force with `--json` / `--text`.

Exit codes: `0` ok · `1` tool error (envelope `terminate`) · `2` usage/param error · `3`
daemon/bridge unavailable.

## Daemon lifecycle

```bash
pi-browser daemon status     # {pid, controlPort, bridgePort, extensionConnected, tabs, tools}
pi-browser daemon start      # foreground (auto-start spawns this detached)
pi-browser daemon stop       # stop the singleton daemon
```

The daemon starts the browser bridge lazily on the first tool call. If a browser extension is
already attached to another bridge on the first port in `18765-18784`, a second daemon binds the
next free port and will not see that extension — run a single daemon per user/profile.

## Tool Surface

All 22 `browser_*` commands — including web-security — are exposed by default. There is no
capability profile, compact/minimal visibility mode, or discovery step; `pi-browser --help`
always lists the full set. WebSecurity commands still carry group metadata for docs and UI
organization, but registration is always-on.

## Usage logging

Set `PI_BROWSER_USAGE_LOG=<path>` to append one JSON line per invocation (tool, timing, result
size) for studying real usage. Off by default; best-effort writes.

## Verification

`npm run smoke:cli` drives the full path (daemon → `/invoke` → bridge → extension → page eval →
back) against a live browser. `npm run check:cli-parity` asserts every registered tool has a
subcommand and that the 22-command surface stays aligned with Pi-native registration.
