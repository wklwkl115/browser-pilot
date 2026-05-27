# Archive History Compression Plan

## Goal

Reduce `ARCHIVE.md` from a long per-TODO execution log into a compact staged archive while preserving:

- final decisions
- behavior boundaries
- proof commands
- artifact pointers
- discoverability for future RFC reopen decisions

## Recommended target shape

### Keep in `ARCHIVE.md`

- one short section per major completed phase
- 3-8 bullets per phase
- explicit links to detailed docs/contracts when they already exist
- only the final state, not the whole execution diary

### Move out of `ARCHIVE.md`

Large detailed historical streams should move to focused archive docs, for example:

- summary docs:
  - `docs/archive/bridge-esm-history.md`
  - `docs/archive/governance-history.md`
  - `docs/archive/orchestration-history.md`
- full-detail docs:
  - `docs/archive/bridge-esm-history.full.md`
  - `docs/archive/governance-history.full.md`
  - `docs/archive/orchestration-history.full.md`

## Safe compression rule

Before removing a detailed block from `ARCHIVE.md`, confirm at least one of these remains true:

1. the decision is already frozen in a dedicated doc
2. contracts/tests encode the invariant
3. README/AI_INSTALL/ROADMAP/CURRENT summarize the final user-facing state
4. artifact paths are not the only remaining proof source

## Candidate historical leftovers still worth tracking

These are not unfinished bugs; they are future design or optional work items still visible in docs:

1. Debugger workflow remains RFC-only
   - page-authored provenance
   - pause/breakpoint/step lifecycle
   - source: `docs/debugger-evidence-workflow-plan.md`

2. Hook dispatcher multi-file injection remains RFC-only evaluation
   - source: `docs/hook-dispatcher-multi-file-evaluation.md`

3. Protocol single-source migration is only partial by domain
   - hook/frame/html/screenshot/evidence are still documented as later domain migrations
   - source: `docs/protocol-single-source-plan.md`, `README.md`

4. Browser session auto-routing from invocation context is still future-facing in historical notes
   - current runtime works; auto-session dispatch is not the active workstream

5. Incognito/profile isolation is still out of current mainline
   - source: `ROADMAP.md`

6. Real ACI eval runner remains opt-in future work
   - source: `ROADMAP.md`, `evals/browser-workflows/future-runner.md`

7. Popup/HUD evolution is intentionally not active
   - source: `ARCHIVE.md` TODO 201 summary

## Recommendation

Compress history now, but do not reopen the items above as active TODOs unless a new requirement arrives.
