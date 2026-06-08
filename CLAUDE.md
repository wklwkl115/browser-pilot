# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> The **Design, Governance & Workflow Rules** section at the end of this file is inlined from the project's `AGENTS.md` (shared with other agent tools such as Codex). Claude Code does not auto-read `AGENTS.md`, so the rules are copied here directly — if you edit one, mirror the change in the other. These rules inherit the parent `D:/Pi/agent/AGENTS.md`.

## Project Overview

**pi-browser-tools** is a native Pi browser automation extension that provides real browser tab control, simplified DOM scanning (GA-style), JavaScript/CDP execution, evidence capture, network recording, file transfer, and a Web security testing tool layer — all backed by a Chrome extension service worker and a Node.js bridge server.

## Active Execution Contract

- Migration contract (now landed): `docs/cli-skill-frontend-migration-plan.md`
- Current shipping external frontends are **Pi-native entry (`index.ts`) + `pi-browser` CLI (`cli/`)**. The MCP shell has been removed; CLI usage is documented in `docs/cli.md`.
- `pi-browser` CLI is shipped and the migration is complete (landed 2026-06-03): code, contracts, current-facing docs, skill text, and live-browser smoke (`npm run smoke:cli`) all passed. No migration items remain.
- `docs/abml-execution-plan.md` is no longer the active queue; ABML remains an internal substrate / historical execution contract.

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

Generated files (do NOT edit manually):
- `bridge/pi_browser_bridge/native_command_schema.json`
- `bridge_src/service_worker/protocol.ts`
- `src/protocol/nativeProtocol.ts`, `nativeActionMetadata.ts`, `nativeErrorCodes.ts`
- `docs/generated/native-protocol.generated.md`

## Common Commands

### Build
```bash
npm run build:bridge          # build extension dist from bridge_src/
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
npm run quality:local         # build + check + pack dry-run (no browser)
```

### Tests
```bash
npm run test:unit              # run all unit tests
npm run check:bridge           # bridge types + build + files + protocol + tools
npm run check:web-security     # web security layer boundaries
npm run check:lifecycle        # multi-browser/tab/MV3 fixtures
npm run check:runtime-fixtures # network/hook/wait/transfer fixtures
```

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
npm run docs:generate         # regenerate tool contract docs
npm run sync:protocol         # regenerate protocol from native_command_schema.json
npm run docs:sync-indexes     # sync archive/roadmap/todo index blocks
```

## Key Files & Directories

- `src/tools/toolRegistry.ts` — declarative always-on tool registration order + core/security group metadata
- `src/tools/toolAdapter.ts` — shared param handling, timeout, error wrapping, artifact fallback
- `src/driver/BrowserBridgeServer.ts` — facade delegating to sub-registries
- `bridge_src/service-worker.ts` — Chrome extension entry point (ESM import graph)
- `bridge/native_command_schema.json` — native command protocol source of truth
- `tests/contracts/` — contract tests (protocol, tools, boundaries)
- `tests/smoke/` — browser smoke tests
- `evals/browser-workflows/` — ACI evals: deterministic `runner.mjs` + blind-agent discovery layer (`launch-blind.mjs`/`pb-blind.mjs`/`teardown-blind.mjs`, `blind-tasks-realsite.md`, `blind-findings.md`)
- `skills/pi-browser-blind-eval/` — operator/cron procedure for the standing blind real-agent eval loop
- `docs/generated/` — auto-generated protocol and tool contract docs
- `docs/cli-skill-frontend-migration-plan.md` — active frontend migration execution contract

## Development Workflow

1. **Changing bridge_src/**: Edit TypeScript in `bridge_src/`, then `npm run build:bridge`, then reload extension
2. **Changing src/**: Edit TypeScript in `src/`, types check with `tsc -p tsconfig.json`
3. **Changing protocol**: Edit `bridge/native_command_schema.json`, then `npm run sync:protocol`
4. **Adding a tool**: Add registrar in `src/tools/toolRegistry.ts`, create `register*Tool.ts`, update tests
5. **Before merging**: `npm run quality:local` (build + all checks + pack dry-run)
6. **During the active frontend migration**: update `CURRENT.md` + `docs/cli-skill-frontend-migration-plan.md` before large frontend/package/contract moves

## TypeScript Configuration

- `tsconfig.json` — Node.js source (`src/`, `index.ts`), strict, ES2022, ESNext modules
- `tsconfig.bridge-src.json` — Extension source (`bridge_src/`), strict, ES2022, ESNext, WebWorker lib

Both use `moduleResolution: "Bundler"` and `noImplicitAny: true`.

## Conventions

- Tool outputs default to `detailLevel:"summary"` — compact, token-efficient, cookie/token redacted
- Sensitive evidence goes to local artifacts in `.pi/browser-artifacts/`, not in tool output
- Bridge port range: `127.0.0.1:18765-18784` — first free port is used
- `browserSessionId` parameter isolates tab selection across concurrent sessions
- Write operations require lease; concurrent write to same tab returns `TAB_LEASE_CONFLICT`

## Code search & navigation (large, multi-layer codebase)

This repo spans many layers (`abml-core → abml → tools → driver → bridge_src`). To avoid
mislocating or misnaming things in a codebase this size:

- **Verify before naming.** Before referencing any tool / API / param / flag in code, prose,
  or a prompt handed to another agent, confirm it exists (`Grep` / read the source) — never
  from memory. The public tool surface is `browser_*`. There is **no `browser_click` /
  `browser_type`**: page actions go through `browser_execute` (JavaScript) or `browser_command`
  (bridge). ABML verbs (click/type/scroll/read) are **internal substrate**, reached via
  `browser_execute`/Pi-native, not a public tool. R3 `envelope.diff` is only produced by
  `browser_observe(mode:"scan", baseline:X)`.

## Design, Governance & Workflow Rules (inlined from AGENTS.md)

> Inlined verbatim from `AGENTS.md` so Claude Code (which does not auto-read `AGENTS.md`) follows the same rules as other agent tools. Keep the two files in sync: edit here and mirror in `AGENTS.md` (and vice versa). These rules inherit the parent `D:/Pi/agent/AGENTS.md`.

### Scope

- Applies to `D:/Pi/agent/extensions/pi-browser-tools` and all child paths.
- Inherits `D:/Pi/agent/AGENTS.md`; this file only adds stricter browser/Web extension rules.

### Role

- This package is Pi's browser/Web capability layer.
- Keep CTF protocol, routing, solver methodology, and challenge policy in `pi-ctf-protocol`.
- Keep concrete callable browser/Web tools, evidence capture, replay, state sync, and artifacts here.

### Design Principles

- Brain-Hand Separation: tools expose perception and execution; agents keep strategic judgment, planning, and proof construction. The line is not computation versus judgment — tools should encode deterministic mechanical expertise and provide sensible, visible, overridable defaults. What belongs to the agent is context-dependent strategic choice; what belongs in the tool is reliable domain knowledge that does not depend on task context and can be audited, overridden, and improved independently.
- Semantic Singularity: one capability class has one canonical tool. Names, schemas, and descriptions must have clear non-overlapping boundaries.
- Atomic Composability: prefer Unix-like primitives and programmable surfaces over black-box workflows or excessive micro-tools.
- Recoverable Diagnostics: optimize for feedback loops. Return structured high-signal summaries, actionable errors, observable state, idempotent/replayable operations, and artifact evidence.
- Eval-Driven Evolution: evolve tool interfaces from realistic task evals, failed transcripts, token/call cost, success rate, and recovery quality.

### Tool Design Rules

- Expose pure capability. Do not encode strategic decisions, challenge-solving policy, broad safety gates, or hidden risk tiers in this extension.
- Prefer improving `browser_execute`, `browser_http_replay`, `browser_artifact`, evidence, and wait/state tools before adding narrow one-off tools.
- Specialized automation, scanners, fuzzers, and bridges are follow-up layers; they must consume explicit scoped inputs and preserve evidence.
- Tool descriptions must state purpose, when to use, constraints, limitations, and examples when helpful.
- Choose granularity by frequency, certainty, and risk: high-frequency deterministic actions stay atomic; side effects need verification/stale-state protection; rare work may use bounded aggregation.
- Parameters should be minimal, strongly typed, and enum-based where practical. Normalize loose input early; do not let `unknown`-heavy flows spread.
- Outputs must be compact by default, structured, semantically named, token-efficient, optionally detailed, and non-leaking for cookies/tokens; full evidence belongs in artifacts.

### Agent-First Tool Constitution

- Public tools serve agent decision quality first, not implementer convenience.
- Good atomicity means **low hidden dependency cost**. Do not make the agent guess undocumented prerequisite steps.
- If a tool depends on prior state, expose it explicitly through params, handles, artifacts, or diagnostics.
- Keep Core tools aligned to irreducible physical capabilities. Do not split them into strategy-shaped micro-tools.
- WebSecurity tools may represent follow-up domains, but they must not rely on silent workflow assumptions.
- Internalize only the cheapest deterministic prerequisite; do not hide expensive, risky, or escalation decisions inside a tool.
- Keep **public surface thin, internal engines thick**. Prefer internal consolidation before public tool merges.
- Do not merge public tools unless execution context, parameter model, error semantics, and recovery flow are truly shared.
- Strategy belongs to skills and evals, not hidden tool chaining.
- Every complex tool must fail with factual remediation: missing prerequisite, reusable handle/artifact, and next concrete action.
- Any tool-surface consolidation requires eval proof that agent outcomes improve and recovery quality does not regress.

### Architecture Rules

- Keep one Web package; prefer internal layering over parallel Web extensions unless explicitly required.
- Keep registration/composition entrypoints thin; put domain logic in domain modules.
- Split files before they become mixed-domain maintenance bottlenecks.
- Keep external tool contracts stable unless a migration is explicit and documented: names, schemas, summaries, artifacts, and verification flow must not drift.
- Prefer mature dependencies for generic parsing/format work and Pi-native bridges for mature external engines when they beat local reimplementation.
- Mature bridges must be portable: no private absolute paths, throwaway scripts, or host-specific production assumptions.
- Future `browser_*` names must not be registered until implemented.

### Anti-Patterns

- Tools that decide strategy for the agent or hide uncertainty behind broad if/else logic.
- Zero-opinion tools with no mechanical expertise or defaults, forcing agents to spend attention on deterministic decisions better encoded as auditable, overridable tool behavior.
- Duplicate or overlapping tools, namespace drift, and capability sprawl.
- Swiss-army workflow tools that cannot be diagnosed, replayed, or composed.
- Excessive fragmentation that makes tool choice the task.
- Static design without evals, transcript review, or production feedback.

### Change Workflow

- Before large architecture changes, scope changes, mature substitutions, bridges, or major refactors, update `TODO.md` with the concrete decision and execution path.
- When changing an implemented tool, update affected contracts/docs in the same workstream; do not document future capability as current callable capability.
- Keep TODO order actionable; mark completed items and reorder dependent work when scope changes.

### Sync & Verification

- Tool additions or material changes must update code, contracts, budgets, summaries, README, CHANGELOG, TODO, the `pi-browser-tools` skill, and related `pi-ctf-protocol` docs/contracts when affected.
- Document structure rules live in `docs/document-structure.md`. When changing archive/roadmap/todo/current index blocks or archive file layout, run `npm run docs:sync-indexes` before `npm run check`.
- After code or contract changes run `npm run check` in this extension.
- For fast local iteration, use the narrowest grouped gate first when sufficient: `npm run check:all:bridge`, `npm run check:all:package`, `npm run check:all:contracts`; keep `npm run check` as the final full gate.
- When a structured local verification summary is useful, run `node scripts/run-check-groups.mjs --json ...`; artifact is written to `.pi/browser-artifacts/check-groups-summary.json`.
- The `pi-browser-tools` skill source lives in-repo at `skills/pi-browser-tools/SKILL.md`; the global load path `D:/Pi/agent/skills/pi-browser-tools` is a directory junction to it. When touching skill text, edit the repo file and run `PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/extensions/pi-browser-tools/skills/pi-browser-tools`.
- After runtime reload for new/enhanced tools, run bounded local-fixture smoke tests and actual callable-tool runtime tests that write artifacts; summarize artifact paths.
