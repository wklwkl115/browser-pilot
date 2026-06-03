# CLI + Skill Frontend Migration Plan

> **Status: COMPLETE — landed 2026-06-03.** Shipping external frontends are now **Pi-native
> entry (`index.ts`) + `pi-browser` CLI (`cli/`)**; the MCP shell (`mcp/`) was removed. P0–P4 all
> landed and `npm run check` passes end to end (incl. `check:cli-parity`, `check:cli-migration-drift`),
> the live-browser `npm run smoke:cli` passes, and Pi-native registers all 22 tools with zero mcp
> imports. CLI usage: `docs/cli.md`. This document is retained as the historical execution record;
> the checklist below reflects the completed state.

## Decision source

User direction (2026-06-02): MCP underperforms in real use; preferred form is **CLI + Skill**. Confirmed product decisions:

- Remove `mcp/` entirely after replacement parity is green.
- Keep the Chrome extension + long-lived bridge layer.
- Support both daemon auto-start and explicit `start/stop/status`.
- Keep the Pi-native extension entry (`index.ts`) unchanged.

## Goal

Make `pi-browser` CLI + Skill the primary external frontend while preserving:

- canonical `browser_*` tool capability set
- current artifact/evidence/redaction behavior
- Pi-native registration path
- zero new runtime dependencies

## Fixed issues from plan review

This revision closes the gaps found in the first draft:

1. **No green-gap deletion.** Do **not** remove the MCP shell before CLI parity, replacement contracts, and current-facing docs are ready.
2. **Caller cwd is explicit.** Request-scoped artifact/memory/wordlist/OAST/crawl/sqlmap/nuclei paths must flow from the CLI caller `cwd`, not daemon `process.cwd()`.
3. **Daemon auto-start is local-process based.** Spawn with `process.execPath` + resolved local `dist/cli/bin.js`; do not shell out to `pi-browser` by bin name.
4. **Daemon scope is explicit.** Use a **user-local singleton daemon**; do not store daemon lock state under the caller project `.pi/`.
5. **Docs/contracts scope is explicit.** Current-facing docs must switch only when the behavior lands; historical docs may retain MCP history.

## Repo facts (post-migration, 2026-06-03)

The pre-activation facts below were the starting point; all are now resolved:

- `cli/` exists (bin/client/daemon/daemonControl/flags/index/registry/render); `mcp/` was deleted.
- `package.json` exposes only the `pi-browser` bin and the `.` export; `./mcp`, `pi-browser-mcp`,
  `mcp`/`check:mcp-*` scripts, and `@modelcontextprotocol/sdk` are all removed (prod deps:
  js-yaml/typebox/typescript/ws/zod).
- Shared infra lives in `src/frontend/` + `src/resources/`; no active code imports `mcp/`
  (locked by `check:cli-migration-drift`).
- Request-scoped path writers thread the caller `cwd` (`requestCwd(options)` from the
  `runWebSecurityTool` adapter): nucleiBridge, sqlmapBridge, crawl, and **oastWorkerManager**
  (callback-OAST session root is now caller-cwd-rooted, not `process.cwd()`).
- Current-facing docs/skill describe the CLI; MCP mentions remain only as historical notes.

## Accepted migration decisions

### 1. Frontend split

Keep one tool core. Move reusable non-protocol frontend code out of `mcp/`:

- frontend helpers → `src/frontend/`
- ref/resource infra used by core → `src/resources/`
- only the protocol shell stays delete-only until final cutover

### 2. No hidden browser startup in CLI help/list paths

CLI parsing/help/command registry must be local and cheap:

- build subcommands from registered tool metadata
- do **not** start `BrowserBridgeServer` for `--help`, local command lookup, or parity checks
- tool execution only is delegated to the daemon

### 3. Daemon scope contract

The daemon is a **user-local singleton per user/profile**, not per caller cwd.

- daemon control state/lockfile lives in a user-local state root
- caller project `.pi/` remains for artifacts, memory, and evidence output only
- `status` / `stop` address the singleton daemon
- multiple projects can invoke the same daemon; per-call `cwd` decides artifact/memory roots

### 4. Caller-cwd contract

Every request-scoped path decision must use explicit caller `cwd`:

- artifact output roots
- browser memory roots
- bounded wordlist path allowlists
- sqlmap/nuclei/crawl temporary artifact dirs
- callback OAST persisted session state

`process.cwd()` may remain only for:

- build/release/check scripts
- process-global daemon state fallback
- code paths that are truly process-global and not request-scoped

### 5. Current-facing docs vs historical docs

Current-facing docs must switch when behavior lands:

- `README.md`
- `AI_INSTALL.md`
- `CLAUDE.md`
- `skills/pi-browser-tools/SKILL.md`
- `docs/browser-usage.md`
- `docs/tool-boundaries.md`
- `docs/generated/**`
- `CURRENT.md`
- `TODO.md`

Historical docs may retain MCP history and are **not** migration blockers by themselves:

- `CHANGELOG.md`
- `ARCHIVE.md`
- `docs/archive/**`
- completed historical plan/docs such as `docs/mcp-standardization-progressive-disclosure-plan.md`

### 6. No capability weakening

- CLI exposes every registered tool allowed by `PI_BROWSER_TOOL_PROFILE`.
- No compact/minimal visibility mode and no `browser_tool_discovery` replacement.
- No MCP compatibility shim remains after cutover.

## Coupling map

### A. Relocate to `src/frontend/`

| From | To | Rename / fix |
|---|---|---|
| `mcp/adapter.ts` | `src/frontend/toolCollector.ts` | `McpExtensionAdapter` → `ToolCollectingAdapter` |
| `mcp/validation.ts` | `src/frontend/validation.ts` | `validateMcpToolArgs` → `validateToolArgs`; `McpValidationResult` → `ToolValidationResult` |
| `mcp/middleware.ts` | `src/frontend/middleware.ts` | log prefix `[pi-browser-mcp]` → `[pi-browser]` |
| `mcp/usageLog.ts` | `src/frontend/usageLog.ts` | fix imports to `src/utils/...` |

### B. Relocate to `src/resources/`

| From | To | Notes |
|---|---|---|
| `mcp/resourceStore.ts` | `src/resources/resourceStore.ts` | shared by ABML/runtime/tests |
| `mcp/resourceReader.ts` | `src/resources/resourceReader.ts` | shared by stream/runtime reads |
| `mcp/resourceFreshness.ts` | `src/resources/resourceFreshness.ts` | shared freshness helpers |
| `mcp/memoryResourceStore.ts` | `src/resources/memoryResourceStore.ts` | keep `resolveBrowserResultEvidence` export |
| `mcp/memoryResourceReader.ts` | `src/resources/memoryResourceReader.ts` | shared browser-memory resource reader |

### C. Delete only after replacement parity is green

`mcp/index.ts`, `mcp/bin.ts`, `mcp/handleResolver.ts`, `mcp/handleFields.ts`, `mcp/jsonPath.ts`, `mcp/prompts.ts`, `mcp/structuredEnvelopeSchema.ts`, `mcp/toolAnnotations.ts`, `mcp/toolVisibility.ts`.

## Phase gates

| Phase | Goal | Must stay true | Gate |
|---|---|---|---|
| P0 | activate plan + freeze scope | shipping behavior still MCP + Pi-native | `npm run check:doc-structure` |
| P1 | shared infra relocation + cwd propagation | MCP shell still works | `check:src:types` + `test:unit` + targeted contracts |
| P2 | CLI client + daemon | local help/list path does not start browser | build + frontend/CLI tests |
| P3 | package/contracts cutover + MCP removal | replacement checks green before deletion | `npm run check` + `npm pack --dry-run --json` |
| P4 | skill/docs/runtime verification | current-facing docs match shipped behavior | skill validate + smoke + `quality:local` |

## Execution phases

### P0 · Activate plan and freeze migration scope

- [x] Promote this document to the active execution contract.
- [x] Wire active queue references in `TODO.md` / `CURRENT.md` / `CLAUDE.md`.
- [x] Add a bounded migration drift contract for active code/tests/docs:
  - patterns: `mcp/`, `dist/mcp`, `pi-browser-mcp`, `@modelcontextprotocol/sdk`, `browser_tool_discovery`, `PI_BROWSER_MCP_`
  - exclude historical docs listed above
- [x] Record the final daemon state-root contract in code-facing docs before implementation begins.

### P1 · Shared infra relocation and caller-cwd propagation

- [x] Move frontend helpers from `mcp/` to `src/frontend/`.
- [x] Move resource/ref infra from `mcp/` to `src/resources/`.
- [x] Repoint all verified core/test/smoke importers away from `mcp/*`.
- [x] Add/rename frontend unit tests:
  - `tests/unit/frontend/validation.test.ts`
  - `tests/unit/frontend/usageLog.test.ts`
  - middleware unit coverage
- [x] Propagate caller `cwd` into every request-scoped path writer.
- [x] Remove MCP-only `browser_tool_discovery` references from active code paths once the tool is gone (for example `src/tools/memory/autoSurface.ts` and current-facing docs/skill).
- [x] Keep the MCP shell operational during this phase; no `rm -r mcp/` yet.

P1 gate:

- `npm run check:src:types`
- `npm run test:unit`
- targeted bridge/contracts as needed for repointed imports
- no active `src/**`, `index.ts`, `tests/**`, or smokes import shared infra from `mcp/*`

### P2 · CLI client + daemon

- [x] Add `cli/flags.ts`.
- [x] Add `cli/render.ts`.
- [x] Add `cli/registry.ts` using `ToolCollectingAdapter` and local tool metadata only.
- [x] Add `cli/client.ts`.
- [x] Add `cli/daemon.ts` with loopback control server and `memoryEvidenceResolver: resolveBrowserResultEvidence`.
- [x] Add `cli/daemonControl.ts` with singleton discovery, stale detection, and auto-start.
- [x] Add `cli/index.ts` and `cli/bin.ts`.
- [x] Auto-start via `process.execPath` + resolved local CLI entry, not shell `pi-browser`.
- [x] Pass caller `cwd` on every `/invoke` and execute tools with `{ cwd, hasUI:false }`.
- [x] Define CLI exit codes and non-TTY/TTY rendering behavior.

P2 gate:

- local `--help` / command parity path works without browser startup
- CLI unit coverage for flags/render/daemon control
- daemon lifecycle coverage
- replacement parity contract exists and passes for core/security profiles

### P3 · Package/contracts cutover and MCP shell removal

- [x] Replace `package.json` surface:
  - remove `./mcp`
  - `pi-browser-mcp` → `pi-browser`
  - drop `mcp` scripts
  - drop `@modelcontextprotocol/sdk`
  - add CLI parity scripts/tests
- [x] Update `tsconfig.build.json` include from `mcp/**/*.ts` to `cli/**/*.ts`.
- [x] Replace/remove MCP-specific contracts and grouped check entries.
- [x] Update `check-package-files.mjs`, `check-dependencies.mjs`, `check-bridge-files.mjs`, `check-pi-browser-bridge.mjs`, and `scripts/run-check-groups.mjs`.
- [x] Add CLI/frontend replacement contracts (including bounded drift contract from P0).
- [x] Delete the MCP protocol shell files from `mcp/` only after all replacement checks are green.
- [x] Regenerate `package-lock.json` after dependency changes.

P3 gate:

- `npm run build`
- `npm run check`
- `npm pack --dry-run --json`
- active code/tests/current-facing docs no longer depend on MCP-only names

### P4 · Skill/docs switch and runtime verification

- [x] Update `skills/pi-browser-tools/SKILL.md` to CLI invocation syntax.
- [x] Add `docs/cli.md`.
- [x] Update current-facing docs only after shipped behavior matches them:
  - `README.md`
  - `AI_INSTALL.md`
  - `CLAUDE.md`
  - `docs/browser-usage.md`
  - `docs/tool-boundaries.md`
  - `docs/generated/**`
- [x] Run skill validation.
- [x] Add and run live CLI smoke (`tests/smoke/smoke-cli.mjs`).
- [x] Archive the MCP frontend path as historical, not current behavior.

P4 gate:

- `PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/extensions/pi-browser-tools/skills/pi-browser-tools`
- live browser smoke for `pi-browser tabs list`, `observe --mode scan`, `execute`, `cookie-analyze`
- `npm run quality:local`

## Sequencing (green at every step)

1. **Docs activation + scope freeze** — this document, `TODO.md`, `CURRENT.md`, `CLAUDE.md`.
2. **Shared infra relocation + cwd propagation** — keep MCP shell alive.
3. **CLI + daemon implementation** — still keep MCP shell alive while parity/tests land.
4. **Package/contracts/docs cutover** — switch package/bin/contracts/current-facing docs, then delete MCP shell.
5. **Runtime verification + archive cleanup**.

There is intentionally **no** step that deletes `mcp/` before CLI parity and replacement contracts are green.

## Verification matrix

- P0: `npm run check:doc-structure`
- P1: `npm run check:src:types` + `npm run test:unit`
- P2: `npm run build` + CLI/frontend targeted tests
- P3: `npm run check` + `npm pack --dry-run --json`
- P4: skill validate + live smoke + `npm run quality:local`

## Non-goals

- no change to `bridge_src/` or `bridge/native_command_schema.json`
- no new runtime dependency / no CLI framework
- no new public `browser_*` tools
- no MCP compatibility shim left behind
- no change to Pi-native `index.ts` behavior beyond import relocation
- no current-facing doc claiming `pi-browser` exists before the implementation lands

## Current executable TODO queue

1. [x] Activate the migration plan in top-level docs.
2. [x] Add bounded migration drift contract and daemon scope contract.
3. [x] Relocate shared frontend/resources infra and repoint imports.
4. [x] Propagate caller `cwd` through every request-scoped path root.
5. [x] Implement CLI client + singleton daemon.
6. [x] Switch package/contracts/current-facing docs and remove MCP shell.
7. [x] Run skill validation, live CLI smoke, and `quality:local`.
