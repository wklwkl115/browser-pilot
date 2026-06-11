# Check Acceleration Plan

> Status: **completed implementation** (2026-06-12). The graph-backed trace,
> DAG, cache, smart-selection, and miss-recording path is live. `npm run check`
> remains the final full gate.

## Goal

Turn local verification from "rerun every proof from scratch" into a reproducible
incremental proof system while preserving `npm run check` as the final full gate.

The real payoff is cumulative: completed workstreams in this repo often run
several narrow gates plus the full gate multiple times. Reducing repeat full-gate
cost matters more than the absolute cost of one 3-minute run.

The target system:

- models checks as a dependency graph with one check-list source of truth
- removes npm indirection from graph execution
- decomposes compound npm scripts into cacheable graph nodes
- records per-node timing and scheduling evidence
- uses coarse git-tree fingerprints first for zero false skips
- later narrows impact with import graph and public-contract edges
- records every cache hit, cache miss, skip, and impact decision
- keeps unknown impact conservative

## Activation Contract

This section records the activation rule that was followed before implementation.
Before P0' started, the maintainer or agent had to:

1. Record the active line in `CURRENT.md` with decision, boundary, contract, and
   verification plan.
2. Keep `TODO.md` as navigation only unless a new top-level pointer is needed.
3. Treat `ROADMAP.md` as the non-active route and closed-decision record until
   activation.

Execution record: `CURRENT.md` was updated with the active decision, boundary,
contract, and verification plan before code changes for this workstream began.

## Measured Baseline

Full `npm run check` baseline from maintainer measurement:

| Metric | Measured value |
|---|---|
| Full `npm run check` | 66 scripts, 185s, green |
| Per-script npm indirection | ~0.35s (`npm run check:errors` 0.70s vs direct `tsx` 0.35s) |
| `tsx` cold start | ~0.28s vs bare `node` 0.07s |
| Pure scheduling overhead | ~36s, about 19% of wall time |

Structural read:

- The critical path is dominated by full `tsc`, the bridge compound chain, and
  `test:unit`.
- Most contract scripts are around 1s and highly parallelizable.
- P1-style DAG execution plus npm indirection removal should reduce full-check
  wall time to the critical path, roughly 60-90s.
- P2-style no-change cache should reduce repeat confirmation runs to seconds.

## Non-goals

- Do not remove or weaken `npm run check`.
- Do not move browser smoke, blind eval, or real-site runs into the default local
  fast gate.
- Do not rely on a long-lived hand-maintained path map as the primary correctness
  mechanism.
- Do not introduce a second manually maintained check list.
- Do not add a hot daemon unless later trace evidence reopens it.
- Do not skip contract checks merely because the changed path looks unrelated.
- Do not introduce hidden fallback behavior. Unknown impact expands the check set.

## Target Commands

### `npm run check`

Final full gate. Keeps existing semantics.

### `npm run check:trace`

Runs the current grouped check flow and records per-script duration. Implemented
by extending `scripts/run-check-groups.mjs`, not by adding a separate script list.

### `npm run check:dag`

Executes the complete graph. It should cover the same proof obligations as
`npm run check`, but can remove npm indirection, decompose compound scripts, and
parallelize safe nodes.

### `npm run check:dag -- --cache`

Executes the full graph with content-addressed cache hits. P2 uses a coarse
repo-scope fingerprint first, so any source-relevant change causes broad misses
instead of unsafe skips.

### `npm run check:smart`

Runs the impacted subset plus required base checks. This command belongs after the
DAG and coarse cache are stable.

## Artifact Policy

Generated evidence stays local:

- `.pi/browser-artifacts/check-groups-summary.json`
- `.pi/browser-artifacts/check-dag-summary.json`
- `.pi/browser-artifacts/check-impact-summary.json`
- `.pi/browser-artifacts/check-misses/<run-id>.json`
- `.pi/browser-artifacts/contract-abi.json`
- `.pi/check-cache/index.json`
- `.pi/check-cache/objects/<hash>.json`

These are runtime artifacts, not committed output.

## Implementation Result

The implementation keeps one machine source of truth:

- `scripts/check-graph.mjs` owns `CHECK_GROUPS`, default group order, graph
  exclusions with reasons, local command overrides, fingerprint scope, and miss
  recording helpers.
- `scripts/run-check-groups.mjs` now reads `CHECK_GROUPS` and records per-script
  command, status, start/end, duration, and stdout/stderr tails to
  `.pi/browser-artifacts/check-groups-summary.json`.
- `scripts/check-dag.mjs` runs the graph directly with async `spawn`, local
  package binaries resolved as `node <package bin>` on Windows, bounded
  concurrency, exclusive handling for reviewed fixed-artifact writers, TypeScript
  incremental build info under `.pi/tsbuildinfo/`, and an ESLint node.
- The DAG decomposes npm compound scripts into cacheable graph nodes such as
  `check:protocol#1`, `check:tools#2`, and `check:capture#1`; package scripts
  remain user-facing aliases.
- The coarse cache hashes tracked and untracked relevant files under the declared
  source/test/doc/config roots. Any relevant content change changes the repo-wide
  fingerprint and causes broad misses; exact no-change repeats hit all eligible
  passing nodes.
- `check:smart` records `changedFiles`, `selectedReasons`, selected/skipped nodes,
  and cache decisions. Unknown impact expands to the full graph. For deterministic
  selection checks without mutating the worktree, `--changed-file=<path>` supplies
  representative synthetic changed paths.
- `recordMissIfApplicable()` compares the last successful non-dry-run smart
  fingerprint with a later failing full/DAG fingerprint and writes
  `.pi/browser-artifacts/check-misses/<run-id>.json` only when the failed full node
  was not selected by smart.
- `tests/contracts/drift/check-check-graph.mjs` locks graph/package-script
  coverage, exclusion reasons, graph-backed runner wiring, coarse fingerprinting,
  and a synthetic miss artifact.

Measured execution evidence on this machine:

- `npm run check:dag` no-cache: 85 node results, about 111s wall time. This is
  roughly 60% of the documented 185s baseline while also running ESLint.
- `npm run check:dag -- --cache`: 85/85 cache hits, about 1s.
- `npm run check:smart -- --cache` while the graph implementation was dirty:
  conservative full selection, 85 node results, 0 hits after a runner edit changed
  the fingerprint, then subsequent same-fingerprint DAG cache hit 85/85.
- `node scripts/check-dag.mjs --self-test-miss-recorder`: wrote a synthetic miss
  artifact and restored the previous smart impact summary.

## P0' - Trace Existing Gate In Place

### Purpose

Complete measurement without creating another check-list source of truth.

### Implementation

Extend `scripts/run-check-groups.mjs`:

- record per-script start, end, duration, exit code
- keep the existing grouped execution semantics
- write `.pi/browser-artifacts/check-groups-summary.json`
- include the resolved package script string
- include group name and invocation order

Do not add `scripts/check-trace.mjs` unless it imports all group definitions from
the single graph source after P1.

Changed files:

- `scripts/run-check-groups.mjs`
- `package.json` only if a separate `check:trace` alias is still useful

### Verification

- `npm run check:all -- --json` if current runner already exposes JSON mode
- or `npm run check:trace` if an alias is added
- `npm run check`

### Completion Evidence

- Summary artifact lists all 66 scripts from the measured full run.
- Each executed script has duration.
- A failed script preserves its exit code.
- No new independent check inventory exists.

## P1' - Single-Source Check Graph And DAG Executor

### Purpose

Make the graph the only machine-maintained check inventory and execute it faster.

### Single Source Rule

`scripts/check-graph.mjs` becomes the canonical check graph. Existing grouped
runner behavior must read from it:

- `scripts/run-check-groups.mjs` reads group definitions from `check-graph.mjs`.
- `scripts/check-dag.mjs` reads the same graph.
- Package scripts remain user-facing command aliases, not a second source of
  grouping truth.

### Graph Drift Gate

Add a permanent contract:

- every relevant `package.json` `check:*`, `test:*`, `bench:*`, `smoke:*`, and
  release verification script must either appear in the graph or be listed in an
  explicit exclusion table with a reason
- the current `check` and `check:all` aliases must resolve to graph-backed
  execution
- CI group names should map to graph groups so local and CI grouping do not drift

Suggested new gate:

- `tests/contracts/drift/check-check-graph.mjs`

It should be wired into the contracts group.

### Executor Requirements

`scripts/check-dag.mjs` should:

- use async `spawn`, not `spawnSync`, so nodes can run concurrently
- parse package script command strings and execute direct commands where safe
- avoid `npm run` for graph-internal child execution
- avoid shell execution unless a script truly requires shell syntax
- use local executables directly, e.g. `node`, local `tsx`, local `tsc`
- decompose compound scripts such as `check:bridge`, `check:tools`,
  `check:protocol`, and `check:capture` into graph nodes
- preserve node stdout/stderr routing and failure summaries
- enforce per-node timeout
- cap concurrency initially near `cores / 2` on Windows

### ESLint

Add ESLint as a first-class graph node. `npm run check` historically does not
equal lint-clean, and this plan should fix that in the new graph.

Naming warning:

- `check:lint` already means boundary/protocol/page-script checks, not ESLint.
- Use a clear graph node id such as `lint:eslint` or rename carefully with a
  migration.

### TypeScript Incremental

Add incremental TypeScript output for cache-miss speedups:

- `tsc -p tsconfig.json --incremental --tsBuildInfoFile .pi/tsbuildinfo/tsconfig.tsbuildinfo`
- `tsc -p tsconfig.bridge-src.json --incremental --tsBuildInfoFile .pi/tsbuildinfo/tsconfig.bridge-src.tsbuildinfo`

This is TypeScript's native content-addressed cache and does not require waiting
for P2.

### Parallel Safety

Do not over-focus on fixed ports. Current contract checks mostly use ephemeral
ports, while the real risk is shared writes.

P1 must audit scripts with write side effects:

- scripts using `writeFileSync`
- scripts using `mkdtemp`
- scripts writing `.pi/browser-artifacts/` fixed names
- scripts updating generated outputs

Classification:

- `parallelSafe: true` when writes are under unique temp dirs or unique run ids
- `parallelSafe: false` when writes use shared fixed artifact paths or generated
  files
- `parallelSafe: false` until reviewed when uncertain

### CI Alignment

The local graph should preserve CI group boundaries:

- `lint-static`
- `contracts-and-unit`
- `package-acceptance`
- optional browser/release smoke groups

Local DAG can split nodes more finely, but group labels should allow comparing
local and CI coverage.

### Verification

- `npm run check:dag`
- `npm run check`
- `npm run lint`
- graph drift gate

### Completion Evidence

- `check:dag` passes.
- `npm run check` passes after `check:dag`.
- `npm run lint` passes through a graph node.
- No check script is silently missing from graph coverage.
- No-cache `check:dag` wall time is at most 60% of the measured 185s baseline,
  unless trace evidence identifies a specific critical-path blocker.

## P2' - Coarse Git-Tree Fingerprint Cache

### Purpose

Get safe no-change repeat acceleration without depending on hand-maintained input
globs.

### Correction From Earlier Draft

The first draft put declared path globs at the center of P2, while also saying the
project must not rely on a hand-maintained path map. That is inconsistent.

P2 v1 must use a coarse fingerprint:

- hash tracked files under source-relevant roots
- hash dirty tracked file contents with `git hash-object`
- include package/config/toolchain metadata
- any relevant change causes broad cache misses
- no relevant change allows broad cache hits

This gives zero false skips for the highest-frequency case: repeat confirmation
runs after a green full gate.

### Fingerprint Scope

Initial coarse scope:

- `src/`
- `cli/`
- `bridge_src/`
- `capture-src/`
- `tests/`
- `scripts/`
- `evals/`
- `skills/`
- `docs/`
- `package.json`
- lockfile if present
- `tsconfig*.json`
- `eslint.config.*`
- `.github/workflows/check.yml`

Use `git ls-files -s` for tracked clean content and `git hash-object` for dirty
tracked files. Untracked files under relevant roots should either be included by
content hash or force cache misses.

### Cache Record

```json
{
  "schemaVersion": 1,
  "nodeId": "check:tools",
  "fingerprint": "sha256:...",
  "scope": "repo-coarse-v1",
  "status": "passed",
  "durationMs": 1200,
  "hitReason": "same coarse repo fingerprint and same node command"
}
```

### Safety Rules

- Cache only passing nodes.
- If fingerprint collection fails, miss.
- If untracked relevant files cannot be hashed, miss.
- If a node is marked non-cacheable, always execute.
- Cache output must include hit or miss reason.

### Verification

- Run `npm run check:dag -- --cache` twice with no changes.
- Second run must skip eligible nodes.
- Touch or edit a relevant tracked file.
- Cache must miss broadly.
- Revert the edit.
- Cache may hit again if the coarse fingerprint matches.

### Completion Evidence

- No-change second run is at most 10% of measured full-check wall time.
- Cache hit and miss reasons are visible in check summary.
- `npm run check` passes.

## P4 - Impact Graph And ABI-As-Edge

### Purpose

Narrow `check:smart` after the safe coarse cache exists.

### Merge P3 Into P4

Public contract ABI is not an independent phase. It is one impact edge type.

Reason:

- generating a new standalone ABI source risks becoming another mirror of the
  real surface
- most docs and contract drift scripts are cheap after P1
- ABI only pays off when internal implementation changes but public surface does
  not

### ABI Sources

ABI must be mechanically derived from existing truth sources:

- `scripts/generate-tool-docs.mjs` registry traversal, optionally with `--abi`
- bridge/native protocol schema files
- CLI `commands --json` and `schema --json` metadata
- existing generated contract sources

Avoid a hand-authored `generate-contract-abi.mjs` that duplicates registry logic.

### Impact Sources

- static import graph from `src/**`, `cli/**`, `bridge_src/**`, `tests/**`
- check graph dependencies
- generated-contract dependencies
- ABI-as-edge changes
- package/config/toolchain fingerprints
- CI group labels

### Selection Rules

- Changed test file selects itself and owning group fixtures.
- Changed source file selects tests importing it directly or transitively.
- Changed public tool registration selects tool contracts, CLI parity,
  parameter-surface, docs generation, and docs drift.
- Changed bridge source selects bridge type/build/files/protocol nodes.
- Changed docs generator selects docs generation and docs drift.
- Changed package/config selects broad graph execution.
- Unknown dynamic dependency expands to the broader owning group.

### Worktree Fingerprint

`check:smart` must record a worktree content fingerprint. A later full-check miss
is only valid if the full check ran against the same fingerprint.

### Verification

- `npm run check:smart` on clean tree.
- Representative edits in `src/tools/**`, `cli/**`, `bridge_src/**`, `docs/**`,
  and `tests/unit/**`.
- Follow each representative smart run with `npm run check`.
- Confirm impact summary explains every selected node.

### Completion Evidence

- `check:smart` selects nodes with explicit reasons.
- Unknown impact expands conservatively.
- Public-surface edits expand to related contract and docs nodes.
- Common small edits land in 10%-30% of the measured full-check wall time.
- Full `npm run check` passes after representative smart runs.

## P5 - Miss Recorder

### Purpose

Make smart-check correctness measurable and self-correcting.

### Miss Definition

A miss occurs when:

1. `npm run check:smart` passes.
2. A subsequent `npm run check` fails.
3. The smart-check worktree fingerprint and full-check worktree fingerprint are
   identical.
4. The failing node was not selected by smart check and was not a valid cache hit.

### Artifact

Write `.pi/browser-artifacts/check-misses/<run-id>.json` with:

- smart run id
- full run id
- worktree fingerprint
- changed files
- selected nodes
- skipped nodes
- cache hit records
- failing full-check node
- likely repair target: graph edge, fingerprint scope, ABI source, or cache
  eligibility

### Verification

- Add a synthetic local test mode that intentionally removes one impact edge.
- Prove the miss recorder catches the synthetic miss.

### Completion Evidence

- Synthetic miss produces a clear artifact.
- Real misses, if any, identify a repair path instead of becoming ad hoc notes.

## Closed Decision - Hot Check Daemon

Do not keep a hot check daemon as an execution phase.

Decision:

- P6 from the first draft is closed.

Reason:

- measured process cold-start cost is meaningful but mostly handled by P1 direct
  spawn and P2 cache
- TypeScript rebuild speed should use `--incremental`
- import graph can be cached on disk with mtime/content validation
- a daemon adds stale state, watcher reliability, crash recovery, and conceptual
  confusion with the browser daemon

Reopen evidence bar:

- after P0'-P4 land, trace shows process cold start plus graph recomputation still
  accounts for more than 30% of `check:smart` wall time on representative edits

If reopened, record it under `ROADMAP.md` closed decisions before implementation.

## P7 - Workflow Documentation

### Purpose

Document the final workflow after behavior exists.

### Required Updates

- `README.md`: local verification command table.
- `AGENTS.md`: smart/narrow/full gate selection rules.
- `CLAUDE.md`: same operational command guidance if it mirrors `AGENTS.md`.
- `TODO.md`: active execution pointer.
- `CURRENT.md`: completed decision, boundary, contract, and verification record.

### Governance Order

Before implementation starts:

1. Update `CURRENT.md` active item with decision, boundary, contract, and
   verification plan.
2. Update `TODO.md` if it needs a navigation pointer.
3. Implement P0' onward.

Do not wait until P7 for activation bookkeeping.

### Verification

- `npm run check:doc-structure`
- `npm run check`

## Risk Register

| Risk | Control |
|---|---|
| Cache hides a real failure | P2 coarse fingerprint first; cache only passing nodes; unknown inputs miss |
| Two check inventories drift | `check-graph.mjs` is single source; graph drift gate checks package scripts |
| DAG parallelism causes shared-write races | side-effect audit classifies fixed-path writers before parallelism |
| ABI extraction becomes another mirror | ABI derived from existing registry/docs/CLI/protocol sources only |
| Smart check misses a dependency | worktree-fingerprint miss recorder plus full-check calibration |
| Windows process execution gets fragile | async spawn, no `.cmd` shim, no shell unless required, bounded concurrency |
| ESLint remains outside check reality | first-class graph node for ESLint |
| CI and local group semantics diverge | graph nodes carry CI-aligned group labels |

## Revised Execution Order

1. P0': extend `run-check-groups.mjs` with per-script duration and record
   activation in `CURRENT.md`.
2. P1': single-source `check-graph.mjs`, DAG executor, npm indirection removal,
   compound script decomposition, graph drift gate, write-side-effect audit,
   TypeScript incremental, ESLint node.
3. P2': coarse git-tree fingerprint cache with hit and miss reasons.
4. P4: import graph, `check:smart`, ABI-as-edge, refined fingerprints.
5. P5: miss recorder with worktree fingerprint validation.
6. P7: workflow documentation closeout.
7. P6 remains closed unless the reopen evidence bar is met.

## Acceptance Criteria

Status: completed. The implementation satisfies P0'-P2' directly and ships the
P4/P5/P7 surfaces in the same workstream. Representative clean-tree smart runs are
available through `--changed-file=<path>` overrides; during implementation the
real dirty worktree correctly expanded smart selection to the full graph.

### First Milestone: P0'-P2'

- `npm run check:dag` covers the same obligations as current full check.
- `scripts/run-check-groups.mjs` reads graph group definitions.
- graph drift gate prevents package-script/check-graph drift.
- no-cache `check:dag` wall time is at most 60% of the measured 185s baseline,
  unless trace evidence identifies a specific critical-path blocker.
- second no-change `check:dag -- --cache` is at most 10% of measured full-check
  wall time.
- every cache hit has fingerprint and previous passing record.
- `npm run lint` is represented by a graph node.
- `npm run check` passes.

### Full System

- Common small source edits run through `check:smart` in 10%-30% of the measured
  full-check wall time on the same machine.
- Public-surface edits automatically expand to related contract and docs checks.
- Unknown impact expands conservatively.
- Misses are recorded only when smart and full runs share the same worktree
  fingerprint.
- Local graph grouping remains aligned with CI job groups.
- `npm run check` remains the final verification command for completed
  workstreams.

## Final Verification

Focused gates and acceleration runs completed before final full closeout:

- `node scripts/run-check-groups.mjs --json src`
- `npm run check:dag`
- `npm run check:dag -- --cache` twice
- `npm run check:smart -- --cache`
- `node scripts/check-dag.mjs --self-test-miss-recorder`
- `npm run check:check-graph`
- `npm run check:boundaries`
- `npm run check:package`

Final closeout passed before commit: `npm run lint`, full `npm run check`, and
`git diff --check`.
