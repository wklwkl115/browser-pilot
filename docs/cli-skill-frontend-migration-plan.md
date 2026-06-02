# CLI + Skill Frontend Migration Plan

> Status: planning contract. Defines the accepted direction to make a `pi-browser`
> CLI (+ Skill) the primary frontend and remove the MCP server shell. It does not
> describe currently shipping behavior until implementation lands and generated
> docs are updated. Supersedes the MCP-server frontend as the externally promoted
> surface; the Pi-native extension entry (`index.ts`) is unchanged.

## Decision source

User direction (2026-06-02): the MCP form underperforms in practice ("only good
native in Pi"); the ideal form is **CLI + Skill**, which has a broader adapter
surface than MCP. Confirmed decisions:

- **Remove `mcp/` entirely** (not "keep but demote").
- **Daemon** supports both auto-start and explicit `start/stop/status`.
- The Chrome extension + long-lived bridge layer stays (understood and required).

## Why CLI + Skill over MCP (motivation)

- 22 tool schemas bloat the agent's context; `browser_tool_discovery` (a tool to
  discover tools) is a symptom of a surface too large for the tool-list paradigm.
- MCP results are token-heavy JSON; the server connection is flaky (it dropped
  mid-session during real use).
- Outside Pi, a generic MCP client gets only cold schemas — stripped of the
  `promptSnippet`/`promptGuidelines`/Skill guidance layer that actually makes the
  tools usable. What makes Pi good is that guidance layer, not MCP.
- A CLI is consumable by any shell-capable agent + humans + CI + cron (a strict
  superset of MCP clients), invoked via Bash with no tool-list bloat; the Skill is
  the portable knowledge layer.

## Governing principles

- **Frontend-agnostic core**: `registerBrowserTools(adapter, server, ensureStarted, opts)`
  (`src/tools/registerTools.ts`) is the single seam every frontend consumes. Pi
  host (`index.ts`) and the MCP server consume it today via a tool-collecting
  adapter; the CLI client + daemon become the new consumers.
- **Extract before delete**: reusable, non-MCP infra living under `mcp/` must be
  relocated into the core, never lost. (See coupling map — this is larger than the
  four files first assumed.)
- **Zero new runtime deps**: enforced by `check-dependencies.mjs`. No
  commander/yargs — hand-roll argv parsing driven by the existing TypeBox schemas;
  reuse `validateToolArgs` for coercion/validation.
- **No capability weakening**: the CLI exposes every registered tool (per
  `PI_BROWSER_TOOL_PROFILE`); no MCP-style compact/minimal visibility (a CLI's
  command list is not a context cost).
- **Evidence/redaction unchanged**: tools still write artifacts under the caller's
  `.pi/` and redact by default; `redact:false` opt-out preserved.

## Architecture

```
pi-browser <subcommand> [--flags]            (short-lived client)
  ├─ in-process: registerBrowserTools(ToolCollectingAdapter) → flag specs + --help + argv→params
  └─ POST /invoke {tool, params, cwd} ─► bridge daemon (long-lived)
                                            ├─ owns BrowserBridgeServer (extension WS, ports 18765-18784)
                                            ├─ registerBrowserTools(collector, server, ensureStarted, {profile, memoryEvidenceResolver})
                                            ├─ loopback control HTTP server (own port, token-guarded)
                                            └─ lockfile .pi/browser-daemon.json {pid, controlPort, token, bridgePort}
```

Parsing/help is **local** (registration is cheap, no bridge start); only tool
**execution** is delegated to the daemon (it holds the live browser). The client's
`cwd` is forwarded in `/invoke` so artifacts land under the caller's `.pi/`, not
the daemon's.

---

## Coupling map (discovered during reconnaissance — the load-bearing part)

`mcp/` is NOT cleanly separable: several modules under it are shared infra the
**core `src/` (and therefore the Pi extension) already depends on**. Naively
deleting `mcp/` breaks Pi-native too. Classify every `mcp/` file:

### A. Relocate to `src/frontend/` — frontend infra (rename, drop "Mcp")

| From | To | Rename / fix |
|---|---|---|
| `mcp/adapter.ts` | `src/frontend/toolCollector.ts` | class `McpExtensionAdapter` → `ToolCollectingAdapter` |
| `mcp/validation.ts` | `src/frontend/validation.ts` | `validateMcpToolArgs`→`validateToolArgs`, `McpValidationResult`→`ToolValidationResult` |
| `mcp/middleware.ts` | `src/frontend/middleware.ts` | `timingLogHook` log prefix `[pi-browser-mcp]`→`[pi-browser]` |
| `mcp/usageLog.ts` | `src/frontend/usageLog.ts` | import `../src/utils/redaction.js`→`../utils/redaction.js` |

### B. Relocate to `src/resources/` — ref/resource infra USED BY CORE

These back the `pi-ref://` / `browser-result://` descriptor registry that
`src/abml/verbs/*` and `src/tools/summaries/scan.ts` register into and the memory
tool resolves. Shared, not MCP-only.

| From | To | Import fixes after move |
|---|---|---|
| `mcp/resourceStore.ts` | `src/resources/resourceStore.ts` | `../src/abml/{types,refPolicy}.js`→`../abml/...` |
| `mcp/resourceReader.ts` | `src/resources/resourceReader.ts` | `../src/tools/artifactReader.js`→`../tools/artifactReader.js` |
| `mcp/resourceFreshness.ts` | `src/resources/resourceFreshness.ts` | `../src/utils/fileFreshness.js`→`../utils/fileFreshness.js` |
| `mcp/memoryResourceStore.ts` | `src/resources/memoryResourceStore.ts` | `../src/tools/memory/{paths,indexStore}.js`→`../tools/memory/...` |
| `mcp/memoryResourceReader.ts` | `src/resources/memoryResourceReader.ts` | `../src/tools/memory/reader.js`→`../tools/memory/reader.js` |

> `memoryResourceStore` exports `resolveBrowserResultEvidence` — the memory
> evidence resolver. Pi's entry does not pass it, but a unit test exercises it and
> the **daemon should pass it** to `registerBrowserTools` so `browser_memory`
> evidence resolution does not regress.

### C. Delete — true MCP-protocol shell (nothing in core imports these)

`mcp/index.ts`, `mcp/bin.ts`, `mcp/handleResolver.ts`, `mcp/handleFields.ts`,
`mcp/jsonPath.ts`, `mcp/prompts.ts`, `mcp/structuredEnvelopeSchema.ts`,
`mcp/toolAnnotations.ts`, `mcp/toolVisibility.ts` → after A+B, `rm -r mcp/`.

### Importers to repoint (verified)

- **Core (`src/`, 8 files):** `src/abml/verbs/{ax,frame,pierce,stream,vision,}Runtime.ts` + `src/tools/summaries/scan.ts` — `../../../mcp/resourceStore.js`→`../../resources/resourceStore.js` (stream also `resourceReader`).
- **Unit tests (5):** `tests/unit/abml/{frame,stream,pierce,vision}-runtime.test.ts`, `tests/unit/memory/evidenceResolve.test.ts` — `../../../mcp/resourceStore.ts`→`../../../src/resources/resourceStore.ts` (evidenceResolve also `memoryResourceStore`).
- **`tests/unit/tools/frame-abml-integration.test.ts`** — `McpExtensionAdapter` from `mcp/adapter.ts` → `ToolCollectingAdapter` from `src/frontend/toolCollector.ts`. *(Was missing from the original plan.)*
- **Smoke (2):** `tests/smoke/smoke-browser-memory.mjs`, `tests/smoke/smoke-abml-internal-tool-routing.mjs` — same adapter repoint.
- **Move + repoint moved unit tests:** `tests/unit/mcp/{validation,usageLog}.test.ts` → `tests/unit/frontend/` (fix imports + `validateToolArgs` rename).

---

## Contract & manifest surgery (MCP assumptions run deep)

### Delete (14) — `tests/contracts/tools/check-mcp-*.mjs`
`conformance, tools-list, resources, etag, sections, list-changed, prompts,
ingress-handles, structured-envelope, dynamic-tools, e2e, middleware, memory,
parameter-contract`.

### Keep (verified NOT to depend on `mcp/`)
`check-memory-autosurface`, `check-memory-lifecycle`, `check-token-economy`,
`check-jshookmcp-closure` — they drive the tool layer directly.

### Re-create as frontend/CLI tests
- Validation already covered by `tests/unit/frontend/validation.test.ts` (moved).
- Add a frontend middleware unit test (replaces `check-mcp-middleware`).
- Add `tests/contracts/cli/check-cli-parity.mjs` — every registered tool has a
  subcommand + non-empty help; counts **15 core / 22 security** (mirror
  `check-mcp-tools-list.mjs`'s assertions before deleting it).

### `package.json`
- `exports`: remove `"./mcp"`.
- `bin`: `pi-browser-mcp`→`pi-browser` (`./dist/cli/bin.js`).
- `scripts`: remove all `check:mcp-*` (14) and `"mcp": "tsx mcp/index.ts"`; add `check:cli-parity` (+ any cli checks).
- `dependencies`: remove `@modelcontextprotocol/sdk` → allowlist becomes `["js-yaml","typebox","typescript","ws","zod"]`.
- `files`: `"mcp/"`→`"cli/"`.
- **Regenerate `package-lock.json`** (`npm install`) — `check-dependencies.mjs` asserts lockfile `dependencies` deep-equal `package.json` and runs `npm ls`.

### Config / contract files
- `tsconfig.build.json` include: `"mcp/**/*.ts"`→`"cli/**/*.ts"`.
- `tests/contracts/drift/check-dependencies.mjs` (allowlist assert): drop the SDK.
- `tests/contracts/drift/check-package-files.mjs` (deep MCP asserts): bin
  `pi-browser-mcp`→`pi-browser`/`dist/cli/bin.js`; remove `exports."./mcp"` asserts;
  drop `"mcp"` from the tsx-scripts list; `distFiles`/packed asserts
  `dist/mcp/{bin,index}.js`→`dist/cli/bin.js`.
- `scripts/run-check-groups.mjs` `contracts` group: remove the 14 `check:mcp-*`;
  keep memory/token-economy/jshook entries; add `check:cli-parity`.
- `tests/contracts/protocol/check-pi-browser-bridge.mjs:1326-1327` skill grep:
  `"browser_tabs list"`→`"pi-browser tabs list"`.

---

## New CLI (`cli/`, mirrors the old `mcp/` layout)

- `cli/flags.ts` — TypeBox `parameters` (`.properties`/`.required`, `type`/`anyOf`/
  `items`/`description`) → flag specs. `String/Number`→`--x <v>`; `Boolean`→
  `--x`/`--no-x`; `Union([Literal…])`→`--x <enum>`; `Array`→repeatable; `Object`/
  `Record`→`--x <json>`. Subcommand = tool minus `browser_`, `_`→`-`. Collect raw
  argv → `validateToolArgs` (coerce/validate — do NOT re-implement coercion).
  Support `--flag @file` and `--flag -` (stdin).
- `cli/render.ts` — `--json`/non-TTY → raw envelope text; TTY → summary +
  `nextActions` + artifact path + diagnostics; errors→stderr + `recovery`. Exit
  codes 0 ok / 1 tool error / 2 usage / 3 daemon-unavailable. Zero-dep ANSI.
- `cli/registry.ts` — `buildCliCommands({securityToolsEnabled})` via
  `registerBrowserTools(new ToolCollectingAdapter(), placeholderServer, noopEnsureStarted, …)`
  (pattern from `check-mcp-tools-list.mjs`). Profile via `resolveBrowserToolCapabilityProfile()`.
- `cli/daemon.ts` — owns `BrowserBridgeServer` + lazy `ensureStarted` (copy the
  closure from `index.ts`) + `registerBrowserTools(collector, server, ensureStarted,
  {securityToolsEnabled, memoryEvidenceResolver: resolveBrowserResultEvidence})` +
  usage-log hook + loopback `node:http` control server + lockfile + SIGINT/SIGTERM
  teardown. Control endpoints (127.0.0.1, `x-pi-daemon-token`): `POST /invoke
  {tool, params, cwd}`, `GET /status` (`server.snapshot()`), `POST /shutdown`.
- `cli/daemonControl.ts` — `.pi/browser-daemon.json` `{pid, controlHost, controlPort,
  token, bridgePort, startedAt, version}`; `findDaemon`/`ensureDaemon` (auto-start:
  spawn detached `pi-browser daemon start`, poll `/status`)/`stopDaemon`; stale
  detection (dead pid / failing status → respawn).
- `cli/client.ts` — `ensureDaemon()`→`POST /invoke`→`render`.
- `cli/index.ts` — dispatch `--help` / `<subcommand>` / `daemon start|stop|status`;
  global flags `--json/--text`, `--detail-level`, `--max-chars`, `--timeout-ms`,
  `--redact/--no-redact`, `--tab-id`, `--browser-session-id`, `--output-path`.
- `cli/bin.ts` — `#!/usr/bin/env node` → `import "./index.js"`.

## Skill + docs

- `skills/pi-browser-tools/SKILL.md`: invocation examples → `pi-browser <cmd>`
  (`browser_observe {mode:"scan"}`→`pi-browser observe --mode scan`); keep Loop /
  Routes / Recovery / Memory; add an **Invocation** preamble (daemon auto-starts;
  `--json` off-TTY; `--help`); drop the visibility/`browser_tool_discovery` section.
- `CLAUDE.md` architecture (MCP layer → CLI + daemon) + Common Commands; `AI_INSTALL.md`,
  `README.md`, `docs/browser-usage.md`, `docs/tool-boundaries.md`; add `docs/cli.md`;
  regenerate `docs/generated/*`.

---

## Sequencing (each commit green; the package contract dictates the order)

`check-package-files.mjs` asserts a **packed bin + lockfile consistency**, so the
first fully-`npm run check`-green state must include the CLI build. Recommended
commits:

1. **relocate + remove MCP shell** — A+B moves, repoint all core/test importers,
   `rm -r mcp/` + delete 14 contract tests, `tsconfig.build`(drop mcp),
   `run-check-groups`(drop mcp), `package.json`(drop `./mcp` export, mcp scripts,
   SDK dep, `files`; **temporarily remove `bin`**), lockfile sync,
   `check-dependencies`(allowlist), `check-package-files`(drop all mcp/bin/dist
   asserts; do not yet require a bin). Gate: `tsc -p tsconfig.json` (excludes mcp),
   `tsc -p tsconfig.bridge-src.json`, `npm run build`, `npm run test:unit`, and the
   trimmed `npm run check`.
2. **CLI client + daemon** — add `cli/`; `package.json` bin `pi-browser` + `files`
   `cli/`; `tsconfig.build` add `cli/**`; `check-package-files` assert
   `dist/cli/bin.js`; `check:cli-parity` + `run-check-groups`. Gate: full `npm run check`.
3. **Skill + docs** — rewrite + regenerate + skill-grep contract update.
4. **Tests + verify** — frontend middleware test, cli flag/render units, daemon
   lifecycle test, live `tests/smoke/smoke-cli.mjs`; `npm run quality:local`.

(Commits 1–2 may be merged if preferred; the constraint is only that a
`check`-green state never expects a bin/dist file that isn't built yet.)

## Verification

- `tsc` (both) + `npm run build` + `npm run test:unit` + `npm run check` green.
- Live browser: `pi-browser tabs list`, `pi-browser observe --mode scan`,
  `pi-browser cookie-analyze --url … --bind-browser-session`,
  `pi-browser execute --script … --no-redact`; confirm human + `--json` output,
  exit codes, daemon auto-start, artifacts under the caller's `.pi/`.
- `npm run quality:local` before merge.

## Non-goals

- No change to `bridge_src/` (extension) or `bridge/native_command_schema.json`
  (protocol untouched).
- No new runtime dependency; no CLI framework.
- No MCP compatibility shim left behind (the protocol shell is removed, not demoted).
- No change to Pi-native registration (`index.ts`) beyond what the relocation
  requires.

## Risks / notes

- **Irreversible**: MCP removal deletes the only non-Pi structured frontend until
  the CLI lands; do A+B (extract) fully before any deletion.
- **Lockfile drift**: forgetting `npm install` after dropping the SDK fails
  `check-dependencies` (lockfile vs package.json equality + `npm ls`).
- **Hidden coupling** (above) is the main trap — `src/abml/verbs/*` and the memory
  tool depend on the resource store that currently lives under `mcp/`.
- The live `smoke-cli.mjs` only runs with a connected browser (CI-skipped, like the
  other browser smokes).
- New top-level `cli/` dir → add to `tsconfig.build.json` include and `package.json`
  `files`; consider `npm run docs:sync-indexes` if a doc index references it.
