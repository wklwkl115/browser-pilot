# CLI ⇄ Pi-native parity testing

The `pi-browser` CLI and the Pi-native host share **one tool core**
(`registerBrowserTools` → the same `def.execute`). The CLI only swaps the *frontend*:
invocation/transport (daemon `/invoke` vs a direct call), flag→param mapping, result
rendering, the caller `cwd`, and `ctx.hasUI:false`. So **result parity is the expected
default** — parity testing hunts for *frontend* regressions, not core logic changes.

Three layers, cheap → expensive:

## Layer 1 — Differential envelope parity (automated, hermetic)

`tests/unit/cli/parity-differential.test.ts` runs the same `(tool, params, cwd)` through
both paths against the same core and asserts the result envelopes are identical after
normalizing inherently-variable fields (bridge port, ids, timestamps, durations, the
cwd prefix):

- **A** `def.execute(..., {cwd, hasUI:false})` — the Pi-native path
- **B** daemon `POST /invoke {tool, params, cwd}` — the CLI path

Cases are browser-free / deterministic-error (`browser_execute`, `browser_tabs`,
`browser_memory recall`) so it runs in CI with no live browser. This is the rigorous
proof that the CLI frontend does not alter tool semantics. Runs in `npm run test:unit`.

## Layer 2 — Live workflow smoke (real browser, scripted)

`npm run smoke:cli` (`tests/smoke/smoke-cli.mjs`) drives a representative workflow set —
`status → execute → tabs → observe(scan, content) → screenshot → network(start, stop)` —
through the CLI control channel against a connected browser, and asserts each returns a
healthy (non-terminate) envelope. Exit `0` PASS · `3` NEEDS BROWSER · `1` FAIL.

`check:cli-parity` separately proves every registered tool has a subcommand for both
capability profiles (15 core / 22 security), and `check:cli-migration-drift` proves no
MCP-only identifiers leak back into active code.

## Layer 3 — Agent A/B (real agent + real browser)

This is the one that validates the migration's *thesis*: that the CLI is consumable by
any shell-capable agent (the reason for moving off MCP). Run it once; the shared core
makes repeated runs low-value.

**Protocol**

1. **Pick 3–5 representative tasks** spanning the surface, e.g.
   - observe + extract a value from a page (`observe` → `execute`)
   - capture a request and read it back (`network` start → action → `artifact`)
   - collect evidence (`evidence`)
   - one web-security tool (e.g. `cookie-analyze` on a known token)
2. **Pin the target** to a stable page (a local fixture served over http, or one
   allow-listed test site) so both arms see identical content.
3. **Baseline arm (Pi-native):** an agent in Pi performs the tasks via the `browser_*`
   tools. Record the final answers + the saved artifacts.
4. **CLI arm:** a fresh agent with **only** the `pi-browser` CLI (via Bash) performs the
   same tasks on the same page. It should discover commands with `pi-browser --help` /
   `pi-browser <cmd> --help`, use `--json` off-TTY, and rely on daemon auto-start.
5. **Compare:** answer correctness + artifact equivalence (normalize paths/ids/timestamps,
   as Layer 1 does). They should match.
6. **Log CLI-only friction** (this is the real signal): flag-mapping confusion, needing
   `--json`, daemon lifecycle surprises, exit-code handling, whether `recovery` hints are
   actionable from a shell.

**Gotchas to control for — or the A/B is unfair**

- **One bridge only (critical).** The extension connects to a single bridge on the first
  free port in `18765-18784`. If a Pi-host bridge already holds `18765`, the CLI daemon
  binds `18766` and **won't see the extension** (`NO_BROWSER_EXTENSION`). Run the CLI arm
  with no competing Pi-host bridge so the CLI daemon owns the extension connection.
  Confirm with `pi-browser daemon status` → `extensionConnected:true`.
- **cwd-rooted artifacts.** The CLI threads the caller `cwd`; artifacts/memory/OAST land
  under the directory you ran `pi-browser` from (`./.pi/…`), not the daemon's. Verify the
  evidence shows up where you expect.
- **Flag round-trip (the most likely frontend bug).** Exercise every param shape:
  object → `--x '<json>'`, array → repeated `--x a --x b`, boolean → `--x` / `--no-x`,
  enum → rejected if out of range, big values → `--script @file` or `-` (stdin).
  `check:cli-parity` only proves the subcommand exists, not that each type round-trips.
- **No streaming in v1.** The CLI returns the final result only (no incremental
  `onUpdate`); long tools (`crawl`/`fuzz`/`callback-oast`) print once at the end. Expected,
  not a bug.
- **Reload the extension after switching bridges.** The extension does not auto-reconnect
  to a new bridge: after you free `18765` and start the CLI daemon, reload the extension (or
  the active tab) so it connects to the daemon — then `pi-browser daemon status` shows
  `extensionConnected:true`. Also, CDP/debugger-backed tools (`screenshot`) carry a
  persistent CDP session that goes **stale** when the extension reconnects to a different
  bridge mid-session — the first such call may `BRIDGE_TIMEOUT`. A clean extension reload
  refreshes the CDP session and they work again (verified live: `screenshot` →
  `method:persistent_cdp`, saved). This is an extension-runtime concern, not a CLI issue.

## What parity does NOT need to be identical

- Rendering: Pi renders via its adapter; the CLI prints human (TTY) or the raw distilled
  envelope (`--json`/off-TTY). The underlying envelope is the same.
- `ctx.hasUI`: Pi may surface `ui.notify`; the CLI is `hasUI:false`. Tools must not depend
  on UI for correctness.
- Absolute paths/ids/ports/timestamps — inherently per-run.
