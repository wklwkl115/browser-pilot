# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> The **Design, Governance & Workflow Rules** section at the end of this file is generated from the project's `AGENTS.md` (shared with other agent tools such as Codex). Claude Code does not auto-read `AGENTS.md`, so edit `AGENTS.md` and run `npm run docs:sync` to refresh this copy. These rules inherit the parent `D:/Pi/agent/AGENTS.md`.

## Project Overview

**pi-browser-tools** is a native Pi browser automation extension that provides real browser tab control, simplified DOM scanning (GA-style), JavaScript/CDP execution, evidence capture, network recording, file transfer, and a Web security testing tool layer — all backed by a Chrome extension service worker and a Node.js bridge server.

## Design Philosophy

**Root-Truth Sourcing (釜底抽薪) — solve every problem at the lowest *real* layer, never on a convenient but lossy upper layer.** This is a standing stance, not a one-off technique: refuse to work on the lossy upper layer.

- **Building:** observe truth from *beneath* the abstraction boundary that hides it — CDP below the JS sandbox, the browser engine below any framework. Ask the engine directly (`DOMDebugger.getEventListeners`) instead of inferring from downstream artifacts (`__reactProps` / `cursor:pointer` heuristics).
- **Deciding:** source from running code (verified `file:line`), first principles, and measured / real-agent evidence — never from framework products or archived/superseded docs.
- **Root fix vs patch:** a fix must dissolve a whole *class* of inputs (agnostic by construction), not handle one instance — a tech-stack name appearing in the code is an overfit smell. Thread it by an identity that survives boundaries (`backendNodeId`, not CSS selector). Going lower is a hypothesis until proven at the mechanism and net-positive.

## Current Execution State

- Current execution entry: `CURRENT.md`; current top-level navigation: `TODO.md`; future routes:
  `ROADMAP.md`; completed summaries: `ARCHIVE.md`.
- Active execution line: none at the moment. New large workstreams must first record the decision, boundary, contract, and verification plan in `CURRENT.md`.
- Historical migration contract: `docs/archive/cli-skill-frontend-migration-plan.md`
- Current shipping external frontends are **Pi-native entry (`index.ts`) + `pi-browser` CLI (`cli/`)**. The MCP shell has been removed; CLI usage is documented in `docs/cli.md`.
- `pi-browser` CLI is shipped and the migration is complete (landed 2026-06-03): code, contracts, current-facing docs, skill text, and live-browser smoke (`npm run smoke:cli`) all passed. No migration items remain.
- `docs/archive/abml-execution-plan.md` is no longer the active queue; ABML remains an internal substrate / historical execution contract.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Chrome Extension (bridge_src/)                                 │
│  service-worker.ts → ESM bundle → bridge/dist/service-worker.js │
│  page_scripts/ → content.ts, hook_dispatcher.ts, disable_dialogs.ts
│  Commands: wait, network, hook, frame, screenshot, transfer...  │
└─────────────────────────┬───────────────────────────────────────┘
                          │ WebSocket (127.0.0.1:18765-18784)
┌─────────────────────────▼───────────────────────────────────────┐
│  Node.js Bridge Server (src/driver/)                            │
│  BrowserBridgeServer (facade)                                   │
│  ├─ BrowserBridgeHttpServer (HTTP/upgrade)                      │
│  ├─ BrowserBridgeClientRegistry (client connections)            │
│  ├─ BrowserTabSessionRouter (tabs/sessions)                     │
│  ├─ BrowserBridgePendingRequests (ACK/timeout)                  │
│  └─ BrowserBridgeDiagnostics (timeout snapshots)                │
└─────────────────────────┬───────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────────┐
│  Tool Layer (src/tools/)                                        │
│  toolRegistry.ts → declarative registration order               │
│  toolAdapter.ts → shared params, timeout, error wrapping        │
│  register*Tool.ts → schema + domain logic per tool              │
│  Core: tabs, execute, command, observe, pick, wait, network,    │
│        hook, evidence, frame, screenshot, artifact, download,   │
│        upload                                                    │
│  WebSecurity: recon, crawl, fuzz, sqli, nuclei, template,      │
│               oast, cookie, http_replay                         │
└─────────────────────────────────────────────────────────────────┘
```

### Four-Kernel Structure

The project has four pure-logic kernels, all zero browser/Node dependencies, each CI-boundary-locked:

| Kernel | Source | Purpose | Boundary check |
|--------|--------|---------|----------------|
| Capture (sense) | `capture-src/` → `src/capture/generated/` | Page-world JS templates injected into the browser | `check:capture` / `check-capture-core-boundary.mjs` (entry set pinned at 4; 5th entry fails gate) |
| ABML (perceive) | `src/abml-core/` | Entity extraction, diffing, templating, relations, causal | `check:abml-core-boundary` |
| Distill (express) | `src/distill-core/` | Token economy, salience renderer, fact allocator, recovery | `check:distill-core-boundary` |
| Memory (retain) | `src/memory-core/` | Profile distillation, recall scoring/IDF routing, staleness verification | `check:memory-core-boundary` |

`src/abml/`, `src/distill/`, and `src/memory/` are the respective runtime integration layers. Layer import order: `capture → abml-core → distill-core`; `memory-core` imports from no other kernel (structural types only); no kernel may import from the others' runtime layers, driver, or tools. The memory plane additionally has a runtime contract gate: `check:memory-plane` (byte-identity when disabled/empty, `livePlaneSignature()` preservation, negative controls).

### Frontend Migration Boundary

The migration kept one tool core and swapped the external frontend layer (now complete):

- reusable non-protocol frontend helpers live in `src/frontend/` (were in `mcp/`)
- shared ref/resource infra used by core lives in `src/resources/` (was in `mcp/`)
- request-scoped artifacts/memory/wordlists/temp roots use explicit caller `cwd`
- the CLI daemon is a **user-local singleton** (`~/.pi/browser-daemon.json`), not a per-project daemon
- `mcp/` was removed after CLI parity + replacement checks went green and the live-browser `smoke:cli` passed

### Protocol Single Source

`bridge/native_command_schema.json` is the single source of truth for the native command protocol. After modifying it:

```bash
npm run sync:protocol    # generates bridge dist, types, metadata, docs
npm run check:protocol   # verify no drift
```

A `lefthook` pre-commit hook auto-runs `npm run sync:protocol` and stages generated files when `bridge/native_command_schema.json` is in the commit.

Generated files (do NOT edit manually):
- `bridge/pi_browser_bridge/native_command_schema.json`
- `bridge_src/service_worker/protocol.ts`
- `src/protocol/nativeProtocol.ts`, `nativeActionMetadata.ts`, `nativeErrorCodes.ts`
- `docs/generated/native-protocol.generated.md`

## Common Commands

### Build
```bash
npm run build:bridge          # build extension dist from bridge_src/
npm run build                 # compile outer dist/ (index.ts + src/ + cli/) via tsc
```

### Lint
```bash
npm run lint                  # ESLint (flat config, eslint.config.js)
npm run lint:fix              # auto-fix
```

### Type Check
```bash
tsc -p tsconfig.json             # check src/ (Node.js code)
tsc -p tsconfig.bridge-src.json  # check bridge_src/ (extension code)
```

### Checks & Quality
```bash
npm run check                 # run all checks (bridge, unit, package, contracts)
npm run check:all:bridge      # bridge + unit tests only
npm run check:all:package     # package + docs checks only
npm run check:all:contracts   # contract tests only
npm run check:trace           # grouped runner trace with per-script durations
npm run check:dag             # graph-backed DAG runner with direct local binaries + ESLint
npm run check:dag -- --cache  # v2 per-node impact-map cache; global-scope nodes still use whole-repo keys
npm run check:smart           # impact-selected graph subset with conservative expansion
npm run quality:local         # build + check + pack dry-run (no browser)
```

### Tests
```bash
npm run test:unit              # run all unit tests (umbrella; DAG uses test:unit:* shards)
tsx --test tests/unit/tools/toolRegistry.test.ts   # run a single test file
npm run check:bridge           # bridge types + build + files + protocol + tools
npm run check:web-security     # web security layer boundaries
npm run check:lifecycle        # multi-browser/tab/MV3 fixtures
npm run check:runtime-fixtures # network/hook/wait/transfer fixtures
npm run check:capture          # capture-core boundary + entry-set pin
npm run check:task-conditioned-salience  # relevance/ledger behavior contract
npm run check:distill-core-boundary      # distill-core import boundary
npm run check:recovery-boundary          # recovery module boundary
npm run check:summary-boundary           # summary boundary
npm run check:session-delta-long-conversation  # session-delta regression
npm run check:memory-core-boundary       # memory-core import boundary
npm run check:memory-plane               # envelope.memory contract (byte-identity, signature, negative controls)
npm run bench:distill          # token-economy comparative bench (salience vs ladder)
```

### Governance gates
```bash
npm run check:governance        # runs all 6: spec-truth, surface-liveness, compute-once, purity-vocabulary, kernel-test-map, env-flags
```

Runs as part of `check:all:contracts`. Shared governance modules live in `tests/contracts/drift/`:
- `purity-vocabulary.js`, `spec-claims.js`, `kernel-export-inventory.json`, `kernel-test-map.json`, `env-flags.json`

```bash
npm run smoke:cli              # CLI smoke (requires browser)
npm run smoke:cli:full         # full CLI smoke including connection control
```

> **Note:** `npm run check` now runs through the DAG closing gate and includes ESLint as `lint:eslint`.

### Smoke Tests (require browser)
```bash
npm run smoke:browser                # full smoke against running browser
npm run smoke:browser:isolated       # isolated Chrome profile smoke
npm run smoke:browser:scan-summary   # scan summary smoke
npm run smoke:browser:transfer       # download/upload smoke
```

### Evals (agent-computer-interface quality)
```bash
npm run eval:browser-workflows -- --fixture-server   # deterministic regression layer (local fixtures)
npm run eval:blind:launch -- --confirm --url <site>  # blind real-agent discovery layer (isolated, real site)
npm run eval:blind:teardown                          # tear the blind stage down
```
Two layers: the **deterministic runner** replays human-authored sequences against local fixtures
(regression); the **blind-agent discovery loop** (mature-maintenance optimization driver) has a
skill-guided, implementation-blind subagent work a READ-ONLY task on a real, mainland-China-reachable
site and report triaged friction. The blind loop is operator-/cron-driven via the
`pi-browser-blind-eval` skill — **not** part of `npm run check`. See
`evals/browser-workflows/future-runner.md` (boundaries) and `evals/browser-workflows/blind-findings.md`.

### Docs & Protocol
```bash
npm run docs:sync             # regenerate tool contract docs, doc indexes, and managed blocks
npm run sync:protocol         # regenerate protocol from native_command_schema.json
```

## Key Files & Directories

- `src/tools/toolRegistry.ts` — declarative always-on tool registration order + core/security group metadata
- `src/tools/toolAdapter.ts` — shared param handling, timeout, error wrapping, artifact fallback
- `src/tools/resultMiddleware.ts` — shared envelope/result middleware; read with `src/tools/toolAdapter.ts`
- `src/tools/observe/` — observe runners, memory/relevance augmentation, render cache, and scan split
- `src/driver/BrowserBridgeServer.ts` — facade delegating to sub-registries
- `bridge_src/service-worker.ts` — Chrome extension entry point (ESM import graph)
- `bridge/native_command_schema.json` — native command protocol source of truth
- `src/abml-core/` — pure-logic ABML perception kernel (no browser deps); `src/abml/` — runtime integration
- `src/distill-core/` — pure-logic distill kernel: salience renderer, fact allocator, token economy, recovery, `PerceptionLedger`
- `src/memory-core/` — pure-logic memory kernel (retain): profile distillation, IDF recall routing, staleness verification; `src/memory/` — runtime persistence (HMAC stamps, serialized profile flushes)
- `capture-src/entries/*Template.ts` — page-world sensing templates (source); `src/capture/generated/` — committed bundles (do NOT edit manually); `src/capture/inject.ts` — injection coordinator
- `src/tools/webSecurity/` — `register/` (schemas), `browserNative/` (core execution), `bridges/` (sqlmap/nuclei), `shared/` (cookie provider, diagnostics)
- `tests/contracts/` — contract tests (protocol, tools, boundaries)
- `tests/smoke/` — browser smoke tests
- `evals/browser-workflows/` — ACI evals: deterministic `runner.mjs` + blind-agent discovery layer (`launch-blind.mjs`/`pb-blind.mjs`/`teardown-blind.mjs`, `blind-tasks-realsite.md`, `blind-findings.md`)
- `skills/pi-browser-tools/SKILL.md` — Pi-native skill source (junction at `D:/Pi/agent/skills/pi-browser-tools`); `skills/pi-browser-cli/SKILL.md` — CLI-first skill (not in Pi global junction — only for CLI agents)
- `skills/pi-browser-blind-eval/` — operator/cron procedure for the standing blind real-agent eval loop
- `skills/pi-kernel-audit/SKILL.md` — G7 operator/cron audit procedure; auditors write read-only reports under `agent-audits/runs/`; findings recurring a second time must graduate to a static G1–G6 gate
- `docs/maintainer-map.md`, `docs/reference/concept-ownership.md`, `docs/generated/browser-tool-contract.generated.md`, `docs/generated/native-protocol.generated.md`, `docs/generated/code-map.generated.md` — discovery indexes for landing changes, concept ownership, callable tools, native protocol, and code inventory
- `docs/generated/` — auto-generated protocol and tool contract docs

## Development Workflow

1. **Changing bridge_src/**: Edit TypeScript in `bridge_src/`, then `npm run build:bridge`, then reload extension
2. **Changing src/**: Edit TypeScript in `src/`, types check with `tsc -p tsconfig.json`
3. **Changing protocol**: Edit `bridge/native_command_schema.json`, then `npm run sync:protocol`
4. **Adding a tool**: Add registrar in `src/tools/toolRegistry.ts`, create `register*Tool.ts`, update tests
5. **Before merging**: `npm run quality:local` (build + all checks + pack dry-run)
6. **Before starting a new large workstream**: update `CURRENT.md` with the decision, boundary, contract, and verification plan before large frontend/package/contract moves

## TypeScript Configuration

- `tsconfig.json` — Node.js source (`src/`, `index.ts`), strict, ES2022, ESNext modules (type checking)
- `tsconfig.build.json` — compilation to `dist/` for npm/CLI consumers
- `tsconfig.bridge-src.json` — Extension source (`bridge_src/`), strict, ES2022, ESNext, WebWorker lib

All use `moduleResolution: "Bundler"` and `noImplicitAny: true`.

Pi runtime loads source `.ts` directly via `pi.extensions: ["./index.ts"]`; npm package and `pi-browser` CLI bin use compiled `dist/`. The `prepack` script rebuilds both `dist/` and `bridge/` before publish.

## Conventions

- Tool outputs default to `detailLevel:"summary"` — compact, token-efficient, cookie/token redacted
- Sensitive evidence goes to local artifacts in `.pi/browser-artifacts/`, not in tool output
- Bridge port range: `127.0.0.1:18765-18784` — first free port is used
- `browserSessionId` parameter isolates tab selection across concurrent sessions
- Write operations require lease; concurrent write to same tab returns `TAB_LEASE_CONFLICT`
- Default renderer is **salience-v1** with session-delta on; escape hatches: `PI_BROWSER_RENDERER=ladder`, `PI_BROWSER_SESSION_DELTA=0`
- `PI_BROWSER_*` env flags are registered in `tests/contracts/drift/env-flags.json` (single authoritative list); `affectsOutput: true` flags must have a declared signature site — adding a new flag without registering it fails `check:env-flags`
- `npm run check` includes ESLint through the DAG graph node `lint:eslint`

## Code search & navigation (large, multi-layer codebase)

This repo spans many layers (`capture-src → abml-core → distill-core → abml/distill → tools → driver → bridge_src`). To avoid
mislocating or misnaming things in a codebase this size:

- **Semantic search first.** For concept-level location questions ("where is the tab lease
  conflict thrown", "how does the scan summary fit its token budget"), use the `acemcp` MCP
  semantic search (`mcp__acemcp__search_context` with
  `project_root_path: "D:/Pi/agent/extensions/pi-browser-tools"` and a natural-language query
  plus keywords) BEFORE blind grepping. It incrementally indexes the working tree (uncommitted
  files included) and returns scored file:line snippets across all layers — typically the full
  multi-file chain in one query. Hits are leads, not verification: results can miss one layer
  of a chain, so read the source before naming anything a hit suggested. Exact-string questions
  (contract marker pins, known identifiers, gate impact) stay with `npm run query:markers`,
  `Grep`, and `npm run check:smart -- --dry-run --changed-file=<path>`.
- **Verify before naming.** Before referencing any tool / API / param / flag in code, prose,
  or a prompt handed to another agent, confirm it exists (`Grep` / read the source) — never
  from memory. The public tool surface is `browser_*`. There is **no `browser_click` /
  `browser_type`**: page actions go through `browser_execute` (JavaScript) or `browser_command`
  (bridge). ABML read verb is **internal substrate** (perception-only), reached via
  `browser_observe`/Pi-native, not a public tool. R3 `envelope.diff` is only produced by
  `browser_observe(mode:"scan", baseline:X)`.

## Design, Governance & Workflow Rules (inlined from AGENTS.md)

<!-- BEGIN GENERATED: claude-agents-inline (npm run docs:sync) -->
> Full design principles, tool constitution, and architecture rules: see `AGENTS.md`. Only actionable workflow rules are inlined below.

### Code Search

- For concept-level location questions ("where is X thrown", "which files implement Y across layers"), use semantic code search FIRST when available: the `acemcp` MCP tool `search_context` (exposed in Claude Code as `mcp__acemcp__search_context`). Call it with `project_root_path` set to this repo root using forward slashes and a natural-language query plus optional keywords, e.g. query "Where is the tab lease conflict thrown and where is its recovery text generated? Keywords: TAB_LEASE_CONFLICT, recovery nextActions".
- It incrementally indexes the working tree before each search (uncommitted and untracked files included) and returns scored file/line snippets across src, tests, contracts, scripts, and docs — use it instead of blind directory grepping when you do not yet know the identifiers.
- Treat hits as leads, not verification: results can miss one layer of a multi-layer chain, so open the files and apply the verify-before-naming rule before referencing or editing anything a hit suggested.
- Exact-string questions stay with exact tools: `npm run query:markers` for contract marker pins, plain grep for known identifiers, `npm run check:smart -- --dry-run --changed-file=<path>` for gate impact. Semantic search routes you to the neighborhood; the exact tools and the source decide.

### Change Workflow

- Before large architecture changes, scope changes, mature substitutions, bridges, or major refactors, update `TODO.md` with the concrete decision and execution path.
- When changing an implemented tool, update affected contracts/docs in the same workstream; do not document future capability as current callable capability.
- Audit-only agent reviews belong in `agent-audits/`: auditors may record reports under `agent-audits/runs/` but must not change project code; fix agents/maintainers use `skills/pi-browser-audit-fix/SKILL.md`, verify findings, then fix through normal workstreams.
- Keep TODO order actionable; mark completed items and reorder dependent work when scope changes.

### Sync & Verification

- Tool additions or material changes must update code, contracts, budgets, summaries, README, CHANGELOG, TODO, the `pi-browser-tools` skill, and related `pi-ctf-protocol` docs/contracts when affected.
- Document structure rules live in `docs/document-structure.md`. When changing generated doc indexes or managed blocks, run `npm run docs:sync` before `npm run check`.
- For mirrored governance rules, `AGENTS.md` is the single editing surface: edit this file, then run `npm run docs:sync` to regenerate the `CLAUDE.md` inlined block.
- Development-harness authoring rules live in `docs/agent-development.md`; use it for check wiring, marker queries, ledger ratchets, and workstream closure.
- After code or contract changes run `npm run check` in this extension.
- For fast local iteration, use the narrowest grouped gate first when sufficient: `npm run check:all:bridge`, `npm run check:all:package`, `npm run check:all:contracts`; keep `npm run check` as the final full gate.
- For external CLI/tool parameter surface changes, include `npm run check:param-surface` and `npm run check:input-surface` in the focused verification set.
- When a structured serial verification summary is useful, run `node scripts/run-check-groups.mjs --json ...`; artifact is written to `.pi/browser-artifacts/check-groups-summary.json`. The closing `npm run check` artifact is `.pi/browser-artifacts/check-dag-summary.json` plus per-run copies under `.pi/browser-artifacts/check-dag/`.
- For accelerated local verification, use the graph-backed runners after the relevant narrow gate: `npm run check:trace` records grouped per-script durations, `npm run check:dag` executes the graph with direct local binaries and ESLint, `npm run check:dag -- --cache` may skip nodes by v2 per-node impact-map scope while global-scope nodes still use the whole-repo key, and `npm run check:smart` records impact-selected nodes plus conservative expansion reasons. These are acceleration aids; completed workstreams still close with full `npm run check`.
- The `pi-browser-tools` skill source lives in-repo at `skills/pi-browser-tools/SKILL.md`; the global load path `D:/Pi/agent/skills/pi-browser-tools` is a directory junction to it. When touching skill text, edit the repo file and run `PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/extensions/pi-browser-tools/skills/pi-browser-tools`.
- After runtime reload for new/enhanced tools, run bounded local-fixture smoke tests and actual callable-tool runtime tests that write artifacts; summarize artifact paths.
<!-- END GENERATED: claude-agents-inline -->
