# `browser-pilot` CLI

The `browser-pilot` CLI is the external frontend for the browser tools — a strict superset
of what the old MCP server exposed, usable by any shell-capable agent, human, CI, or cron.
Inside Pi the same tools are still invoked natively as `browser_*` tool calls; the CLI is for
everything outside Pi. Both share one tool core (`registerBrowserTools`).

## Model

```
browser-pilot <subcommand> [--flags]      (short-lived client)
  ├─ parse + --help: local, no browser startup
  └─ execute: POST /invoke ─► bridge daemon (long-lived, owns the browser)
```

Parsing and `--help` are local and cheap (no browser). Only tool **execution** is delegated to a
**user-local singleton daemon** that holds the live `BrowserBridgeServer`. The daemon auto-starts
on the first invocation (built CLI: `node dist/cli/bin.js daemon start`; source CLI:
`node node_modules/tsx/dist/cli.mjs cli/bin.ts daemon start`); its lockfile lives in a user-local state root (`~/.pi/browser-daemon.json`,
override with `PI_BROWSER_DAEMON_STATE_DIR`), never under the caller project `.pi/`. Each call sends
the caller `cwd`, so artifacts/memory/evidence land under the caller's `.pi/`, not the daemon's.

For multi-step agent work, make readiness explicit before the first browser operation:

```bash
browser-pilot connect --wait --timeout-ms 15000 --json
browser-pilot status --json
```

`connect` is an idempotent readiness gate: it starts or reuses the singleton daemon, starts the
bridge, waits for the extension when `--wait` is present, and reports `ready`, daemon, bridge,
extension, tab count, active tab, health, and recovery commands. `status` is read-only and never
starts daemon or bridge. Both commands are compact by default; add `--tabs` only when the full
`tabs[]` array is needed. Simple one-off commands still auto-start the daemon for compatibility.

## Commands

Every registered `browser_*` tool maps to a subcommand: drop the `browser_` prefix and turn `_`
into `-` (`browser_cookie_analyze` → `cookie-analyze`). Flags are the kebab-cased tool parameters.

```bash
browser-pilot --help                       # list every command
browser-pilot <cmd> --help                 # flags for one command
browser-pilot connect --wait --timeout-ms 15000 --json
browser-pilot status --json
browser-pilot tabs --action list
browser-pilot observe --mode scan
browser-pilot wait selector --selector "#result"
browser-pilot network start
browser-pilot network list --session-id net-1
browser-pilot frame list
browser-pilot frame evaluate --frame-id frame-1 --expression "document.title"
browser-pilot hook install-targets --targets console,error
browser-pilot hook collect --session-id hook-1
browser-pilot execute --script "document.title"
browser-pilot execute --script-file ./extract.js   # avoids shell quoting for longer JS
browser-pilot cookie-analyze --url https://target.example --bind-browser-session
```

Flag mapping from the tool's TypeBox schema: `string`/`number` → `--x <v>`; `boolean` → `--x` /
`--no-x`; enum (union of literals) → `--x <choice>`; array → repeatable `--x`; object → `--x <json>`.
Big values accept `--flag @file` or `--flag -` (stdin). `execute --script-file <path>` is a CLI-only
shortcut that reads a cwd-relative/absolute JavaScript file into the normal `script` parameter and
cannot be combined with `--script`. Coercion/validation reuses the shared frontend validator — there
is no separate CLI coercion.

Prefer files for anything containing quotes, braces, newlines, request bodies, or long JavaScript:

```bash
# bash / sh / zsh
browser-pilot execute --script-file ./extract.js --json
browser-pilot command --command @native-command.json --json
browser-pilot http-replay --raw-request @request.txt --json
browser-pilot http-replay --request @captured-request.json --json
browser-pilot http-replay --har-path ./capture.har --har-url-pattern "/api/" --json
browser-pilot template --template-path ./template.yaml --url https://target.example --json

# PowerShell
browser-pilot execute --script-file .\extract.js --json
browser-pilot command --command '@native-command.json' --json
browser-pilot http-replay --raw-request '@request.txt' --json
browser-pilot http-replay --request '@captured-request.json' --json
browser-pilot http-replay --har-path .\capture.har --har-url-pattern '/api/' --json
browser-pilot template --template-path .\template.yaml --url https://target.example --json

# cmd.exe
browser-pilot execute --script-file extract.js --json
browser-pilot command --command @native-command.json --json
browser-pilot http-replay --raw-request @request.txt --json
browser-pilot http-replay --request @captured-request.json --json
browser-pilot http-replay --har-path capture.har --har-url-pattern /api/ --json
browser-pilot template --template-path template.yaml --url https://target.example --json
```

For local validation without starting the daemon or browser, put parameters in one object file:

```bash
browser-pilot validate execute --params @params.json --json
browser-pilot validate http-replay --params @replay-params.json --json
```

### Natural action subcommands

`wait`, `network`, `frame`, and selected `hook` actions expose natural action subcommands for the
common agent path:

```bash
browser-pilot wait selector --selector "#ready" --json
browser-pilot wait navigate --url https://example.test --json
browser-pilot wait network-idle --json
browser-pilot network start --json
browser-pilot network list --session-id net-1 --json
browser-pilot network export-har --session-id net-1 --json
browser-pilot frame list --json
browser-pilot frame evaluate --frame-id frame-1 --expression "document.body.innerText" --json
browser-pilot hook install-targets --targets console,error --json
browser-pilot hook collect --session-id hook-1 --json
```

These are CLI routing sugar over the same underlying tools and are equivalent to the legacy
`--action` form. Keep the legacy form for compatibility, full native-action coverage, and advanced
JSON protocol access:

```bash
browser-pilot wait --action selector --params '{"selector":"#ready"}' --json
```

For full bridge-native objects that do not fit a modeled command, use the command escape hatch:

```bash
browser-pilot command --command @native-command.json --json
```

Natural routing is intentionally scoped. Complex or low-frequency actions such as frame script
lifecycle operations, hook listener-chain inspection, or hook event-listener mutation remain available
through the advanced `--action/--params` interface.

For `hook install-targets`, target ids are the `hook list-targets` ids such as `console` and `error`.
The natural CLI route accepts either comma-separated values (`--targets console,error`) or repeated
flags (`--targets console --targets error`); file-backed arrays still use `--targets @targets.json`.

Use `browser-pilot <cmd> --help`, `browser-pilot <cmd> <natural-subcommand> --help`, or
`browser-pilot schema <cmd> <natural-subcommand> --json` to discover narrowed action-specific flags
without starting the daemon or browser.

### Agent routing metadata

`browser-pilot commands --json` and `browser-pilot schema <cmd> [natural-subcommand] --json` expose an
`agentCli` object so agents do not have to infer route quality from help prose:

- `mode:"standard"` — ordinary recommended command flags.
- `mode:"natural"` — recommended action subcommand, such as `wait selector`; it also includes the
  underlying native action it translates to.
- `mode:"advancedCompatibility"` — supported `--action/--params` interface for compatibility,
  complete native action coverage, and advanced JSON escape use.
- `mode:"nativeEscapeHatch"` — `command --command`, the full native bridge command-object escape
  hatch.

Skills should teach `standard` and `natural` routes first, and reserve the advanced modes for legacy
scripts, actions without a natural route, or complex command objects.

For action tools, bare `schema wait|network|frame|hook --json` still marks the root command as
`advancedCompatibility` because the root invocation is the low-level `--action/--params` interface,
but it also includes `subcommands[]` with the recommended natural routes. Use
`schema hook install-targets --json` or `schema frame evaluate --json` for the narrowed flag mapping.

The same discovery objects include `artifactBehavior`, which describes the shared result-artifact
contract: results with `saved.path` are enriched with `artifacts[]` and executable `readCommands`;
`cliNextActions[]` only carries non-duplicate follow-up actions. Bounded follow-up reads use
`browser-pilot artifact --path <saved.path>`.

## Output

- **TTY** → a compact human summary (+ `nextActions`, artifact path, diagnostics).
- **non-TTY** (pipes, agents, CI) → the distilled envelope as raw JSON.
- Force with `--json` / `--text`; global output flags may appear before the subcommand
  (`browser-pilot --json commands`) or after it (`browser-pilot commands --json`). If both are
  present, the last one in argv wins.

Exit codes: `0` ok · `1` tool error (envelope `terminate`) · `2` usage/param error · `3`
daemon/bridge unavailable · `4` local file/stdin input error.

In JSON mode, usage, local input, daemon unavailable, daemon invoke, and tool/runtime failures all
return one parseable JSON object on stdout. Daemon invoke errors include `taxonomy`, `diagnostics`,
`recovery.commands[]`, and `nextActions` such as `browser-pilot schema <cmd> --json`,
`browser-pilot validate <cmd> --params @params.json --json`, `browser-pilot doctor --json`, and
`browser-pilot daemon status --json`.

For machine JSON, invoke the installed `browser-pilot` binary, `node dist/cli/bin.js`, or the source
entry directly. During repo-local debugging, use `npm --silent run cli -- ...`; ordinary
`npm run cli -- ...` prints npm lifecycle banner text to stdout before the CLI output, so it is not
a valid single-JSON transport.

## Daemon lifecycle

```bash
browser-pilot connect --wait --timeout-ms 15000 --json  # agent readiness gate
browser-pilot status --json                             # compact read-only readiness state
browser-pilot status --tabs --json                      # include full tabs[] when needed
browser-pilot daemon status     # {pid, controlPort, version, expectedVersion, versionStale, bridgePort, extensionConnected, extension, tabCount, activeTab, health, tools}
browser-pilot daemon start      # foreground (auto-start spawns this detached)
browser-pilot daemon stop       # stop the singleton daemon
```

The recommended agent path is `connect --wait` at the start of a multi-step task, then ordinary
`browser-pilot` commands. Do not use `daemon stop` as normal task cleanup; it is an advanced lifecycle
command for tests, profile/port conflicts, upgrades, or explicit resource release.

The daemon starts the browser bridge lazily on the first tool call, or explicitly through
`connect`. If a browser extension is
already attached to another bridge on the first port in `18765-18784`, a second daemon binds the
next free port and will not see that extension — run a single daemon per user/profile.
Concurrent cold starts coordinate through a user-local start lock so two agents do not both spawn a
detached daemon while the first one is still writing its lockfile.
CLI tool invocations automatically replace a lockfile-backed daemon whose recorded version does
not match the current CLI package + daemon protocol version; `doctor --json` and
`status` / `connect` / `doctor` / `daemon status --json` expose daemon
`versionStale` and extension build-skew diagnostics (`extension.extensionStale`,
`expectedBuild`, `reportedBuild`, `buildManifestPath`) for read-only diagnosis.
If a command fails with unexplained `INVALID_RULE` / unsupported action while the
package is current, reload the extension and re-check these fields.
`daemon stop` only escalates to process signals after the token-guarded `/shutdown` control
request is acknowledged. A stale lockfile whose PID is still alive but whose control port is
unreachable is left untouched to avoid killing an unrelated PID that the OS may have reused.
In JSON mode, `daemon status`, `daemon stop`, and `doctor` expose this case as
`staleLockfile` with non-sensitive fields (`pid`, `controlHost`, `controlPort`, `version`,
`pidAlive`, `unreachable`); the daemon token is never emitted.

## Readiness

`browser-pilot connect --wait --timeout-ms 15000 --json` is the first command an external agent should
run for a multi-step browser workflow. It returns one JSON object with `ready`, `startedDaemon`,
`startedBridge`, `waitedMs`, `daemon`, `bridge`, `extension`, `tabCount`, `activeTab`, `health`, and
`recovery.commands[]`. Pass `--tabs` to include full `tabs[]`; the default is intentionally compact
for multi-tab profiles. If the extension does not connect before the timeout, it exits `3` with
`code:"CLI_EXTENSION_NOT_CONNECTED"` and concrete recovery commands. If the daemon cannot start the
bridge server, it exits `3` with `code:"CLI_BRIDGE_START_FAILED"` so agents can inspect daemon/bridge
startup diagnostics before waiting on the browser extension.

`browser-pilot status --json` is the fast read-only state check. It never auto-starts daemon or bridge;
with no daemon it returns `ready:false` and exit `0`. When a daemon is reachable it reports
`tabCount`, `activeTab`, and `health` fields such as `lastPingAt`, `lastPongAt`, `connectedForMs`,
and `tabSyncAgeMs`; use `status --tabs --json` only when the agent needs the full tab list.

`browser-pilot doctor --json` is read-only and broader diagnostics. It reports the CLI package `version`, caller `cwd`,
`commandCount`, `commandGroups`, `webSecurityCommandCount`, daemon `lockfile`, daemon
`reachable`/`running`, expected daemon version, bridge port/running state, extension connectivity,
the selected/active tab summary when available, the caller-local `artifactRoot`, and structured
`recovery.commands[]` entries with both display `command` and executable `argv`.

`browser-pilot selftest --confirm --json` is the bounded live smoke. It may create, use, and close a
temporary safe tab, and reports each cleanup step in JSON.

## Artifact Reads

When a CLI result writes `saved.path`, JSON mode adds normalized `artifacts[]` and
deduplicated `cliNextActions[]` entries. The generic read is:

```bash
browser-pilot artifact --path <saved.path> --mode json --json-path data --json
```

Common direct reads are also emitted under `artifacts[].readCommands` so agents do not have to guess
artifact shape:

```bash
browser-pilot artifact --path <saved.path> --mode json --json-path data.content --json
browser-pilot artifact --path <saved.path> --mode json --json-path data.actionables --json
browser-pilot artifact --path <saved.path> --mode json --json-path data.list_hints --json
```

## Tool Surface

All 22 `browser_*` commands — including web-security — are exposed by default. There is no
capability profile, compact/minimal visibility mode, or discovery step; `browser-pilot --help`
always lists the full set. WebSecurity commands still carry group metadata for docs and UI
organization, but registration is always-on.

## Usage logging

Set `PI_BROWSER_USAGE_LOG=<path>` to append one JSON line per invocation (tool, timing, result
size, and CLI routing metadata such as `routing:"natural"` versus
`routing:"advancedCompatibility"`) for studying real usage. Off by default; best-effort writes.
Arguments are redacted by default; `PI_BROWSER_USAGE_LOG_RAW=1` is available only for controlled
local debugging.

## Connection & TLS environment

- **`PI_BROWSER_EXTENSION_WAIT_MS`** — grace (ms) a command waits for a not-yet-connected browser
  extension to dial into the bridge before failing. Default `5000`; `0` disables the wait. The MV3
  service worker is often merely idle on a cold start, so this lets the first `tabs list` succeed
  transparently. When no extension connects in time, the command fails with an actionable
  `NO_BROWSER_EXTENSION` error whose `recovery.nextActions` name the fix (load/enable the extension,
  open or reload a tab, check `browser-pilot daemon status`). Inspect connection state any time with
  `browser-pilot daemon status` / `browser-pilot doctor` (`extensionConnected`).
- **`PI_BROWSER_NO_SYSTEM_CA`** — set to `1` to stop the daemon from trusting the OS/browser CA
  store. By default (Node ≥22.15) the daemon launches with `--use-system-ca` so outbound
  web-security fetches (`crawl`/`fuzz`/`http_replay`) work behind a TLS-intercepting proxy/AV or a
  corporate root CA without disabling certificate verification. TLS chain failures still surface a
  remediation (set `NODE_EXTRA_CA_CERTS=<pem>` or fix the server chain).

## Verification

`npm run smoke:cli` drives a representative full path (daemon → `/invoke` → bridge → extension →
page eval → back) against a live browser.

`npm run smoke:cli:full` is the heavier full CLI runtime audit. It launches an isolated Edge/Chrome
profile with a temporary patched extension and a temporary `PI_BROWSER_DAEMON_STATE_DIR`, then runs
real `browser-pilot` CLI subprocesses across all 22 commands, local discovery/help/schema/validate,
natural `wait`/`network`/`frame`/`hook` routes, file inputs, `command --command @file`, WebSecurity
HTTP helpers, memory, transfer, artifacts, and selftest. Results are written to
`.pi/browser-artifacts/smoke-cli-full-results.json`.

`npm run check:cli-parity` asserts every registered tool has a subcommand and that the 22-command
surface stays aligned with Pi-native registration.
