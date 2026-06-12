# Audit Run Report

## Scope

- Requested scope: static audit of `docs/agent-harness-optimization-plan.md`, focused on omissions in an otherwise accepted design.
- Agent / run id: codex-agent-harness-plan-static
- Date: 2026-06-12
- Audit type: static
- Commit / worktree basis: `master`; target plan is currently untracked as `docs/agent-harness-optimization-plan.md`.

## Commands Run

| Command | Purpose | Result | Artifact |
|---|---|---|---|
| `Get-Content docs\agent-harness-optimization-plan.md` | Read target plan | ok | n/a |
| `rg -n ... docs\agent-harness-optimization-plan.md` | Locate plan claims and acceptance lines | ok | n/a |
| `Get-Content AGENTS.md` | Check governing sync/verification rules | ok | n/a |
| `Get-Content scripts\build-bridge.mjs bridge_src\shared\buildInfo.ts bridge_src\service_worker\bridge_info.ts bridge_src\service_worker\transport.ts` | Verify current bridge build/skew surface | ok | n/a |
| `Get-Content src\tools\registerObserveTool.ts src\tools\observeRunners.ts` | Verify observe `fresh` insertion and validation surface | ok | n/a |
| `Get-Content src\driver\BrowserLeaseRegistry.ts src\driver\BrowserBridgeCommandService.ts src\tools\registerTabsTool.ts` | Verify lease conflict and snapshot exposure surface | ok | n/a |
| `rg -n "src/tools/observeRunners.ts|cli/index.ts" tests src docs scripts` | Find static tests/imports affected by ACI-10/11 splits | ok | n/a |
| `Get-Content scripts\check-graph.mjs package.json` | Confirm check group wiring pattern | ok | n/a |

## Findings

| ID | Severity | Confidence | Area | Status |
|---|---|---|---|---|
| AUDIT-001 | P1 | high | ACI-5 build fingerprint | unverified |
| AUDIT-002 | P1 | high | ACI-7 lease redaction | unverified |
| AUDIT-003 | P2 | high | ACI-6 fresh validation | unverified |
| AUDIT-004 | P2 | high | ACI-10/11 split migration | unverified |
| AUDIT-005 | P2 | medium | cross-plan verification/docs sync | unverified |

## Finding Details

### AUDIT-001 - ACI-5 does not define a non-self-referential fingerprint

- Severity: P1
- Confidence: high
- Area: bridge build fingerprint / stale extension detection
- Evidence: plan lines 219-223 say `build:bridge` computes a content hash of the built service-worker bundle and writes it into both `build-manifest.json` and an injected constant in the bundle. Current build writes the bundle first in `scripts/build-bridge.mjs`, and current marker is a static `BRIDGE_BUILD_PIPELINE_VERSION` in `bridge_src/shared/buildInfo.ts`.
- Reproduction: Read `scripts/build-bridge.mjs` and `bridge_src/service-worker.ts`; the injected constant is part of the bundle content being hashed.
- Expected: The plan specifies a stable hash algorithm, e.g. hash normalized sources or all dist files with the build-id placeholder excluded, then inject that build id and verify that exact algorithm.
- Actual: The plan says to hash the built bundle and also inject the resulting value into that same bundle, which is circular unless an exclusion/two-pass rule is added.
- Impact: Implementers can create a hash that never matches after injection, or silently verify a different object than the running bundle. This weakens the core ACI-5 skew signal.
- Suggested fix direction: Amend ACI-5 to define `buildId` as a deterministic non-self-referential hash. Also decide whether the fingerprint covers service-worker only or the whole extension dist set (`service-worker`, `offscreen`, content, hook, disable-dialogs, manifest/config).
- Verification command: `npm run build:bridge && npm run verify:bridge:dist`; add a rebuild determinism assertion that a clean rebuild produces the same `buildId` for unchanged inputs.
- Notes: The plan's "extension build fingerprint" wording is broader than "service-worker bundle hash"; make the scope explicit.

### AUDIT-002 - ACI-7 redacts conflict details but not public snapshot/session surfaces

- Severity: P1
- Confidence: high
- Area: lease conflict diagnostics / privacy
- Evidence: plan lines 286-292 only mention the two throw sites. Current public `browser_tabs action=snapshot` returns `server.snapshot(browserSession)` directly in `src/tools/registerTabsTool.ts:121-123`; `BrowserBridgeServer.snapshot()` includes `leases: this.leases.listTabLeases()` and `uiLock: this.leases.uiLockInfo()`, whose types include raw `browserSessionId` and `tabSessionId`.
- Reproduction: Read `src/tools/registerTabsTool.ts`, `src/driver/BrowserBridgeServer.ts`, `src/driver/types.ts`, and `src/driver/BrowserLeaseRegistry.ts`.
- Expected: Any agent-visible foreign lease holder information is consistently redacted or replaced with short stable hashes, including conflict errors and snapshot/list surfaces that are recommended for recovery.
- Actual: The plan closes only throw-site details; `browser_tabs snapshot` can still expose raw lease/session identifiers if unchanged.
- Impact: The planned recovery path can continue leaking the exact foreign holder id that ACI-7 intends to remove.
- Suggested fix direction: Add a `publicSnapshot`/`compactLease` layer for agent-facing snapshots, covering `leases[]` and `uiLock`, while preserving raw ids internally and in owner-scoped return values where needed.
- Verification command: extend `tests/unit/driver/BrowserLeaseRegistry.test.ts` or `check-fake-ws` plus a `browser_tabs snapshot` contract asserting raw foreign `browserSessionId`/`tabSessionId` are absent and `remainingMs`/`expiresAt` are present.
- Notes: Include `UI_LOCK_CONFLICT` in the same audit if it shares the same raw-holder exposure class.

### AUDIT-003 - ACI-6 omits `fresh` conflicts with by-reference baseline params

- Severity: P2
- Confidence: high
- Area: `browser_observe fresh:true`
- Evidence: plan lines 253-260 says `fresh` is mutually exclusive with explicit `baseline`. Current `registerObserveTool.ts:145-154` maps `baselinePath`/`baselineSnapshotId` into `observeParams.baseline` before mode normalization and validation.
- Reproduction: Inspect `src/tools/registerObserveTool.ts`; no `fresh` param exists yet, and `validateObserveParams()` has no cross-param rejection for `fresh` with `baseline`, `baselinePath`, or `baselineSnapshotId`.
- Expected: `fresh:true` rejects all baseline equivalents: `baseline`, `baselinePath`, and `baselineSnapshotId`, with a negative test.
- Actual: The plan only names `baseline`, so an implementation could accidentally allow `fresh:true baselinePath=...` to synthesize a baseline and defeat the fresh-render escape.
- Impact: The context-loss recovery affordance becomes ambiguous and can produce a delta instead of a fresh I-frame.
- Suggested fix direction: Amend ACI-6 with exact validation in `validateObserveParams()` or before baseline scalar mapping; include all three baseline entrypoints.
- Verification command: extend `check:session-delta-long-conversation` with `fresh:true` plus `baseline`, `baselinePath`, and `baselineSnapshotId` invalid-rule negative controls.
- Notes: Also specify that `fresh:true` skips prior baseline/cache reads but still records a new ledger frame for the next default delta.

### AUDIT-004 - ACI-10/11 undercount static source-text contracts that will break after splits

- Severity: P2
- Confidence: high
- Area: behavior-preserving module splits
- Evidence: plan lines 388-392 says `observeRunners.ts` remains a facade and every existing test path keeps working, mentioning only `check:compute-once` ledger repoints. Current tests contain many source-text reads of `src/tools/observeRunners.ts`, e.g. `tests/contracts/protocol/check-protocol-contract.mjs:101`, `tests/contracts/runtime/check-content-pick.mjs:60`, `tests/contracts/tools/check-task-conditioned-salience.mjs:13`, and multiple ABML contract files. `tests/unit/cli/flags-render.test.ts:11` imports helper exports from `cli/index.ts`.
- Reproduction: `rg -n 'src/tools/observeRunners.ts|../../../cli/index.ts' tests src docs scripts`.
- Expected: The split plan lists static contract migrations and facade re-export expectations, not only runtime import compatibility.
- Actual: Several checks assert source text in `observeRunners.ts`; moving logic into `src/tools/observe/*` makes those fail unless repointed or converted to module/import assertions. ACI-11 likewise needs either re-export compatibility from `cli/index.ts` or test import updates.
- Impact: Implementation agents may hit avoidable contract failures mid-refactor, or keep logic duplicated in the facade to satisfy stale text checks.
- Suggested fix direction: Add an ACI-10/11 sub-step: migrate static text guards to the new module paths or test public exports explicitly; re-export only intentional compatibility helpers from facades.
- Verification command: `npm run check:protocol`, `npm run check:content-pick`, `npm run check:task-conditioned-salience`, ABML contract checks, and `npx tsx --test tests/unit/cli/flags-render.test.ts`.
- Notes: This is not a design rejection; it is a migration checklist gap.

### AUDIT-005 - Acceptance omits repo-required docs/runtime sync for material tool and bridge changes

- Severity: P2
- Confidence: medium
- Area: plan acceptance / governance
- Evidence: `AGENTS.md:90-99` requires material changes to update contracts, budgets, summaries, README, CHANGELOG, TODO, the `pi-browser-tools` skill, affected docs/contracts, and runtime callable smoke after enhanced tools. The plan only says activation needs `CURRENT.md` at line 9 and final acceptance lines 519-522 mention gates, baselines, skills, `npm run check`, and `npm run lint`.
- Reproduction: Compare plan acceptance with `AGENTS.md` Sync & Verification.
- Expected: Acceptance names the doc/sync artifacts affected by the plan: `CURRENT.md` activation entry, `TODO.md` navigation state if activation changes, README/AI_INSTALL or generated docs for new `fresh` and extension-stale surfaces, CHANGELOG, both skills, package/check graph wiring, and actual callable runtime smoke artifacts where public tool behavior changes.
- Actual: Several are implied by full check but not stated as acceptance items.
- Impact: Future execution could land code/gates while leaving maintainer docs or user-facing recovery docs stale, especially for ACI-5 and ACI-6.
- Suggested fix direction: Add a final "sync checklist" section to the plan and tie each ACI to required generated/manual docs.
- Verification command: `npm run docs:generate`, `npm run check:tool-docs`, `npm run check:doc-structure`, skill quick-validate for both skills, full `npm run check`, plus a callable `browser_observe fresh:true` runtime smoke artifact after reload.
- Notes: This is governance completeness, not a flaw in the technical direction.

## Non-Issues / Rejected Leads

- ACI-9 heartbeat contentless update is correctly scoped; current `withTrackedOperation()` routes heartbeats through `handle.update()` and `emitTrackedProgress()`, so a unit test can lock heartbeat content removal without changing operation liveness.
- ACI-10/11 structural direction is supported by current file sizes and existing deferred split text; the finding is only about migration details.
- ACI-3's `diagnostics.nextActions` removal is acknowledged by the plan through "any other reader found by grep"; no separate finding unless implementation misses CLI JSON/render tests.

## Handoff Summary

- Highest-risk finding: AUDIT-001, because a circular build hash can invalidate ACI-5's core skew signal.
- Fastest verification: add explicit negative tests for AUDIT-003 and snapshot redaction tests for AUDIT-002 before implementation.
- Files most likely affected: `scripts/build-bridge.mjs`, `bridge_src/shared/buildInfo.ts`, `bridge_src/service_worker/bridge_info.ts`, `src/driver/BrowserBridgeClientRegistry.ts`, `src/driver/BrowserLeaseRegistry.ts`, `src/tools/registerTabsTool.ts`, `src/tools/registerObserveTool.ts`, `tests/contracts/**`, `skills/pi-browser-tools/SKILL.md`, `skills/pi-browser-cli/SKILL.md`.
